import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createAuthentication } from './auth.js';

function createMemoryServices(options = {}) {
	const sessions = new Map();
	const live = new Map();
	const vaults = new Map();
	const listeners = new Map();
	let config = {
		provider: 'custom', model: 'test-model', ready: true,
		hasApiKey: true, apiKeyHint: '••••test'
	};

	const state = {
		loadCalls: 0,
		ensureCalls: [],
		runCalls: [],
		closeCalls: [],
		events: [],
		configTests: [],
		ready: options.ready ?? true,
		ensureError: undefined,
		liveFor,
		listenerCount(sessionId) {
			return listeners.get(sessionId)?.size ?? 0;
		}
	};

	function createSession(title = 'New test run') {
		const now = Date.now();
		const session = {
			id: randomUUID(),
			title,
			createdAt: now,
			updatedAt: now,
			status: 'idle',
			targetUrl: undefined,
			messages: [],
			activities: [],
			findings: [],
			todos: [],
			report: undefined,
			pendingQuestion: undefined,
			contextUsage: undefined,
			secretNames: []
		};
		sessions.set(session.id, session);
		return session;
	}

	function liveFor(id) {
		let record = live.get(id);
		if (!record) {
			record = {};
			live.set(id, record);
		}
		return record;
	}

	function publish(session, type, payload = {}) {
		const event = { type, sessionId: session.id, ts: Date.now(), ...payload };
		state.events.push(event);
		for (const listener of listeners.get(session.id) ?? []) listener(event);
	}

	const services = {
		runs: {
			load() {
				state.loadCalls++;
			},
			create: createSession,
			get: id => sessions.get(id),
			list: () => [...sessions.values()]
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map(session => ({
					id: session.id,
					title: session.title,
					status: session.status,
					targetUrl: session.targetUrl,
					createdAt: session.createdAt,
					updatedAt: session.updatedAt,
					findingCount: session.findings.length,
					messageCount: session.messages.length
				})),
			delete(id) {
				liveFor(id).dispose?.();
				live.delete(id);
				return sessions.delete(id);
			},
			addMessage(session, message) {
				const entry = { id: randomUUID(), ts: Date.now(), ...message };
				session.messages.push(entry);
				publish(session, 'message', { message: entry });
				return entry;
			},
			setStatus(session, status, detail) {
				session.status = status;
				publish(session, 'status', { status, detail });
			}
		},
		events: {
			publish,
			subscribe(sessionId, listener) {
				let group = listeners.get(sessionId);
				if (!group) {
					group = new Set();
					listeners.set(sessionId, group);
				}
				group.add(listener);
				return () => {
					group.delete(listener);
					if (group.size === 0) listeners.delete(sessionId);
				};
			}
		},
		configuration: {
			getPublic: () => ({ ...config }),
			save(patch) {
				config = { ...config, ...patch };
				return { ...config };
			},
			testConnection(candidate) {
				state.configTests.push(candidate);
				return Promise.resolve({ ok: true, models: ['test-model'] });
			}
		},
		secrets: {
			clear: id => vaults.delete(id),
			names: id => [...(vaults.get(id)?.keys() ?? [])],
			store(id, entries) {
				let vault = vaults.get(id);
				if (!vault) {
					vault = new Map();
					vaults.set(id, vault);
				}
				const names = [];
				for (const [name, value] of Object.entries(entries)) {
					if (typeof value !== 'string' || value.length === 0) continue;
					const normalized = name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
					vault.set(normalized, value);
					names.push(normalized);
				}
				return names;
			}
		},
		reports: {
			buildMarkdown: session => `# QA report\n\nRun: ${session.title}`
		},
		agent: {
			ensureRuntime(session) {
				state.ensureCalls.push(session.id);
				if (state.ensureError) throw state.ensureError;
				liveFor(session.id).runtime ??= {};
			},
			runTurn(session, turnOptions) {
				state.runCalls.push({ sessionId: session.id, options: turnOptions });
				return options.runTurn?.(session, turnOptions) ?? Promise.resolve();
			},
			closeBrowser(id) {
				state.closeCalls.push(id);
				return Promise.resolve();
			},
			getLiveState(id) {
				const record = liveFor(id);
				return { running: Boolean(record.running), frame: record.bridge?.getLastFrame?.() };
			},
			stop(id) {
				liveFor(id).controller?.abort();
			},
			invalidateIdleRuntimes() {
				let kept = 0;
				for (const session of sessions.values()) {
					const record = liveFor(session.id);
					if (!record.runtime) continue;
					if (record.running) {
						kept++;
						continue;
					}
					record.dispose?.();
					delete record.runtime;
					delete record.bridge;
					delete record.dispose;
				}
				return kept;
			}
		},
		readiness: {
			check: () => ({
				ready: state.ready,
				checks: { testStore: state.ready ? 'ready' : 'initializing' }
			})
		}
	};

	return { services, state };
}

function createTestAuthentication({ authenticated = true } = {}) {
	return {
		mount(app) {
			app.get('/api/auth/session', (_request, response) => {
				response.json({ authenticated, configured: true });
			});
			app.use('/api', (request, response, next) => {
				if (!authenticated) {
					response.status(401).json({ error: 'Authentication required.' });
					return;
				}
				request.auth = { email: 'owner@example.com', sessionId: 'test-session' };
				next();
			});
		},
		isSessionActive: () => authenticated
	};
}

async function startFixture(options = {}) {
	const memory = options.memory ?? createMemoryServices(options);
	const application = createApplication({
		services: memory.services,
		authentication: options.authentication ?? createTestAuthentication(),
		demoEnabled: options.demoEnabled,
		environment: options.environment ?? {},
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const address = server.address();
	const origin = `http://127.0.0.1:${address.port}`;

	async function request(path, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		let body = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(requestOptions.json);
		}
		return fetch(`${origin}${path}`, { ...requestOptions, headers, body });
	}

	async function close() {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
	}

	return { ...memory, ...application, server, origin, request, close };
}

async function body(response) {
	return response.json();
}

test('application construction has no startup side effects and validates its service contract', () => {
	const memory = createMemoryServices();
	const application = createApplication({
		services: memory.services,
		authentication: createTestAuthentication(),
		demoEnabled: false
	});
	assert.equal(memory.state.loadCalls, 0);
	assert.equal(application.app.listening, undefined);
	assert.throws(
		() => createApplication({ services: {}, authentication: createTestAuthentication() }),
		/Application service group is missing/
	);
});

test('health and readiness are public, minimal, and reflect the injected readiness check', async t => {
	const fixture = await startFixture({ authentication: createTestAuthentication({ authenticated: false }) });
	t.after(() => fixture.close());

	const health = await fixture.request('/healthz');
	assert.equal(health.status, 200);
	assert.deepEqual(await body(health), { status: 'ok' });
	assert.equal(health.headers.get('cache-control'), 'no-store');
	assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

	const ready = await fixture.request('/readyz');
	assert.equal(ready.status, 200);
	assert.deepEqual(await body(ready), { status: 'ready' });

	fixture.state.ready = false;
	const unavailable = await fixture.request('/readyz');
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await body(unavailable), { status: 'not_ready' });
});

test('auth status stays public while application APIs remain protected', async t => {
	const fixture = await startFixture({ authentication: createTestAuthentication({ authenticated: false }) });
	t.after(() => fixture.close());

	assert.equal((await fixture.request('/api/auth/session')).status, 200);
	assert.equal((await fixture.request('/api/sessions')).status, 401);
	assert.equal((await fixture.request('/api/sessions/missing/report.md')).status, 401);
	assert.equal((await fixture.request('/api/sessions/missing/events')).status, 401);
});

test('the real owner authentication and CSRF middleware protect extracted run routes', async t => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-app-auth-test-'));
	const authentication = createAuthentication({
		filePath: path.join(directory, 'auth.json'),
		cookieSecure: false
	});
	const fixture = await startFixture({ authentication });
	t.after(async () => {
		await fixture.close();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	assert.equal((await fixture.request('/api/sessions')).status, 401);
	const setup = await fixture.request('/api/auth/setup', {
		method: 'POST',
		json: { email: 'owner@example.com', password: 'correct horse battery staple' }
	});
	assert.equal(setup.status, 201);
	const session = await body(setup);
	const cookie = setup.headers.get('set-cookie').split(';', 1)[0];

	assert.equal((await fixture.request('/api/sessions', { headers: { cookie } })).status, 200);
	assert.equal((await fixture.request('/api/sessions', {
		method: 'POST', headers: { cookie }
	})).status, 403);
	assert.equal((await fixture.request('/api/sessions', {
		method: 'POST',
		headers: { cookie, 'x-qase-csrf-token': session.csrfToken }
	})).status, 201);
});

test('production cannot enable the practice site or its relaxed script policy', async t => {
	const fixture = await startFixture({
		environment: { NODE_ENV: 'production' },
		demoEnabled: true
	});
	t.after(() => fixture.close());

	const response = await fixture.request('/demo', { redirect: 'manual' });
	assert.equal(response.status, 404);
	assert.doesNotMatch(response.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
});

test('development retains the isolated practice site', async t => {
	const fixture = await startFixture({ environment: { NODE_ENV: 'development' } });
	t.after(() => fixture.close());

	const response = await fixture.request('/demo', { redirect: 'manual' });
	assert.equal(response.status, 302);
	assert.equal(response.headers.get('location'), '/demo/login');
	assert.match(response.headers.get('content-security-policy'), /script-src[^;]*unsafe-inline/);
});

test('run CRUD preserves summaries, derived detail fields, cleanup, and 404 behavior', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const createdResponse = await fixture.request('/api/sessions', { method: 'POST' });
	assert.equal(createdResponse.status, 201);
	const created = await body(createdResponse);
	assert.equal(created.title, 'New test run');
	assert.equal(created.status, 'idle');

	const summaries = await body(await fixture.request('/api/sessions'));
	assert.equal(summaries.length, 1);
	assert.equal(summaries[0].id, created.id);
	assert.equal(summaries[0].messageCount, 0);
	assert.equal(summaries[0].findingCount, 0);

	fixture.services.secrets.store(created.id, { qa_password: 'fixture-secret' });
	fixture.state.liveFor(created.id).running = true;
	fixture.state.liveFor(created.id).bridge = { getLastFrame: () => 'data:image/jpeg;base64,frame' };
	const detail = await body(await fixture.request(`/api/sessions/${created.id}`));
	assert.deepEqual(detail.secretNames, ['QA_PASSWORD']);
	assert.equal(detail.running, true);
	assert.equal(detail.frame, 'data:image/jpeg;base64,frame');
	assert.equal(JSON.stringify(detail).includes('fixture-secret'), false);

	const removed = await body(await fixture.request(`/api/sessions/${created.id}`, { method: 'DELETE' }));
	assert.deepEqual(removed, { deleted: true });
	const removedAgain = await body(await fixture.request(`/api/sessions/${created.id}`, { method: 'DELETE' }));
	assert.deepEqual(removedAgain, { deleted: false });
	assert.equal((await fixture.request(`/api/sessions/${created.id}`)).status, 404);
});

test('messages preserve validation, URL normalization, runtime startup, and detached errors', async t => {
	const fixture = await startFixture({
		runTurn: async () => {
			throw new Error('model unavailable');
		}
	});
	t.after(() => fixture.close());
	const session = fixture.services.runs.create();

	const empty = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST', json: { text: '   ' }
	});
	assert.equal(empty.status, 400);
	assert.equal(session.messages.length, 0);

	fixture.state.liveFor(session.id).running = true;
	const busy = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST', json: { text: 'test example.com' }
	});
	assert.equal(busy.status, 409);
	assert.equal(session.messages.length, 0);
	fixture.state.liveFor(session.id).running = false;

	const accepted = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST', json: { text: 'Please test example.com now.' }
	});
	assert.equal(accepted.status, 200);
	assert.deepEqual(await body(accepted), { ok: true });
	assert.equal(session.targetUrl, 'https://example.com/');
	assert.equal(session.title, 'example.com');
	assert.equal(fixture.state.ensureCalls.length, 1);
	assert.deepEqual(fixture.state.runCalls[0].options, { task: 'Please test example.com now.' });

	await fixture.whenIdle();
	assert.equal(session.status, 'error');
	assert.equal(session.messages.at(-1).text, 'model unavailable');
	assert.equal(session.messages.at(-1).kind, 'error');
});

test('runtime initialization failures retain the user message and return the established error', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create();
	fixture.state.ensureError = new Error('runtime configuration invalid');

	const response = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST', json: { text: 'Test https://example.com' }
	});
	assert.equal(response.status, 500);
	assert.deepEqual(await body(response), { error: 'runtime configuration invalid' });
	assert.equal(session.messages[0].role, 'user');
	assert.equal(session.messages.at(-1).role, 'system');
	assert.equal(session.status, 'error');
});

test('answers and credentials require pending input and never expose raw credential values', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create();

	assert.equal((await fixture.request(`/api/sessions/${session.id}/answer`, {
		method: 'POST', json: { answer: 'yes' }
	})).status, 409);

	session.pendingQuestion = { question: 'Continue?' };
	const answer = await fixture.request(`/api/sessions/${session.id}/answer`, {
		method: 'POST', json: { answer: ' yes ' }
	});
	assert.equal(answer.status, 200);
	assert.equal(session.messages.at(-1).kind, 'answer');
	assert.deepEqual(fixture.state.runCalls.at(-1).options, { resumeAnswer: 'yes' });

	const rawSecret = 'fixture-only-password';
	const credentials = await fixture.request(`/api/sessions/${session.id}/credentials`, {
		method: 'POST',
		json: { fields: { 'qa password': rawSecret, ignored: '' }, note: 'Use the test account.' }
	});
	assert.equal(credentials.status, 200);
	const credentialResponse = await body(credentials);
	assert.deepEqual(credentialResponse, { ok: true, secretNames: ['QA_PASSWORD'] });
	assert.equal(JSON.stringify(credentialResponse).includes(rawSecret), false);
	assert.equal(JSON.stringify(session.messages).includes(rawSecret), false);
	assert.equal(JSON.stringify(fixture.state.events).includes(rawSecret), false);
	const resume = fixture.state.runCalls.at(-1).options.resumeAnswer;
	assert.match(resume, /\{\{QA_PASSWORD\}\}/);
	assert.equal(resume.includes(rawSecret), false);
	await fixture.whenIdle();
});

test('stop, report, configuration, malformed JSON, and API 404 contracts remain stable', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create('Example run');
	let aborted = 0;
	fixture.state.liveFor(session.id).controller = { abort: () => aborted++ };

	assert.deepEqual(await body(await fixture.request(`/api/sessions/${session.id}/stop`, { method: 'POST' })), { ok: true });
	assert.equal(aborted, 1);

	const report = await fixture.request(`/api/sessions/${session.id}/report.md`);
	assert.equal(report.status, 200);
	assert.match(report.headers.get('content-type'), /^text\/markdown/);
	assert.match(await report.text(), /Run: Example run/);

	const publicConfig = await body(await fixture.request('/api/config'));
	assert.equal(publicConfig.model, 'test-model');
	assert.equal('apiKey' in publicConfig, false);
	const saved = await body(await fixture.request('/api/config', {
		method: 'PUT', json: { model: 'next-model' }
	}));
	assert.equal(saved.model, 'next-model');
	assert.equal(saved.runsKeepingOldSettings, 0);
	const tested = await body(await fixture.request('/api/config/test', {
		method: 'POST', json: { model: 'next-model' }
	}));
	assert.deepEqual(tested, { ok: true, models: ['test-model'] });

	const malformed = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: '{'
	});
	assert.equal(malformed.status, 400);
	assert.deepEqual(await body(malformed), { error: 'Request body is not valid JSON.' });
	assert.deepEqual(await body(await fixture.request('/api/unknown')), { error: 'API route not found.' });
});

test('SSE sends the current frame and removes its subscription on disconnect', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create();
	fixture.state.liveFor(session.id).bridge = { getLastFrame: () => 'data:image/jpeg;base64,current' };
	const controller = new AbortController();

	const response = await fixture.request(`/api/sessions/${session.id}/events`, {
		signal: controller.signal
	});
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('content-type'), 'text/event-stream');
	const reader = response.body.getReader();
	const first = await reader.read();
	const text = new TextDecoder().decode(first.value);
	assert.match(text, /: connected/);
	assert.match(text, /"type":"frame"/);
	assert.match(text, /data:image\/jpeg;base64,current/);
	assert.equal(fixture.state.listenerCount(session.id), 1);

	controller.abort();
	await reader.cancel().catch(() => {});
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(fixture.state.listenerCount(session.id), 0);
});
