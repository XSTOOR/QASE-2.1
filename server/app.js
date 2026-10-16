import * as path from 'node:path';
import { chooseAutomaticBrowser } from './automaticBrowser.js';
import { createSingleRunAdmission } from './singleRunAdmission.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { createInstanceAccess, securityHeaders } from './instanceAccess.js';
import { isDeviceId, DEFAULT_DEVICE_ID, publicDeviceProfile, DEVICE_PROFILES } from './deviceProfiles.js';
import { engineRegistryResolved, isEngineId } from './browserEngines.js';
import { probeTargetReachability } from './targetReachability.js';
import { assertApplicationServices } from './contracts.js';
import { mountDemoSite } from './demoSite.js';
import { mountDefectFixtures, listDefectFixtures, getDefectFixture, fixtureExpectation } from './defectFixtures.js';
import { verifyFixtureAgainstProfile } from './defectFixtureRunner.js';
import { createOperationalControls } from './operations.js';
import { runWithRequestActor } from './requestActor.js';
import { authThrottleKey, createAuthThrottle } from './authThrottle.js';
import { InviteError } from './invites.js';
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
import { detectFounderProjectContext } from './founderContext.js';
import { projectStateFromSession, reconcileSelections } from './founderProjectState.js';
import { createFounderHandoffService, FounderHandoffError } from './founderHandoff.js';
import { buildSqaReportMarkdown } from './sqaAssessment.js';
import { computeMatrixCoverage } from './matrixCoverage.js';
import { createCatalogRoutes } from './catalogApi.js';
import { createTestCaseRoutes } from './testCaseApi.js';
import { createBugRoutes } from './bugApi.js';
import { createMatrixRoutes } from './matrixApi.js';
import { createMatrixOrchestrator } from './matrixOrchestrator.js';
import { checkEnvironmentHealth } from './environmentHealth.js';
import { createMailer } from './mailer.js';
import { resolveBrowserSupport } from './browserSupportResolution.js';
import { buildFeedbackSectionMarkdown } from './report.js';
import { normalizeQaScopeSelection } from '../public/qaScopeCatalog.js';
import { createConfiguredTelegramNotifier } from './telegramNotifier.js';
import { resolveDisplayTimeZone, formatFeedbackTimestamp } from './displayTime.js';
import { createSqaState, createSqaTodoPlan, publicSqaCatalog, recordReviewerSqaObservation } from './sqaService.js';
import { preflightSqaRuntime } from './sqaRuntime.js';
import { publicQaTestCatalog } from './qaTestCatalog.js';
import { validateQaSelectedTests, validateSecurityAuthorization } from './appQaSelection.js';
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

/**
 * Resolve an optional environmentId for run creation. Returns undefined for a
 * run without an environment (back-compat), the frozen environment record on a
 * hit, and a 422-worthy public error for unknown or deactivated environments.
 */
async function resolveEnvironmentForRun(services, environmentId) {
	if (environmentId === undefined || environmentId === null || environmentId === '') return undefined;
	if (typeof environmentId !== 'string') {
		throw new PublicInputError('environmentId must be a string.', 422);
	}
	const environment = await services.environments.get(environmentId);
	if (!environment) {
		throw new PublicInputError(`Unknown environment "${environmentId}".`, 422);
	}
	if (environment.active !== true) {
		throw new PublicInputError(`Environment "${environmentId}" is inactive (deprecated) and cannot start new runs.`, 422);
	}
	return environment;
}

/**
 * Resolve an optional testCaseId for run creation (Phase 4). Returns undefined
 * when no case is given (back-compat). When a case IS given, the environment
 * (if any) must be assigned to the case. Returns the case for snapshotting.
 */
async function resolveTestCaseForRun(services, testCaseId, environmentId) {
	if (testCaseId === undefined || testCaseId === null || testCaseId === '') return undefined;
	if (typeof testCaseId !== 'string') {
		throw new PublicInputError('testCaseId must be a string.', 422);
	}
	const { TestCaseValidationError } = await import('./testCaseService.js');
	try {
		return await services.testCases.resolveForRun(testCaseId, environmentId);
	} catch (error) {
		if (error instanceof TestCaseValidationError) {
			throw new PublicInputError(error.message, 422);
		}
		throw error;
	}
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
	const mailer = options.mailer ?? createMailer({ environment, logger });
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

	// Project-level Founder Mode persistence (Phase 3): on every successful
	// founder finalization, mirror the validated report into the per-project
	// founder state store. Failures are logged and never break the run —
	// the run-level report remains the source of truth for recovery.
	const founderProjectState = typeof services.runs.getFounderProjectState === 'function'
		? {
			get: services.runs.getFounderProjectState.bind(services.runs),
			save: services.runs.saveFounderProjectState.bind(services.runs)
		}
		: undefined;
	if (typeof services.events.subscribeGlobal === 'function' && founderProjectState) {
		services.events.subscribeGlobal(async (sessionId, event) => {
			if (event?.type !== 'founder.finalized') return;
			try {
				const session = await services.runs.getAny?.(sessionId);
				const state = projectStateFromSession(session);
				if (!state) return;
				// Regeneration replaces the set; selections that still name a
				// live recommendation id survive into the new state.
				const previous = await founderProjectState.get();
				const previousSelections = previous?.recommendationSet?.recommendations && Array.isArray(previous.selections)
					? previous.selections
					: [];
				await founderProjectState.save(reconcileSelections({ ...state, selections: previousSelections }));
			} catch (error) {
				logger?.error?.(`[Founder project state] Could not persist after finalization: ${error?.message ?? error}`);
			}
		});
	}
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
	// Gzip the big catalog payloads (the full-catalog index is ~13MB raw,
	// ~300KB gzipped) — keeps the launcher's first load off the SSE limit.
	app.use(compression());
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

	// QA matrix launcher (#14942): the request body carries every selected
	// configuration id (a full default selection is ~37k ids ≈ 2MB). The route
	// itself caps the RUN at 2000 configurations with an actionable 422 —
	// the global 1mb limit would preempt that with a bare 413 ("Request body
	// is too large") that gives the user nothing to act on. A generous
	// route-specific limit lets the cap message win; arbitrary bulk beyond it
	// is still bounded.
	app.use('/api/qa-matrix-runs', express.json({ limit: '8mb' }));
	app.use(express.json({ limit: '1mb' }));
	app.get('/login', (_request, response) => {
		// The HTML shell must never be served from cache — a stale shell
		// referencing pre-versioned asset URLs resurrects broken layouts.
		response.set('Cache-Control', 'no-cache');
		response.sendFile('index.html', { root: publicDirectory });
	});
	// Versioned assets (?v=…) are immutable per version — cache hard. Everything
	// else (unversioned paths, index.html) revalidates every load.
	app.use(express.static(publicDirectory, {
		setHeaders(response, filePath) {
			if (filePath.endsWith('.html')) response.set('Cache-Control', 'no-cache');
			else if (/[?&]v=/.test(response.req?.url ?? '') || filePath.endsWith('.css') || filePath.endsWith('.js')) {
				response.set('Cache-Control', 'public, max-age=0, must-revalidate');
			}
		}
	}));
	// #14650 (NI02 Phase 2): known-defect fixture pages — mounted BEFORE
	// mountDemoSite because its router has a catch-all 404 under /demo that
	// would otherwise swallow /demo/defects/*. Reproduction depends on the
	// emulated form factor (viewport/touch), never fabricated.
	if (demoEnabled) {
		mountDefectFixtures(app);
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
	const publicAuthRoute = request.path === '/auth/register' || request.path === '/auth/login' || request.path === '/pilot-status'
		|| request.path === '/auth/forgot-password' || request.path === '/auth/reset-password'
		|| request.path === '/auth/verify-reset-otp' || request.path === '/auth/recover';
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
		const expected = error instanceof AuthError || error instanceof InviteError;
		const status = expected ? error.status : 500;
		response.status(status).json({ error: expected ? error.message : 'Authentication is temporarily unavailable. Please try again.' });
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
		if (request.method !== 'POST' || !['/login', '/register', '/password', '/forgot-password', '/reset-password', '/verify-reset-otp', '/recovery-codes', '/recover'].includes(request.path)) return next();
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
		// Prevalidate for a uniform admission error. redeem rechecks under its
		// lock and persists consumption before registering; known validation
		// failures release the code, while uncertain storage failures fail closed.
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
			const register = () => authService.register({ ...(request.body ?? {}), ...(invited ? { role: 'pilot' } : {}) });
			let result;
			if (invited) {
				const email = String(request.body?.email ?? '').trim().toLowerCase();
				if (typeof inviteService.redeem === 'function') result = await inviteService.redeem(inviteCode, email, register);
				else { await inviteService.consume(inviteCode, email); result = await register(); }
			} else result = await register();
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

	// Password reset via email OTP (public, pre-auth, throttled). The request
	// endpoint is deliberately oracle-free — identical response whether or not
	// the account exists. The 6-digit OTP travels ONLY inside the email body
	// (mock outbox in dev/test, SMTP in production); it is never returned by
	// any API response and never logged. After a verified OTP the client gets a
	// short-lived, single-use reset authorization to set the new password.
	app.post('/api/auth/forgot-password', async (request, response) => {
		if (!authService?.requestPasswordReset) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		const neutral = { message: 'If an account exists for that email, a reset code has been sent.' };
		try {
			const issued = await authService.requestPasswordReset(String(request.body?.email ?? ''));
			if (issued) {
				const text = `A password reset was requested for your Qase account (${issued.user.email}).\n\nYour verification code is: ${issued.otp}\n\nIt expires in 5 minutes and can be used only once. If you did not request this, you can ignore this email — your password stays unchanged.`;
				await mailer.send({
					to: issued.user.email,
					subject: 'Your Qase password-reset code',
					text,
					html: `<p>A password reset was requested for your Qase account (<strong>${issued.user.email}</strong>).</p><p>Your verification code is:</p><p style="font-size:22px;letter-spacing:4px"><strong>${issued.otp}</strong></p><p>It expires in <strong>5 minutes</strong> and can be used only once.</p><p>If you did not request this, you can ignore this email — your password stays unchanged.</p>`
				});
			}
			response.json(neutral);
		} catch (error) {
			// Even a mailer failure must not leak account existence.
			authFailure(response, error);
		}
	});

	app.post('/api/auth/verify-reset-otp', async (request, response) => {
		if (!authService?.verifyResetOtp) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			const verified = await authService.verifyResetOtp({ email: request.body?.email, otp: request.body?.otp });
			// The authorization token is the ONLY secret issued; it is handed
			// to the verified client and consumed once at reset-password.
			response.json({ message: 'Code verified. Choose a new password.', authorization: verified.authorization });
		} catch (error) { authFailure(response, error); }
	});

	app.post('/api/auth/reset-password', async (request, response) => {
		if (!authService?.resetPassword) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			await authService.resetPassword({ token: request.body?.authorization, password: request.body?.password });
			response.json({ message: 'Password updated. You can now sign in.' });
		} catch (error) { authFailure(response, error); }
	});

	// Recovery codes (#15725/#15727). Generation is AUTHENTICATED and gated on
	// the current password; the plaintext codes appear exactly once in this one
	// response and are never logged or persisted in the clear. Status is a
	// read-only count for the Profile → Security panel (never the codes).
	app.post('/api/auth/recovery-codes', async (request, response) => {
		if (!authService?.generateRecoveryCodes) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			const generated = await authService.generateRecoveryCodes(request.auth.userId, { currentPassword: request.body?.currentPassword });
			response.json(generated);
		} catch (error) { authFailure(response, error); }
	});
	app.get('/api/auth/recovery-codes', async (request, response) => {
		if (!authService?.recoveryCodeStatus) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		response.json(await authService.recoveryCodeStatus(request.auth.userId));
	});
	// Public, pre-auth, throttled. Deliberately oracle-free: identical response
	// for unknown email / account without codes / wrong or used code, so the
	// endpoint cannot be used to enumerate accounts. A matched unused code is
	// consumed atomically and exchanged for the same short-lived, single-use
	// reset authorization the email-OTP flow issues (reset-password above).
	app.post('/api/auth/recover', async (request, response) => {
		if (!authService?.recoverWithCode) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			const recovered = await authService.recoverWithCode({ email: request.body?.email, code: request.body?.code });
			response.json({ message: 'Recovery code accepted. Choose a new password.', authorization: recovered.authorization });
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
	 * Resolve the detected Founder project context for the requesting owner
	 * from trusted run records (QA + Founder modes only). Shared by
	 * GET /api/founder/context and POST /api/founder/sessions enrichment.
	 * Returns undefined when nothing usable is found — never throws on empty
	 * history so a first launch stays frictionless.
	 */
	async function founderDetectedContext(request) {
		const ownerUserId = request.auth?.userId;
		const listAll = services.runs.listAll ?? services.runs.list.bind(services.runs);
		const summaries = await listAll({ limit: 100, ownerUserId });
		const getAny = services.runs.getAny?.bind(services.runs) ?? services.runs.get.bind(services.runs);
		const runs = [];
		for (const summary of summaries) {
			if (summary.mode !== 'qa' && summary.mode !== 'founder') continue;
			const session = await getAny(summary.id);
			if (session && (!ownerUserId || session.ownerUserId === ownerUserId)) runs.push(session);
		}
		const detected = detectFounderProjectContext({ runs });
		// Only enrich the founder scope with the facts the schema accepts;
		// drop transport-only fields (detectedAt, targetName) at this boundary.
		return {
			targetUrl: detected.targetUrl,
			studio: detected.studio,
			previousFindings: detected.previousFindings,
			previousFounder: detected.previousFounder
		};
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

	/**
	 * #14652 (NI04): inject the matrix coverage snapshot for sessions spawned
	 * by a matrix run, so the downloaded report renders the per-run gap
	 * section from ACTUAL item data (userFeedback-style injection — the
	 * session record itself is never mutated in the store).
	 */
	async function attachMatrixCoverage(session) {
		if (!session?.matrixRunId || !services.matrix?.get || !services.matrix?.list) return session;
		try {
			const run = await services.matrix.get(session.matrixRunId);
			if (!run) return session;
			session.matrixCoverage = computeMatrixCoverage([run]);
			// #14942 (Phase 4): the report layer renders per-configuration rows
			// from the recorded items (see buildMatrixSectionMarkdown). Items are
			// enriched with the same per-environment defect linkage the API uses,
			// so report rows carry their own evidence counts.
			const items = Array.isArray(run.items) ? run.items : [];
			const byEnvironment = new Map();
			for (const item of items) {
				if (!item.environmentId) continue;
				if (!byEnvironment.has(item.environmentId)) {
					try {
						byEnvironment.set(item.environmentId, await services.bugs.list({ environmentId: item.environmentId }));
					} catch {
						byEnvironment.set(item.environmentId, []);
					}
				}
				const defects = byEnvironment.get(item.environmentId) ?? [];
				item.defects = defects.map(({ bugNumber, title, severity, status }) => ({ bugNumber, title, severity, status }));
			}
			session.matrixItems = items;
		} catch (error) {
			console.warn('attachMatrixCoverage failed:', error?.message ?? error);
			session.matrixCoverage = undefined;
		}
		return session;
	}

	/** Runs a turn detached: HTTP returns immediately and progress arrives by SSE. */
	function startTurn(session, turnOptions) {
		let turn;
		try {
			turn = Promise.resolve(services.agent.runTurn(
				session,
				turnOptions,
				services.runs,
				services.deviceRuntime
			));
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

	app.get('/api/qa/catalog', (_request, response) => {
		response.set('Cache-Control', 'private, max-age=300');
		response.json(publicQaTestCatalog());
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

	// Detected project context for the Founder launcher: target URL candidates,
	// Studio project metadata availability, prior findings and prior Founder
	// context. Computed from trusted server-side run records for the
	// requesting owner; never accepts request-body input.
	app.get('/api/founder/context', async (request, response) => {
		try {
			const ownerUserId = request.auth?.userId;
			const listAll = services.runs.listAll ?? services.runs.list.bind(services.runs);
			const summaries = await listAll({ limit: 100, ownerUserId });
			const getAny = services.runs.getAny?.bind(services.runs) ?? services.runs.get.bind(services.runs);
			const runs = [];
			for (const summary of summaries) {
				if (summary.mode !== 'qa' && summary.mode !== 'founder') continue;
				const session = await getAny(summary.id);
				if (session && (!ownerUserId || session.ownerUserId === ownerUserId)) runs.push(session);
			}
			response.set('Cache-Control', 'no-store');
			response.json(detectFounderProjectContext({ runs }));
		} catch (error) {
			safeErrorResponse(request, response, error, 500);
		}
	});

	// Saved Founder Mode project state (Phase 3): last successful
	// recommendation set, selections and handoff status. The state is shared
	// at the trusted tenant-project scope; writes additionally require a
	// non-pilot actor (pilots may read, never mutate).
	app.get('/api/founder/state', async (request, response) => {
		if (!founderProjectState) {
			response.status(501).json({ error: 'Founder project state persistence is not available in this mode.' });
			return;
		}
		try {
			const state = reconcileSelections(await founderProjectState.get());
			response.set('Cache-Control', 'no-store');
			response.json({ state: state ?? null });
		} catch (error) {
			safeErrorResponse(request, response, error, 500);
		}
	});

	// Persist user selections (and only selections — the recommendation set
	// itself is only written at finalization time from a validated report).
	app.patch('/api/founder/state/selections', async (request, response) => {
		if (!founderProjectState) {
			response.status(501).json({ error: 'Founder project state persistence is not available in this mode.' });
			return;
		}
		if (request.auth?.role === 'pilot') {
			response.status(403).json({ error: 'Pilot accounts cannot modify Founder Mode selections.' });
			return;
		}
		try {
			const raw = request.body?.selectedRecommendationIds;
			if (!Array.isArray(raw) || raw.length > 50 || !raw.every(id => typeof id === 'string' && id.length <= 128)) {
				response.status(400).json({ error: 'selectedRecommendationIds must be an array of up to 50 recommendation ids.' });
				return;
			}
			const current = await founderProjectState.get();
			if (!current?.recommendationSet?.recommendations) {
				response.status(409).json({ error: 'No saved recommendation set exists yet. Finalize a Founder review first.' });
				return;
			}
			const known = new Set(current.recommendationSet.recommendations.map(item => item.id));
			const unknown = raw.filter(id => !known.has(id));
			if (unknown.length > 0) {
				response.status(400).json({ error: `Unknown recommendation ids: ${unknown.join(', ')}.` });
				return;
			}
			const next = reconcileSelections({ ...current, selections: [...new Set(raw)] });
			await founderProjectState.save(next);
			response.json({ state: next });
		} catch (error) {
			safeErrorResponse(request, response, error, 500);
		}
	});

	// The signed delivery client is reused only when a founder-specific target
	// is configured; otherwise the handoff stays export-only rather than
	// silently delivering founder payloads to the QA tickets endpoint.
	const founderDeliveryTarget = drytisDelivery?.founderHandoffTarget;
	const founderHandoff = founderProjectState
		? createFounderHandoffService({
			deliveryClient: founderDeliveryTarget ? drytisDelivery.deliveryClient : undefined,
			target: founderDeliveryTarget,
			get: async () => reconcileSelections(await founderProjectState.get()),
			save: state => founderProjectState.save(state),
			tenantProjectId: services.tenantContext?.projectId
		})
		: undefined;
	app.locals.qaseFounderHandoff = founderHandoff;

	// Explicit Founder → Studio handoff (Phase 4): selection alone never
	// triggers a delivery; the client must POST the selected ids here.
	app.post('/api/founder/handoff', async (request, response) => {
		if (!founderProjectState) {
			response.status(501).json({ error: 'Founder project state persistence is not available in this mode.' });
			return;
		}
		if (request.auth?.role === 'pilot') {
			response.status(403).json({ error: 'Pilot accounts cannot send Founder recommendations to Studio.' });
			return;
		}
		let payloadOnly = false;
		try {
			const raw = request.body?.selectedRecommendationIds;
			if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50
				|| !raw.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
				response.status(400).json({ error: 'selectedRecommendationIds must be a non-empty array of up to 50 recommendation ids.' });
				return;
			}
			// Fallback path: export requests NEVER deliver — the payload is
			// returned ready for copy/download without claiming a build started.
			payloadOnly = request.body?.export === true;
			const handoffService = request.app.locals.qaseFounderHandoff;
			if (!handoffService) {
				response.status(501).json({ error: 'Founder handoff is not configured on this instance.' });
				return;
			}
			if (payloadOnly) {
				const payload = await handoffService.build(raw);
				response.json({ ok: false, unavailable: true, payload });
				return;
			}
			const result = await handoffService.send(raw);
			response.json({
				ok: result.ok,
				...(result.unavailable ? { unavailable: true, payload: result.payload } : {}),
				handoff: result.handoff,
				state: await founderProjectState.get()
			});
		} catch (error) {
			if (error instanceof FounderHandoffError) {
				response.status(error.status).json({ error: error.message, code: error.code });
				return;
			}
			safeErrorResponse(request, response, error, 500);
		}
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

	// Apple compatibility matrix: list/filter environments. All facet dimensions
	// are accepted as query params (platform, device, os, osVersion, browser,
	// browserVersion, deviceType, executionProvider, active, isRealDevice, search,
	// limit, offset).
	// DB-backed catalog routes (Phase 2 of the device matrix): /api/catalog/*.
	// #14648: mount the read-only /api/catalog/meta route BEFORE the
	// /api/catalog/:entity wildcard these routes register, otherwise 'meta'
	// resolves as an unknown catalog entity and the metadata endpoint 400s.
	if (services.deviceCatalog) {
		app.get('/api/catalog/meta', async (_request, response) => {
			try {
				const { catalogProviderMeta } = await import('./catalogProviderRegistry.js');
				response.set('Cache-Control', 'no-store');
				response.json(await catalogProviderMeta());
			} catch (error) {
				safeErrorResponse(request, response, error);
			}
		});
		const { route: catalogRoutes } = createCatalogRoutes({
			catalogBackend: services.deviceCatalog,
			onError: safeErrorResponse
		});
		catalogRoutes(app);
	}

	// Launcher configuration catalog (QA matrix Phase 1, #14935): the complete
	// honestly-annotated device–OS–browser–version set for the Start QA
	// dialog. Derived from the environment catalog + browser support
	// resolution + runtime board — no new data source, no invented versions.
	if (services.environments) {
		app.get('/api/qa-configurations', async (request, response) => {
			try {
				const query = request.query ?? {};
				const limit = query.limit === undefined ? 200 : Number(query.limit);
				if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 80000)) {
					response.status(400).json({ error: 'limit must be an integer from 1 through 80000.' });
					return;
				}
				const offset = query.offset === undefined ? undefined : Number(query.offset);
				if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
					response.status(400).json({ error: 'offset must be a non-negative integer.' });
					return;
				}
				const { buildQaConfigurations, buildQaConfigurationsByDevice } = await import('./qaConfigurations.js');
				const { catalogProviderMeta } = await import('./catalogProviderRegistry.js');
				const [providersMeta] = await Promise.all([
					catalogProviderMeta().catch(() => ({ providers: [] })),
					Promise.resolve()
				]);
				const providers = (providersMeta?.providers ?? []).map((provider) => ({
					slug: provider.slug,
					name: provider.name ?? provider.slug,
					kind: provider.kind ?? 'catalog',
					connected: Boolean(provider.connected),
					stale: Boolean(provider.stale)
				}));
				const board = services.deviceRuntime && typeof services.deviceRuntime.deviceBoard === 'function'
					? services.deviceRuntime.deviceBoard()
					: [];
				// #15439 Issue 2: device-grouped windows — one window returns ALL
				// rows of `limit` DEVICE groups in canonical platform order, so
				// the tree shows iPhone/iPad/Android/desktops from the first
				// screen instead of 200 rows of one device.
				if (query.groupBy === 'device') {
					const result = await buildQaConfigurationsByDevice(
						{
							environmentsService: services.environments,
							providers,
							board,
							limit,
							offset: offset ?? 0
						},
					{
						platform: query.platform,
						manufacturer: query.manufacturer,
						osVersion: query.osVersion,
						orientation: query.orientation,
						browserCode: query.browserCode,
						search: query.search,
						// #16045: category filter — filterConfigurations already
						// supports the field; the route now forwards it.
						deviceType: query.deviceType
					}
				);
				response.set('Cache-Control', 'no-store');
				response.json(result);
				return;
				}
				const result = await buildQaConfigurations(
					{
						environmentsService: services.environments,
						providers,
						board,
						limit,
						offset,
						index: query.index === '1' || query.index === 'true'
					},
					{
						platform: query.platform,
						manufacturer: query.manufacturer,
						osVersion: query.osVersion,
						orientation: query.orientation,
						browserCode: query.browserCode,
						search: query.search,
						deviceType: query.deviceType
					}
				);
				response.set('Cache-Control', 'no-store');
				response.json(result);
			} catch (error) {
				safeErrorResponse(request, response, error);
			}
		});
	}

	// Device runtime control plane (Phase 21): availability board, sessions,
	// queue, honest fallbacks. Never downgrades a level silently.
	if (services.deviceRuntime) {
		const runtime = services.deviceRuntime;
		// Pre-register every environment on the availability board so the UI
		// can show honest execution type / availability before first use.
		if (typeof runtime.seedBoard === 'function' && services.environments?.list) {
			// RT2 (#14704): pass the real browser-support resolver so the board
			// reflects which browsers the local runtime can genuinely execute.
			const reseedBoard = () => Promise.resolve(services.environments.list({ limit: 80000 }))
				.then((rows) => runtime.seedBoard(Array.isArray(rows) ? rows : rows?.environments ?? [], { resolveBrowserSupport }))
				.catch(() => { /* board fills lazily via sessions */ });
			void reseedBoard();
			// RT2 (#14753): the board is LIVE, not boot-only. Re-run the
			// resolver on an interval so a capability change (binary removed /
			// installed, registry TTL re-probe) flips statuses within one
			// refresh interval. seedBoard preserves live sessions (BUSY/
			// RUNNING wins — never rewritten) so this is safe mid-flight.
			setInterval(() => { void reseedBoard(); }, 60_000).unref?.();
		}
		app.get('/api/device-runtime/devices', (request, response) => {
			response.json({
				devices: runtime.deviceBoard(),
				providers: runtime.providers
			});
		});
		app.post('/api/device-runtime/sessions', async (request, response) => {
			try {
				const body = request.body ?? {};
				let environment = body.environment ?? null;
				if (!environment && typeof body.environmentId === 'string') {
					environment = await services.environments.get(body.environmentId).catch(() => null);
				}
				const result = await runtime.requestSession({
					environment,
					requestedLevel: body.requestedLevel,
					linkedRunId: body.linkedRunId,
					linkedTestCaseId: body.linkedTestCaseId,
					allowQueue: body.allowQueue !== false
				});
				const statusByResult = { started: 201, queued: 202, busy: 409, not_available: 503, failed: 500 };
				response.status(statusByResult[result.status] ?? 200).json(result);
			} catch (error) {
				safeErrorResponse(request, response, error);
			}
		});
		app.get('/api/device-runtime/sessions', (request, response) => {
			response.json({ sessions: services.deviceRuntime.listSessions({ status: request.query?.status }) });
		});
		app.get('/api/device-runtime/sessions/:id', (request, response) => {
			const session = runtime.getSession(request.params.id);
			if (!session) {
				response.status(404).json({ error: 'Unknown device session.' });
				return;
			}
			response.json(session);
		});
		app.post('/api/device-runtime/sessions/:id/cancel', async (request, response) => {
			const result = await runtime.cancelSession(request.params.id);
			if (!result.cancelled) {
				response.status(409).json(result);
				return;
			}
			response.json(result);
		});
	}

	// Test cases with multi-environment assignment (Phase 4): /api/test-cases.
	if (services.testCases) {
		const testCaseRoutes = createTestCaseRoutes({
			testCases: services.testCases,
			runs: services.runs,
			autogen: services.testCaseAutogen ?? null,
			onError: safeErrorResponse
		});
		testCaseRoutes(app);
	}

	// Bug reports with BUG-XXXX ids + auto environment association (Phase 6).
	if (services.bugs) {
		createBugRoutes({
			bugs: services.bugs,
			onError: safeErrorResponse
		})(app);
	}

	// Matrix runs — one shared workflow across device/browser profiles
	// (#14633 NI02 Phase 1). The orchestrator binds to the session machinery
	// that lives in this closure (startTurn, resolveEnvironmentForRun).
	if (services.matrix) {
		// Engine follows the browser: firefox → Firefox engine, safari → WebKit,
		// everything else Chromium (the same mapping resolveExecution applies at
		// launch — this is just the session-level default tag).
		const engineForMatrixItem = (item) => {
			if (item.browserCode === 'firefox') return 'firefox';
			if (item.browserCode === 'safari') return 'webkit';
			return 'chromium';
		};
		const orchestrator = createMatrixOrchestrator(
			{ runs: services.runs, agent: services.agent, matrix: services.matrix, environments: services.environments },
			{
				// RT2 (#14704): pre-execution health gate — real engine/network/
				// emulation probes; a FAIL blocks the item with the exact reason.
				checkEnvironmentHealth,
				selectAutomaticEnvironment: async run => chooseAutomaticBrowser(services.environments, {
					...options.automaticBrowserOptions,
					health: options.automaticBrowserOptions?.health ?? (env => checkEnvironmentHealth(env, { targetUrl: run.targetUrl }))
				}),
				// Start a real session for the item — the same path
				// POST /api/sessions + message uses, so emulation, runtime gates,
				// findings, and reports behave identically for matrix items.
				startSession: async (matrixRun, item) => {
					const environment = await resolveEnvironmentForRun(services, item.environmentId);
					const session = await services.runs.create(
						`${matrixRun.title} — ${item.device} · ${item.browser} ${item.browserVersion}`,
						{
							device: DEFAULT_DEVICE_ID,
							engine: engineForMatrixItem(item),
							ownerUserId: matrixRun.ownerUserId ?? undefined,
							environmentId: environment.envId,
							environmentSnapshot: environment,
							testCaseId: item.testCaseId ?? matrixRun.items?.[0]?.testCaseId ?? undefined,
							selectedTests: matrixRun.selectedTests ?? undefined,
							securityAuthorization: matrixRun.securityAuthorization ?? undefined,
							scopeSelection: matrixRun.scopeSelection ?? undefined,
							matrixRunId: matrixRun.id
						}
					);
					return session;
				},
				sendTask: async (session, matrixRun, { signal } = {}) => {
					signal?.throwIfAborted();
					// #15043 (B1): QA-start runs carry their own kickoff text
					// (target URL + coverage message); test-case runs send the
					// raw target as before.
					const text = matrixRun.kickoffText ?? matrixRun.targetUrl;
					await services.runs.addMessage(session, { role: 'user', text });
					session.targetUrl = matrixRun.targetUrl;
					await services.runs.commit(session, 'session', { targetUrl: matrixRun.targetUrl });
					signal?.throwIfAborted();
					await services.agent.ensureRuntime(session);
					if (signal?.aborted) throw new Error('Run startup was cancelled before the agent turn began.');
					startTurn(session, { task: text });
				},
				// Pipeline Phase 3 (#15493): authorized auto-answer — resume a
				// paused child with the SAME session and turn machinery the
				// interactive /answer route uses, so policy-covered questions
				// (target permission, scan continuation) don't block an
				// unattended run.
				resumeSession: async (session, answer) => {
					if (!session?.pendingQuestion) return false;
					const text = String(answer ?? '').trim();
					if (!text) return false;
					await services.runs.addMessage(session, { role: 'user', text, kind: 'answer' });
					startTurn(session, { resumeAnswer: text });
					return true;
				},
				// Pipeline Phase 3 (#15493): browser hygiene — close the item's
				// child-session browser after every execution (suspend
				// semantics: the conversation survives; the process does not).
				closeSessionBrowser: async (session) => {
					await services.agent.closeBrowser(session.id, services.runs);
				},
				// #14650 (NI02 Phase 2): per-profile evidence — list the
				// artifacts the session ACTUALLY produced (screenshots/video
				// from the existing Phase-22 store). Empty list = none
				// captured; never fabricated.
				collectArtifacts: async (session) => {
					const list = services.artifacts?.list?.(session.id) ?? [];
					return list.map((meta) => ({
						artifactId: meta.artifactId,
						type: meta.type,
						contentType: meta.contentType,
						bytes: meta.bytes,
						capturedAt: meta.capturedAt,
						label: meta.label ?? null
					}));
				},
				// #14650 (NI02 Phase 2): known-defect fixtures verified per
				// profile — the ENGINE probes the fixture page under the
				// item's emulated context; verdicts record reproduced
				// TRUE/FALSE/NOT_VERIFIED with evidence, never a guess.
				// Note: listDefectFixtures() entries are summary-only (no
				// verify/affects functions) — resolve the FULL fixture by id
				// at verification time, never execute the stripped form.
				resolveEnvironment: (item) => resolveEnvironmentForRun(services, item.environmentId),
				verifyFixtures: listDefectFixtures(),
				runFixtureVerification: ({ fixture, environment }) => {
					const fullFixture = getDefectFixture(fixture?.id);
					if (!fullFixture) {
						return Promise.resolve({
							reproduced: 'NOT_VERIFIED',
							evidence: null,
							error: `Unknown fixture "${fixture?.id}".`,
							expected: 'NOT_VERIFIED'
						});
					}
					const baseUrl = process.env.QASE_PUBLIC_URL?.trim()
						|| `http://127.0.0.1:${Number(process.env.PORT ?? 5173)}`;
					// The full fixture (with its affects predicate) is resolved
					// HERE — the caller only ever sees the serializable summary,
					// so the expectation must be computed on the full object.
					return verifyFixtureAgainstProfile({ fixture: fullFixture, environment, baseUrl })
						.then((verdict) => ({
							...verdict,
							expected: fixtureExpectation(fullFixture, environment)
						}));
				},
			emit: (matrixRunId, payload) => {
				// #14649: matrix events ride the existing SSE run bus keyed by
				// matrix-run id. services.events.publish() re-targets a SESSION
				// aggregate (it stamps updatedAt on its first argument), so we
				// go through the raw run-store bus instead. Fan-out failures
				// must never stall execution — swallow + log.
				try {
					services.runs?.bus?.emit?.(matrixRunId, {
						type: payload.type,
						sessionId: matrixRunId,
						ts: Date.now(),
						...payload
					});
				} catch (error) {
					console.error('[matrix] event emit failed', matrixRunId, error);
				}
			}
		}
		);
		services.matrixOrchestrator = orchestrator;
		const admitSingleRun = createSingleRunAdmission({ matrix: services.matrix, orchestrator });
		// #14633 (NI02 Phase 1): clean up any matrix run a previous container
		// died mid-flight — dangling RUNNING items become ERROR "interrupted".
		orchestrator.resumeRecovery();
		// #15043 (B1): QA-start path — Start QA submits its selected
		// device–browser configurations here; one matrix run, one item per
		// configuration, honest statuses for everything not executable.
		app.post('/api/qa-matrix-runs', async (request, response) => {
			try {
				const body = request.body ?? {};
				const targetUrl = String(body.targetUrl ?? '').trim();
				if (!/^https?:\/\//i.test(targetUrl)) {
					response.status(400).json({ error: 'targetUrl must be an http(s) URL.' });
					return;
				}
				let envIds = Array.isArray(body.configurationEnvIds)
					? body.configurationEnvIds.map(String).filter(Boolean)
					: [];
				// The customer launcher always creates one runnable configuration.
				const isParentRequest = body.kind === 'parent';
				const automatic = body.browserMode === 'automatic' || (!body.browserMode && envIds.length === 0);
				if ((body.browserMode && !['automatic', 'custom'].includes(body.browserMode)) || isParentRequest || body.parentId || body.batchKey || (!automatic && envIds.length !== 1)) {
					response.status(422).json({ error: 'Choose exactly one browser and one device. Multiple configurations and batches are not supported in this launcher.' });
					return;
				}
				if (automatic && (envIds.length || isParentRequest || body.parentId || body.batchKey)) {
					response.status(422).json({ error: 'Automatic browser selection cannot be combined with custom configurations or batches.' });
					return;
				}
				// Validate the QA context exactly as POST /api/sessions does —
				// the same tests/scope/security rules apply to every item.
				let selectedTests;
				let securityAuthorization;
				try {
					selectedTests = validateQaSelectedTests(body.selectedTests);
					securityAuthorization = validateSecurityAuthorization(body.securityAuthorization, selectedTests);
				} catch (error) {
					response.status(422).json({ error: error instanceof Error ? error.message : String(error) });
					return;
				}
				let scopeSelection = null;
				if (body.scopeSelection !== undefined && body.scopeSelection !== null) {
					const { normalizeQaScopeSelection } = await import('../public/qaScopeCatalog.js');
					try {
						scopeSelection = normalizeQaScopeSelection(body.scopeSelection);
					} catch (error) {
						response.status(422).json({ error: error instanceof Error ? error.message : String(error) });
						return;
					}
				}
				const launchSingle = async () => {
					// Unknown envIds are NOT rejected here — the matrix service
					let browserSelection = null;
					if (automatic) {
						try {
							// Browser processes may only launch after scheduler admission.
							const chosen = await chooseAutomaticBrowser(services.environments, { ...options.automaticBrowserOptions, probe: false });
							envIds = [chosen.environment.envId];
							browserSelection = chosen.selection;
						} catch (error) {
							if (error.code !== 'AUTOMATIC_BROWSER_UNAVAILABLE') throw error;
							return { status: 503, body: { error: error.message } };
						}
					}
					if (!orchestrator.canStartImmediately()) return { status: 503, body: { code: 'QA_CAPACITY_BUSY', error: 'The test service is busy. No run was queued. Please try again shortly.' } };
					const record = await services.matrix.create({
						browserSelection,
						title: String(body.title ?? `QA run — ${targetUrl}`).slice(0, 120),
						targetUrl,
						testCaseId: body.testCaseId,
						configurationEnvIds: envIds,
						kickoffText: body.kickoffText,
						selectedTests,
						securityAuthorization,
						scopeSelection
					}, { ownerUserId: request.auth?.userId ?? null });
					const started = orchestrator.start(record.id);
					if (!started.ok) {
						return { status: 409, body: { error: started.error } };
					}
					return { status: 201, body: await services.matrix.get(record.id) };
				};
				const result = await admitSingleRun(request.auth?.userId ?? null, launchSingle);
				if (result && !response.headersSent) {
					if (result.status === 503 || result.status === 409) response.set('Retry-After', '15');
					response.status(result.status).json(result.body);
				}
			} catch (error) {
				safeErrorResponse(request, response, error);
			}
		});
		createMatrixRoutes({
			matrix: services.matrix,
			orchestrator,
			bugs: services.bugs,
			onError: safeErrorResponse,
			// Pipeline Phase 5 (#15500): matrix SSE transport — the results
			// board subscribes for push updates on /api/matrix-runs/:id/events.
			events: services.events
		})(app);
	}

	// Coverage dashboard aggregation (Phase 7): cases × environments × runs.
	if (services.coverage) {
		app.get('/api/coverage', async (request, response) => {
			try {
				const payload = await services.coverage.snapshot();
				// Read-your-write matters for the dashboard (a run just finished
				// must appear immediately), so never cache the snapshot.
				response.set('Cache-Control', 'no-store');
				response.json(payload);
			} catch (error) {
				safeErrorResponse(request, response, error);
			}
		});
	}

	app.get('/api/environments', async (request, response) => {
		try {
			const query = request.query;
			const limit = query.limit === undefined ? undefined : Number(query.limit);
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 80000)) {
				response.status(400).json({ error: 'limit must be an integer from 1 through 80000.' });
				return;
			}
			const offset = query.offset === undefined ? undefined : Number(query.offset);
			if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
				response.status(400).json({ error: 'offset must be a non-negative integer.' });
				return;
			}
			const rows = await services.environments.list(query);
			const total = (await services.environments.facets(query)).total;
			// Read-your-write matters for the admin UI (edit → refresh must show
			// the new value), so the environment list is never cached.
			response.set('Cache-Control', 'no-store');
			response.json({ total, count: rows.length, environments: rows });
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	// Facet counts per filter dimension for the admin UI dropdowns.
	app.get('/api/environments/facets', async (request, response) => {
		try {
			response.set('Cache-Control', 'no-store');
			response.json(await services.environments.facets(request.query));
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	// Browser availability per platform, including why unavailable browsers
	// (Brave, DuckDuckGo, Firefox-on-iOS) are excluded from the matrix.
	// #14632: short cache — verdicts recompute per call server-side and must
	// not survive a provider-credential change on the client for long.
	app.get('/api/environments/availability', (_request, response) => {
		response.set('Cache-Control', 'private, max-age=30');
		response.json(services.environments.availability());
	});

	// #14648: read-only catalog metadata — version, registered
	// providers with connected/rowCount, generatedAt (incl. live browser
	// support report). No secrets, ever. Registered earlier (before the
	// /api/catalog/:entity wildcard) when the device catalog is attached.
	app.get('/api/catalog/meta', async (_request, response) => {
		try {
			const { catalogProviderMeta } = await import('./catalogProviderRegistry.js');
			response.set('Cache-Control', 'no-store');
			response.json(await catalogProviderMeta());
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	// #14275 (Phase 2): admin-gated manual catalog refresh — re-fetches
	// provider overlays (provider rows only; builtin rows are untouchable).
	app.post('/api/catalog/refresh', async (request, response) => {
		try {
			const identity = request.auth;
			const isAdmin = !identity?.role || ['owner', 'admin'].includes(identity.role);
			if (!isAdmin) {
				response.status(403).json({ error: 'Catalog refresh requires an admin session.' });
				return;
			}
			const result = await services.environments.refreshCatalog();
			response.json(result);
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	// Bulk environment operations (Phase 3 device matrix UI). Mounted BEFORE
	// /api/environments/:envId so the literal "bulk" segment isn't treated as an id.
	app.post('/api/environments/bulk', async (request, response) => {
		try {
			const body = request.body ?? {};
			const result = await services.environments.bulkCreate(body.combinations ?? []);
			response.status(201).json(result);
		} catch (error) {
			if (error?.code === 'QASE_ENVIRONMENT_INVALID') {
				response.status(422).json({ error: error.message });
				return;
			}
			safeErrorResponse(request, response, error);
		}
	});

	app.post('/api/environments/bulk-toggle', async (request, response) => {
		try {
			const body = request.body ?? {};
			if (!Array.isArray(body.envIds)) {
				response.status(400).json({ error: 'envIds must be an array.' });
				return;
			}
			if (body.envIds.length > 1000) {
				response.status(400).json({ error: 'envIds is limited to 1000 entries per request.' });
				return;
			}
			const active = body.active !== false;
			const result = await services.environments.bulkToggleActive(body.envIds, active);
			response.json(result);
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	app.get('/api/environments/:envId', async (request, response) => {
		try {
			const environment_ = await services.environments.get(request.params.envId);
			if (!environment_) {
				response.status(404).json({ error: 'Unknown environment.' });
				return;
			}
			response.set('Cache-Control', 'private, max-age=60');
			response.json(environment_);
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	app.post('/api/environments', async (request, response) => {
		try {
			const created = await services.environments.create(request.body ?? {});
			response.status(201).json(created);
		} catch (error) {
			if (error?.code === 'QASE_ENVIRONMENT_INVALID') {
				response.status(422).json({ error: error.message });
				return;
			}
			if (error?.code === 'QASE_ENVIRONMENT_CONFLICT') {
				response.status(409).json({ error: error.message, envId: error.envId });
				return;
			}
			safeErrorResponse(request, response, error);
		}
	});

	app.patch('/api/environments/:envId', async (request, response) => {
		try {
			const patch = request.body ?? {};
			if (typeof patch.active !== 'boolean' && patch.active !== undefined) {
				response.status(400).json({ error: 'active must be a boolean.' });
				return;
			}
			if (patch.executionProvider !== undefined && !['local', 'browserstack'].includes(patch.executionProvider)) {
				response.status(400).json({ error: 'executionProvider must be "environment" or "local".' });
				return;
			}
			if (patch.executionLevelRequested !== undefined && patch.executionLevelRequested !== null
				&& !['REAL_DEVICE', 'VIRTUAL_DEVICE', 'SIMULATED'].includes(patch.executionLevelRequested)) {
				response.status(400).json({ error: 'executionLevelRequested must be REAL_DEVICE, VIRTUAL_DEVICE or SIMULATED.' });
				return;
			}
			if (patch.orientation !== undefined && patch.orientation !== null && !['portrait', 'landscape'].includes(patch.orientation)) {
				response.status(400).json({ error: 'orientation must be "portrait" or "landscape".' });
				return;
			}
			if (patch.description !== undefined && patch.description !== null && typeof patch.description !== 'string') {
				response.status(400).json({ error: 'description must be a string.' });
				return;
			}
			const updated = await services.environments.update(request.params.envId, patch);
			if (!updated) {
				response.status(404).json({ error: 'Unknown environment.' });
				return;
			}
			response.json(updated);
		} catch (error) {
			// Phase 20 scenario validation errors are user input errors, not 500s.
			if (error?.code === 'QASE_ENVIRONMENT_INVALID') {
				response.status(422).json({ error: error.message });
				return;
			}
			safeErrorResponse(request, response, error);
		}
	});

	// Delete a saved environment (Phase 10 drawer). Test cases / runs keep their
	// envId references; history is never rewritten.
	app.delete('/api/environments/:envId', async (request, response) => {
		try {
			const deleted = await services.environments.remove(request.params.envId);
			if (!deleted) {
				response.status(404).json({ error: 'Unknown environment.' });
				return;
			}
			response.json({ deleted: true, envId: request.params.envId });
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
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
		try {
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
			let selectedTests;
			let securityAuthorization;
			try {
				selectedTests = validateQaSelectedTests(request.body?.selectedTests);
				securityAuthorization = validateSecurityAuthorization(request.body?.securityAuthorization, selectedTests);
			} catch (error) {
				response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid test selection.' });
				return;
			}
			const environment = await resolveEnvironmentForRun(services, request.body?.environmentId);
			const testCase = await resolveTestCaseForRun(services, request.body?.testCaseId, environment?.envId);
			const cohort = cohortFor(request.auth?.role).cohort;
			const scopeSelection = normalizeQaScopeSelection(request.body?.scopeSelection);
			const session = await services.runs.create(
				engine === 'chromium' ? undefined : `QA — ${engine}`,
				{
					device, deviceLandscape, engine, ownerUserId: request.auth?.userId,
					cohort, selectedTests, securityAuthorization,
					...(scopeSelection ? { scopeSelection } : {}),
					environmentId: environment?.envId,
					environmentSnapshot: environment,
					testCaseId: testCase?.caseNumber,
					testCaseSnapshot: testCase,
					...(scopeSelection ? { scopeSelection } : {})
				}
			);
			track('run_created', { mode: session.mode, ...cohortFor(request.auth?.role) });
			response.status(201).json(session);
		} catch (error) {
			safeErrorResponse(request, response, error);
		}
	});

	app.post('/api/sqa/sessions', async (request, response) => {
		let session;
		try {
			const sqa = publicInput(() => createSqaState(request.body ?? {}));
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
			const environment = await resolveEnvironmentForRun(services, request.body?.environmentId);
			const executionEngine = await preflightSqaRuntime({ environment, engine });
			session = await services.runs.create(`SQA — ${sqa.scope.target.name}`, {
				device, deviceLandscape, engine: executionEngine, ownerUserId: request.auth?.userId,
				cohort: cohortFor(request.auth?.role).cohort,
				environmentId: environment?.envId, environmentSnapshot: environment
			});
			session.mode = 'sqa';
			session.sqa = sqa;
			session.todos = createSqaTodoPlan(sqa);
			session.device = device;
			session.deviceLandscape = deviceLandscape;
			session.environmentId = environment?.envId;
			session.environmentSnapshot = environment;
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
			// Detected project context is resolved server-side (never from the body)
			// so the launcher cannot inject untrusted Studio or findings data.
			const detectedContext = await founderDetectedContext(request);
			const founder = publicInput(() => createFounderState({
				authorizationConfirmed: request.body?.authorizationConfirmed,
				target: request.body?.target,
				productContext: request.body?.productContext,
				projectContext: detectedContext
			}));
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			const engine = isEngineId(request.body?.engine) ? request.body.engine : 'chromium';
			const environment = await resolveEnvironmentForRun(services, request.body?.environmentId);
			session = await services.runs.create(`Founder — ${founder.scope.target.name}`, {
				device, deviceLandscape, engine, ownerUserId: request.auth?.userId,
				cohort: cohortFor(request.auth?.role).cohort,
				environmentId: environment?.envId, environmentSnapshot: environment
			});
			session.mode = 'founder';
			session.founder = founder;
			session.todos = createFounderReviewTodos();
			session.device = device;
			session.deviceLandscape = deviceLandscape;
			session.environmentId = environment?.envId;
			session.environmentSnapshot = environment;
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
				Promise.resolve().then(() => services.artifacts?.removeAll(session.id)),
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
				const probe = await (options.probeTargetReachability ?? probeTargetReachability)(url, { environment });
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
			await services.agent.ensureRuntime(session);
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

	// Phase 22: evidence artifacts with environment + execution-level metadata.
	app.get('/api/sessions/:id/artifacts', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		response.json({ artifacts: services.artifacts?.list(session.id) ?? [] });
	});

	app.get('/api/sessions/:id/artifacts/:artifactId', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const found = services.artifacts?.get(session.id, request.params.artifactId);
		if (!found) {
			response.status(404).json({ error: 'Unknown artifact.' });
			return;
		}
		response.set('Content-Type', found.meta.contentType);
		response.set('X-Qase-Execution-Level', found.meta.executionLevel ?? 'UNKNOWN');
		response.set('X-Qase-Execution-Provider', found.meta.executionProvider ?? 'unknown');
		response.send(found.bytes);
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
			markdown = services.reports.buildMarkdown(await attachMatrixCoverage(await attachUserFeedback(session, request.auth?.userId)));
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
