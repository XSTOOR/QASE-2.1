import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { PublicInputError } from './publicErrors.js';
import { createInstanceAccess } from './instanceAccess.js';
import { finishSqaAssessment } from './sqaService.js';
import { aggregateSessionFindings, setFindingStatus } from './store.js';
import { createCoverageService } from './coverageService.js';

const TEST_TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

/** In-memory feedback service matching the contract's feedback group. */
function createMemoryFeedbackService() {
	const records = new Map();
	const clean = value => String(value ?? '').slice(0, 4000).trim();
	return {
		async create({ runId, submittedBy, context, ...input }) {
			const existing = [...records.values()].find(record => record.runId === runId && record.submittedBy === submittedBy);
			if (existing) {
				const error = new Error('Feedback already exists for this test run.');
				error.code = 'duplicate_feedback';
				error.existingId = existing.id;
				throw error;
			}
			const now = Date.now();
			const record = {
				id: randomUUID(), runId, submittedBy: submittedBy ?? null,
				targetUrl: context?.targetUrl, runStatus: context?.runStatus,
				durationSeconds: context?.durationSeconds,
				rating: Number(input.rating), category: input.category,
				comments: clean(input.comments), improvement: clean(input.improvement) || undefined,
				status: 'new', submittedAt: now, updatedAt: now
			};
			records.set(record.id, record);
			return structuredClone(record);
		},
		async get(id) { return records.get(id) ? structuredClone(records.get(id)) : undefined; },
		async forRun(runId, submittedBy) {
			const found = [...records.values()].find(record => record.runId === runId
				&& (submittedBy === undefined || record.submittedBy === submittedBy));
			return found ? structuredClone(found) : undefined;
		},
		async list(filters = {}) {
			let rows = [...records.values()];
			if (filters.runId !== undefined) rows = rows.filter(record => record.runId === filters.runId);
			rows.sort((a, b) => b.submittedAt - a.submittedAt);
			return rows.slice(0, filters.limit ?? 100).map(structuredClone);
		},
		async update(id, patch = {}) {
			const record = records.get(id);
			if (!record) throw Object.assign(new Error('Feedback not found.'), { code: 'not_found' });
			if (patch.status) record.status = patch.status;
			record.updatedAt = Date.now();
			return structuredClone(record);
		},
		async remove(id) { return records.delete(id); },
		async stats() {
			const rows = [...records.values()];
			return {
				total: rows.length,
				averageRating: rows.length ? rows.reduce((sum, row) => sum + row.rating, 0) / rows.length : undefined,
				byCategory: {}, byStatus: {}, byRating: {}
			};
		}
	};
}

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

	function createSession(title = 'New test run', options = {}) {
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
			environmentId: options.environmentId,
			environmentSnapshot: options.environmentSnapshot ? structuredClone(options.environmentSnapshot) : undefined,
			secretNames: [],
			...options
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
		feedback: createMemoryFeedbackService(state),
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
					messageCount: session.messages.length,
					environmentSnapshot: session.environmentSnapshot
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
			setFindingStatus(session, findingId, patch) {
				const updated = setFindingStatus(session, findingId, patch ?? {});
				publish(session, 'finding_status', { finding: updated });
				return Promise.resolve(updated);
			},
			aggregateFindings(options = {}) {
				// Mirror the local store's semantics over the fixture's session map.
				return Promise.resolve(aggregateSessionFindings([...sessions.values()], options));
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
		environments: {
			seed: async () => ({ inserted: 0 }),
			list: async () => [],
			get: async () => null,
			create: async input => input,
			update: async (envId, patch) => ({ envId, ...patch }),
			facets: async () => ({ total: 0, platform: [], device: [], os: [], osVersion: [], browser: [], browserVersion: [], deviceType: [], executionProvider: [], isRealDevice: [], active: [] }),
			availability: () => [],
			catalogVersion: () => 'test'
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
		probeTargetReachability: options.probeTargetReachability ?? (async () => ({ ok: true })),
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

test('login entry route serves the existing application without masking unknown routes', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const login = await fixture.request('/login');
	assert.equal(login.status, 200);
	assert.match(login.headers.get('content-type') ?? '', /^text\/html\b/);
	assert.match(await login.text(), /<title>QASE — Autonomous quality assurance<\/title>/);

	const loginHead = await fixture.request('/login', { method: 'HEAD' });
	assert.equal(loginHead.status, 200);

	assert.equal((await fixture.request('/not-a-qase-route')).status, 404);
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

test('standard QA run creation accepts a catalog-validated test selection', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	// A valid subset from the catalog is accepted and persisted on the session.
	const created = await body(await fixture.request('/api/sessions', {
		method: 'POST',
		json: { selectedTests: ['navigation', 'forms'], scopeSelection: ['forms', 'navigation', 'forms', 'unknown'] }
	}));
	assert.deepEqual(created.selectedTests, ['navigation', 'forms']);
	assert.deepEqual(created.scopeSelection, ['forms', 'navigation']);
	assert.equal((await body(await fixture.request('/api/sessions'))).length, 1, 'One request creates exactly one session');

	// No selection keeps the historical full-coverage behavior.
	const full = await body(await fixture.request('/api/sessions', { method: 'POST' }));
	assert.equal(full.selectedTests, undefined);

	// Empty, unknown, and duplicate selections are rejected at the route.
	const empty = await fixture.request('/api/sessions', { method: 'POST', json: { selectedTests: [] } });
	assert.equal(empty.status, 400);
	assert.match((await body(empty)).error, /Select at least one standard test\./);
	const unknown = await fixture.request('/api/sessions', { method: 'POST', json: { selectedTests: ['navigation', 'nonexistent'] } });
	assert.equal(unknown.status, 400);
	assert.match((await body(unknown)).error, /Unknown standard test/);
	const duplicate = await fixture.request('/api/sessions', { method: 'POST', json: { selectedTests: ['navigation', 'navigation'] } });
	assert.equal(duplicate.status, 400);
	assert.match((await body(duplicate)).error, /Duplicate standard test/);
});

test('standard QA run creation persists a whitelisted coverage scope selection', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	// Regression for the POST /api/sessions duplicate-block merge artifact: a
	// valid scopeSelection must be persisted by the single live handler.
	const created = await body(await fixture.request('/api/sessions', {
		method: 'POST',
		json: { scopeSelection: ['navigation', 'forms'] }
	}));
	assert.deepEqual(created.scopeSelection, ['navigation', 'forms']);
	// Round-trips through the store.
	const fetched = await body(await fixture.request(`/api/sessions/${created.id}`));
	assert.deepEqual(fetched.scopeSelection, ['navigation', 'forms']);

	// Duplicates collapse and unknown values drop (normalizer contract).
	const collapsed = await body(await fixture.request('/api/sessions', {
		method: 'POST',
		json: { scopeSelection: ['forms', 'forms', 'bogus-scope', 'navigation'] }
	}));
	assert.deepEqual(collapsed.scopeSelection, ['forms', 'navigation']);

	// No scope keeps the legacy full-coverage behavior (undefined, not []).
	const legacy = await body(await fixture.request('/api/sessions', { method: 'POST' }));
	assert.equal(legacy.scopeSelection, undefined);

	// Entirely invalid shape (string object) behaves like no selection — the
	// plain-QA route tolerates it instead of throwing a TypeError in the store.
	const tolerated = await body(await fixture.request('/api/sessions', {
		method: 'POST',
		json: { scopeSelection: { bogus: 'shape' } }
	}));
	assert.equal(tolerated.scopeSelection, undefined);
});

test('security test selections require explicit authorization at the route', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	// Security check without authorization → 400, no session created.
	const unconfirmed = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { selectedTests: ['security_authentication'] }
	});
	assert.equal(unconfirmed.status, 400);
	assert.match((await body(unconfirmed)).error, /requires explicit authorization/);

	// Explicitly false is equally rejected.
	const refused = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { selectedTests: ['security_authentication'], securityAuthorization: { confirmed: false } }
	});
	assert.equal(refused.status, 400);
	assert.match((await body(refused)).error, /requires explicit authorization/);

	// Confirmed authorization → created, with selection + authorization persisted.
	const authorized = await fixture.request('/api/sessions', {
		method: 'POST',
		json: {
			selectedTests: ['navigation', 'security_authentication', 'security_sql_injection'],
			securityAuthorization: { confirmed: true, notes: 'isolated staging fixture' }
		}
	});
	assert.equal(authorized.status, 201);
	const session = await body(authorized);
	assert.deepEqual(session.selectedTests, ['navigation', 'security_authentication', 'security_sql_injection']);
	assert.deepEqual(session.securityAuthorization, { confirmed: true, notes: 'isolated staging fixture' });
	// Round-trips through the store.
	const fetched = await body(await fixture.request(`/api/sessions/${session.id}`));
	assert.deepEqual(fetched.securityAuthorization, { confirmed: true, notes: 'isolated staging fixture' });

	// Authorization without a security selection: inert but persisted shape-safe.
	const inert = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { selectedTests: ['navigation'], securityAuthorization: { confirmed: true } }
	});
	assert.equal(inert.status, 201);

	// Unavailable checks are rejected regardless of authorization.
	for (const id of ['security_mitm', 'security_dos']) {
		const blocked = await fixture.request('/api/sessions', {
			method: 'POST',
			json: { selectedTests: [id], securityAuthorization: { confirmed: true } }
		});
		assert.equal(blocked.status, 400);
		assert.match((await body(blocked)).error, /Not implemented — requires an agreed, configured/);
	}
	const mixed = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { selectedTests: ['navigation', 'security_dos'], securityAuthorization: { confirmed: true } }
	});
	assert.equal(mixed.status, 400);
	assert.match((await body(mixed)).error, /DoS scenario/);
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

test('run creation with an environmentId snapshots the frozen environment onto the run', async t => {
	const fixture = await startFixture({
		memory: createMemoryServices(),
	});
	const frozen = {
		envId: 'ENV-IOS-IP15PRO-18.3-SAF-18.3', platform: 'ios', device: 'iPhone 15 Pro',
		osVersion: '18.3', browser: 'Safari', browserVersion: '18.3',
		deviceType: 'phone', executionProvider: 'environment', isRealDevice: true, active: true
	};
	fixture.services.environments.get = async envId => (envId === frozen.envId ? frozen : null);
	fixture.services.environments.list = async () => [frozen];
	t.after(() => fixture.close());

	const created = await body(await fixture.request('/api/sessions', {
		method: 'POST',
		json: { environmentId: frozen.envId }
	}));
	assert.equal(created.environmentId, frozen.envId);
	assert.equal(created.environmentSnapshot.device, 'iPhone 15 Pro');
	assert.equal(created.environmentSnapshot.executionProvider, 'environment');

	const summaries = await body(await fixture.request('/api/sessions'));
	assert.equal(summaries[0].environmentSnapshot.envId, frozen.envId);

	// Unknown environment → 422, never a silent legacy run.
	const unknown = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { environmentId: 'ENV-DOES-NOT-EXIST' }
	});
	assert.equal(unknown.status, 422);

	// Deprecated environments refuse new runs.
	const deprecated = { ...frozen, envId: 'ENV-IOS-IP11-17.4-SAF-17.4', active: false };
	fixture.services.environments.get = async envId => (envId === deprecated.envId ? deprecated : frozen);
	const refused = await fixture.request('/api/sessions', {
		method: 'POST',
		json: { environmentId: deprecated.envId }
	});
	assert.equal(refused.status, 422);
	assert.match((await body(refused)).error, /inactive \(deprecated\)/);
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
		const invalidObservation = await fixture.request(`/api/sessions/${created.id}/sqa/observations`, {
			method: 'POST',
			json: { controlId: 'NOT-IN-SCOPE', status: 'pass', evidence: [] }
		});
		assert.equal(invalidObservation.status, 400);
		assert.match((await body(invalidObservation)).error, /control|scope/i);
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

test('SQA refuses an unsupported runtime before creating an assessment or starting the model', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	fixture.services.environments.get = async () => ({
		envId: 'unsupported-sqa-browser', active: true, platform: 'ios', browserCode: 'duckduckgo',
		device: 'Test phone', browser: 'DuckDuckGo', executionProvider: 'local'
	});
	const response = await fixture.request('/api/sqa/sessions', {
		method: 'POST', json: {
			authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application'],
			target: { name: 'Runtime validation', release: 'test', environment: 'local' },
			environmentId: 'unsupported-sqa-browser'
		}
	});
	assert.equal(response.status, 422);
	assert.match((await body(response)).error, /SQA cannot start.*NOT SUPPORTED/);
	assert.equal(fixture.state.events.filter(event => event.type === 'sqa.created').length, 0);
	assert.equal(fixture.state.ensureCalls.length, 0);
	assert.equal(fixture.state.runCalls.length, 0);
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

test('SSE waits for asynchronous subscription readiness before sending its handshake', { timeout: 5_000 }, async t => {
	const fixture = await startFixture();
	const controller = new AbortController();
	t.after(async () => { controller.abort(); fixture.server.closeAllConnections(); await fixture.close(); });
	const session = fixture.services.runs.create();
	const started = Promise.withResolvers();
	const gate = Promise.withResolvers();
	const disconnected = Promise.withResolvers();
	const writes = [];
	fixture.server.on('request', (_request, response) => {
		const write = response.write;
		response.write = function (chunk, ...args) { writes.push(String(chunk)); return write.call(this, chunk, ...args); };
		response.once('close', disconnected.resolve);
	});
	const subscribe = fixture.services.events.subscribe;
	fixture.services.events.subscribe = async (id, listener) => {
		started.resolve();
		listener({ type: 'before-ready' });
		await gate.promise;
		return subscribe(id, listener);
	};
	const pendingResponse = fixture.request(`/api/sessions/${session.id}/events`, { signal: controller.signal });
	await started.promise;
	assert.deepEqual(writes, [], 'neither handshake nor early bus events can acknowledge a pending subscription');
	gate.resolve();
	const response = await pendingResponse;
	const reader = response.body.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), ': connected\n\n');
	assert.equal(fixture.state.listenerCount(session.id), 1);
	fixture.services.events.publish(session, 'status', { status: 'running' });
	assert.match(new TextDecoder().decode((await reader.read()).value), /"status":"running"/);
	controller.abort();
	await reader.cancel().catch(() => {});
	await disconnected.promise;
	assert.equal(fixture.state.listenerCount(session.id), 0);
});

test('SSE disposes a subscription that resolves after the client already disconnected', { timeout: 5_000 }, async t => {
	const fixture = await startFixture();
	const controller = new AbortController();
	t.after(async () => { controller.abort(); fixture.server.closeAllConnections(); await fixture.close(); });
	const session = fixture.services.runs.create();
	const started = Promise.withResolvers();
	const gate = Promise.withResolvers();
	const disconnected = Promise.withResolvers();
	const released = Promise.withResolvers();
	let unsubscribeCalls = 0;
	let frameReads = 0;
	fixture.services.agent.getLiveState = () => { frameReads++; return {}; };
	fixture.server.on('request', (_request, response) => response.once('close', disconnected.resolve));
	const subscribe = fixture.services.events.subscribe;
	fixture.services.events.subscribe = async (id, listener) => {
		started.resolve();
		await gate.promise;
		const unsubscribe = subscribe(id, listener);
		return () => { unsubscribeCalls++; unsubscribe(); released.resolve(); };
	};
	const pendingResponse = fixture.request(`/api/sessions/${session.id}/events`, { signal: controller.signal }).catch(error => error);
	await started.promise;
	controller.abort();
	await pendingResponse;
	await disconnected.promise;
	gate.resolve();
	await released.promise;
	assert.equal(unsubscribeCalls, 1);
	assert.equal(fixture.state.listenerCount(session.id), 0);
	assert.equal(frameReads, 0, 'a disconnected client must not restart frame or heartbeat work');
});

test('SSE subscription rejection ends safely without a ready handshake', { timeout: 5_000 }, async t => {
	const fixture = await startFixture();
	t.after(async () => { fixture.server.closeAllConnections(); await fixture.close(); });
	const session = fixture.services.runs.create();
	fixture.services.events.subscribe = async () => { throw new Error('private Redis details'); };
	const response = await fixture.request(`/api/sessions/${session.id}/events`);
	assert.equal(response.status, 200);
	assert.equal(await response.text(), '');
	assert.equal(fixture.state.listenerCount(session.id), 0);
});

test('SSE releases its subscription if initial frame retrieval fails', { timeout: 5_000 }, async t => {
	const fixture = await startFixture();
	t.after(async () => { fixture.server.closeAllConnections(); await fixture.close(); });
	const session = fixture.services.runs.create();
	fixture.services.agent.getLiveState = () => { throw new Error('frame unavailable'); };
	const response = await fixture.request(`/api/sessions/${session.id}/events`);
	assert.equal(await response.text(), ': connected\n\n');
	assert.equal(fixture.state.listenerCount(session.id), 0);
});

test('route failures never expose filesystem paths to API clients', async t => {
	const memory = createMemoryServices();
	memory.services.configuration.save = async () => {
		throw Object.assign(new Error('ENOENT: missing /workspace/private/config.json'), { code: 'ENOENT' });
	};
	const fixture = await startFixture({ memory });
	t.after(() => fixture.close());
	const response = await fixture.request('/api/config', { method: 'PUT', json: { model: 'test' } });
	assert.equal(response.status, 500);
	const payload = await body(response);
	assert.equal(payload.error, 'The request could not be completed. Try again.');
	assert.doesNotMatch(JSON.stringify(payload), /workspace|config\.json/);
});

test('route failures never expose unexpected database or internal details', async t => {
	const memory = createMemoryServices();
	memory.services.configuration.save = async () => {
		throw Object.assign(new Error('duplicate key violates users_email_key; SQL=INSERT INTO users'), { code: '23505' });
	};
	const fixture = await startFixture({ memory });
	t.after(() => fixture.close());
	const response = await fixture.request('/api/config', { method: 'PUT', json: { model: 'test' } });
	assert.equal(response.status, 500);
	const payload = await body(response);
	assert.equal(payload.error, 'The request could not be completed. Try again.');
	assert.doesNotMatch(JSON.stringify(payload), /duplicate|users_email_key|INSERT INTO/);
});

test('only explicitly public input errors retain their message', async t => {
	const memory = createMemoryServices();
	memory.services.configuration.save = async input => {
		if (input.model === 'public') throw new PublicInputError('Choose a supported model.');
		if (input.model === 'spoof') {
			throw Object.assign(new Error('failed reading /workspace/private/auth.json'), {
				name: 'AuthError', status: 418
			});
		}
		throw new TypeError('failed reading /workspace/private/config.json');
	};
	const fixture = await startFixture({ memory });
	t.after(() => fixture.close());

	const publicResponse = await fixture.request('/api/config', { method: 'PUT', json: { model: 'public' } });
	assert.equal(publicResponse.status, 400);
	assert.deepEqual(await body(publicResponse), { error: 'Choose a supported model.' });

	const internalResponse = await fixture.request('/api/config', { method: 'PUT', json: { model: 'internal' } });
	assert.equal(internalResponse.status, 500);
	const payload = await body(internalResponse);
	assert.equal(payload.error, 'The request could not be completed. Try again.');
	assert.doesNotMatch(JSON.stringify(payload), /workspace|config\.json/);

	const spoofedResponse = await fixture.request('/api/config', { method: 'PUT', json: { model: 'spoof' } });
	assert.equal(spoofedResponse.status, 500);
	const spoofedPayload = await body(spoofedResponse);
	assert.equal(spoofedPayload.error, 'The request could not be completed. Try again.');
	assert.doesNotMatch(JSON.stringify(spoofedPayload), /workspace|auth\.json/);
});

test('finding status PATCH validates ownership, input, and broadcasts the transition', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create('Bug route run');
	const finding = {
		id: randomUUID(), ts: 900, severity: 'critical', title: 'Login loop',
		category: 'auth', url: 'https://example.test/login', expected: 'session', actual: 'redirects forever'
	};
	session.findings = [finding];
	const events = [];
	fixture.services.events.subscribe(session.id, event => events.push(event));

	const happy = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'in_progress', note: 'under investigation' }
	});
	assert.equal(happy.status, 200);
	const happyBody = await body(happy);
	assert.equal(happyBody.ok, true);
	assert.equal(happyBody.finding.status, 'in_progress');
	assert.equal(happyBody.finding.statusNote, 'under investigation');
	assert.equal(session.findings[0].status, 'in_progress');
	assert.equal(events.filter(event => event.type === 'finding_status').length, 1);

	const unknownFinding = await fixture.request(`/api/sessions/${session.id}/findings/${randomUUID()}`, {
		method: 'PATCH', json: { status: 'fixed' }
	});
	assert.equal(unknownFinding.status, 404);

	const invalidStatus = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'closed' }
	});
	assert.equal(invalidStatus.status, 400);
	const invalidBody = await body(invalidStatus);
	assert.match(invalidBody.error, /status/i);

	const longNote = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed', note: 'x'.repeat(501) }
	});
	assert.equal(longNote.status, 400);

	const unknownSession = await fixture.request(`/api/sessions/${randomUUID()}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed' }
	});
	assert.equal(unknownSession.status, 404);

	// Clearing a note with an empty string is a valid transition.
	const cleared = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed', note: '' }
	});
	assert.equal(cleared.status, 200);
	assert.equal((await body(cleared)).finding.statusNote, '');
});

test('the finding PATCH route enforces the shared auth and CSRF middleware contract', async t => {
	// The same /api middleware guards every route; this pins the contract for
	// the findings endpoint specifically: 401 without a session, 403 without
	// a CSRF double-submit on mutations, and pass-through with both. Bug
	// tracking is ownership-scoped (any authenticated user manages their own
	// runs' bugs), so there is no additional role gate.
	const memory = createMemoryServices();
	const sessionsSeen = [];
	memory.services.runs.get = async id => {
		sessionsSeen.push(id);
		return undefined;
	};
	const authService = {
		async authenticate(token) {
			if (token !== 'valid') return null;
			return { userId: 'auth-user', role: 'owner' };
		},
		async register() { throw new Error('unused'); },
		async login() { throw new Error('unused'); }
	};
	const fixture = await startFixture({ memory, environment: { QASE_AUTH_REQUIRED: 'true' } });
	// startFixture does not inject authService; rebuild the app with it.
	const { createApplication } = await import('./app.js');
	const application = createApplication({
		services: { ...memory.services, auth: authService },
		access: createTestAccess(),
		environment: { QASE_AUTH_REQUIRED: 'true' },
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	t.after(async () => {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
		await fixture.close();
	});

	const path = '/api/sessions/00000000-0000-4000-8000-000000000000/findings/00000000-0000-4000-8000-000000000001';

	const anon = await fetch(`${origin}${path}`, {
		method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'fixed' })
	});
	assert.equal(anon.status, 401, 'no session cookie → rejected by auth middleware');
	assert.deepEqual(sessionsSeen, [], 'auth rejects before the route runs');

	// Authenticated but no CSRF header/cookie pair → 403 before the route runs.
	const noCsrf = await fetch(`${origin}${path}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', cookie: 'qase_session=valid' },
		body: JSON.stringify({ status: 'fixed' })
	});
	assert.equal(noCsrf.status, 403, 'mutation without CSRF double-submit → 403');
	assert.deepEqual(sessionsSeen, [], 'CSRF rejects before the route runs');

	// A GET is mutation-free: no CSRF requirement, and unknown sessions 404.
	const get = await fetch(`${origin}${path}`, { headers: { cookie: 'qase_session=valid' } });
	assert.equal(get.status, 404);
});

test('GET /api/findings returns the owned backlog with composed filters', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const first = fixture.services.runs.create('Checkout audit');
	first.mode = 'qa';
	const second = fixture.services.runs.create('Homepage audit');
	second.mode = 'qa';
	const findings = [
		{ id: randomUUID(), ts: 100, severity: 'critical', title: 'Payment fails', category: 'checkout', url: 'https://shop.test/pay', expected: 'ok', actual: '500' },
		{ id: randomUUID(), ts: 200, severity: 'medium', title: 'Logo blur', category: 'ui', url: 'https://shop.test/', expected: 'sharp', actual: 'blurry' }
	];
	first.findings = findings;
	second.findings = [
		{ id: randomUUID(), ts: 300, severity: 'high', title: 'Nav overlap', category: 'ui', url: 'https://shop.test/home', expected: 'ok', actual: 'overlap' }
	];
	// Track one finding through its lifecycle before listing.
	await fixture.services.runs.setFindingStatus(first, findings[0].id, { status: 'fixed', note: 'hotfix shipped' });

	const all = await body(await fixture.request('/api/findings'));
	assert.equal(all.findings.length, 3);
	assert.deepEqual(all.findings.map(row => row.severity), ['critical', 'high', 'medium'], 'severity-first, newest within severity');
	assert.equal(all.findings[0].status, 'fixed');
	assert.equal(all.findings[0].statusNote, 'hotfix shipped');
	assert.equal(all.findings[0].runTitle, 'Checkout audit');
	assert.equal(typeof all.serverNow, 'number');

	const fixed = await body(await fixture.request('/api/findings?status=fixed'));
	assert.deepEqual(fixed.findings.map(row => row.title), ['Payment fails']);

	const uiOpen = await body(await fixture.request('/api/findings?severity=medium&status=open'));
	assert.deepEqual(uiOpen.findings.map(row => row.title), ['Logo blur']);

	const byRun = await body(await fixture.request(`/api/findings?run=${second.id}`));
	assert.deepEqual(byRun.findings.map(row => row.title), ['Nav overlap']);

	const search = await body(await fixture.request('/api/findings?q=PAYMENT'));
	assert.equal(search.findings.length, 1);

	const limited = await body(await fixture.request('/api/findings?limit=2'));
	assert.equal(limited.findings.length, 2);

	const badStatus = await fixture.request('/api/findings?status=closed');
	assert.equal(badStatus.status, 400);

	const badSeverity = await fixture.request('/api/findings?severity=blocker');
	assert.equal(badSeverity.status, 400);

	const empty = await body(await fixture.request('/api/findings?q=nothing-matches'));
	assert.deepEqual(empty.findings, []);
});

test('GET /api/coverage aggregates cases × environments × runs with honest metrics', async t => {
	const env = {
		envId: 'ENV-IOS-IP16PRO-18.3-SAF-18.3', platform: 'ios', device: 'iPhone 16 Pro',
		osVersion: '18.3', browser: 'Safari', browserVersion: '18.3', active: true
	};
	// The route mounts only when the coverage group exists at startup, so the
	// fixture swaps the snapshot result per stage rather than the service.
	let snapshotResult = { metrics: { environments: 0, testCases: 0, assignedPairs: 0, executedPairs: 0, passedPairs: 0, coveragePct: 0, passRatePct: 0, runsConsidered: 0 }, rows: [], environments: [] };
	const memory = createMemoryServices();
	memory.services.coverage = { snapshot: async () => snapshotResult };
	const fixture = await startFixture({ memory });
	t.after(() => fixture.close());

	// Empty workspace → zeros/empty, not an error.
	const empty = await body(await fixture.request('/api/coverage'));
	assert.equal(empty.metrics.coveragePct, 0);
	assert.equal(empty.metrics.assignedPairs, 0);
	assert.deepEqual(empty.rows, []);
	assert.deepEqual(empty.environments, []);

	fixture.services.environments.list = async () => [env];
	const expected = createCoverageService({
		testCases: {
			list: async () => ({ testCases: [
				{ caseNumber: 'TC-1', title: 'Checkout flow', tags: [], environmentIds: [env.envId] },
				{ caseNumber: 'TC-2', title: 'Login', tags: [], environmentIds: [env.envId], deleted: true }
			] })
		},
		environments: fixture.services.environments,
		runs: fixture.services.runs,
		listRuns: async () => [
			{ id: 'r1', testCaseId: 'TC-1', environmentId: env.envId, status: 'done', updatedAt: 10, report: { verdict: 'pass_with_issues' } }
		],
		tenantContext: {}
	});
	snapshotResult = await expected.snapshot();

	const payload = await body(await fixture.request('/api/coverage'));
	assert.equal(payload.metrics.environments, 1);
	assert.equal(payload.metrics.testCases, 1); // deleted case excluded
	assert.equal(payload.metrics.assignedPairs, 1);
	assert.equal(payload.metrics.executedPairs, 1);
	assert.equal(payload.metrics.passedPairs, 1); // pass_with_issues is a pass
	assert.equal(payload.metrics.coveragePct, 100);
	assert.equal(payload.metrics.passRatePct, 100);
	assert.equal(payload.rows[0].caseNumber, 'TC-1');
	assert.equal(payload.rows[0].cells[env.envId].latestRunId, 'r1');
	assert.equal(payload.rows[0].cells[env.envId].verdict, 'pass_with_issues');
	assert.equal(payload.environments[0].envId, env.envId);
});

test('GET /api/coverage is absent when no coverage service is configured', async t => {
	const fixture = await startFixture({ memory: createMemoryServices() });
	t.after(() => fixture.close());
	assert.equal(fixture.services.coverage, undefined);
	const response = await fixture.request('/api/coverage');
	assert.equal(response.status, 404);
});


test('finding status PATCH validates ownership, input, and broadcasts the transition', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const session = fixture.services.runs.create('Bug route run');
	const finding = {
		id: randomUUID(), ts: 900, severity: 'critical', title: 'Login loop',
		category: 'auth', url: 'https://example.test/login', expected: 'session', actual: 'redirects forever'
	};
	session.findings = [finding];
	const events = [];
	fixture.services.events.subscribe(session.id, event => events.push(event));

	const happy = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'in_progress', note: 'under investigation' }
	});
	assert.equal(happy.status, 200);
	const happyBody = await body(happy);
	assert.equal(happyBody.ok, true);
	assert.equal(happyBody.finding.status, 'in_progress');
	assert.equal(happyBody.finding.statusNote, 'under investigation');
	assert.equal(session.findings[0].status, 'in_progress');
	assert.equal(events.filter(event => event.type === 'finding_status').length, 1);

	const unknownFinding = await fixture.request(`/api/sessions/${session.id}/findings/${randomUUID()}`, {
		method: 'PATCH', json: { status: 'fixed' }
	});
	assert.equal(unknownFinding.status, 404);

	const invalidStatus = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'closed' }
	});
	assert.equal(invalidStatus.status, 400);
	const invalidBody = await body(invalidStatus);
	assert.match(invalidBody.error, /status/i);

	const longNote = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed', note: 'x'.repeat(501) }
	});
	assert.equal(longNote.status, 400);

	const unknownSession = await fixture.request(`/api/sessions/${randomUUID()}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed' }
	});
	assert.equal(unknownSession.status, 404);

	// Clearing a note with an empty string is a valid transition.
	const cleared = await fixture.request(`/api/sessions/${session.id}/findings/${finding.id}`, {
		method: 'PATCH', json: { status: 'fixed', note: '' }
	});
	assert.equal(cleared.status, 200);
	assert.equal((await body(cleared)).finding.statusNote, '');
});

test('the finding PATCH route enforces the shared auth and CSRF middleware contract', async t => {
	// The same /api middleware guards every route; this pins the contract for
	// the findings endpoint specifically: 401 without a session, 403 without
	// a CSRF double-submit on mutations, and pass-through with both. Bug
	// tracking is ownership-scoped (any authenticated user manages their own
	// runs' bugs), so there is no additional role gate.
	const memory = createMemoryServices();
	const sessionsSeen = [];
	memory.services.runs.get = async id => {
		sessionsSeen.push(id);
		return undefined;
	};
	const authService = {
		async authenticate(token) {
			if (token !== 'valid') return null;
			return { userId: 'auth-user', role: 'owner' };
		},
		async register() { throw new Error('unused'); },
		async login() { throw new Error('unused'); }
	};
	const fixture = await startFixture({ memory, environment: { QASE_AUTH_REQUIRED: 'true' } });
	// startFixture does not inject authService; rebuild the app with it.
	const { createApplication } = await import('./app.js');
	const application = createApplication({
		services: { ...memory.services, auth: authService },
		access: createTestAccess(),
		environment: { QASE_AUTH_REQUIRED: 'true' },
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	t.after(async () => {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
		await fixture.close();
	});

	const path = '/api/sessions/00000000-0000-4000-8000-000000000000/findings/00000000-0000-4000-8000-000000000001';

	const anon = await fetch(`${origin}${path}`, {
		method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'fixed' })
	});
	assert.equal(anon.status, 401, 'no session cookie → rejected by auth middleware');
	assert.deepEqual(sessionsSeen, [], 'auth rejects before the route runs');

	// Authenticated but no CSRF header/cookie pair → 403 before the route runs.
	const noCsrf = await fetch(`${origin}${path}`, {
		method: 'PATCH',
		headers: { 'content-type': 'application/json', cookie: 'qase_session=valid' },
		body: JSON.stringify({ status: 'fixed' })
	});
	assert.equal(noCsrf.status, 403, 'mutation without CSRF double-submit → 403');
	assert.deepEqual(sessionsSeen, [], 'CSRF rejects before the route runs');

	// A GET is mutation-free: no CSRF requirement, and unknown sessions 404.
	const get = await fetch(`${origin}${path}`, { headers: { cookie: 'qase_session=valid' } });
	assert.equal(get.status, 404);
});

test('GET /api/findings returns the owned backlog with composed filters', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());
	const first = fixture.services.runs.create('Checkout audit');
	first.mode = 'qa';
	const second = fixture.services.runs.create('Homepage audit');
	second.mode = 'qa';
	const findings = [
		{ id: randomUUID(), ts: 100, severity: 'critical', title: 'Payment fails', category: 'checkout', url: 'https://shop.test/pay', expected: 'ok', actual: '500' },
		{ id: randomUUID(), ts: 200, severity: 'medium', title: 'Logo blur', category: 'ui', url: 'https://shop.test/', expected: 'sharp', actual: 'blurry' }
	];
	first.findings = findings;
	second.findings = [
		{ id: randomUUID(), ts: 300, severity: 'high', title: 'Nav overlap', category: 'ui', url: 'https://shop.test/home', expected: 'ok', actual: 'overlap' }
	];
	// Track one finding through its lifecycle before listing.
	await fixture.services.runs.setFindingStatus(first, findings[0].id, { status: 'fixed', note: 'hotfix shipped' });

	const all = await body(await fixture.request('/api/findings'));
	assert.equal(all.findings.length, 3);
	assert.deepEqual(all.findings.map(row => row.severity), ['critical', 'high', 'medium'], 'severity-first, newest within severity');
	assert.equal(all.findings[0].status, 'fixed');
	assert.equal(all.findings[0].statusNote, 'hotfix shipped');
	assert.equal(all.findings[0].runTitle, 'Checkout audit');
	assert.equal(typeof all.serverNow, 'number');

	const fixed = await body(await fixture.request('/api/findings?status=fixed'));
	assert.deepEqual(fixed.findings.map(row => row.title), ['Payment fails']);

	const uiOpen = await body(await fixture.request('/api/findings?severity=medium&status=open'));
	assert.deepEqual(uiOpen.findings.map(row => row.title), ['Logo blur']);

	const byRun = await body(await fixture.request(`/api/findings?run=${second.id}`));
	assert.deepEqual(byRun.findings.map(row => row.title), ['Nav overlap']);

	const search = await body(await fixture.request('/api/findings?q=PAYMENT'));
	assert.equal(search.findings.length, 1);

	const limited = await body(await fixture.request('/api/findings?limit=2'));
	assert.equal(limited.findings.length, 2);

	const badStatus = await fixture.request('/api/findings?status=closed');
	assert.equal(badStatus.status, 400);

	const badSeverity = await fixture.request('/api/findings?severity=blocker');
	assert.equal(badSeverity.status, 400);

	const empty = await body(await fixture.request('/api/findings?q=nothing-matches'));
	assert.deepEqual(empty.findings, []);
});
