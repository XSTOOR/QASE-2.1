import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { finishSqaAssessment } from './sqaService.js';

const TEST_TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

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
		lifecycleCloseCalls: 0,
		events: [],
		configTests: [],
		cleanupCalls: [],
		artifactPurgeCalls: [],
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
					mode: session.mode === 'sqa' || session.mode === 'founder' ? session.mode : 'qa',
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
			recordCleanup(id, cleanupOptions) {
				state.cleanupCalls.push({ id, options: cleanupOptions });
				return Promise.resolve({ recorded: true, runId: id, ...cleanupOptions });
			},
			commit(session, type, payload = {}) {
				publish(session, type, payload);
				return session;
			},
			addMessage(session, message) {
				const entry = { id: randomUUID(), ts: Date.now(), ...message };
				session.messages.push(entry);
				publish(session, 'message', { message: entry });
				return entry;
			},
			addActivity(session, activity) {
				const entry = { id: activity.id ?? randomUUID(), ts: Date.now(), status: 'done', ...activity };
				session.activities.push(entry);
				publish(session, 'activity', { activity: entry });
				return entry;
			},
			updateActivity(session, id, patch) {
				const entry = session.activities.find(candidate => candidate.id === id);
				if (!entry) return undefined;
				Object.assign(entry, patch);
				publish(session, 'activity', { activity: entry });
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
			purgeArtifacts(id) {
				state.artifactPurgeCalls.push(id);
				return options.purgeArtifacts?.(id);
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
		},
		lifecycle: {
			close() {
				state.lifecycleCloseCalls++;
				return Promise.resolve();
			}
		}
	};

	return { services, state };
}

function createTestAccess() {
	return createInstanceAccess({ tenantContext: TEST_TENANT });
}

async function startFixture(options = {}) {
	const memory = options.memory ?? createMemoryServices(options);
	const application = createApplication({
		services: memory.services,
		access: options.access ?? createTestAccess(),
		demoEnabled: options.demoEnabled,
		environment: options.environment ?? {},
		isDraining: options.isDraining,
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
		access: createTestAccess(),
		demoEnabled: false
	});
	assert.equal(memory.state.loadCalls, 0);
	assert.equal(application.app.listening, undefined);
	assert.throws(
		() => createApplication({ services: {}, access: createTestAccess() }),
		/Application service group is missing/
	);
});

test('health and readiness are public, minimal, and reflect the injected readiness check', async t => {
	let draining = false;
	const fixture = await startFixture({
		isDraining: () => draining
	});
	t.after(() => fixture.close());

	const health = await fixture.request('/healthz');
	assert.equal(health.status, 200);
	assert.deepEqual(await body(health), { status: 'ok' });
	assert.equal(health.headers.get('cache-control'), 'no-store');
	assert.equal(health.headers.get('x-content-type-options'), 'nosniff');

	const ready = await fixture.request('/readyz');
	assert.equal(ready.status, 200);
	assert.deepEqual(await body(ready), { status: 'ready' });
	draining = true;
	const drainingResponse = await fixture.request('/readyz');
	assert.equal(drainingResponse.status, 503);
	assert.deepEqual(await body(drainingResponse), { status: 'not_ready' });
	draining = false;

	fixture.state.ready = false;
	const unavailable = await fixture.request('/readyz');
	assert.equal(unavailable.status, 503);
	assert.deepEqual(await body(unavailable), { status: 'not_ready' });
});

test('embedded instance APIs need no Qase login and reject cross-origin browser mutations', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	assert.equal((await fixture.request('/api/sessions')).status, 200);
	assert.equal((await fixture.request('/api/sessions', { method: 'POST' })).status, 201);
	const rejected = await fixture.request('/api/sessions', {
		method: 'POST',
		headers: { origin: 'https://attacker.example' }
	});
	assert.equal(rejected.status, 403);
	assert.deepEqual(await body(rejected), { error: 'Cross-origin request rejected.' });
	assert.equal((await fixture.request('/api/auth/session')).status, 404);
	for (const action of ['setup', 'login', 'logout']) {
		const response = await fixture.request(`/api/auth/${action}`, { method: 'POST' });
		assert.equal(response.status, 404);
		assert.equal(response.headers.get('set-cookie'), null);
	}
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

test('Drytis embedding is disabled by default and can only allow one exact HTTPS origin', async t => {
	const fixture = await startFixture({
		environment: { NODE_ENV: 'production', QASE_DRYTIS_EMBED_ORIGIN: 'https://studio.drytis.ai' }
	});
	t.after(() => fixture.close());
	const response = await fixture.request('/healthz');
	assert.match(response.headers.get('content-security-policy'), /frame-ancestors https:\/\/studio\.drytis\.ai/);
	assert.equal(response.headers.get('x-frame-options'), null);

	const memory = createMemoryServices();
	assert.throws(() => createApplication({
		services: memory.services,
		access: createTestAccess(),
		environment: { QASE_DRYTIS_EMBED_ORIGIN: 'https://*.drytis.ai' }
	}), /one exact HTTPS origin/);
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

	const deleteResponse = await fixture.request(`/api/sessions/${created.id}`, { method: 'DELETE' });
	const removed = await body(deleteResponse);
	assert.deepEqual(removed, { deleted: true });
	assert.deepEqual(fixture.state.artifactPurgeCalls, [created.id]);
	assert.deepEqual(fixture.state.cleanupCalls, [{
		id: created.id,
		options: {
			status: 'completed', actorType: 'system',
			referenceId: `request/${deleteResponse.headers.get('x-request-id')}`
		}
	}]);
	const removedAgain = await body(await fixture.request(`/api/sessions/${created.id}`, { method: 'DELETE' }));
	assert.deepEqual(removedAgain, { deleted: false });
	assert.equal((await fixture.request(`/api/sessions/${created.id}`)).status, 404);
});

test('SQA catalog and authorized scope creation stay pending until evidence is evaluated', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const catalogResponse = await fixture.request('/api/sqa/catalog');
	assert.equal(catalogResponse.status, 200);
	const catalog = await body(catalogResponse);
	assert.match(catalog.catalogVersion, /^2026\./);
	assert.ok(catalog.controls.length >= 40);
	assert.match(catalog.disclaimer, /not legal advice/i);

	const unauthorized = await fixture.request('/api/sqa/sessions', {
		method: 'POST',
		json: {
			profiles: ['core'],
			attributes: ['web_application'],
			target: { name: 'Example', release: '1.0', environment: 'staging' }
		}
	});
	assert.equal(unauthorized.status, 400);
	assert.match((await body(unauthorized)).error, /authorized/i);

	const createdResponse = await fixture.request('/api/sqa/sessions', {
		method: 'POST',
		json: {
			authorizationConfirmed: true,
			profiles: ['core'],
			attributes: ['web_application', 'user_interface'],
			target: { name: 'Example product', release: '1.0.0', environment: 'staging' },
			scopeNotes: 'Non-destructive browser assessment of the staging release.'
		}
	});
	assert.equal(createdResponse.status, 201);
	const created = await body(createdResponse);
        assert.equal(created.mode, 'sqa');
        assert.equal(created.sqa.scope.authorization.confirmed, true);
        assert.equal(created.sqa.assessment, undefined);
		assert.equal(created.todos.length, 6);
		assert.ok(created.todos.every(item => item.status === 'pending'));
		assert.match(created.todos[0].text, /authorized target.*assessment boundary/i);
		assert.match(created.todos.at(-1).text, /publish the professional SQA report/i);
		const initialPlan = fixture.state.events.find(event => (
			event.type === 'todos' && event.sessionId === created.id
		));
		assert.equal(initialPlan.todos.length, 6);

        const report = await fixture.request(`/api/sessions/${created.id}/report.md`);
	assert.equal(report.status, 409);
	assert.match((await body(report)).error, /pending/i);

	const stored = fixture.services.runs.get(created.id);
	await finishSqaAssessment(stored, fixture.services.runs, () => Date.parse('2026-08-15T00:00:00.000Z'));
	const finalizedAt = stored.sqa.finalizedAt;
	delete stored.sqa.finalizedAt;
	const unpublishedReport = await fixture.request(`/api/sessions/${created.id}/report.md`);
	assert.equal(unpublishedReport.status, 409);
	assert.match((await body(unpublishedReport)).error, /not been finalized/i);
	stored.sqa.finalizedAt = finalizedAt;
	const finalReport = await fixture.request(`/api/sessions/${created.id}/report.md`);
	assert.equal(finalReport.status, 200);
	assert.match(await finalReport.text(), /^# SQA assessment/);
});

test('a pending SQA scope accepts its first target URL and starts the agent', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const createdResponse = await fixture.request('/api/sqa/sessions', {
		method: 'POST',
		json: {
			authorizationConfirmed: true,
			profiles: ['core'],
			attributes: ['web_application', 'user_interface'],
			target: { name: 'Example product', release: '1.0.0', environment: 'staging' }
		}
	});
	assert.equal(createdResponse.status, 201);
	const session = await body(createdResponse);
	assert.equal(session.status, 'idle');
	assert.equal(session.sqa.assessment, undefined);

	const startResponse = await fixture.request(`/api/sessions/${session.id}/message`, {
		method: 'POST',
		json: { text: 'Run the SQA assessment against https://example.com/releases/1.0.0.' }
	});
	assert.equal(startResponse.status, 200);
	assert.deepEqual(await body(startResponse), { ok: true });
	const started = await body(await fixture.request(`/api/sessions/${session.id}`));
	assert.equal(started.mode, 'sqa');
	assert.equal(started.targetUrl, 'https://example.com/releases/1.0.0');
	assert.equal(fixture.state.ensureCalls.at(-1), session.id);
	assert.deepEqual(fixture.state.runCalls.at(-1), {
		sessionId: session.id,
		options: { task: 'Run the SQA assessment against https://example.com/releases/1.0.0.' }
	});
	await fixture.whenIdle();
});

test('Founder Mode creates an authorized pending review and starts only from a target URL message', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const catalogResponse = await fixture.request('/api/founder/catalog');
	assert.equal(catalogResponse.status, 200);
	const catalog = await body(catalogResponse);
	assert.match(catalog.schemaVersion, /^2026\./);
	assert.equal(catalog.categories.length, 17);
	assert.deepEqual(catalog.observationTypes, ['strength', 'friction', 'opportunity', 'risk']);
	assert.deepEqual(catalog.confidenceLevels, ['low', 'medium', 'high']);
	assert.match(catalog.caveat, /hypotheses to validate/i);

	const unauthorized = await fixture.request('/api/founder/sessions', {
		method: 'POST',
		json: { target: { name: 'Example product' } }
	});
	assert.equal(unauthorized.status, 400);
	assert.match((await body(unauthorized)).error, /authorized/i);

	const createdResponse = await fixture.request('/api/founder/sessions', {
		method: 'POST',
		json: {
			authorizationConfirmed: true,
			tenantId: 'request-controlled-tenant',
			organizationId: 'request-controlled-organization',
			target: { name: 'Example product', release: '1.0.0', environment: 'staging' },
			productContext: {
				stage: 'mvp',
				businessModel: 'B2B SaaS',
				targetCustomer: 'Product teams',
				primaryGoal: 'Improve activation',
				competitors: ['Incumbent suite']
			}
		}
	});
	assert.equal(createdResponse.status, 201);
	const created = await body(createdResponse);
	assert.equal(created.mode, 'founder');
	assert.equal(created.status, 'idle');
	assert.equal(created.targetUrl, undefined);
	assert.equal(created.founder.scope.authorization.confirmed, true);
	assert.deepEqual(created.founder.observations, []);
	assert.equal(created.todos.length, 8);
	assert.ok(created.todos.every(item => item.status === 'pending'));
	assert.match(created.todos[0].text, /evidence baseline/i);
	assert.equal(created.founder.report, undefined);
	assert.equal(created.founder.finalizedAt, undefined);
	assert.equal(JSON.stringify(created).includes('request-controlled-tenant'), false);
	assert.equal(JSON.stringify(created).includes('request-controlled-organization'), false);
	assert.equal(fixture.state.runCalls.length, 0);
	assert.equal(fixture.state.events.at(-1).type, 'founder.created');
	const initialPlan = fixture.state.events.find(event => (
		event.type === 'todos' && event.sessionId === created.id
	));
	assert.equal(initialPlan.todos.length, 8);
	const missingTarget = await fixture.request(`/api/sessions/${created.id}/message`, {
		method: 'POST', json: { text: 'Please begin the review.' }
	});
	assert.equal(missingTarget.status, 400);
	assert.match((await body(missingTarget)).error, /target URL/i);
	assert.equal(fixture.state.runCalls.length, 0);
	assert.equal(fixture.services.runs.get(created.id).messages.length, 0);

	const summaries = await body(await fixture.request('/api/sessions'));
	assert.equal(summaries[0].mode, 'founder');
	const pendingReport = await fixture.request(`/api/sessions/${created.id}/report.md`);
	assert.equal(pendingReport.status, 409);
	assert.match((await body(pendingReport)).error, /pending/i);

	const instruction = 'Review the complete product at https://example.com/app.';
	const startResponse = await fixture.request(`/api/sessions/${created.id}/message`, {
		method: 'POST',
		json: { text: instruction }
	});
	assert.equal(startResponse.status, 200);
	const started = await body(await fixture.request(`/api/sessions/${created.id}`));
	assert.equal(started.targetUrl, 'https://example.com/app');
	assert.equal(started.founder.scope.target.url, 'https://example.com/app');
	const targetBinding = fixture.state.events.find(event => (
		event.type === 'founder.target_bound' && event.sessionId === created.id
	));
	assert.equal(targetBinding.authorizedTargetUrl, 'https://example.com/app');
	assert.deepEqual(fixture.state.runCalls.at(-1), {
		sessionId: created.id,
		options: { task: instruction }
	});
	await fixture.whenIdle();

	const preauthorizedResponse = await fixture.request('/api/founder/sessions', {
		method: 'POST',
		json: {
			authorizationConfirmed: true,
			target: { name: 'Bound product', url: 'https://authorized.example/product' }
		}
	});
	assert.equal(preauthorizedResponse.status, 201);
	const preauthorized = await body(preauthorizedResponse);
	assert.equal(fixture.state.events.at(-1).authorizedTargetUrl, 'https://authorized.example/product');
	const runsBeforeMismatch = fixture.state.runCalls.length;
	const mismatchResponse = await fixture.request(`/api/sessions/${preauthorized.id}/message`, {
		method: 'POST', json: { text: 'Review https://different.example/product' }
	});
	assert.equal(mismatchResponse.status, 400);
	assert.match((await body(mismatchResponse)).error, /does not match the authorized/i);
	assert.equal(fixture.state.runCalls.length, runsBeforeMismatch);
	assert.equal(fixture.services.runs.get(preauthorized.id).messages.length, 0);
	assert.equal(fixture.services.runs.get(preauthorized.id).targetUrl, undefined);

	const authorizedStart = await fixture.request(`/api/sessions/${preauthorized.id}/message`, {
		method: 'POST', json: { text: 'Review https://authorized.example/product' }
	});
	assert.equal(authorizedStart.status, 200);
	assert.equal(fixture.services.runs.get(preauthorized.id).targetUrl, 'https://authorized.example/product');
	const preauthorizedBinding = fixture.state.events.find(event => (
		event.type === 'founder.target_bound' && event.sessionId === preauthorized.id
	));
	assert.equal(preauthorizedBinding.authorizedTargetUrl, 'https://authorized.example/product');
	await fixture.whenIdle();

	const stored = fixture.services.runs.get(created.id);
	stored.founder.finalizedAt = '2026-08-18T00:00:00.000Z';
	stored.founder.report = {
		generatedAt: stored.founder.finalizedAt,
		target: { name: 'Example product' },
		coverage: { categoriesReviewed: [], totalCategories: 17, evidenceBackedObservations: 0 },
		executiveSummary: 'A bounded product review.',
		icp: { primary: 'Product teams', users: ['Operators'], buyers: ['Leaders'], jobs: ['Ship'], pains: ['Friction'] },
		positioning: { oneLiner: 'Ship with confidence.', valueProposition: 'Evidence-informed decisions.' },
		recommendations: [],
		marketing: { channels: [] },
		sales: { motion: 'Founder-led discovery.' },
		risks: [],
		plan: { days30: [], days60: [], days90: [] },
		metrics: { northStar: { name: 'Activation', definition: 'First successful run.' }, experiments: [] },
		caveat: 'Recommendations are hypotheses to validate.'
	};
	const finalReport = await fixture.request(`/api/sessions/${created.id}/report.md`);
	assert.equal(finalReport.status, 200);
	assert.match(await finalReport.text(), /^# Founder review — Example product/);
});

test('run deletion remains hidden while durable cleanup records a sanitized failure', async t => {
	const fixture = await startFixture({
		purgeArtifacts() { throw new Error('workspace path and secret must never enter audit'); }
	});
	t.after(() => fixture.close());
	const session = fixture.services.runs.create();

	const response = await fixture.request(`/api/sessions/${session.id}`, { method: 'DELETE' });
	assert.equal(response.status, 200);
	assert.deepEqual(await body(response), { deleted: true });
	assert.deepEqual(fixture.state.cleanupCalls, [{
		id: session.id,
		options: {
			status: 'failed', errorCode: 'artifact_purge_failed', actorType: 'system',
			referenceId: `request/${response.headers.get('x-request-id')}`
		}
	}]);
	assert.equal(JSON.stringify(fixture.state.cleanupCalls).includes('workspace path'), false);
	assert.equal((await fixture.request(`/api/sessions/${session.id}`)).status, 404);
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

test('Founder credential refusal persists a public-only boundary and cannot re-open the login gate', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const created = await body(await fixture.request('/api/founder/sessions', {
		method: 'POST',
		json: {
			authorizationConfirmed: true,
			target: { name: 'Public product', url: 'https://example.com/' }
		}
	}));
	const session = fixture.services.runs.get(created.id);
	session.pendingQuestion = {
		question: 'Provide credentials to continue.',
		credentialLike: true
	};

	const response = await fixture.request(`/api/sessions/${session.id}/answer`, {
		method: 'POST',
		json: { answer: 'No credentials available. Skip anything behind the login.' }
	});
	assert.equal(response.status, 200);
	assert.deepEqual(session.founder.scope.access, {
		decision: 'public_only',
		authenticatedSurfaces: 'excluded',
		decidedAt: session.founder.scope.access.decidedAt,
		source: 'user'
	});
	assert.match(session.messages.at(-1).text, /public-only review/i);
	assert.match(session.messages.at(-1).text, /do not ask for credentials again/i);
	assert.deepEqual(fixture.state.runCalls.at(-1).options, {
		resumeAnswer: session.messages.at(-1).text
	});
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

test('SSE stays live without login sessions and removes its subscription on disconnect', { timeout: 5_000 }, async t => {
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
	const heartbeat = await reader.read();
	assert.equal(heartbeat.done, false);
	assert.match(new TextDecoder().decode(heartbeat.value), /: ping/);

	controller.abort();
	await reader.cancel().catch(() => {});
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(fixture.state.listenerCount(session.id), 0);
});
