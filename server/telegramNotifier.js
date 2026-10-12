/**
 * Telegram Bot API dispatch module for QASE user-feedback notifications.
 *
 * Sends one message per configured chat id via the official Telegram Bot API
 * (POST https://api.telegram.org/bot<TOKEN>/sendMessage). Replaces the
 * previous WhatsApp Cloud API notifier for the user-feedback workflow.
 *
 * Hard guarantees (identical to the WhatsApp notifier it replaces):
 *  1. Dispatch never blocks or fails feedback submission.
 *  2. One feedback id → at most one message per chat id, enforced by a
 *     persisted idempotency ledger (survives restarts).
 *  3. The bot token never appears in any log, error, or projection. The
 *     token is part of the request URL — logs only ever show
 *     'bot<redacted>/sendMessage'.
 *  4. Construction state is ALWAYS logged once (enabled / disabled /
 *     invalid) — never silent.
 *
 * Lifecycle: PENDING → SENDING → SENT; on failure FAILED with retry
 * (retryNotification replays and skips chats already sent).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeErrorDetail } from './errorSanitizer.js';

export class TelegramNotificationError extends Error {
	constructor(message, { code, retryable = false, upstreamStatus, retryAfterMs, errorCode, detail } = {}) {
		super(message);
		this.name = 'TelegramNotificationError';
		this.code = code;
		this.retryable = retryable;
		this.upstreamStatus = upstreamStatus;
		this.retryAfterMs = retryAfterMs; // Telegram 429: parameters.retry_after (ms)
		this.telegramErrorCode = errorCode; // Telegram's numeric error_code
		this.detail = detail;
	}
}

const STATE_DIR = '.qase';
export const LEDGER_FILE = `${STATE_DIR}/telegram-notifications.json`;
export const MAX_ATTEMPTS = 3;
export const RETRY_DELAY_MS = 2_000;
export const MAX_CHAT_IDS = 20;
export const MAX_MESSAGE_CHARS = 4_096; // Telegram sendMessage limit
export const NOTIFICATION_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED'];

/** TELEGRAM-<feedbackId> — unique, deterministic, grep-able. */
export function notificationIdFor(feedbackId) {
	return `TELEGRAM-${feedbackId}`;
}

function enabledFlag(environment) {
	const raw = environment.QASE_TELEGRAM_ENABLED;
	if (raw === undefined || raw === null || String(raw).trim() === '') return false;
	const normalized = String(raw).trim().toLowerCase();
	if (['true', 'enabled', 'on', '1'].includes(normalized)) return true;
	if (['false', 'disabled', 'off', '0'].includes(normalized)) return false;
	throw new TypeError('QASE_TELEGRAM_ENABLED must be true or false.');
}

function required(environment, key) {
	const value = environment[key];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new TypeError(`${key} is required when QASE_TELEGRAM_ENABLED is true.`);
	}
	if (/[\u0000-\u001f\u007f]/.test(value)) {
		throw new TypeError(`${key} contains control characters.`);
	}
	return value.trim();
}

/**
 * Parse QASE_TELEGRAM_CHAT_IDS: comma-separated chat ids (user ids or
 * -100… supergroup ids). Digits, optional leading '-'. Deduped, max 20.
 */
export function parseChatIds(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') {
		throw new TypeError('QASE_TELEGRAM_CHAT_IDS is required (comma-separated chat ids).');
	}
	const seen = new Set();
	const chatIds = [];
	for (const part of raw.split(',')) {
		const candidate = part.trim();
		if (candidate === '') continue;
		if (!/^-?\d{1,20}$/.test(candidate)) {
			throw new TypeError(`Invalid Telegram chat id: ${candidate.slice(0, 24)}.`);
		}
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		chatIds.push(candidate);
		if (chatIds.length > MAX_CHAT_IDS) {
			throw new TypeError(`QASE_TELEGRAM_CHAT_IDS allows at most ${MAX_CHAT_IDS} chat ids.`);
		}
	}
	if (chatIds.length === 0) {
		throw new TypeError('QASE_TELEGRAM_CHAT_IDS contains no valid chat ids.');
	}
	return chatIds;
}

/**
 * Read and freeze the integration config. Returns undefined when disabled
 * (the dispatch call then becomes a no-op).
 */
export function parseTelegramConfig(environment) {
	if (!enabledFlag(environment)) return undefined;
	const botToken = required(environment, 'QASE_TELEGRAM_BOT_TOKEN');
	if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
		throw new TypeError('QASE_TELEGRAM_BOT_TOKEN is not a valid bot token.');
	}
	const chatIds = parseChatIds(environment.QASE_TELEGRAM_CHAT_IDS);
	const apiOriginRaw = String(environment.QASE_TELEGRAM_API_ORIGIN ?? '').trim();
	return Object.freeze({
		botToken,
		chatIds,
		// Blank (present-but-empty) values must not wipe the default origin —
		// env materializers write empty strings for unset optional keys.
		apiOrigin: (apiOriginRaw === '' ? 'https://api.telegram.org' : apiOriginRaw).replace(/\/+$/, ''),
		timeoutMs: 15_000
	});
}

/** Timestamp in the report style (e.g. 07-Oct-2026 10:30 PM). Built with an
 * explicit Intl formatter so the output is identical on every locale build
 * and honors the submitting user's QASE timezone (their profile setting —
 * the same zone QASE's UI renders feedback timestamps in). Falls back to
 * UTC when no zone is supplied. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatSubmittedOn(timestampMs, timeZone) {
	const zone = typeof timeZone === 'string' && timeZone.trim() !== '' ? timeZone.trim() : 'UTC';
	let parts;
	try {
		parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: zone, hour12: false,
			year: 'numeric', month: 'numeric', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		}).formatToParts(new Date(timestampMs));
	} catch {
		parts = new Intl.DateTimeFormat('en-GB', {
			timeZone: 'UTC', hour12: false,
			year: 'numeric', month: 'numeric', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		}).formatToParts(new Date(timestampMs));
	}
	const get = type => Number(parts.find(part => part.type === type)?.value ?? 0);
	const hours24 = get('hour') % 24;
	const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
	const pad = value => String(value).padStart(2, '0');
	return `${pad(get('day'))}-${MONTHS[get('month') - 1]}-${get('year')} `
		+ `${pad(hours12)}:${pad(get('minute'))} ${hours24 < 12 ? 'AM' : 'PM'}`;
}

const MODE_LABELS = { qa: 'New QA Run', sqa: 'SQA', founder: 'Founder Review' };

/**
 * Clock read ONLY when the caller genuinely has no authoritative timestamp
 * (a context built outside the feedback flow). The live feedback route always
 * supplies record.submittedAt, so this path is never taken for real feedback.
 */
function recordFallbackNow(context) {
	return typeof context.fallbackNow === 'number' ? context.fallbackNow : Date.now();
}

/**
 * Build the notification body — exact format agreed with the customer:
 * predefined default message above the actual user feedback.
 * Pure function of the feedback record and run context; only these fields
 * ever travel — never tokens, never report content, never finding details.
 */
export function buildFeedbackMessage(feedback, context = {}) {
	const rating = Math.max(1, Math.min(5, Number(feedback.rating) || 0));
	const comments = typeof feedback.comments === 'string' && feedback.comments.trim() !== ''
		? feedback.comments.trim()
		: undefined;
	const improvement = typeof feedback.improvement === 'string' && feedback.improvement.trim() !== ''
		? feedback.improvement.trim()
		: undefined;
	const modeLabel = MODE_LABELS[context.mode] ?? 'QASE Test';
	const shortId = typeof feedback.runId === 'string' && feedback.runId.length >= 8
		? feedback.runId.slice(0, 8) : '—';
	const title = typeof context.title === 'string' && context.title.trim() !== ''
		? context.title.trim() : undefined;
	const runLabel = title ? `${title} (#${shortId})` : `${modeLabel} #${shortId}`;
	const targetUrl = typeof context.targetUrl === 'string' && context.targetUrl.trim() !== ''
		? context.targetUrl.trim() : undefined;
	const submittedBy = typeof context.submittedByName === 'string' && context.submittedByName.trim() !== ''
		? context.submittedByName.trim() : 'QASE user';
	const submittedOn = formatSubmittedOn(
		Number.isFinite(context.submittedAt) ? context.submittedAt : recordFallbackNow(context),
		context.submittedAtTimeZone
	);
	const message = [
		'📢 QASE User Feedback Received',
		'',
		'A new user feedback has been submitted after completion of a QASE testing task.',
		'',
		`⭐ Rating: ${rating}/5`,
		'',
		'📝 User Feedback:',
		comments ?? 'Not provided.',
		'',
		'🔧 What should we improve?',
		improvement ?? 'Not provided.',
		'',
		`📊 QA Run: ${runLabel}`,
		...(targetUrl ? [`🌐 Target URL: ${targetUrl}`] : []),
		`👤 Submitted By: ${submittedBy}`,
		`🕒 Submitted On: ${submittedOn}`
	].join('\n');
	return message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message;
}

/** Load the persisted idempotency ledger (feedback id → outcome). */
function loadLedger(file = LEDGER_FILE) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
	} catch {
		// Missing or corrupt ledger starts empty; the idempotency guarantee
		// degrades to in-flight tracking only, never double-delivery of a
		// completed send.
	}
	return {};
}

function persistLedger(ledger, file = LEDGER_FILE) {
	let tmp;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(tmp, JSON.stringify(ledger, undefined, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		if (tmp) { try { fs.unlinkSync(tmp); } catch { /* best-effort */ } }
		console.error(`[qase-telegram] failed to persist notification ledger: ${error?.code ?? 'unknown'}`);
	}
}

/** Map an upstream failure to a typed error with a retryability verdict. */
function toNotificationError(error, attemptLabel) {
	if (error instanceof TelegramNotificationError) return error;
	if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
		return new TelegramNotificationError('Telegram request timed out.', { code: 'telegram_timeout', retryable: true });
	}
	if (error?.name === 'TypeError' && typeof error?.message === 'string' && /fetch|network/i.test(error.message)) {
		return new TelegramNotificationError('Telegram API is unreachable.', { code: 'telegram_unreachable', retryable: true });
	}
	// Unknown failures are treated as retryable a bounded number of times.
	return new TelegramNotificationError(`${attemptLabel} failed.`, { code: 'telegram_notification_failed', retryable: true });
}

async function readBoundedText(response, maximum) {
	const text = await response.text();
	return text.length > maximum ? text.slice(0, maximum) : text;
}

/** Extract the message id from a Telegram success body {ok, result:{message_id}}. */
function extractMessageId(body) {
	try {
		const parsed = JSON.parse(body);
		const id = parsed?.result?.message_id;
		return Number.isInteger(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Extract Telegram's error_code + description from a failure body. */
function extractError(body) {
	try {
		const parsed = JSON.parse(body);
		return {
			errorCode: Number.isInteger(parsed?.error_code) ? parsed.error_code : undefined,
			description: typeof parsed?.description === 'string' ? parsed.description : undefined
		};
	} catch {
		return {};
	}
}

/** Extract retry_after seconds from a 429 body, if present. */
function extractRetryAfterMs(body) {
	try {
		const parsed = JSON.parse(body);
		const seconds = parsed?.parameters?.retry_after;
		return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Send to one chat. The token is part of the URL — this URL is NEVER
 * returned, logged, or projected anywhere.
 */
async function sendToChat(config, chatId, message, { fetchImpl, createTimeoutSignal }) {
	const url = `${config.apiOrigin}/bot${config.botToken}/sendMessage`;
	let response;
	try {
		response = await fetchImpl(url, {
			method: 'POST',
			redirect: 'error',
			signal: createTimeoutSignal(config.timeoutMs),
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true })
		});
	} catch (error) {
		throw toNotificationError(error, 'Telegram message delivery');
	}
	if (response.ok) {
		return { messageId: extractMessageId(await readBoundedText(response, 2_048)) };
	}
	const rawBody = await readBoundedText(response, 512);
	const { errorCode: telegramErrorCode } = extractError(rawBody);
	const detail = sanitizeErrorDetail(rawBody);
	const status = response.status;
	if (status === 401) {
		throw new TelegramNotificationError('Telegram authentication failed.', { code: 'telegram_auth_failed', upstreamStatus: status });
	}
	if (status === 400) {
		// Invalid chat id, bot blocked by the user, malformed payload.
		throw new TelegramNotificationError('Telegram rejected the message.', { code: 'telegram_rejected', upstreamStatus: status, detail, errorCode: telegramErrorCode });
	}
	if (status === 429) {
		throw new TelegramNotificationError('Telegram API rate limit reached.', {
			code: 'telegram_rate_limited', retryable: true, upstreamStatus: status, retryAfterMs: extractRetryAfterMs(rawBody), errorCode: telegramErrorCode
		});
	}
	if (status >= 500) {
		throw new TelegramNotificationError('Telegram API returned a server error.', { code: 'telegram_server_error', retryable: true, upstreamStatus: status });
	}
	throw new TelegramNotificationError('Telegram API request failed.', { code: 'telegram_notification_failed', retryable: true, upstreamStatus: status, detail, errorCode: telegramErrorCode });
}

function publicEntry(entry) {
	// Projection safe for APIs and logs: statuses, chats, sanitized reason.
	return {
		notificationId: entry.notificationId,
		feedbackId: entry.feedbackId,
		runId: entry.runId,
		status: entry.status,
		recipients: entry.recipients.map(recipient => ({
			chatId: recipient.chatId,
			state: recipient.state,
			attempts: recipient.attempts,
			...(recipient.messageId ? { messageId: recipient.messageId } : {}),
			...(Number.isInteger(recipient.upstreamStatus) ? { upstreamStatus: recipient.upstreamStatus } : {}),
			...(recipient.errorCode ? { errorCode: recipient.errorCode } : {}),
			...(recipient.lastError ? { lastError: recipient.lastError } : {})
		})),
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt
	};
}

/**
 * Create the configured notifier. `undefined` when the integration is off —
 * the dispatch call then becomes a no-op, mirroring drytisIntegrationFactory.
 * The construction state is ALWAYS logged once (never silent).
 */
export function createTelegramNotifier(options = {}) {
	const environment = options.environment ?? process.env;
	const logger = options.logger ?? console;
	const fetchImpl = options.fetchImpl ?? fetch;
	const createTimeoutSignal = options.createTimeoutSignal ?? (timeoutMs => AbortSignal.timeout(timeoutMs));
	const sleep = options.sleep ?? (ms => new Promise(resolve => { setTimeout(resolve, ms); }));
	const ledgerFile = options.ledgerFile ?? LEDGER_FILE;
	const loadLedgerImpl = options.loadLedger ?? loadLedger;
	const persistLedgerImpl = options.persistLedger ?? persistLedger;

	let config;
	try {
		config = options.config ?? parseTelegramConfig(environment);
	} catch (error) {
		// Misconfiguration must never take feedback down: log once, stay off.
		logger.error?.('telegram.integration', {
			state: 'invalid',
			reason: sanitizeErrorDetail(error)
		});
		return undefined;
	}
	if (!config) {
		// Root-cause guard: a disabled integration must be VISIBLE, not silent.
		logger.info?.('telegram.integration', {
			state: 'disabled',
			reason: 'QASE_TELEGRAM_ENABLED is not true'
		});
		return undefined;
	}
	logger.info?.('telegram.integration', {
		state: 'enabled',
		recipients: config.chatIds.length
	});

	const ledger = loadLedgerImpl(ledgerFile);

	function logFailure(event, notificationId, feedback, error) {
		const fields = {
			notificationId,
			feedbackId: feedback?.id,
			runId: feedback?.runId,
			reason: error instanceof Error ? sanitizeErrorDetail(error) : String(error ?? 'unknown')
		};
		if (Number.isInteger(error?.upstreamStatus)) fields.status = error.upstreamStatus;
		logger.warn?.(event, fields);
	}

	/** Per-attempt outcome: everything the brief asks for, never the token. */
	function logAttempt(recipient, notificationId, feedbackId, attempt, result) {
		logger.info?.('telegram.delivery.attempt', {
			notificationId,
			feedbackId,
			chatId: recipient.chatId,
			attempt,
			provider: 'telegram-bot-api',
			endpoint: 'bot<redacted>/sendMessage',
			status: result.ok ? 200 : result.status,
			messageId: result.messageId,
			errorCode: result.errorCode,
			reason: result.reason
		});
	}

	/**
	 * Send to every chat that has not already been accepted, tracking
	 * per-chat state. Idempotent per (notification, chat) pair. One chat's
	 * failure never prevents attempts to the remaining chats (except a dead
	 * bot token, which helps nobody).
	 */
	async function runDispatch(entry, feedback, context) {
		const notificationId = entry.notificationId;
		const message = buildFeedbackMessage(feedback, context);
		let authFailed = false;
		for (const recipient of entry.recipients) {
			if (recipient.state === 'sent') continue; // retry never duplicates
			recipient.state = 'sending';
			entry.status = 'SENDING';
			persistLedgerImpl(ledger, ledgerFile);
			let sent = false;
			let attempt = 0; // attempts within THIS dispatch (recipient.attempts is cumulative)
			while (attempt < MAX_ATTEMPTS) {
				attempt += 1;
				recipient.attempts += 1;
				persistLedgerImpl(ledger, ledgerFile);
				try {
					const { messageId } = await sendToChat(config, recipient.chatId, message, { fetchImpl, createTimeoutSignal });
					sent = true;
					// The Bot API accepted the message synchronously — this
					// IS Telegram-side acceptance (message_id is the proof).
					recipient.messageId = messageId;
					delete recipient.upstreamStatus;
					delete recipient.errorCode;
					delete recipient.lastError;
					logAttempt(recipient, notificationId, feedback.id, attempt,
						{ ok: true, messageId });
					break;
				} catch (error) {
					const typed = toNotificationError(error, 'Telegram message delivery');
					if (Number.isInteger(typed.upstreamStatus)) recipient.upstreamStatus = typed.upstreamStatus;
					recipient.errorCode = typed.code; // stable symbolic code (telegram_rejected, …)
					recipient.lastError = typed.message;
					logAttempt(recipient, notificationId, feedback.id, attempt, {
						ok: false,
						status: typed.upstreamStatus,
						errorCode: typed.code,
						reason: typed.message
					});
					// A dead bot token helps no chat: stop the whole dispatch
					// instead of hammering the API three times per chat.
					if (typed.code === 'telegram_auth_failed') {
						authFailed = true;
						break;
					}
					if (!typed.retryable) break;
					if (attempt >= MAX_ATTEMPTS) break;
					await sleep(typed.retryAfterMs ?? RETRY_DELAY_MS * attempt);
				}
			}
			if (sent) {
				recipient.state = 'sent';
				delete recipient.lastError;
			} else {
				recipient.state = 'failed';
				logFailure('telegram.delivery.failed', notificationId, feedback,
					recipient.lastError ? new Error(recipient.lastError) : new Error('Telegram message delivery failed.'));
			}
			entry.updatedAt = Date.now();
			persistLedgerImpl(ledger, ledgerFile);
			if (authFailed) break; // remaining chats stay unattempted
		}
		const allSent = entry.recipients.every(recipient => recipient.state === 'sent');
		entry.status = allSent ? 'SENT' : 'FAILED';
		entry.updatedAt = Date.now();
		persistLedgerImpl(ledger, ledgerFile);
		if (entry.status === 'SENT') {
			logger.info?.('telegram.feedback.notified', {
				notificationId,
				feedbackId: feedback.id,
				runId: feedback.runId,
				recipients: entry.recipients.length
			});
		} else {
			const failed = entry.recipients.filter(recipient => recipient.state !== 'sent');
			logFailure('telegram.notification.failed', notificationId, feedback,
				new Error(`status FAILED — ${failed.length}/${entry.recipients.length} chat(s) not accepted: ${failed.map(r => `${r.chatId}(${r.lastError ?? 'unattempted'})`).join('; ')}`));
		}
	}

	function newEntry(feedback, context) {
		return {
			notificationId: notificationIdFor(feedback.id),
			feedbackId: feedback.id,
			runId: feedback.runId,
			status: 'PENDING',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			recipients: config.chatIds.map(chatId => ({ chatId, state: 'pending', attempts: 0 })),
			// Retain exactly what a retry needs to rebuild the message.
			replay: {
				feedback: { id: feedback.id, runId: feedback.runId, rating: feedback.rating, comments: feedback.comments, improvement: feedback.improvement },
				context: {
					mode: context.mode,
					title: context.title,
					targetUrl: context.targetUrl,
					submittedByName: context.submittedByName,
					submittedAtTimeZone: context.submittedAtTimeZone,
					// Retry must reuse the SAME authoritative instant — never
					// mint a fresh one (that would shift Submitted On).
					submittedAt: Number.isFinite(context.submittedAt)
						? context.submittedAt
						: undefined
				}
			}
		};
	}

	/**
	 * Fire-and-forget dispatch for one committed feedback record. Returns a
	 * tracked promise; NEVER let it reject (the caller may legitimately
	 * ignore it — guarantee 1).
	 */
	function dispatchFeedbackNotification(feedback, context = {}) {
		if (!feedback?.id || !Array.isArray(config.chatIds) || config.chatIds.length === 0) {
			return Promise.resolve();
		}
		const notificationId = notificationIdFor(feedback.id);
		// Idempotency: a completed (SENT) or in-flight (PENDING/SENDING)
		// notification never restarts from scratch.
		const prior = ledger[feedback.id];
		if (prior && ['SENT', 'PENDING', 'SENDING'].includes(prior.status)) {
			return Promise.resolve();
		}
		const entry = prior ?? newEntry(feedback, context);
		// A FAILED entry being re-dispatched keeps its per-chat states —
		// already-accepted chats are skipped (no duplicate messages).
		entry.status = 'PENDING';
		entry.updatedAt = Date.now();
		ledger[feedback.id] = entry;
		persistLedgerImpl(ledger, ledgerFile);

		const run = runDispatch(entry, feedback, context);
		// Guarantee 1: the dispatch promise itself never rejects.
		return run.catch(error => {
			logFailure('telegram.dispatch.failed', notificationId, feedback, error);
			entry.status = 'FAILED';
			entry.updatedAt = Date.now();
			persistLedgerImpl(ledger, ledgerFile);
		});
	}

	/**
	 * Retry a FAILED notification by id (TELEGRAM-<feedbackId>). Resolves to
	 * { ok: true, notification } on dispatch, { ok: false, reason } when the
	 * retry is not allowed. Already-sent chats are skipped by runDispatch.
	 */
	function retryNotification(id) {
		const entry = Object.values(ledger).find(candidate => candidate.notificationId === id || candidate.feedbackId === id);
		if (!entry) {
			return Promise.resolve({ ok: false, reason: 'not_found' });
		}
		if (entry.status === 'SENT') {
			return Promise.resolve({ ok: false, reason: 'already_sent' });
		}
		if (entry.status === 'PENDING' || entry.status === 'SENDING') {
			return Promise.resolve({ ok: false, reason: 'in_progress' });
		}
		const { feedback, context } = entry.replay ?? {};
		if (!feedback?.id) {
			return Promise.resolve({ ok: false, reason: 'not_replayable' });
		}
		entry.status = 'PENDING';
		entry.updatedAt = Date.now();
		persistLedgerImpl(ledger, ledgerFile);
		return runDispatch(entry, feedback, context)
			.catch(error => {
				logFailure('telegram.dispatch.failed', entry.notificationId, feedback, error);
				entry.status = 'FAILED';
				entry.updatedAt = Date.now();
				persistLedgerImpl(ledger, ledgerFile);
			})
			.then(() => ({ ok: true, notification: publicEntry(entry) }));
	}

	/** List notification records (admin projection — sanitized). */
	function listNotifications(filter = {}) {
		let entries = Object.values(ledger);
		if (filter.status) entries = entries.filter(entry => entry.status === filter.status);
		if (filter.feedbackId) entries = entries.filter(entry => entry.feedbackId === filter.feedbackId);
		entries.sort((a, b) => b.createdAt - a.createdAt);
		return entries.map(publicEntry);
	}

	/** Inspect one notification by notification id or feedback id. */
	function getNotification(id) {
		const entry = Object.values(ledger).find(candidate => candidate.notificationId === id || candidate.feedbackId === id);
		return entry ? publicEntry(entry) : undefined;
	}

	return Object.freeze({
		dispatchFeedbackNotification,
		retryNotification,
		listNotifications,
		getNotification,
		buildMessage: buildFeedbackMessage
	});
}

/** Convenience for app wiring: disabled/invalid → undefined (no-op). */
export function createConfiguredTelegramNotifier(options = {}) {
	return createTelegramNotifier(options);
}
