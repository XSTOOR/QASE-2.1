import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuthentication, securityHeaders } from './auth.js';
import { assertApplicationServices } from './contracts.js';
import { mountDemoSite } from './demoSite.js';
import { createOperationalControls } from './operations.js';
import { runWithRequestActor } from './requestActor.js';

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

/**
 * Creates the HTTP application without listening or installing process signal
 * handlers. Startup stays in index.js; tests can provide in-memory services.
 */
export function createApplication(options = {}) {
	const services = assertApplicationServices(options.services);
	const environment = options.environment ?? process.env;
	const authentication = options.authentication ?? createAuthentication();
	const demoEnabled = environment.NODE_ENV !== 'production'
		&& (options.demoEnabled ?? String(environment.QASE_ENABLE_DEMO ?? '').toLowerCase() !== 'false');
	const heartbeatMs = Math.max(1_000, Number(options.sseHeartbeatMs) || 15_000);
	const publicDirectory = options.publicDirectory ?? path.join(here, '..', 'public');
	const operations = options.operations ?? createOperationalControls({ environment });
	const activeTurns = new Set();

	const app = express();
	app.disable('x-powered-by');
	app.locals.qaseDemoEnabled = demoEnabled;
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

	app.use(express.json({ limit: '1mb' }));
	app.use(express.static(publicDirectory));
	if (demoEnabled) {
		mountDemoSite(app);
	}

	// Authentication routes stay public; middleware installed after them protects
	// every application API route, including reports and event streams.
	authentication.mount(app);
	app.use('/api', (request, _response, next) => runWithRequestActor({
		...request.auth,
		requestId: request.qaseRequestId
	}, next));

	async function requireSession(request, response) {
		const session = await services.runs.get(request.params.id);
		if (!session) {
			response.status(404).json({ error: 'No such session.' });
			return undefined;
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
			const message = error instanceof Error ? error.message : String(error);
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

	app.get('/api/sessions', async (_request, response) => {
		response.json(await services.runs.list());
	});

	app.post('/api/sessions', async (_request, response) => {
		response.status(201).json(await services.runs.create());
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

	app.delete('/api/sessions/:id', async (request, response) => {
		const session = await services.runs.get(request.params.id);
		if (!session) {
			response.json({ deleted: false });
			return;
		}
		if (services.agent.isRemote) await services.agent.stop(session.id);
		const deleted = await services.runs.delete(session.id);
		if (deleted) await services.secrets.clear(session.id);
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

		await services.runs.addMessage(session, { role: 'user', text });
		const url = extractUrl(text);
		if (url && !session.targetUrl) {
			session.targetUrl = url;
			session.title = new URL(url).host;
			await services.runs.commit(session, 'session', { targetUrl: url, title: session.title });
		}

		try {
			services.agent.ensureRuntime(session);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
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
		const answer = String(request.body?.answer ?? '').trim();
		if (!answer) {
			response.status(400).json({ error: 'Answer is empty.' });
			return;
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
		response.type('text/markdown').send(services.reports.buildMarkdown(session));
	});

	app.get('/api/sessions/:id/events', async (request, response) => {
		const session = await requireSession(request, response);
		if (!session) return;

		response.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no'
		});
		response.write(': connected\n\n');

		const send = event => response.write(`data: ${JSON.stringify(event)}\n\n`);
		const unsubscribe = services.events.subscribe(session.id, send);

		const frame = services.agent.getLiveState(session.id).frame;
		if (frame) {
			send({ type: 'frame', sessionId: session.id, frame });
		}

		let closed = false;
		let checkingSession = false;
		const cleanup = () => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			unsubscribe();
		};
		const heartbeat = setInterval(async () => {
			if (checkingSession) return;
			checkingSession = true;
			try {
				if (!await authentication.isSessionActive(
					request.auth?.sessionReference ?? request.auth?.sessionId
				)) {
					cleanup();
					response.end();
					return;
				}
				response.write(': ping\n\n');
			} catch {
				cleanup();
				response.end();
			} finally {
				checkingSession = false;
			}
		}, heartbeatMs);
		request.on('close', cleanup);
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
		console.error(`[Qase server ${request.qaseRequestId ?? 'no-request-id'}]`, error instanceof Error ? error.message : String(error));
		response.status(500).json({ error: 'Unexpected server error.' });
	});

	return {
		app,
		authentication,
		demoEnabled,
		services,
		operations,
		whenIdle: () => Promise.allSettled([...activeTurns])
	};
}
