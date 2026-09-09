import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createInstanceAccess, securityHeaders } from './instanceAccess.js';
import { isDeviceId, DEFAULT_DEVICE_ID, publicDeviceProfile, DEVICE_PROFILES } from './deviceProfiles.js';
import { assertApplicationServices } from './contracts.js';
import { mountDemoSite } from './demoSite.js';
import { createOperationalControls } from './operations.js';
import { runWithRequestActor } from './requestActor.js';
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
import { createSqaState, createSqaTodoPlan, publicSqaCatalog, recordReviewerSqaObservation } from './sqaService.js';
import { renderReportPdf } from './reportPdf.js';
import { buildAllFixPromptsMarkdown } from './fixPromptBuilder.js';
import {
	AuthError,
	clearAuthCookies,
	requestAuthToken,
	requestCookieCsrfToken,
	requestCsrfToken,
	setAuthCookies
} from './auth.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i;

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

	const app = express();
	app.disable('x-powered-by');
	app.locals.qaseDemoEnabled = demoEnabled;
	app.locals.qaseFrameAncestors = configuredFrameAncestors(environment);
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
	const safeCookies = request => Boolean(request.secure || request.headers['x-forwarded-proto'] === 'https'
		|| String(environment.NODE_ENV ?? '').toLowerCase() === 'production');
	app.use('/api/auth', (_request, response, next) => {
		response.set('Cache-Control', 'no-store');
		next();
	});
	app.use('/api', (request, response, next) => {
		const publicAuthRoute = request.path === '/auth/register' || request.path === '/auth/login';
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
		const status = error instanceof AuthError ? error.status : 400;
		response.status(status).json({ error: error instanceof Error ? error.message : 'Authentication failed.' });
	}

	app.post('/api/auth/register', async (request, response) => {
		if (!authService) { response.status(404).json({ error: 'Authentication is not configured.' }); return; }
		try {
			const result = await authService.register(request.body ?? {});
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

	app.get('/api/config', (_request, response) => {
		response.json(services.configuration.getPublic());
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
			const config = services.configuration.save(request.body ?? {});
			const kept = await services.agent.invalidateIdleRuntimes();
			response.json({ ...config, runsKeepingOldSettings: kept });
		} catch (error) {
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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

	app.get('/api/sessions', async (request, response) => {
		const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			response.status(400).json({ error: 'limit must be an integer from 1 through 100.' });
			return;
		}
		response.json(await services.runs.list({ limit }));
	});

	app.post('/api/sessions', async (request, response) => {
		const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
		const deviceLandscape = request.body?.deviceLandscape === true;
		const session = await services.runs.create(undefined, { device, deviceLandscape, ownerUserId: request.auth?.userId });
		response.status(201).json(session);
	});

	app.post('/api/sqa/sessions', async (request, response) => {
		let session;
		try {
			const sqa = createSqaState(request.body ?? {});
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			session = await services.runs.create(`SQA — ${sqa.scope.target.name}`, { device, deviceLandscape, ownerUserId: request.auth?.userId });
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
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post('/api/founder/sessions', async (request, response) => {
		let session;
		try {
			// Tenant and actor identity always come from trusted per-instance
			// context. Only the explicit Founder review scope crosses this boundary.
			const founder = createFounderState({
				authorizationConfirmed: request.body?.authorizationConfirmed,
				target: request.body?.target,
				productContext: request.body?.productContext
			});
			const device = isDeviceId(request.body?.device) ? request.body.device : DEFAULT_DEVICE_ID;
			const deviceLandscape = request.body?.deviceLandscape === true;
			session = await services.runs.create(`Founder — ${founder.scope.target.name}`, { device, deviceLandscape, ownerUserId: request.auth?.userId });
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
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.get('/api/sessions/:id', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;
		const liveState = services.agent.getLiveState(session.id);
		response.json({
			...session,
			secretNames: await services.secrets.names(session.id),
			running: liveState.running,
			frame: liveState.frame
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
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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
			session.title = new URL(url).host;
			if (session.mode === 'founder' && session.founder?.scope?.target) {
				session.founder.scope.target.url = url;
				session.founder.updatedAt = new Date().toISOString();
			}
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
		const markdown = session.mode === 'sqa'
			? buildSqaReportMarkdown(session.sqa.assessment)
			: session.mode === 'founder'
				? buildFounderReportMarkdown(session)
				: services.reports.buildMarkdown(session);
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
			const pdf = await renderReportPdf(session);
			response.setHeader('Content-Type', 'application/pdf');
			response.setHeader('Content-Disposition', 'attachment; filename="qase-' + (session.mode || 'qa') + '-report.pdf"');
			response.send(pdf);
		} catch (error) {
			const status = error?.code === 'QASE_PDF_BROWSER_UNAVAILABLE' ? 503 : 500;
			response.status(status).json({ error: error?.message ?? 'PDF rendering failed.' });
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
		if (!closed) heartbeat = setInterval(() => write(': ping\n\n'), heartbeatMs);
	});

	app.use('/api', (_request, response) => {
		response.status(404).json({ error: 'API route not found.' });
	});

	app.use((error, request, response, next) => {
		if (response.headersSent) {
			next(error);
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
