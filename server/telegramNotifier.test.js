import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createTelegramNotifier,
	parseTelegramConfig,
	parseChatIds,
	buildFeedbackMessage,
	formatSubmittedOn,
	notificationIdFor,
	TelegramNotificationError
} from './telegramNotifier.js';

// Synthetic fixture values ONLY — never a real token or chat id.
const VALID_ENV = {
	QASE_TELEGRAM_ENABLED: 'true',
	QASE_TELEGRAM_BOT_TOKEN: '1234567890:TEST-TOKEN-abcdefghij_klmnopqrstuv',
	QASE_TELEGRAM_CHAT_IDS: '-1001110001111,-1002220002222,-1003330003333,123456789'
};

const FEEDBACK = {
	id: '11111111-2222-4333-8444-555555555555',
	runId: 'cf5b7e5f-a4fa-4189-85a3-7d07473ad7c0',
	rating: 5,
	comments: 'The automation testing was smooth and the results were easy to understand.',
	improvement: 'The test execution report could provide more detailed information about failed test cases.'
};

const CONTEXT = {
	mode: 'qa',
	title: 'Homepage regression sweep',
	targetUrl: 'https://qase.dev/',
	submittedByName: 'QA User',
	submittedAt: Date.UTC(2026, 9, 7, 22, 0, 0) // 07-Oct-2026 10:00 PM UTC
};

function makeLedgerSandbox() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-telegram-'));
	return { dir, ledgerFile: path.join(dir, 'telegram-notifications.json') };
}

function readLedger(sandbox) {
	return JSON.parse(fs.readFileSync(sandbox.ledgerFile, 'utf8'));
}

function jsonResponse(status, body) {
	return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/** Scripted per-chat fetch: map chatId → queue array or iterator object with
 * next(); the fallback may also be a response or iterator for unscripted
 * chats. */
function perChatFetch(scripts, fallback = jsonResponse(200, '{"ok":true,"result":{"message_id":1}}')) {
	const calls = [];
	const resolve = source => {
		if (Array.isArray(source)) {
			return source.length > 0 ? source.shift() : fallback;
		}
		if (source && typeof source.next === 'function') return source.next();
		return source;
	};
	const fetchImpl = (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, init, body, chatId: String(body.chat_id) });
		const script = scripts.get(String(body.chat_id));
		const next = script !== undefined ? resolve(script) : resolve(fallback);
		return Promise.resolve(next);
	};
	fetchImpl.calls = calls;
	return fetchImpl;
}

function collectingLogger() {
	const entries = { info: [], warn: [], error: [] };
	return {
		entries,
		info: (event, fields) => entries.info.push({ event, fields }),
		warn: (event, fields) => entries.warn.push({ event, fields }),
		error: (event, fields) => entries.error.push({ event, fields })
	};
}

/* ── Config parsing ─────────────────────────────────────────────── */

test('parseTelegramConfig returns undefined when disabled or unset', () => {
	assert.equal(parseTelegramConfig({}), undefined);
	assert.equal(parseTelegramConfig({ QASE_TELEGRAM_ENABLED: 'false' }), undefined);
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: 'false' }), undefined);
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: 'Disabled' }), undefined);
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: 'off' }), undefined);
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: '0' }), undefined);
});

test('parseTelegramConfig accepts the standard truthy spellings, case-insensitive', () => {
	for (const value of ['true', 'TRUE', 'Enabled', 'enabled', 'ON', 'on', '1']) {
		const config = parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: value });
		assert.ok(config, `expected config for QASE_TELEGRAM_ENABLED=${value}`);
		assert.deepEqual(config.chatIds, ['-1001110001111', '-1002220002222', '-1003330003333', '123456789']);
	}
});

test('parseTelegramConfig throws on a non-boolean enable flag', () => {
	assert.throws(() => parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: 'yes' }), /true or false/);
	assert.throws(() => parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_ENABLED: 'maybe' }), /true or false/);
});

test('parseTelegramConfig requires bot token and chat ids when enabled', () => {
	assert.throws(() => parseTelegramConfig({ QASE_TELEGRAM_ENABLED: 'true' }), /QASE_TELEGRAM_BOT_TOKEN/);
	assert.throws(() => parseTelegramConfig({ QASE_TELEGRAM_ENABLED: 'true', QASE_TELEGRAM_BOT_TOKEN: VALID_ENV.QASE_TELEGRAM_BOT_TOKEN }), /QASE_TELEGRAM_CHAT_IDS/);
});

test('parseTelegramConfig rejects malformed bot tokens', () => {
	assert.throws(() => parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_BOT_TOKEN: 'short' }), /not a valid bot token/);
});

test('parseChatIds validates, dedupes, and caps chat ids', () => {
	assert.deepEqual(parseChatIds('-1001110001111, -1001110001111 ,123456789'), ['-1001110001111', '123456789']);
	assert.throws(() => parseChatIds('not-a-chat'), /Invalid Telegram chat id/);
	assert.throws(() => parseChatIds(''), /required/);
	const many = Array.from({ length: 22 }, (_, i) => String(100000000 + i)).join(',');
	assert.throws(() => parseChatIds(many), /at most 20/);
});

test('parseTelegramConfig applies defaults and freezes', () => {
	const config = parseTelegramConfig(VALID_ENV);
	assert.equal(config.apiOrigin, 'https://api.telegram.org');
	assert.equal(config.timeoutMs, 15_000);
	assert.deepEqual(config.chatIds, ['-1001110001111', '-1002220002222', '-1003330003333', '123456789']);
	// A present-but-empty API_ORIGIN (as materialized for unset optional
	// keys) must fall back to the default origin, never a blank one.
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_API_ORIGIN: '' }).apiOrigin, 'https://api.telegram.org');
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_API_ORIGIN: '   ' }).apiOrigin, 'https://api.telegram.org');
	assert.equal(parseTelegramConfig({ ...VALID_ENV, QASE_TELEGRAM_API_ORIGIN: 'https://bot.example/hood' }).apiOrigin, 'https://bot.example/hood');
	assert.ok(Object.isFrozen(config));
	assert.throws(() => parseChatIds('123,+456/789'), /Invalid Telegram chat id/);
});

/* ── Message building ───────────────────────────────────────────── */

test('buildFeedbackMessage emits the exact agreed format', () => {
	const message = buildFeedbackMessage(FEEDBACK, CONTEXT);
	assert.equal(message, [
		'📢 QASE User Feedback Received',
		'',
		'A new user feedback has been submitted after completion of a QASE testing task.',
		'',
		'⭐ Rating: 5/5',
		'',
		'📝 User Feedback:',
		'The automation testing was smooth and the results were easy to understand.',
		'',
		'🔧 What should we improve?',
		'The test execution report could provide more detailed information about failed test cases.',
		'',
		'📊 QA Run: Homepage regression sweep (#cf5b7e5f)',
		'🌐 Target URL: https://qase.dev/',
		'👤 Submitted By: QA User',
		'🕒 Submitted On: 07-Oct-2026 10:00 PM'
	].join('\n'));
});

test('buildFeedbackMessage omits target URL and falls back to mode label when context lacks them', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 4, comments: 'no context fields' },
		{ mode: 'sqa', submittedAt: CONTEXT.submittedAt }
	);
	assert.doesNotMatch(message, /Target URL/);
	assert.match(message, /📊 QA Run: SQA #abcd1234/);
});

test('buildFeedbackMessage clamps ratings, defaults missing fields', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 9, comments: '   ' },
		{ mode: 'sqa', submittedAt: CONTEXT.submittedAt }
	);
	assert.match(message, /⭐ Rating: 5\/5/);
	assert.match(message, /📝 User Feedback:\nNot provided\./);
	assert.match(message, /🔧 What should we improve\?\nNot provided\./);
	assert.match(message, /📊 QA Run: SQA #abcd1234/);
	assert.match(message, /👤 Submitted By: QASE user/);
});

test('buildFeedbackMessage shows improvement-only feedback with Not provided for comments', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 3, comments: '   ', improvement: 'The automation should provide better failure explanations.' },
		{ mode: 'qa', submittedAt: CONTEXT.submittedAt }
	);
	assert.match(message, /📝 User Feedback:\nNot provided\./);
	assert.match(message, /🔧 What should we improve\?\nThe automation should provide better failure explanations\./);
});

test('buildFeedbackMessage keeps both text fields separate and labeled', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 5, comments: 'General thoughts', improvement: 'Specific suggestion' },
		{ mode: 'qa', submittedAt: CONTEXT.submittedAt }
	);
	const commentsIdx = message.indexOf('📝 User Feedback:\nGeneral thoughts');
	const improveIdx = message.indexOf('🔧 What should we improve?\nSpecific suggestion');
	assert.ok(commentsIdx > -1 && improveIdx > -1, 'both sections present');
	assert.ok(commentsIdx < improveIdx, 'improvement follows general feedback');
});

test('buildFeedbackMessage preserves multiline and emoji content in both fields', () => {
	const message = buildFeedbackMessage(
		{
			id: 'x',
			runId: 'abcd1234-0000-0000-0000-000000000000',
			rating: 4,
			comments: 'Line one 🎉\nLine two — “special” <chars> & more',
			improvement: 'Step 1. improve\nStep 2. 🚀 improve'
		},
		{ mode: 'qa', submittedAt: CONTEXT.submittedAt }
	);
	assert.match(message, /Line one 🎉\nLine two — “special” <chars> & more/);
	assert.match(message, /Step 1\. improve\nStep 2\. 🚀 improve/);
});

test('buildFeedbackMessage truncates to 4096 chars', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 3, comments: 'y'.repeat(9_000) },
		{ mode: 'qa', submittedAt: CONTEXT.submittedAt }
	);
	assert.equal(message.length, 4_096);
	assert.ok(message.endsWith('…'));
});

test('notificationIdFor produces the TELEGRAM-FB-<id> pattern', () => {
	assert.equal(notificationIdFor('123'), 'TELEGRAM-123');
});

/* ── Authoritative metadata (Submitted On / Submitted By) ────────── */

test('formatSubmittedOn honors the submitting user timezone (IST boundary)', () => {
	const ts = Date.UTC(2026, 9, 8, 20, 45); // 08-Oct-2026 20:45 UTC
	// UTC rendering (default)
	assert.equal(formatSubmittedOn(ts), '08-Oct-2026 08:45 PM');
	// Asia/Kolkata (+05:30) — next calendar day, matching QASE UI display
	assert.equal(formatSubmittedOn(ts, 'Asia/Kolkata'), '09-Oct-2026 02:15 AM');
	// QASE's example pair: 02:15 PM IST === 08:45 AM UTC
	assert.equal(formatSubmittedOn(Date.UTC(2026, 9, 9, 8, 45), 'Asia/Kolkata'), '09-Oct-2026 02:15 PM');
	// Invalid zone falls back to UTC instead of throwing
	assert.equal(formatSubmittedOn(ts, 'Not/AZone'), '08-Oct-2026 08:45 PM');
});

test('buildFeedbackMessage uses context.submittedAt + timezone, never a fresh clock read', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 4, comments: 'ok' },
		{ mode: 'qa', submittedAt: Date.UTC(2026, 9, 8, 20, 45), submittedAtTimeZone: 'Asia/Kolkata' }
	);
	assert.match(message, /🕒 Submitted On: 09-Oct-2026 02:15 AM/, 'rendered in the user profile timezone');
	assert.doesNotMatch(message, /Date\.now/, 'no clock generation');
});

test('submittedByName comes from the context only — no default when the backend supplies it', () => {
	const message = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 4, comments: 'ok' },
		{ mode: 'qa', submittedByName: 'Manoj Kumar', submittedAt: CONTEXT.submittedAt }
	);
	assert.match(message, /👤 Submitted By: Manoj Kumar/);
	const fallback = buildFeedbackMessage(
		{ id: 'x', runId: 'abcd1234-0000-0000-0000-000000000000', rating: 4, comments: 'ok' },
		{ mode: 'qa', submittedAt: CONTEXT.submittedAt }
	);
	assert.match(fallback, /👤 Submitted By: QASE user/, 'fallback only when no authenticated name is available');
});

/* ── Construction visibility ────────────────────────────────────── */

test('createTelegramNotifier stays off and logs once when disabled', () => {
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({ environment: {}, logger });
	assert.equal(notifier, undefined);
	assert.equal(logger.entries.info.length, 1);
	assert.equal(logger.entries.info[0].event, 'telegram.integration');
	assert.equal(logger.entries.info[0].fields.state, 'disabled');
});

test('createTelegramNotifier logs invalid config once and stays off', () => {
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({ environment: { QASE_TELEGRAM_ENABLED: 'true' }, logger });
	assert.equal(notifier, undefined);
	assert.equal(logger.entries.error.length, 1);
	assert.equal(logger.entries.error[0].fields.state, 'invalid');
	assert.ok(!JSON.stringify(logger.entries).includes(VALID_ENV.QASE_TELEGRAM_BOT_TOKEN));
});

test('createTelegramNotifier logs the enabled state with chat count', () => {
	const logger = collectingLogger();
	const fetchImpl = perChatFetch(new Map());
	createTelegramNotifier({ environment: VALID_ENV, logger, fetchImpl });
	const entry = logger.entries.info.find(e => e.event === 'telegram.integration');
	assert.equal(entry.fields.state, 'enabled');
	assert.equal(entry.fields.recipients, 4);
	assert.ok(!JSON.stringify(logger.entries).includes(VALID_ENV.QASE_TELEGRAM_BOT_TOKEN));
});

/* ── Dispatch ───────────────────────────────────────────────────── */

test('dispatch delivers to every chat and ends SENT with message ids', async () => {
	const sandbox = makeLedgerSandbox();
	let seq = 0;
	// Repeating iterator so every chat gets a distinct incrementing id.
	const fetchImpl = perChatFetch(new Map(), { next: () => jsonResponse(200, JSON.stringify({ ok: true, result: { message_id: ++seq + 100 } })) });
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal(fetchImpl.calls.length, 4);
	for (const call of fetchImpl.calls) {
		assert.match(call.url, /^https:\/\/api\.telegram\.org\/bot1234567890:TEST-TOKEN-[\w-]+\/sendMessage$/);
		assert.equal(call.init.method, 'POST');
		assert.equal(call.init.redirect, 'error');
		assert.equal(call.init.headers['Content-Type'], 'application/json');
		assert.equal(call.body.disable_web_page_preview, true);
		assert.ok(call.body.text.startsWith('📢 QASE User Feedback Received'));
	}

	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'SENT');
	assert.equal(entry.notificationId, `TELEGRAM-${FEEDBACK.id}`);
	assert.ok(entry.recipients.every(r => r.state === 'sent' && r.attempts === 1));
	assert.deepEqual(entry.recipients.map(r => r.messageId), [101, 102, 103, 104]);
	assert.equal(logger.entries.info.filter(e => e.event === 'telegram.feedback.notified').length, 1);
});

test('dispatch is idempotent: SENT or in-flight never resends; refresh-safe', async () => {
	const sandbox = makeLedgerSandbox();
	const fetchImpl = perChatFetch(new Map());
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);
	assert.equal(fetchImpl.calls.length, 4);

	// Duplicate submit / page refresh → same feedback id again: zero new calls.
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);
	assert.equal(fetchImpl.calls.length, 4);
});

test('per-chat failure isolation: a bad chat never blocks the others', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map([
		['-1002220002222', { next: () => jsonResponse(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}') }]
	]);
	const fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal(fetchImpl.calls.length, 4); // every chat attempted exactly once
	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'FAILED');
	const failedChat = entry.recipients.find(r => r.chatId === '-1002220002222');
	assert.equal(failedChat.state, 'failed');
	assert.match(failedChat.lastError, /rejected/);
	assert.equal(failedChat.errorCode, 'telegram_rejected');
	assert.ok(entry.recipients.filter(r => r.chatId !== '-1002220002222').every(r => r.state === 'sent'));
	assert.equal(logger.entries.warn.filter(e => e.event === 'telegram.notification.failed').length, 1);
});

test('retryable failure: PENDING → SENDING → FAILED with attempts capped', async () => {
	const sandbox = makeLedgerSandbox();
	// Repeating generators keep every attempt failing (queue never exhausts
	// into the success fallback).
	const scripts = new Map(VALID_ENV.QASE_TELEGRAM_CHAT_IDS.split(',').map(chatId => [
		chatId, { next: () => jsonResponse(500, '{"ok":false,"error_code":500,"description":"Internal Server Error"}') }
	]));
	const fetchImpl = perChatFetch(scripts);
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal(fetchImpl.calls.length, 12); // 4 chats × 3 attempts
	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'FAILED');
	assert.ok(entry.recipients.every(r => r.state === 'failed' && r.attempts === 3));
});

test('timeout then success: chat ends sent after a retry', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map(VALID_ENV.QASE_TELEGRAM_CHAT_IDS.split(',').map(chatId => [
		chatId, [Promise.reject(Object.assign(new Error('fetch failed'), { name: 'AbortError' }))]
	]));
	// First attempt rejects with AbortError; default fallback succeeds after.
	const wrapped = {};
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		const queue = scripts.get(String(body.chat_id));
		const next = queue?.shift();
		return next ?? jsonResponse(200, '{"ok":true,"result":{"message_id":7}}');
	};
	fetchImpl.calls = [];
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'SENT');
	assert.ok(entry.recipients.every(r => r.state === 'sent' && r.attempts === 2 && r.messageId === 7));
});

test('auth failure (401) is terminal: no retries, remaining chats unattempted, feedback unaffected', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map([
		['-1001110001111', { next: () => jsonResponse(401, '{"ok":false,"error_code":401,"description":"Unauthorized"}') }]
	]);
	const fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal(fetchImpl.calls.length, 1); // terminal — no 3× hammering
	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'FAILED');
	assert.equal(entry.recipients[0].state, 'failed');
	assert.ok(entry.recipients.slice(1).every(r => r.state === 'pending' || r.state === 'sending'));
	assert.ok(!JSON.stringify(entry).includes(VALID_ENV.QASE_TELEGRAM_BOT_TOKEN));
	// dispatchFeedbackNotification resolved (never rejected).
});

test('rate limiting (429) retries per chat and honors retry_after', async () => {
	const sandbox = makeLedgerSandbox();
	const singleChatEnv = { ...VALID_ENV, QASE_TELEGRAM_CHAT_IDS: '-1001110001111' };
	const sleeps = [];
	const scripts = new Map([
		['-1001110001111', [
			jsonResponse(429, '{"ok":false,"error_code":429,"description":"Too Many Requests","parameters":{"retry_after":3}}'),
			jsonResponse(200, '{"ok":true,"result":{"message_id":42}}')
		]]
	]);
	const fetchImpl = perChatFetch(scripts);
	const notifier = createTelegramNotifier({
		environment: singleChatEnv, fetchImpl, logger: collectingLogger(),
		ledgerFile: sandbox.ledgerFile, sleep: async ms => sleeps.push(ms)
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal(fetchImpl.calls.length, 2);
	assert.deepEqual(sleeps, [3_000]); // retry_after honored, not blind backoff
	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.status, 'SENT');
	assert.equal(entry.recipients[0].messageId, 42);
});

test('per-attempt logs carry chatId, provider, endpoint, messageId — never the token or URL', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map([
		['-1001110001111', [jsonResponse(400, JSON.stringify({ ok: false, error_code: 400, description: `token ${VALID_ENV.QASE_TELEGRAM_BOT_TOKEN} leaked` }))]]
	]);
	const fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	const attempts = logger.entries.info.filter(e => e.event === 'telegram.delivery.attempt');
	const logged = JSON.stringify(attempts);
	assert.ok(!logged.includes(VALID_ENV.QASE_TELEGRAM_BOT_TOKEN), 'token leaked into attempt logs');
	assert.ok(!logged.includes('api.telegram.org/bot'), 'full URL leaked into attempt logs');
	const bad = attempts.find(e => e.fields.chatId === '-1001110001111');
	assert.equal(bad.fields.provider, 'telegram-bot-api');
	assert.equal(bad.fields.endpoint, 'bot<redacted>/sendMessage');
	assert.equal(bad.fields.status, 400);
	assert.equal(bad.fields.errorCode, 'telegram_rejected');
});

test('dispatch never rejects even when fetchImpl throws unexpected junk', async () => {
	const sandbox = makeLedgerSandbox();
	const fetchImpl = () => { throw new Error('junk'); };
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await assert.doesNotReject(() => notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT));
	assert.equal(readLedger(sandbox)[FEEDBACK.id].status, 'FAILED');
});

/* ── Retry API ──────────────────────────────────────────────────── */

test('retryNotification replays a FAILED notification without resending sent chats', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map([
		['-1002220002222', [jsonResponse(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')]]
	]);
	let fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	let notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);
	assert.equal(fetchImpl.calls.length, 4);

	// The chat id is fixed in config — a "fixed" chat now succeeds on retry.
	fetchImpl = perChatFetch(new Map());
	notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	const result = await notifier.retryNotification(`TELEGRAM-${FEEDBACK.id}`);
	assert.equal(result.ok, true);
	assert.equal(fetchImpl.calls.length, 1); // only the failed chat retried
	assert.equal(fetchImpl.calls[0].chatId, '-1002220002222');
	assert.equal(readLedger(sandbox)[FEEDBACK.id].status, 'SENT');
});

test('retry replay snapshot retains the improvement field so retries rebuild the full message', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map([
		['-1002220002222', [jsonResponse(400, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')]]
	]);
	const fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);
	const entry = readLedger(sandbox)[FEEDBACK.id];
	assert.equal(entry.replay.feedback.improvement, FEEDBACK.improvement, 'ledger replay carries improvement');
});

test('retryNotification guards: SENT, in-flight, unknown, non-replayable', async () => {
	const sandbox = makeLedgerSandbox();
	const fetchImpl = perChatFetch(new Map());
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	assert.equal((await notifier.retryNotification(`TELEGRAM-${FEEDBACK.id}`)).reason, 'already_sent');
	assert.equal((await notifier.retryNotification('TELEGRAM-none')).reason, 'not_found');

	const noReplay = {
		[FEEDBACK.id]: {
			notificationId: `TELEGRAM-${FEEDBACK.id}`, feedbackId: FEEDBACK.id, runId: FEEDBACK.runId,
			status: 'FAILED', createdAt: 1, updatedAt: 1,
			recipients: [{ chatId: '-1001110001111', state: 'failed', attempts: 1 }],
			replay: {}
		}
	};
	fs.writeFileSync(sandbox.ledgerFile, JSON.stringify(noReplay));
	const rebuilt = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	assert.equal((await rebuilt.retryNotification(`TELEGRAM-${FEEDBACK.id}`)).reason, 'not_replayable');
});

/* ── Projections ────────────────────────────────────────────────── */

test('listNotifications/getNotification expose sanitized public records', async () => {
	const sandbox = makeLedgerSandbox();
	const fetchImpl = perChatFetch(new Map());
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger: collectingLogger(), ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	const all = notifier.listNotifications();
	assert.equal(all.length, 1);
	assert.equal(all[0].status, 'SENT');
	assert.ok(all[0].recipients.every(r => r.messageId === 1 && r.state === 'sent'));
	assert.ok(!('replay' in all[0]));
	assert.equal(notifier.listNotifications({ status: 'FAILED' }).length, 0);
	assert.equal(notifier.getNotification(`TELEGRAM-${FEEDBACK.id}`).feedbackId, FEEDBACK.id);
	assert.equal(notifier.getNotification('TELEGRAM-missing'), undefined);
});

/* ── Security regression ────────────────────────────────────────── */

test('no credential material appears in logs or ledger, even when upstream echoes it back', async () => {
	const sandbox = makeLedgerSandbox();
	const scripts = new Map(VALID_ENV.QASE_TELEGRAM_CHAT_IDS.split(',').map(chatId => [
		chatId, [jsonResponse(400, JSON.stringify({ ok: false, description: `unauthorized ${VALID_ENV.QASE_TELEGRAM_BOT_TOKEN} second line with ${VALID_ENV.QASE_TELEGRAM_BOT_TOKEN}` }))]
	]));
	const fetchImpl = perChatFetch(scripts);
	const logger = collectingLogger();
	const notifier = createTelegramNotifier({
		environment: VALID_ENV, fetchImpl, logger, ledgerFile: sandbox.ledgerFile, sleep: async () => {}
	});
	await notifier.dispatchFeedbackNotification(FEEDBACK, CONTEXT);

	const everything = `${JSON.stringify(logger.entries)}\n${fs.readFileSync(sandbox.ledgerFile, 'utf8')}`;
	assert.ok(!everything.includes(VALID_ENV.QASE_TELEGRAM_BOT_TOKEN), 'token leaked into logs or ledger');
});

test('TelegramNotificationError carries code, retryability, and upstream status', () => {
	const error = new TelegramNotificationError('boom', { code: 'telegram_rejected', retryable: false, upstreamStatus: 400 });
	assert.equal(error.code, 'telegram_rejected');
	assert.equal(error.retryable, false);
	assert.equal(error.upstreamStatus, 400);
});
