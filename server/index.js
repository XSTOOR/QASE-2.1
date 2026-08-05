import 'dotenv/config';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { closeBrowser, ensureRuntime, runTurn } from './agent.js';
import { createAuthentication, securityHeaders } from './auth.js';
import { getPublicConfig, saveConfig, testConnection } from './config.js';
import { mountDemoSite } from './demoSite.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, secretNames, storeSecrets } from './secrets.js';
import {
	addMessage, bus, createSession, deleteSession, emit, getSession,
	listSessions, liveFor, loadSessions, setStatus
} from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
if (String(process.env.QASE_TRUST_PROXY ?? '').toLowerCase() === 'true') {
	app.set('trust proxy', 1);
}
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, '..', 'public')));

// A deliberately broken practice site to point a first run at.
mountDemoSite(app);

loadSessions();

// Authentication routes stay public; the middleware installed after them
// protects every existing /api route, including SSE and report downloads.
const authentication = createAuthentication();
authentication.mount(app);

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

function requireSession(request, response) {
	const session = getSession(request.params.id);
	if (!session) {
		response.status(404).json({ error: 'No such session.' });
		return undefined;
	}
	return session;
}

/** Runs a turn detached: the HTTP call returns at once, progress arrives by SSE. */
function startTurn(session, options) {
	runTurn(session, options).catch(error => {
		const message = error instanceof Error ? error.message : String(error);
		addMessage(session, { role: 'system', text: message, kind: 'error' });
		setStatus(session, 'error', message);
	});
}

app.get('/api/config', (_request, response) => {
	response.json(getPublicConfig());
});

/**
 * Saves model settings. Runtimes capture their configuration at construction,
 * so idle sessions are torn down and rebuilt on their next turn; a session
 * mid-run keeps the settings it started with.
 */
app.put('/api/config', (request, response) => {
	try {
		const config = saveConfig(request.body ?? {});
		let kept = 0;
		for (const summary of listSessions()) {
			const record = liveFor(summary.id);
			if (!record.runtime) {
				continue;
			}
			if (record.running) {
				kept++;
				continue;
			}
			record.dispose?.();
			delete record.runtime;
			delete record.bridge;
			delete record.dispose;
		}
		response.json({ ...config, runsKeepingOldSettings: kept });
	} catch (error) {
		response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
	}
});

/** Probes the configured endpoint so a wrong URL or key surfaces before a run. */
app.post('/api/config/test', async (request, response) => {
	response.json(await testConnection(request.body ?? {}));
});

app.get('/api/sessions', (_request, response) => {
	response.json(listSessions());
});

app.post('/api/sessions', (_request, response) => {
	response.status(201).json(createSession());
});

app.get('/api/sessions/:id', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	const record = liveFor(session.id);
	response.json({
		...session,
		secretNames: secretNames(session.id),
		running: Boolean(record.running),
		frame: record.bridge?.getLastFrame?.()
	});
});

app.delete('/api/sessions/:id', (request, response) => {
	clearSecrets(request.params.id);
	response.json({ deleted: deleteSession(request.params.id) });
});

/** The chat entry point: a URL starts a run, anything else steers the current one. */
app.post('/api/sessions/:id/message', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	const text = String(request.body?.text ?? '').trim();
	if (!text) {
		response.status(400).json({ error: 'Message is empty.' });
		return;
	}
	if (liveFor(session.id).running) {
		response.status(409).json({ error: 'The agent is still working. Stop it before sending another instruction.' });
		return;
	}

	addMessage(session, { role: 'user', text });

	const url = extractUrl(text);
	if (url && !session.targetUrl) {
		session.targetUrl = url;
		session.title = new URL(url).host;
		emit(session, 'session', { targetUrl: url, title: session.title });
	}

	try {
		ensureRuntime(session);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		addMessage(session, { role: 'system', text: message, kind: 'error' });
		setStatus(session, 'error', message);
		response.status(500).json({ error: message });
		return;
	}

	// A pending question means the user typed instead of using the answer form.
	const pending = session.pendingQuestion;
	startTurn(session, pending ? { resumeAnswer: text } : { task: text });
	response.json({ ok: true });
});

/** Answers a blocking ask_question with a plain option or free-text reply. */
app.post('/api/sessions/:id/answer', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	if (!session.pendingQuestion) {
		response.status(409).json({ error: 'Nothing is waiting on an answer.' });
		return;
	}
	const answer = String(request.body?.answer ?? '').trim();
	if (!answer) {
		response.status(400).json({ error: 'Answer is empty.' });
		return;
	}
	addMessage(session, { role: 'user', text: answer, kind: 'answer' });
	startTurn(session, { resumeAnswer: answer });
	response.json({ ok: true });
});

/**
 * Answers a credential question without the values ever reaching the model.
 * They go into the session vault; the agent gets placeholder names back.
 */
app.post('/api/sessions/:id/credentials', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	if (!session.pendingQuestion) {
		response.status(409).json({ error: 'Nothing is waiting on an answer.' });
		return;
	}

	const fields = request.body?.fields;
	if (!fields || typeof fields !== 'object' || Object.keys(fields).length === 0) {
		response.status(400).json({ error: 'No credentials supplied.' });
		return;
	}

	const names = storeSecrets(session.id, fields);
	if (names.length === 0) {
		response.status(400).json({ error: 'No usable credentials supplied.' });
		return;
	}
	session.secretNames = secretNames(session.id);

	const note = String(request.body?.note ?? '').trim();
	const placeholders = names.map(name => `{{${name}}}`).join(', ');
	const answer = [
		`The credentials are stored in the host vault. You will not be shown the values.`,
		`Fill the sign-in form using these literal placeholders as the browser_fill value: ${placeholders}.`,
		`The host substitutes the real secret at the keyboard. Never print, repeat or report a credential value.`,
		note && `Note from the user: ${note}`
	].filter(Boolean).join(' ');

	addMessage(session, {
		role: 'user',
		kind: 'credentials',
		text: `Provided ${names.length} credential${names.length === 1 ? '' : 's'} securely: ${placeholders}`
	});
	emit(session, 'secrets', { secretNames: session.secretNames });

	startTurn(session, { resumeAnswer: answer });
	response.json({ ok: true, secretNames: names });
});

app.post('/api/sessions/:id/stop', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	liveFor(session.id).controller?.abort();
	response.json({ ok: true });
});

app.get('/api/sessions/:id/report.md', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}
	response.type('text/markdown').send(buildReportMarkdown(session));
});

/** Server-sent events: one stream per session, carrying state and browser frames. */
app.get('/api/sessions/:id/events', (request, response) => {
	const session = requireSession(request, response);
	if (!session) {
		return;
	}

	response.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no'
	});
	response.write(': connected\n\n');

	const send = event => {
		response.write(`data: ${JSON.stringify(event)}\n\n`);
	};
	bus.on(session.id, send);

	// Reconnecting clients want the last frame immediately, not in 300ms.
	const frame = liveFor(session.id).bridge?.getLastFrame?.();
	if (frame) {
		send({ type: 'frame', sessionId: session.id, frame });
	}

	let closed = false;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		bus.off(session.id, send);
	};
	const heartbeat = setInterval(() => {
		if (!authentication.isSessionActive(request.auth?.sessionId)) {
			cleanup();
			response.end();
			return;
		}
		response.write(': ping\n\n');
	}, 15_000);
	request.on('close', cleanup);
});

app.use('/api', (_request, response) => {
	response.status(404).json({ error: 'API route not found.' });
});

app.use((error, _request, response, next) => {
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
	console.error('[Qase server]', error instanceof Error ? error.message : String(error));
	response.status(500).json({ error: 'Unexpected server error.' });
});

// Chromium is a child process; without this it outlives the server that
// started it and the user is left closing browsers by hand.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		if (shuttingDown) {
			process.exit(1);
		}
		shuttingDown = true;
		await Promise.all(listSessions().map(summary => {
			liveFor(summary.id).controller?.abort();
			return closeBrowser(summary.id);
		}));
		process.exit(0);
	});
}

const port = Number(process.env.PORT ?? 5173);
const host = String(process.env.QASE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
app.listen(port, host, () => {
	const config = getPublicConfig();
	console.log(`\n  Qase — autonomous QA agent`);
	console.log(`  http://${host}:${port}`);
	console.log(`  ${config.provider} · ${config.model}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`);
	console.log(`  practice target: http://${host}:${port}/demo  (demo@qase.dev / demo1234)\n`);
	if (config.problem) {
		console.log(`  ! ${config.problem} Set it in the dashboard under Settings, or in .env.\n`);
	}
});
