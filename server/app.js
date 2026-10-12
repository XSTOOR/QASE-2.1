import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createInstanceAccess, securityHeaders } from './instanceAccess.js';
import { isDeviceId, DEFAULT_DEVICE_ID, publicDeviceProfile, DEVICE_PROFILES } from './deviceProfiles.js';
import { engineRegistryResolved, isEngineId } from './browserEngines.js';
import { probeTargetReachability } from './targetReachability.js';
import { assertApplicationServices } from './contracts.js';
import { mountDemoSite } from './demoSite.js';
import { createOperationalControls } from './operations.js';
import { runWithRequestActor } from './requestActor.js';
import { authThrottleKey, createAuthThrottle } from './authThrottle.js';
import { sanitizeErrorDetail } from './errorSanitizer.js';
import {
	FOUNDER_CATEGORIES,
	FOUNDER_CAVEAT,
	FOUNDER_LEVELS,
	FOUNDER_OBSERVATION_TYPES,
	FOUNDER_SCHEMA_VERSION
} from './founderSchema.js';
import {
	buildFounderReportMarkdown,
	createFounderReviewTodos,
	createFounderState,
	FOUNDER_PUBLIC_ONLY_ANSWER,
	recordFounderPublicOnlyDecision
} from './founderService.js';
import { buildSqaReportMarkdown } from './sqaAssessment.js';
import { buildFeedbackSectionMarkdown } from './report.js';
import { normalizeQaScopeSelection } from '../public/qaScopeCatalog.js';
import { createConfiguredTelegramNotifier } from './telegramNotifier.js';
import { resolveDisplayTimeZone, formatFeedbackTimestamp } from './displayTime.js';
import { createSqaState, createSqaTodoPlan, publicSqaCatalog, recordReviewerSqaObservation } from './sqaService.js';
import { renderReportPdf } from './reportPdf.js';
import { buildAllFixPromptsMarkdown } from './fixPromptBuilder.js';
import { PublicInputError, publicInput } from './publicErrors.js';
import { recordEvent, summarize, durationBucket } from './analytics.js';
import {
	AuthError,
	clearAuthCookies,
	requestAuthToken,
	requestCookieCsrfToken,
	requestCsrfToken,
	setAuthCookies
} from './auth.js';

function safeErrorResponse(request, response, error, status = 400) {
	if (error instanceof AuthError) {
		return response.status(error.status ?? 400).json({ error: error.message });
	}
	if (error instanceof PublicInputError) {
		return response.status(error.status).json({ error: error.message });
	}
	console.error(`[Qase server ${request.qaseRequestId ?? 'no-request-id'}] sanitized route error:`, error?.code ?? error?.message ?? String(error));
	return response.status(500).json({ error: 'The request could not be completed. Try again.' });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i;

/** Local analytics counters live beside the session store. */
const ANALYTICS_DIR = path.join(process.cwd(), '.qase', 'analytics');

/** Fire-and-forget analytics; a counter failure must never break a request. */
function track(name, dimensions) {
	try { recordEvent(ANALYTICS_DIR, name, { dimensions }); } catch { /* best-effort */ }
}

/** Cohort dimension: pilot users' events carry cohort='pilot'. */
function cohortFor(authRole) {
	return authRole === 'pilot' ? { cohort: 'pilot' } : {};
}

/** Pulls the site under test out of whatever the user typed. */
function extractUrl(text) {
	const match = text.match(URL_PATTERN);
	if (!match) {
		return undefined;
	}
	const raw = match[0].replace(/[.,;:)]+$/, '');
	try {
		return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString();
	} catch {
		return undefined;
	}
}

function readinessPayload(result) {
	if (result === true) return { ready: true };
	if (result === false || result === undefined || result === null) return { ready: false };
	if (typeof result !== 'object') return { ready: false };
	return { ready: result.ready === true };
}

function configuredFrameAncestors(environment) {
	const raw = String(environment.QASE_DRYTIS_EMBED_ORIGIN ?? '').trim();
	if (!raw) return Object.freeze([]);
	let origin;
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== 'https:' || parsed.username || parsed.password
			|| parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.hostname.includes('*')) {
			throw new Error('invalid origin');
		}
		origin = parsed.origin;
	} catch {
		throw new TypeError('QASE_DRYTIS_EMBED_ORIGIN must be one exact HTTPS origin.');
	}
	return Object.freeze([origin]);
}

/**
 * Creates the HTTP application without listening or installing process signal
 * handlers. Startup stays in index.js; tests can provide in-memory services.
 */
export function createApplication(options = {}) {
	const services = assertApplicationServices(options.services);
	const environment = options.environment ?? process.env;
	const isProduction = String(environment.NODE_ENV ?? '').toLowerCase() === 'production';
	const access = options.access ?? createInstanceAccess({
		tenantContext: options.tenantContext ?? services.tenantContext
	});
	const demoEnabled = environment.NODE_ENV !== 'production'
		&& (options.demoEnabled ?? String(environment.QASE_ENABLE_DEMO ?? '').toLowerCase() !== 'false');
	const heartbeatMs = Math.max(1_000, Number(options.sseHeartbeatMs) || 15_000);
	const publicDirectory = options.publicDirectory ?? path.join(here, '..', 'public');
	const operations = options.operations ?? createOperationalControls({ environment });
	const logger = options.logger;
	if (logger !== undefined && typeof logger?.error !== 'function') throw new TypeError('Application logger is invalid.');
	const isDraining = typeof options.isDraining === 'function' ? options.isDraining : () => false;
	const activeTurns = new Set();
	const drytisIntegrationApi = options.drytisIntegrationApi;
	if (drytisIntegrationApi !== undefined && typeof drytisIntegrationApi?.mount !== 'function') {
		throw new TypeError('Drytis integration API must provide mount(app).');
	}
	const drytisDelivery = options.drytisDelivery;
	if (drytisDelivery !== undefined) {
		if ((drytisDelivery.deliveryClient === undefined) !== (drytisDelivery.ticketsTarget === undefined)) {
			throw new TypeError('Drytis delivery client and tickets target must be configured together.');
		}
		if (drytisDelivery.deliveryClient !== undefined
			&& typeof drytisDelivery.deliveryClient?.deliver !== 'function') {
			throw new TypeError('Drytis delivery client must provide deliver().');
		}
	}

	const app = express();
	app.disable('x-powered-by');
	// Telegram feedback notifications: built once, disabled/invalid → undefined.
	// Delivery is fire-and-forget AFTER the record is persisted; feedback
	// storage and reports never depend on it.
	const telegramNotifier = options.telegramNotifier !== undefined
		? options.telegramNotifier
		: createConfiguredTelegramNotifier({
			environment,
			logger: logger ?? { info: () => {}, warn: () => {}, error: () => {} }
		});
	if (telegramNotifier !== undefined && typeof telegramNotifier?.dispatchFeedbackNotification !== 'function') {
		throw new TypeError('Telegram notifier must provide dispatchFeedbackNotification().');
	}
	app.locals.qaseDemoEnabled = demoEnabled;
	app.locals.qaseFrameAncestors = configuredFrameAncestors(environment);
	// Authoritative display timezone for user-facing timestamps (feedback
	// report tab, md/PDF reports, Telegram notifications). One zone for every
	// surface so all renderings of the same submission match exactly.
	const displayTimeZone = resolveDisplayTimeZone(environment);
	app.locals.qaseDisplayTimeZone = displayTimeZone;
	if (options.trustProxy ?? String(environment.QASE_TRUST_PROXY ?? '').toLowerCase() === 'true') {
		app.set('trust proxy', 1);
	}
	app.use(operations.middleware);
	app.use(securityHeaders);

	app.get('/healthz', (_request, response) => {
		response.set('Cache-Control', 'no-store');
		response.json({ status: 'ok' });
	});

	app.get('/readyz', async (_request, response) => {
		response.set('Cache-Control', 'no-store');
		if (isDraining()) {
			response.status(503).json({ status: 'not_ready' });
			return;
		}
		try {
			const readiness = readinessPayload(await services.readiness.check());
			response.status(readiness.ready ? 200 : 503).json({
				status: readiness.ready ? 'ready' : 'not_ready'
			});
		} catch {
			response.status(503).json({ status: 'not_ready' });
		}
	});
	operations.mount(app, { queue: options.executionQueue });
	// The service-to-service data plane authenticates the exact raw request
	// bytes. It must be mounted before any JSON middleware can transform them.
	drytisIntegrationApi?.mount(app);

	app.use(express.json({ limit: '1mb' }));
	app.get('/login', (_request, response) => {
		response.sendFile(path.join(publicDirectory, 'index.html'));
	});
	app.use(express.static(publicDirectory));
	if (demoEnabled) {
		mountDemoSite(app);
	}

	// Drytis owns authentication and routes each user to a dedicated Qase
	// instance. The in-process boundary rejects cross-origin browser API calls
	// and attributes work to the trusted instance owner.
	access.mount(app);
	const authService = services.auth;
	const authRequired = options.authRequired ?? (Boolean(authService)
		&& String(environment.QASE_AUTH_REQUIRED ?? 'true').toLowerCase() !== 'false');
	const safeCookies = request => Boolean(request.secure
		|| String(environment.NODE_ENV ?? '').toLowerCase() === 'production');
	app.use('/api/auth', (_request, response, next) => {
		response.set('Cache-Control', 'no-store');
		next();
	});
	// ── Telegram webhook (mounted BEFORE /api auth + CSRF) ──────────
	// Meta calls back on message lifecycle (sent/delivered/read/failed).
	// GET = subscription verification; POST = status payloads. Both must be
	// reachable without QASE session auth; Meta never holds our session
	// cookies, so /api gating would reject it.
	const telegramWebhookSecretToken = String(environment.QASE_TELEGRAM_WEBHOOK_SECRET ?? '').trim();
	// ── Telegram webhook (mounted BEFORE /api auth + CSRF) ──────────
	// Telegram delivers updates to configured webhooks. QASE does not use
	// Telegram as an inbound channel, so the endpoint only verifies it is
	// reachable and acknowledges; nothing triggers notifications here.
	// A shared secret (set via BotFather / setWebhook secret_token) keeps
	// outsiders from probing: unauthenticated POSTs are simply dropped.
	app.post('/webhooks/telegram', (request, response) => {
		// Always answer 200 quickly: Telegram retries non-200 aggressively
		// and we must never leak internals into the response body.
		response.status(200).send('OK');
		if (!telegramWebhookSecretToken) return;
		const header = request.headers['x-telegram-bot-api-secret-token'];
		if (header !== telegramWebhookSecretToken) return;
		// No inbound commands are implemented; acknowledged and ignored.
	});

	app.use('/api', (request, response, next) => {
		const publicAuthRoute = request.path === '/auth/register' || request.path === '/auth/login' || request.path === '/pilot-status';
		if (!authService || !authRequired || publicAuthRoute) {
			return runWithRequestActor({ ...request.auth, requestId: request.qaseRequestId }, next);
		}
		void (async () => {
			const identity = await authService.authenticate(requestAuthToken(request));
			if (!identity) {
				response.status(401).json({ error: 'Authentication required.' });
				return;
			}
			if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
				const headerToken = requestCsrfToken(request);
				const cookieToken = requestCookieCsrfToken(request);
				if (!headerToken || !cookieToken || headerToken !== cookieToken) {
					response.status(403).json({ error: 'A valid CSRF token is required.' });
					return;
				}
			}
			request.auth = { ...request.auth, ...identity };
			runWithRequestActor({ ...request.auth, requestId: request.qaseRequestId }, next);
		})().catch(next);
	});

	function authFailure(response, error) {
		const status = error instanceof AuthError ? error.status : 500;
		response.status(status).json({ error: error instanceof AuthError ? error.message : 'Authentication is temporarily unavailable. Please try again.' });
	}

	// Operator endpoints: pilot-role users (invite-admitted beta users) are
	// excluded; owner/admin/developer are trusted on this single-tenant
	// instance where the bootstrap developer IS the operator.
	function requireOperator(request, response) {
		if (request.auth?.role === 'pilot') {
			response.status(403).json({ error: 'This action is limited to instance operators.' });
			return false;
		}
		return true;
	}

	app.get('/api/pilot-status', (_request, response) => {
		response.json({ pilot: String(environment.QASE_PILOT_MODE ?? '') === 'true' });
	});
	const fallbackAuthThrottle = createAuthThrottle();
	app.use('/api/auth', async (request, response, next) => {
		if (request.method !== 'POST' || !['/login', '/register', '/password'].includes(request.path)) return next();
		const consume = authService?.consumeAuthAttempt ?? fallbackAuthThrottle;
		try {
			const ipAllowed = await consume(authThrottleKey(`ip:${request.ip}`), 40);
			// instanceAccess pre-populates request.auth with the instance owner for
			// every /api route, so request.auth.userId would throttle ALL accounts
			// as one. The submitted email is the real per-account key.
			const submittedEmail = String(request.body?.email ?? '').trim().toLowerCase();
			const accountKey = submittedEmail || 'no-email';
			const accountAllowed = await consume(authThrottleKey(`account:${accountKey}`), 10);
			if (!ipAllowed || !accountAllowed) { response.set('Retry-After', '900').status(429).json({ error: 'Too many attempts. Please try again in 15 minutes.' }); return; }
			next();
		} catch (error) { authFailure(response, error); }
	});

	app.post('/api/auth/register', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		// Registration is open in dev/pilot instances, but a production instance
		// must opt in explicitly — open registration plus a shared env model key
		// would let anyone reach the instance's paid endpoint. A valid unused
		// invite code is the third state: one operator-minted code admits
		// exactly one pilot user while registration stays closed to everyone else.
		const registrationOpen = String(environment.QASE_OPEN_REGISTRATION ?? '') === 'true';
		let invited = false;
		const inviteService = options.inviteService;
		const inviteCode = request.body?.inviteCode;
		const inviteRequired = authRequired && isProduction && !registrationOpen;
		if (inviteRequired && !inviteService) {
			response.status(403).json({ error: 'Registration is closed on this instance. Ask the operator for an account.' });
			return;
		}
		if (inviteRequired && (typeof inviteCode !== 'string' || inviteCode.trim() === '')) {
			response.status(403).json({ error: 'Registration is invite-only on this instance. Enter an invite code.' });
			return;
		}
		// Validate the code up front (so closed mode rejects invalid codes with
		// a uniform 403 before any account work), but only CONSUME it after
		// registration succeeds — a failed registration (weak password, dupe
		// email, throttle) must not burn the operator's invite.
		if (inviteCode !== undefined && String(inviteCode).trim() !== '') {
			try {
				await inviteService.validate(inviteCode);
				invited = true;
			} catch (error) {
				if (inviteRequired) {
					// Uniform 403 for invalid, expired and used codes — no oracle.
					response.status(403).json({ error: 'Registration is invite-only on this instance. Enter a valid invite code.' });
					return;
				}
				invited = false;
			}
		}
		try {
			const result = await authService.register({ ...(request.body ?? {}), ...(invited ? { role: 'pilot' } : {}) });
			if (invited) {
				// Only now is the admission final — mark the code used with the
				// registrant's email. On a race (someone else consumed it in the
				// validation window) we keep the account but log the anomaly.
				try {
					await inviteService.consume(inviteCode, String(request.body?.email ?? '').trim().toLowerCase());
				} catch (error) {
					options.logger?.error?.('invite consumption failed after registration', { error: error instanceof Error ? error.message : String(error) });
				}
			}
			setAuthCookies(response, result.token, result.csrf, { secure: safeCookies(request) });
			response.status(201).json(result.user);
		} catch (error) { authFailure(response, error); }
	});

	app.post('/api/auth/login', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			const result = await authService.login(request.body ?? {});
			setAuthCookies(response, result.token, result.csrf, { secure: safeCookies(request) });
			response.json(result.user);
		} catch (error) { authFailure(response, error); }
	});

	app.get('/api/auth/me', async (request, response) => {
		if (!authService) { response.json(request.auth); return; }
		if (!authRequired) { response.json(request.auth); return; }
		const identity = await authService.authenticate(requestAuthToken(request));
		if (!identity) { response.status(401).json({ error: 'Authentication required.' }); return; }
		response.json(await authService.profile(identity.userId));
	});

	app.post('/api/auth/logout', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try { await authService?.logout(requestAuthToken(request)); } finally { clearAuthCookies(response, { secure: safeCookies(request) }); }
		response.status(204).end();
	});
	app.post('/api/auth/password', async (request, response) => {
		if (!authService?.changePassword) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			await authService.changePassword(request.auth.userId, request.body ?? {});
			clearAuthCookies(response, { secure: safeCookies(request) });
			response.status(204).end();
		} catch (error) { authFailure(response, error); }
	});

	app.get('/api/profile', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		response.json(await authService.profile(request.auth.userId));
	});

	app.put('/api/profile', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try { response.json(await authService.updateProfile(request.auth.userId, request.body ?? {})); }
		catch (error) { authFailure(response, error); }
	});

	app.get('/api/memory', async (request, response) => {
		if (!authService) { response.json([]); return; }
		response.json(await authService.listMemory(request.auth.userId));
	});

	app.put('/api/memory', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try { response.status(201).json(await authService.putMemory(request.auth.userId, request.body ?? {})); }
		catch (error) { authFailure(response, error); }
	});

	app.delete('/api/memory/:id', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try { response.json({ deleted: await authService.deleteMemory(request.auth.userId, request.params.id) }); }
		catch (error) { authFailure(response, error); }
	});

	async function requireSession(request, response) {
		const session = await services.runs.get(request.params.id);
		if (!session) {
			response.status(404).json({ error: 'No such session.' });
			return undefined;
		}
		if (authService && request.auth?.userId) {
			session.userMemory = await authService.listMemory(request.auth.userId);
		}
		return session;
	}

	/**
	 * Attaches the requesting user's feedback for this run (reports embed the
	 * submitter's own record; nothing from other runs or users leaks in).
	 */
	async function attachUserFeedback(session, userId) {
		if (!services.feedback || !session?.id) return session;
		try {
			const record = await services.feedback.forRun(session.id, userId ?? null);
			if (record) {
				if (userId && authService?.profile) {
					try {
						const submitter = await authService.profile(userId);
						record.userName = submitter?.displayName || submitter?.email?.split('@')[0];
					} catch { /* display name is best-effort */ }
				}
			}
			session.userFeedback = record ? decorateFeedbackRecord(record) : undefined;
		} catch {
			session.userFeedback = undefined;
		}
		return session;
	}

	/** Runs a turn detached: HTTP returns immediately and progress arrives by SSE. */
	function startTurn(session, turnOptions) {
		let turn;
		try {
			turn = Promise.resolve(services.agent.runTurn(session, turnOptions));
		} catch (error) {
			turn = Promise.reject(error);
		}
		const tracked = turn.catch(async error => {
			const message = sanitizeErrorDetail(error);
			try {
				await services.runs.addMessage(session, { role: 'system', text: message, kind: 'error' });
				await services.runs.setStatus(session, 'error', message);
			} catch {
				console.error('[Qase persistence] Could not record the failed agent turn.');
			}
		});
		activeTurns.add(tracked);
		void tracked.finally(() => activeTurns.delete(tracked));
		return tracked;
	}

	app.get('/api/config', async (_request, response) => {
		response.json(await services.configuration.getPublic());
	});

	app.get('/api/sqa/catalog', (_request, response) => {
		response.set('Cache-Control', 'private, max-age=300');
		response.json(publicSqaCatalog());
	});

	app.get('/api/founder/catalog', (_request, response) => {
		response.set('Cache-Control', 'private, max-age=300');
		response.json({
			schemaVersion: FOUNDER_SCHEMA_VERSION,
			categories: FOUNDER_CATEGORIES,
			observationTypes: FOUNDER_OBSERVATION_TYPES,
			confidenceLevels: FOUNDER_LEVELS,
			caveat: FOUNDER_CAVEAT
		});
	});

	app.put('/api/config', async (request, response) => {
		try {
			const config = await services.configuration.save(request.body ?? {});
			const kept = await services.agent.invalidateIdleRuntimes();
			response.json({ ...config, runsKeepingOldSettings: kept });
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	app.post('/api/config/test', async (request, response) => {
		response.json(await services.configuration.testConnection(request.body ?? {}));
	});

	app.get('/api/devices', (_request, response) => {
		response.json({
			default: DEFAULT_DEVICE_ID,
			devices: DEVICE_PROFILES.map(profile => publicDeviceProfile(profile.id))
		});
	});

	app.get('/api/engines', async (_request, response) => {
		response.json({
			default: 'chromium',
			engines: await engineRegistryResolved()
		});
	});

	app.get('/api/sessions', async (request, response) => {
		const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			response.status(400).json({ error: 'limit must be an integer from 1 through 100.' });
			return;
		}
		response.json(await services.runs.list({ limit }));
	});

	// Test Execution Timer analytics. Computed server-side from stored run
	// timestamps; falls back to an empty aggregate when the repository does
	// not support analytics (in-memory store).
	app.get('/api/analytics/durations', async (request, response) => {
		const targetUrl = typeof request.query.targetUrl === 'string' && request.query.targetUrl.trim() !== ''
			? request.query.targetUrl.trim()
			: undefined;
		if (typeof services.runs.durationAnalytics !== 'function') {
			response.json({ runCount: 0, byTarget: [] });
			return;
		}
		response.json(await services.runs.durationAnalytics({ targetUrl }));
	});

	app.get('/api/analytics/targets/durations', async (request, response) => {
		const targetUrl = typeof request.query.targetUrl === 'string' ? request.query.targetUrl.trim() : '';
		if (targetUrl === '') {
			response.status(400).json({ error: 'targetUrl query parameter is required.' });
			return;
		}
		if (typeof services.runs.targetDurationHistory !== 'function') {
			response.json([]);
			return;
		}
		response.json(await services.runs.targetDurationHistory(targetUrl));
	});

	/* ── User feedback on test runs ───────────────────────────── */

	/** Public base URL used in Telegram message deep links back to the run report. */
	const telegramQaseUrl = (() => {
		const raw = String(environment.QASE_PUBLIC_URL ?? '').trim();
		return raw === '' ? undefined : raw;
	})();
	/** How long POST /api/feedback may WAIT for the Telegram dispatch result. */
	const telegramResultTimeoutMs = (() => {
		const parsed = Number(environment.QASE_TELEGRAM_RESULT_TIMEOUT_MS);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : 10_000;
	})();

	/** Response projection of a notification record — sanitized, no replay data. */
	function telegramProjection(notification) {
		const status = notification?.status;
		const message = status === 'FAILED'
			? 'Feedback saved, but the Telegram notification failed.'
			: status === 'PENDING' || status === 'SENDING'
				? 'Feedback saved, but the Telegram notification result is pending.'
				: undefined;
		return {
			status,
			...(message ? { message } : {}),
			recipients: (notification?.recipients ?? []).map(recipient => ({
				chatId: recipient.chatId,
				state: recipient.state,
				attempts: recipient.attempts,
				...(recipient.messageId ? { messageId: recipient.messageId } : {}),
				...(recipient.errorCode ? { errorCode: recipient.errorCode } : {}),
				...(recipient.lastError ? { lastError: recipient.lastError } : {})
			}))
		};
	}

	const feedbackService = () => {
		if (!services.feedback) {
			response.status(501).json({ error: 'Feedback is not available on this instance.' });
			return undefined;
		}
		return services.feedback;
	};

	function requireFeedbackAdmin(request, response) {
		if (request.auth?.role && !['owner', 'admin'].includes(request.auth.role)) {
			response.status(403).json({ error: 'Feedback review requires an owner or administrator.' });
			return false;
		}
		return true;
	}

	/** Attach the server-rendered, system-timezone formatted submission
	 *  timestamp so every client (report tab, admin panel) displays the SAME
	 *  string the Telegram notification and md/PDF reports use — no
	 *  browser-local re-formatting that could drift from QASE. */
	function decorateFeedbackRecord(record) {
		if (!record || typeof record !== 'object') return record;
		return {
			...record,
			submittedAtFormatted: Number.isFinite(record.submittedAt)
				? formatFeedbackTimestamp(record.submittedAt, displayTimeZone)
				: '—'
		};
	}

	app.post('/api/feedback', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		const runId = typeof request.body?.runId === 'string' ? request.body.runId.trim() : '';
		if (runId === '') {
			response.status(400).json({ error: 'runId is required.' });
			return;
		}
		const session = await services.runs.get(runId);
		if (!session) {
			response.status(404).json({ error: 'No such test run.' });
			return;
		}
		// Feedback exists for finished runs — both successes and failures —
		// never mid-execution.
		if (!['done', 'error'].includes(session.status)) {
			response.status(409).json({ error: 'Feedback is available once the test run has finished.' });
			return;
		}
		const pausedSeconds = Number.isFinite(session.pausedSeconds) ? session.pausedSeconds : 0;
		const durationSeconds = session.startedAt === undefined ? undefined : Math.max(
			0,
			Math.floor(
				((session.pausedAt ?? session.completedAt ?? Date.now()) - session.startedAt) / 1000
				- pausedSeconds
			)
		);
		try {
			const record = await feedback.create({
				runId,
				submittedBy: request.auth?.userId ?? null,
				context: {
					targetUrl: session.targetUrl,
					runStatus: session.status,
					durationSeconds
				},
				rating: request.body?.rating,
				category: request.body?.category,
				comments: request.body?.comments,
				improvement: request.body?.improvement
			});
			// Notify AFTER the record is durably stored. The dispatch is
			// bounded by an await-with-timeout so the response truthfully
			// reports {feedbackSaved, telegramSent} from real provider
			// results — but a stuck/slow provider can never hang feedback:
			// the dispatch itself keeps running detached, only the await
			// gives up. A dispatch failure is logged by the notifier and
			// never fails this request.
			let telegram;
			if (telegramNotifier && record?.id) {
				// Authoritative metadata only — no second timestamp read, no
				// frontend-supplied or default identity: the name comes from
				// the authenticated session's user record (same source QASE's
				// UI renders), the timestamp from the stored feedback record.
				const dispatched = Promise.resolve(telegramNotifier.dispatchFeedbackNotification(record, {
					mode: session.mode,
					title: session.title,
					targetUrl: session.targetUrl,
					qaseUrl: telegramQaseUrl,
					submittedByName: request.auth?.displayName ?? request.auth?.email,
					submittedAt: record.submittedAt,
					// System display timezone (QASE_DISPLAY_TIMEZONE, default
					// Asia/Kolkata) — the SAME zone QASE renders timestamps in,
					// so Telegram matches QASE regardless of the submitter's
					// profile default (UTC) or their browser zone.
					submittedAtTimeZone: displayTimeZone
				}));
				// Await with a strict timeout (default 10s): PENDING result on
				// expiry, feedback still saved, dispatch continues detached.
				telegram = await new Promise(resolve => {
					const timer = setTimeout(() => resolve(undefined), telegramResultTimeoutMs);
					if (typeof timer?.unref === 'function') timer.unref();
					dispatched.then(
						() => { clearTimeout(timer); resolve(telegramNotifier.getNotification?.(record.id)); },
						() => { clearTimeout(timer); resolve(telegramNotifier.getNotification?.(record.id)); }
					);
				}).then(notification => notification ?? { status: 'PENDING' });
			}
			response.status(201).json({
				...record,
				feedbackSaved: true,
				telegramSent: Boolean(telegram?.status === 'SENT'),
				...(telegram ? { telegram: telegramProjection(telegram) } : {})
			});
		} catch (error) {
			if (error?.code === 'duplicate_feedback') {
				response.status(409).json({ error: 'Feedback already exists for this test run.', existingId: error.existingId });
				return;
			}
			if (error?.code === 'invalid_input') {
				response.status(400).json({ error: 'Feedback validation failed.', fields: error.fields });
				return;
			}
			throw error;
		}
	});

	// The submitter's own feedback for a run — powers the completion UI's
	// "edit your feedback" mode and the already-submitted state.
	app.get('/api/sessions/:id/feedback', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		const session = await requireSession(request, response);
		if (!session) return;
		const record = await feedback.forRun(session.id, request.auth?.userId ?? null);
		response.json(record ? decorateFeedbackRecord(record) : null);
	});

	app.get('/api/feedback/stats', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		if (!requireFeedbackAdmin(request, response)) return;
		response.json(await feedback.stats());
	});

	// Telegram notification status — admin visibility into delivery attempts.
	// Contract note: 'SENT' means the Telegram Bot API ACCEPTED the message
	// (message_id returned) for that chat; group delivery beyond acceptance
	// is not tracked.
	app.get('/api/feedback/notifications', (request, response) => {
		if (!requireFeedbackAdmin(request, response)) return;
		if (!telegramNotifier?.listNotifications) {
			response.status(200).json({ enabled: false, notifications: [], note: 'Telegram notifications are not enabled in this environment.' });
			return;
		}
		const q = request.query;
		const notifications = telegramNotifier.listNotifications({
			status: typeof q.status === 'string' && q.status.trim() !== '' ? q.status.trim().toUpperCase() : undefined,
			feedbackId: typeof q.feedbackId === 'string' && q.feedbackId.trim() !== '' ? q.feedbackId.trim() : undefined
		});
		response.json({ enabled: true, notifications, note: "status 'SENT' reflects Telegram API acceptance." });
	});

	// Retry a FAILED notification — replays only chats not yet accepted.
	app.post('/api/feedback/notifications/:id/retry', async (request, response) => {
		if (!requireFeedbackAdmin(request, response)) return;
		if (!telegramNotifier?.retryNotification) {
			response.status(501).json({ error: 'Telegram notifications are not enabled in this environment.' });
			return;
		}
		const result = await telegramNotifier.retryNotification(String(request.params.id ?? ''));
		if (!result.ok) {
			const statusByReason = { not_found: 404, already_sent: 409, in_progress: 409, not_replayable: 409 };
			const status = statusByReason[result.reason] ?? 400;
			const messageByReason = {
				not_found: 'No such notification.',
				already_sent: 'Notification already sent to all chats.',
				in_progress: 'Notification dispatch is already in progress.',
				not_replayable: 'Notification cannot be replayed (missing stored feedback).'
			};
			response.status(status).json({ error: messageByReason[result.reason] ?? 'Retry not allowed.', reason: result.reason });
			return;
		}
		response.json({ ...result.notification, note: "status 'SENT' reflects Telegram API acceptance." });
	});

	app.get('/api/feedback', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		if (!requireFeedbackAdmin(request, response)) return;
		const q = request.query;
		const rating = /^\d+$/.test(String(q.rating ?? '')) ? Number(q.rating) : undefined;
		const since = /^\d+$/.test(String(q.since ?? '')) ? Number(q.since) : undefined;
		const until = /^\d+$/.test(String(q.until ?? '')) ? Number(q.until) : undefined;
		const rows = await feedback.list({
			runId: typeof q.runId === 'string' && q.runId.trim() !== '' ? q.runId.trim() : undefined,
			targetUrl: typeof q.targetUrl === 'string' && q.targetUrl.trim() !== '' ? q.targetUrl.trim() : undefined,
			rating,
			category: typeof q.category === 'string' && q.category.trim() !== '' ? q.category.trim() : undefined,
			status: typeof q.status === 'string' && q.status.trim() !== '' ? q.status.trim() : undefined,
			since,
			until,
			q: typeof q.q === 'string' && q.q.trim() !== '' ? q.q.trim() : undefined,
			limit: /^\d+$/.test(String(q.limit ?? '')) ? Number(q.limit) : undefined
		});
		response.json(rows.map(row => decorateFeedbackRecord(row)));
	});

	app.get('/api/feedback/mine', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		// The submitter's own feedback across runs — powers run-list badges.
		const runs = String(request.query.runs ?? '')
			.split(',')
			.map(id => id.trim())
			.filter(Boolean)
			.slice(0, 100);
		const all = await feedback.list({
			submittedBy: request.auth?.userId ?? null,
			limit: 500
		});
		const decorated = all.map(row => decorateFeedbackRecord(row));
		response.json(runs.length === 0 ? decorated : decorated.filter(record => runs.includes(record.runId)));
	});

	app.get('/api/feedback/:id', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		if (!requireFeedbackAdmin(request, response)) return;
		const record = await feedback.get(request.params.id);
		if (!record) {
			response.status(404).json({ error: 'No such feedback.' });
			return;
		}
		// Trace back to the execution: include the run summary, never secrets.
		const session = await services.runs.get(record.runId);
		response.json({
			...decorateFeedbackRecord(record),
			run: session ? {
				id: session.id,
				title: session.title,
				status: session.status,
				targetUrl: session.targetUrl,
				startedAt: session.startedAt,
				completedAt: session.completedAt,
				findingCount: Array.isArray(session.findings) ? session.findings.length : 0
			} : undefined
		});
	});

	app.put('/api/feedback/:id', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		// Two authorizations share this route: an owner/admin may change the
		// review status AND content; the submitter may edit their OWN content
		// (rating/category/comments/improvement) but never a review status.
		const identity = request.auth;
		const isAdmin = !identity?.role || ['owner', 'admin'].includes(identity.role);
		if (!isAdmin) {
			const existing = await feedback.get(request.params.id);
			if (!existing) {
				response.status(404).json({ error: 'No such feedback.' });
				return;
			}
			if (existing.submittedBy !== identity?.userId) {
				response.status(403).json({ error: 'You can only edit your own feedback.' });
				return;
			}
			if (request.body?.status !== undefined) {
				response.status(403).json({ error: 'Review status can only be changed by an owner or administrator.' });
				return;
			}
		}
		try {
			const record = await feedback.update(request.params.id, {
				status: isAdmin ? request.body?.status : undefined,
				rating: request.body?.rating,
				category: request.body?.category,
				comments: request.body?.comments,
				improvement: request.body?.improvement
			});
			response.json(decorateFeedbackRecord(record));
		} catch (error) {
			if (error?.code === 'not_found') {
				response.status(404).json({ error: 'No such feedback.' });
				return;
			}
			if (error?.code === 'invalid_input') {
				response.status(400).json({ error: 'Feedback validation failed.', fields: error.fields });
				return;
			}
			throw error;
		}
	});

	app.delete('/api/feedback/:id', async (request, response) => {
		const feedback = feedbackService();
		if (!feedback) return;
		if (!requireFeedbackAdmin(request, response)) return;
		const removed = await feedback.remove(request.params.id);
		if (!removed) {
			response.status(404).json({ error: 'No such feedback.' });
			return;
		}
		response.status(204).end();
	});

	app.post('/api/sessions', async (request, response) => {
		const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
		const deviceLandscape = request.body?.deviceLandscape === true;
		const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
		const cohort = cohortFor(request.auth?.role).cohort;
		const scopeSelection = normalizeQaScopeSelection(request.body?.scopeSelection);
		const session = await services.runs.create(engine === 'chromium' ? undefined : `QA — ${engine}`, { device, deviceLandscape, engine, ownerUserId: request.auth?.userId, cohort, scopeSelection });
		track('run_created', { mode: session.mode, ...cohortFor(request.auth?.role) });
		response.status(201).json(session);
	});

	app.post('/api/sqa/sessions', async (request, response) => {
		let session;
		try {
			const sqa = publicInput(() => createSqaState(request.body ?? {}));
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
			session = await services.runs.create(`SQA — ${sqa.scope.target.name}`, { device, deviceLandscape, engine, ownerUserId: request.auth?.userId, cohort: cohortFor(request.auth?.role).cohort });
			session.mode = 'sqa';
			session.sqa = sqa;
			session.todos = createSqaTodoPlan(sqa);
			session.device = device;
			session.deviceLandscape = deviceLandscape;
			// Persist the host-owned assessment plan before the metadata-only SQA
			// creation event so PostgreSQL and local mode expose identical progress.
			await services.runs.commit(session, 'todos', { todos: session.todos });
			await services.runs.commit(session, 'sqa.created', {
				catalogVersion: sqa.scope.catalogVersion,
				profiles: sqa.scope.profiles,
				attributes: sqa.scope.attributes
			});
			response.status(201).json(session);
		} catch (error) {
			if (session) await services.runs.delete(session.id).catch(() => undefined);
			safeErrorResponse(request, response, error);
		}
	});

	app.post('/api/founder/sessions', async (request, response) => {
		let session;
		try {
			// Tenant and actor identity always come from trusted per-instance
			// context. Only the explicit Founder review scope crosses this boundary.
			const founder = publicInput(() => createFounderState({
				authorizationConfirmed: request.body?.authorizationConfirmed,
				target: request.body?.target,
				productContext: request.body?.productContext
			}));
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
			session = await services.runs.create(`Founder — ${founder.scope.target.name}`, { device, deviceLandscape, engine, ownerUserId: request.auth?.userId, cohort: cohortFor(request.auth?.role).cohort });
			session.mode = 'founder';
			session.founder = founder;
			session.todos = createFounderReviewTodos();
			session.device = device;
			session.deviceLandscape = deviceLandscape;
			// `founder.created` intentionally skips relational child rewrites in the
			// PostgreSQL repository. Persist the host-owned plan explicitly first so
			// progress is visible before the model's first update_todo call.
			await services.runs.commit(session, 'todos', { todos: session.todos });
			await services.runs.commit(session, 'founder.created', {
				schemaVersion: founder.schemaVersion,
				categories: founder.scope.categories,
				authorizedTargetUrl: founder.scope.target.url
			});
			response.status(201).json(session);
		} catch (error) {
			if (session) await services.runs.delete(session.id).catch(() => undefined);
			safeErrorResponse(request, response, error);
		}
	});

	app.get('/api/sessions/:id', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const liveState = services.agent.getLiveState(session.id);
		// Active (pause-excluded) seconds, server-authoritative: a paused run
		// freezes at the pause point instead of reporting undefined.
		const pausedSeconds = Number.isFinite(session.pausedSeconds) ? session.pausedSeconds : 0;
		const durationSeconds = session.startedAt === undefined ? undefined : Math.max(
			0,
			Math.floor(
				((session.pausedAt ?? session.completedAt ?? Date.now()) - session.startedAt) / 1000
				- pausedSeconds
			)
		);
		response.json({
			...session,
			durationSeconds,
			secretNames: await services.secrets.names(session.id),
			running: liveState.running,
			frame: liveState.frame,
			// Server-authoritative clock sample: the client computes elapsed
			// timer time from this skew, never from its own render time.
			serverNow: Date.now()
		});
	});

	app.post('/api/sessions/:id/sqa/observations', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (session.mode !== 'sqa') {
			response.status(409).json({ error: 'This run is not an SQA assessment.' });
			return;
		}
		if (request.auth?.role && !['owner', 'admin'].includes(request.auth.role)) {
			response.status(403).json({ error: 'SQA evidence review requires an owner or administrator.' });
			return;
		}
		try {
			const result = await recordReviewerSqaObservation(
				session,
				request.body ?? {},
				request.auth ?? {},
				services.runs
			);
			response.json({ result, assessment: session.sqa.assessment });
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	app.get('/api/findings', async (request, response) => {
		try {
			const rawLimit = Number(request.query.limit);
			const findings = await services.runs.aggregateFindings({
				status: request.query.status,
				severity: request.query.severity,
				runId: request.query.run,
				search: request.query.q,
				limit: Number.isSafeInteger(rawLimit) ? rawLimit : undefined
			});
			response.json({ findings, serverNow: Date.now() });
		} catch (error) {
			if (error?.code === 'QASE_FINDING_STATUS_INVALID' || error?.code === 'QASE_FINDING_SEVERITY_INVALID') {
				return response.status(400).json({ error: error.message });
			}
			safeErrorResponse(request, response, error);
		}
	});

	app.patch('/api/sessions/:id/findings/:findingId', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		// Any authenticated user may track bugs on runs they own;
		// requireSession already scopes access to the requesting owner.
		try {
			const finding = await services.runs.setFindingStatus(session, request.params.findingId, {
				status: request.body?.status,
				note: request.body?.note
			});
			response.json({ ok: true, finding });
		} catch (error) {
			if (error?.code === 'QASE_FINDING_NOT_FOUND') {
				return response.status(404).json({ error: 'That bug does not exist on this run.' });
			}
			if (error?.code === 'QASE_FINDING_STATUS_INVALID') {
				return response.status(400).json({ error: error.message });
			}
			safeErrorResponse(request, response, error);
		}
	});

	app.delete('/api/sessions/:id', async (request, response) => {
		const session = await services.runs.get(request.params.id);
		if (!session) {
			response.json({ deleted: false });
			return;
		}
		if (services.agent.isRemote) await services.agent.stop(session.id);
		const deleted = await services.runs.delete(session.id);
		if (deleted) {
			const cleanup = await Promise.allSettled([
				Promise.resolve().then(() => services.secrets.clear(session.id)),
				Promise.resolve().then(() => services.agent.purgeArtifacts?.(session.id))
			]);
			const failed = cleanup
				.map((result, index) => result.status === 'rejected' ? index : -1)
				.filter(index => index >= 0);
			const deferred = services.agent.cleanupDeferred === true && failed.length === 0;
			if (!deferred && typeof services.runs.recordCleanup === 'function') {
				const errorCode = failed.length > 1
					? 'multiple_cleanup_failures'
					: failed[0] === 0 ? 'secret_clear_failed' : 'artifact_purge_failed';
				try {
					const referenceId = request.qaseRequestId
						? `request/${request.qaseRequestId}`
						: undefined;
					const attribution = referenceId ? { referenceId } : {};
					await services.runs.recordCleanup(session.id, failed.length > 0
						? { status: 'failed', errorCode, actorType: 'system', ...attribution }
						: { status: 'completed', actorType: 'system', ...attribution });
				} catch (error) {
					if (logger) logger.error('run.cleanup.attestation_failed', {
						requestId: request.qaseRequestId,
						errorName: error?.name ?? 'Error'
					});
					else console.error(`[Qase cleanup ${request.qaseRequestId ?? 'no-request-id'}] attestation failed`);
				}
			}
		}
		response.json({ deleted });
	});

	/** A URL starts a run; any other chat message steers the current one. */
	app.post('/api/sessions/:id/message', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const text = String(request.body?.text ?? '').trim();
		if (!text) {
			response.status(400).json({ error: 'Message is empty.' });
			return;
		}
		if (session.status === 'running' || services.agent.getLiveState(session.id).running) {
			response.status(409).json({ error: 'The agent is still working. Stop it before sending another instruction.' });
			return;
		}

		const url = extractUrl(text);
		if (session.mode === 'founder' && !session.targetUrl && !url) {
			response.status(400).json({ error: 'Founder Mode needs a target URL before the review can start.' });
			return;
		}
		if (session.mode === 'founder' && !session.targetUrl && url && session.founder?.scope?.target?.url) {
			const authorizedTargetUrl = new URL(session.founder.scope.target.url).toString();
			if (url !== authorizedTargetUrl) {
				response.status(400).json({ error: 'The requested URL does not match the authorized Founder Mode target.' });
				return;
			}
		}
		await services.runs.addMessage(session, { role: 'user', text });
		if (url && !session.targetUrl) {
			session.targetUrl = url;
			// Keep the engine tag when the host-based default title replaces it later.
			const engineSuffix = isEngineId(session.engine) && session.engine !== 'chromium' ? ` (${session.engine})` : '';
			session.title = `${new URL(url).host}${engineSuffix}`;
			if (session.mode === 'founder' && session.founder?.scope?.target) {
				session.founder.scope.target.url = url;
				session.founder.updatedAt = new Date().toISOString();
			}

			// Environmental pre-flight: detect split-horizon DNS (the run
			// container resolving a public hostname, or a name in its CNAME
			// chain, to a private endpoint with a mismatched certificate)
			// BEFORE the agent navigates. Without this, a browser that lands
			// on the internal endpoint reports a certificate error and the
			// run concludes "site unreachable" with a false CRITICAL —
			// observed for www.drytis.com behind a public CNAME pointing at
			// internal infrastructure. The note tells the agent (and the
			// report reader) that any TLS/connect failure for this host is
			// the environment's, not the site's.
			try {
				const probe = await probeTargetReachability(url);
				if (!probe.ok && probe.unreachable) {
					await services.runs.addMessage(session, {
						role: 'system',
						text: `Pre-flight check: ${url} is not reachable from this environment (${probe.reason}). If every navigation attempt fails, record the run as blocked by network conditions rather than filing a site-unreachable defect, unless you can independently verify the site is down for the public internet.`,
						kind: 'warning'
					});
				} else if (probe.note === 'split-horizon-dns') {
					session.environmentNotes = [
						...(session.environmentNotes ?? []),
						{ host: new URL(url).hostname, note: 'split-horizon-dns', detail: probe.detail, ts: Date.now() }
					];
					await services.runs.addMessage(session, {
						role: 'system',
						text: `Environment note: ${probe.detail} If a browser shows a certificate error or connection failure for this host, treat it as an environmental limitation, do not file it as a site defect, and state the limitation in the final report.`,
						kind: 'warning'
					});
				}
			} catch { /* pre-flight must never block a run */ }

			await services.runs.commit(
				session,
				session.mode === 'founder' ? 'founder.target_bound' : 'session',
				{
					targetUrl: url,
					title: session.title,
					...(session.mode === 'founder' ? { authorizedTargetUrl: url } : {})
				}
			);
		}

		try {
			services.agent.ensureRuntime(session);
		} catch (error) {
			const message = sanitizeErrorDetail(error);
			await services.runs.addMessage(session, { role: 'system', text: message, kind: 'error' });
			await services.runs.setStatus(session, 'error', message);
			response.status(500).json({ error: message });
			return;
		}

		const pending = session.pendingQuestion;
		startTurn(session, pending ? { resumeAnswer: text } : { task: text });
		if (!pending) {
			// Launcher hypothesis: do users deselect scope options or hit select-all?
			const scopeSelection = /focusing on:/i.test(text) ? 'focused' : 'default';
			track('run_launched', { mode: session.mode, scope_selection: scopeSelection, ...cohortFor(request.auth?.role) });
		}
		response.json({ ok: true });
	});

	app.post('/api/sessions/:id/answer', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (!session.pendingQuestion) {
			response.status(409).json({ error: 'Nothing is waiting on an answer.' });
			return;
		}
		let answer = String(request.body?.answer ?? '').trim();
		if (!answer) {
			response.status(400).json({ error: 'Answer is empty.' });
			return;
		}
		if (session.mode === 'founder' && session.pendingQuestion.credentialLike === true) {
			recordFounderPublicOnlyDecision(session);
			answer = FOUNDER_PUBLIC_ONLY_ANSWER;
		}
		await services.runs.addMessage(session, { role: 'user', text: answer, kind: 'answer' });
		startTurn(session, { resumeAnswer: answer });
		response.json({ ok: true });
	});

	/** Credential answers are stored in the vault; only placeholders reach the agent. */
	app.post('/api/sessions/:id/credentials', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (!session.pendingQuestion) {
			response.status(409).json({ error: 'Nothing is waiting on an answer.' });
			return;
		}

		const fields = request.body?.fields;
		if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
			response.status(400).json({ error: 'No credentials supplied.' });
			return;
		}

		const names = await services.secrets.store(session.id, fields);
		if (names.length === 0) {
			response.status(400).json({ error: 'No usable credentials supplied.' });
			return;
		}
		session.secretNames = await services.secrets.names(session.id);

		const note = String(request.body?.note ?? '').trim();
		const placeholders = names.map(name => `{{${name}}}`).join(', ');
		const answer = [
			'The credentials are stored in the host vault. You will not be shown the values.',
			`Fill the sign-in form using these literal placeholders as the browser_fill value: ${placeholders}.`,
			'The host substitutes the real secret at the keyboard. Never print, repeat or report a credential value.',
			note && `Note from the user: ${note}`
		].filter(Boolean).join(' ');

		await services.runs.addMessage(session, {
			role: 'user',
			kind: 'credentials',
			text: `Provided ${names.length} credential${names.length === 1 ? '' : 's'} securely: ${placeholders}`
		});
		await services.runs.commit(session, 'secrets', { secretNames: session.secretNames });
		startTurn(session, { resumeAnswer: answer });
		response.json({ ok: true, secretNames: names });
	});

	app.post('/api/sessions/:id/stop', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		await services.runs.commit(session, 'run.stop_requested');
		await services.agent.stop(session.id);
		response.json({ ok: true });
	});

	app.get('/api/sessions/:id/report.md', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (session.mode === 'sqa' && (!session.sqa?.assessment || !session.sqa?.finalizedAt)) {
			response.status(409).json({ error: 'The SQA assessment is pending and has not been finalized yet.' });
			return;
		}
		if (session.mode === 'founder' && (!session.founder?.report || !session.founder?.finalizedAt)) {
			response.status(409).json({ error: 'The Founder review is pending and has not been finalized yet.' });
			return;
		}
		let markdown;
		if (session.mode === 'sqa') {
			markdown = buildSqaReportMarkdown(session.sqa.assessment);
			// Append the submitter's own feedback (same section the QA report
			// embeds); attachUserFeedback scopes it to this run + user.
			const feedbackSection = buildFeedbackSectionMarkdown(await attachUserFeedback(session, request.auth?.userId));
			if (feedbackSection) markdown += `\n${feedbackSection}`;
		} else if (session.mode === 'founder') {
			markdown = buildFounderReportMarkdown(session);
		} else {
			markdown = services.reports.buildMarkdown(await attachUserFeedback(session, request.auth?.userId));
		}
		response.type('text/markdown').send(markdown);
	});

	app.get('/api/sessions/:id/fix-prompts.md', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const findings = Array.isArray(session.findings) ? session.findings : [];
		if (findings.length === 0) {
			response.status(409).json({ error: 'This run has no findings to build fix prompts from.' });
			return;
		}
		const markdown = buildAllFixPromptsMarkdown(session);
		response.type('text/markdown').send(markdown);
	});

	app.get('/api/sessions/:id/report.pdf', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (session.mode === 'sqa' && (!session.sqa?.assessment || !session.sqa?.finalizedAt)) {
			response.status(409).json({ error: 'The SQA assessment is pending and has not been finalized yet.' });
			return;
		}
		if (session.mode === 'founder' && (!session.founder?.report || !session.founder?.finalizedAt)) {
			response.status(409).json({ error: 'The Founder review is pending and has not been finalized yet.' });
			return;
		}
		try {
			const pdf = await renderReportPdf(await attachUserFeedback(session, request.auth?.userId));
			response.setHeader('Content-Type', 'application/pdf');
			response.setHeader('Content-Disposition', 'attachment; filename="qase-' + (session.mode || 'qa') + '-report.pdf"');
			response.send(pdf);
		} catch (error) {
			if (error?.code === 'QASE_PDF_BROWSER_UNAVAILABLE') {
				return response.status(503).json({ error: 'PDF rendering is temporarily unavailable.' });
			}
			safeErrorResponse(request, response, error, 500);
		}
	});

	const FEEDBACK_RATINGS = new Set(['up', 'down']);

	/** Thumbs up/down on a run. Last rating wins; owner-only. */
	app.post('/api/sessions/:id/feedback', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const rating = request.body?.rating;
		if (!FEEDBACK_RATINGS.has(rating)) {
			response.status(400).json({ error: 'rating must be "up" or "down".' });
			return;
		}
		const note = String(request.body?.note ?? '').trim().slice(0, 2000) || undefined;
		session.feedback = { rating, ...(note ? { note } : {}), updatedAt: Date.now() };
		await services.runs.commit(session, 'feedback', { feedback: session.feedback });
		track('feedback', { rating, mode: session.mode, ...cohortFor(request.auth?.role) });
		response.json({ ok: true, feedback: session.feedback });
	});

	/** Drytis board push (dashboard side): accepts finding selection and pushes
	 *  signed tickets via the same delivery client the internal API uses. */
	app.post('/api/sessions/:id/drytis/push', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		if (!drytisDelivery?.deliveryClient) {
			response.status(409).json({ error: 'Drytis ticket push is not configured on this instance.' });
			return;
		}
		if (!session.drytisIntegration) {
			response.status(409).json({ error: 'This run has no Drytis review attached.' });
			return;
		}
		const acceptedFindingIds = request.body?.acceptedFindingIds;
		if (!Array.isArray(acceptedFindingIds)
			|| acceptedFindingIds.some(id => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
			response.status(400).json({ error: 'acceptedFindingIds must be an array of finding ids.' });
			return;
		}
		const state = session.drytisIntegration;
		const requestedAt = new Date().toISOString();
		const acceptedSet = new Set(acceptedFindingIds);
		const tickets = (session.findings ?? [])
			.filter(finding => acceptedSet.has(finding.id))
			.map(finding => ({
				id: finding.id,
				title: finding.title,
				body: [
					finding.actual ? `**Actual:** ${finding.actual}` : null,
					finding.expected ? `**Expected:** ${finding.expected}` : null,
					finding.steps?.length ? `**Steps:**\n${finding.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}` : null,
					finding.evidence ? `**Evidence:** ${finding.evidence}` : null
				].filter(Boolean).join('\n\n'),
				severity: finding.severity,
				...(finding.engine ? { engine: finding.engine } : {}),
				...(finding.url ? { url: finding.url } : {}),
				...(finding.category ? { category: finding.category } : {})
			}));
		if (tickets.length === 0) {
			response.status(400).json({ error: 'No accepted findings to push.' });
			return;
		}
		const payload = {
			schemaVersion: 1,
			reviewId: state.externalReviewId,
			project: state.project,
			pushedAt: requestedAt,
			tickets
		};
		state.tickets = {
			acceptedFindingIds: [...acceptedSet],
			status: 'delivering',
			requestedAt
		};
		state.updatedAt = requestedAt;
		await services.runs.commit(session, 'drytis.tickets.requested', {
			accepted: tickets.length, origin: 'dashboard'
		});
		try {
			const receipt = await drytisDelivery.deliveryClient.deliver(drytisDelivery.ticketsTarget, payload, {
				idempotencyKey: `tickets-${session.id}-${tickets.map(ticket => ticket.id).sort().join(',')}`.slice(0, 128),
				correlationId: randomUUID()
			});
			const deliveredAt = new Date().toISOString();
			state.tickets = {
				acceptedFindingIds: [...acceptedSet],
				status: 'delivered',
				deliveredAt,
				ticketCount: tickets.length,
				...(Number.isInteger(receipt?.status) ? { upstreamStatus: receipt.status } : {})
			};
			state.updatedAt = deliveredAt;
			await services.runs.commit(session, 'drytis.tickets.completed', {
				ticketCount: tickets.length, origin: 'dashboard'
			});
			track('drytis_ticket_push', { tickets: tickets.length, mode: session.mode });
			response.json({ ok: true, tickets: state.tickets });
		} catch (error) {
			const failedAt = new Date().toISOString();
			state.tickets = {
				acceptedFindingIds: [...acceptedSet],
				status: 'failed',
				failedAt,
				error: { code: 'ticket_push_failed', message: 'The Drytis push did not complete.', retryable: true }
			};
			state.updatedAt = failedAt;
			await services.runs.commit(session, 'drytis.tickets.failed', { origin: 'dashboard' });
			response.status(502).json({ error: 'The Drytis push did not complete. Try again.' });
		}
	});

	/** Aggregated local usage counters. No PII. */
	app.get('/api/analytics/summary', (_request, response) => {
		try {
			response.json(summarize(ANALYTICS_DIR));
		} catch {
			response.json({ schemaVersion: 1, totalEvents: 0, events: {} });		}
	});

	// Operator invite minting — registered after the auth middleware so
	// request.auth carries the caller's role.
	const inviteService = options.inviteService;
	if (inviteService) {
		// Per-operator rate limit on minting — spec controlled-pilot.md. Small
		// fixed budget: an operator never legitimately needs more than a
		// handful of codes per window; a hot loop minting thousands is a
		// script or a bug.
		const inviteMintThrottle = createAuthThrottle();
		app.post('/api/auth/invites', async (request, response, next) => {
			try {
				const operatorKey = request.auth?.userId ?? 'anonymous';
				const allowed = await inviteMintThrottle(authThrottleKey(`invite-mint:${operatorKey}`), 30);
				if (!allowed) { response.set('Retry-After', '900').status(429).json({ error: 'Too many invites minted in this window. Try again in 15 minutes.' }); return; }
				next();
			} catch (error) { authFailure(response, error); }
		});
		app.post('/api/auth/invites', async (request, response) => {
			if (!authRequired) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
			if (!requireOperator(request, response)) return;
			try {
				const invite = await inviteService.create({ note: request.body?.note, createdBy: request.auth?.userId });
				response.status(201).json(invite);
			} catch (error) {
				response.status(error?.status ?? 500).json({ error: error instanceof Error ? error.message : 'Could not create an invite.' });
			}
		});
		app.get('/api/auth/invites', async (request, response) => {
			if (!authRequired) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
			if (!requireOperator(request, response)) return;
			response.json({ invites: await inviteService.list() });
		});
	}

	// Operator-only pilot feedback review: every rating across all sessions,
	// newest first, with the optional note the user chose to type. This is the
	// review surface for the pilot gate (spec: controlled-pilot.md).
	app.get('/api/analytics/feedback', async (request, response) => {
		if (!requireOperator(request, response)) return;
		try {
			// listAll/getAny deliberately bypass per-user owner scoping — the
			// whole point of this endpoint is cross-user pilot feedback review,
			// already gated by the operator role check above.
			const listAll = services.runs.listAll ?? services.runs.list.bind(services.runs);
			const sessions = await listAll({ limit: 100 });
			const feedback = [];
			for (const summary of sessions) {
				const getAny = services.runs.getAny?.bind(services.runs) ?? services.runs.get.bind(services.runs);
				const session = await getAny(summary.id);
				if (session?.feedback?.rating) {
					feedback.push({
						sessionId: session.id,
						title: session.title,
						mode: session.mode,
						targetUrl: session.targetUrl,
						rating: session.feedback.rating,
						note: session.feedback.note,
						updatedAt: session.feedback.updatedAt
					});
				}
			}
			feedback.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
			response.json({ feedback });
		} catch {
			response.status(500).json({ error: 'Could not read feedback.' });
		}
	});

	app.get('/api/sessions/:id/events', async (request, response) => {
		let closed = false;
		let ready = false;
		let heartbeat;
		let unsubscribe;
		const cleanup = () => {
			closed = true;
			clearInterval(heartbeat);
			// Cleanup can precede asynchronous subscription completion. Clearing the
			// handle, rather than returning when closed, also disposes a late handle.
			const dispose = unsubscribe;
			unsubscribe = undefined;
			if (typeof dispose === 'function') {
				try { Promise.resolve(dispose()).catch(() => {}); } catch { /* connection already ended */ }
			}
		};
		const endStream = () => {
			cleanup();
			if (!response.destroyed && !response.writableEnded) response.end();
		};
		// A client can leave while either storage or Redis is still awaiting I/O.
		response.once('close', cleanup);
		response.once('error', cleanup);
		request.once('aborted', cleanup);
		const session = await requireSession(request, response);
		if (!session || closed || response.destroyed || response.writableEnded) return;

		response.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		});

		const write = chunk => {
			if (closed || response.destroyed || response.writableEnded) {
				cleanup();
				return;
			}
			try { response.write(chunk); } catch { endStream(); }
		};
		const send = event => {
			if (!ready || closed) return;
			try { write(`data: ${JSON.stringify(event)}\n\n`); } catch { endStream(); }
		};
		try {
			// Distributed transports subscribe to a session-scoped frame channel.
			// Awaiting it closes the race where the first live frame could be sent
			// before this API replica had joined that channel.
			unsubscribe = await services.events.subscribe(session.id, send);
		} catch {
			endStream();
			return;
		}
		if (closed || response.destroyed || response.writableEnded) {
			cleanup();
			return;
		}
		// The first bytes are the client's subscription-ready handshake. Sending
		// them before subscribing can lose a newly launched run's initial events.
		ready = true;
		write(': connected\n\n');

		try {
			const frame = services.agent.getLiveState(session.id).frame;
			if (frame) send({ type: 'frame', sessionId: session.id, frame });
		} catch {
			endStream();
			return;
		}
		if (!closed) heartbeat = setInterval(async () => {
			try {
				if (authRequired && !await authService.authenticate(requestAuthToken(request))) { endStream(); return; }
				if (!closed) write(': ping\n\n');
			} catch { endStream(); }
		}, heartbeatMs);
	});

	app.use('/api', (_request, response) => {
		response.status(404).json({ error: 'API route not found.' });
	});

	app.use((error, request, response, next) => {
		if (response.headersSent) {
			next(error);
			return;
		}
		// The Telegram webhook always answers 200 (Telegram retries non-200
		// aggressively); a JSON parse error there must not surface as 400.
		if (request.path === '/webhooks/telegram') {
			response.status(200).send('OK');
			return;
		}
		if (error?.type === 'entity.too.large') {
			response.status(413).json({ error: 'Request body is too large.' });
			return;
		}
		if (error instanceof SyntaxError && error?.status === 400) {
			response.status(400).json({ error: 'Request body is not valid JSON.' });
			return;
		}
		if (error?.name === 'RunVersionConflictError' || error?.code === 'RUN_VERSION_CONFLICT') {
			response.status(409).json({
				error: 'This run changed on another server. Refresh it and try again.'
			});
			return;
		}
		if (logger) logger.error('http.request.failed', {
			requestId: request.qaseRequestId,
			errorName: error?.name ?? 'Error'
		});
		else console.error(`[Qase server ${request.qaseRequestId ?? 'no-request-id'}]`, error instanceof Error ? error.message : String(error));
		response.status(500).json({ error: 'Unexpected server error.' });
	});

	return {
		app,
		access,
		demoEnabled,
		services,
		operations,
		whenIdle: () => Promise.allSettled([...activeTurns])
	};
}
