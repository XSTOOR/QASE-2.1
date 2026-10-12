import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { EnvironmentValidationError, EnvironmentConflictError } from './environmentService.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

const SAMPLE = {
	envId: 'ENV-IOS-IP16PRO-18.3-CHR-151',
	platform: 'ios',
	platformLabel: 'iPhone',
	device: 'iPhone 16 Pro',
	os: 'iOS',
	osVersion: '18.3',
	browser: 'Chrome',
	browserCode: 'chrome',
	browserVersion: '151',
	deviceType: 'mobile',
	screenSize: '6.3 inch',
	executionProvider: 'environment',
	isRealDevice: true,
	active: true,
	runtimeCapabilities: { browserName: 'chrome', browserVersion: '151', os: 'ios', osVersion: '18.3', deviceName: 'iPhone 16 Pro', realMobile: true }
};

async function startFixture(overrides = {}) {
	const services = {
		runs: {
			load: async () => undefined,
			list: async () => [],
			create: async o => o,
			get: async () => null,
			delete: async () => true,
			recordCleanup: async () => ({ recorded: true }),
			commit: async s => s,
			addMessage: async (s, m) => m,
			addActivity: async (s, a) => a,
			updateActivity: async (s, _i, a) => a,
			setStatus: async (s, _st) => s,
			markExecutionStarted: async s => s,
			markReportPhase: async s => s,
			publish: async () => undefined,
			subscribe: () => ({ dispose() {} }),
			dropLive: () => undefined
		},
		events: { publish: async () => undefined, subscribe: () => ({ dispose() {} }) },
		configuration: { getPublic: async () => ({}), save: async () => ({}), testConnection: async () => ({}) },
		secrets: { clear: async () => undefined, names: () => [], store: async () => undefined },
feedback: {
		create: async () => ({}),
		get: async () => null,
		list: async () => [],
		update: async () => ({}),
		remove: async () => true,
		stats: async () => ({}),
		forRun: async () => null
		},
		reports: { buildMarkdown: async () => '' },
		agent: { ensureRuntime: async () => ({}), runTurn: async () => ({}), closeBrowser: async () => undefined, getLiveState: () => ({}), stop: async () => undefined, invalidateIdleRuntimes: () => undefined },
		readiness: { check: async () => ({ ready: true }) },
		feedback: { create: async () => ({}), get: async () => undefined, list: async () => [], update: async () => ({}), remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		lifecycle: { close: async () => undefined },
		environments: {
			seed: async () => ({ inserted: 0 }),
			list: async filters => (overrides.list ? overrides.list(filters) : [SAMPLE]),
			get: async envId => (envId === SAMPLE.envId ? SAMPLE : null),
			create: async input => {
				if (overrides.create) return overrides.create(input);
				throw new EnvironmentValidationError('invalid combo');
			},
			update: async (envId, patch) => (overrides.update ? overrides.update(envId, patch) : { ...SAMPLE, ...patch }),
			facets: async filters => (overrides.facets ? overrides.facets(filters) : { total: 1, platform: [{ value: 'ios', count: 1 }] }),
			availability: () => [{ platform: 'ios', available: ['Safari', 'Chrome'], unavailable: [{ browser: 'Firefox', reason: 'not on iOS' }] }],
			catalogVersion: () => 'test'
		},
		feedback: { create: async () => undefined, get: async () => undefined, list: async () => [], update: async () => undefined, remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		...(overrides.services ?? {})
	};
	if (overrides.refreshCatalog) {
		services.environments.refreshCatalog = overrides.refreshCatalog;
	}
	const application = createApplication({
		services,
		access: overrides.access ?? createInstanceAccess({ tenantContext: TENANT }),
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const address = server.address();
	const origin = `http://127.0.0.1:${address.port}`;

	async function json(path, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		let body = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(requestOptions.json);
		}
		const response = await fetch(`${origin}${path}`, { ...requestOptions, headers, body });
		let parsed = null;
		try {
			parsed = await response.json();
		} catch {
			parsed = null;
		}
		return { status: response.status, body: parsed };
	}

	async function close() {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
	}
	return { json, close };
}

test('GET /api/environments returns rows plus total', async () => {
	const fx = await startFixture();
	try {
		const { status, body } = await fx.json('/api/environments?platform=ios&browser=Chrome&osVersion=18.3&browserVersion=151');
		assert.equal(status, 200);
		assert.equal(body.total, 1);
		assert.equal(body.environments[0].envId, 'ENV-IOS-IP16PRO-18.3-CHR-151');
	} finally {
		await fx.close();
	}
});

test('GET /api/environments validates limit/offset bounds', async () => {
	const fx = await startFixture();
	try {
		assert.equal((await fx.json('/api/environments?limit=0')).status, 400);
		assert.equal((await fx.json('/api/environments?limit=80001')).status, 400);
		assert.equal((await fx.json('/api/environments?offset=-1')).status, 400);
		assert.equal((await fx.json('/api/environments?limit=80000&offset=0')).status, 200);
	} finally {
		await fx.close();
	}
});

test('GET /api/environments/facets returns dimension counts', async () => {
	const fx = await startFixture();
	try {
		const { status, body } = await fx.json('/api/environments/facets?platform=ios');
		assert.equal(status, 200);
		assert.equal(body.total, 1);
		assert.deepEqual(body.platform, [{ value: 'ios', count: 1 }]);
	} finally {
		await fx.close();
	}
});

test('GET /api/environments/availability explains gaps', async () => {
	const fx = await startFixture();
	try {
		const { status, body } = await fx.json('/api/environments/availability');
		assert.equal(status, 200);
		assert.equal(body[0].unavailable[0].browser, 'Firefox');
	} finally {
		await fx.close();
	}
});

test('GET /api/environments/:envId returns the record or 404', async () => {
	const fx = await startFixture();
	try {
		assert.equal((await fx.json(`/api/environments/${SAMPLE.envId}`)).status, 200);
		assert.equal((await fx.json('/api/environments/ENV-NOPE')).status, 404);
	} finally {
		await fx.close();
	}
});

test('POST /api/environments maps validation errors to 422 with a readable reason', async () => {
	const fx = await startFixture({
		create: async () => { throw new EnvironmentValidationError('Firefox is not available on iPhone via BrowserStack'); }
	});
	try {
		const { status, body } = await fx.json('/api/environments', {
			method: 'POST',
			json: { platform: 'ios', device: 'iPhone 16 Pro', browser: 'firefox' }
		});
		assert.equal(status, 422);
		assert.match(body.error, /not available on iPhone/);
	} finally {
		await fx.close();
	}
});

test('POST /api/environments maps duplicate env_id to 409', async () => {
	const fx = await startFixture({
		create: async () => { throw new EnvironmentConflictError('ENV-IOS-IP16PRO-18.3-CHR-151'); }
	});
	try {
		const { status, body } = await fx.json('/api/environments', {
			method: 'POST',
			json: { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151' }
		});
		assert.equal(status, 409);
		assert.equal(body.envId, 'ENV-IOS-IP16PRO-18.3-CHR-151');
	} finally {
		await fx.close();
	}
});

test('POST /api/environments returns 201 for a valid combination', async () => {
	const fx = await startFixture({ create: async input => ({ ...SAMPLE, ...input }) });
	try {
		const { status } = await fx.json('/api/environments', {
			method: 'POST',
			json: { platform: 'macos', device: 'macOS Sonoma', osVersion: 'Sonoma', browser: 'chrome', browserVersion: '151' }
		});
		assert.equal(status, 201);
	} finally {
		await fx.close();
	}
});

test('PATCH deactivates (deprecates) an environment', async () => {
	const fx = await startFixture();
	try {
		const { status, body } = await fx.json(`/api/environments/${SAMPLE.envId}`, {
			method: 'PATCH',
			json: { active: false }
		});
		assert.equal(status, 200);
		assert.equal(body.active, false);
	} finally {
		await fx.close();
	}
});

test('PATCH validates patch shape and rejects unknown environments', async () => {
	const fx = await startFixture({ update: async () => null });
	try {
		assert.equal((await fx.json(`/api/environments/${SAMPLE.envId}`, { method: 'PATCH', json: { active: 'nope' } })).status, 400);
		assert.equal((await fx.json(`/api/environments/${SAMPLE.envId}`, { method: 'PATCH', json: { executionProvider: ' SauceLabs ' } })).status, 400);
		assert.equal((await fx.json(`/api/environments/${SAMPLE.envId}`, { method: 'PATCH', json: { active: false } })).status, 404);
	} finally {
		await fx.close();
	}
});

test('filters are passed through to the service untouched', async () => {
	const seen = [];
	const fx = await startFixture({
		list: async filters => { seen.push(filters); return []; },
		facets: async () => ({ total: 0 })
	});
	try {
		await fx.json('/api/environments?platform=ios&osVersion=18.3&browser=Chrome&browserVersion=151&active=true&isRealDevice=true&deviceType=mobile&search=IP16PRO');
		assert.equal(seen.length, 1);
		assert.equal(seen[0].platform, 'ios');
		assert.equal(seen[0].osVersion, '18.3');
		assert.equal(seen[0].active, 'true');
		assert.equal(seen[0].isRealDevice, 'true');
		assert.equal(seen[0].search, 'IP16PRO');
	} finally {
		await fx.close();
	}
});

// ---------------------------------------------------------------------------
// Phase 3: bulk operations
// ---------------------------------------------------------------------------

test('POST /api/environments/bulk creates valid combos and skips invalid ones', async () => {
	const fx = await startFixture({
		services: {
			environments: {
				seed: async () => ({}),
				list: async () => [],
				get: async () => null,
				create: async input => {
					if (input.browser === 'firefox') throw new EnvironmentValidationError('firefox is not available on iOS');
					return { ...SAMPLE, envId: `ENV-${input.browserVersion}` };
				},
				update: async () => null,
				facets: async () => ({ total: 0 }),
				availability: () => [],
				catalogVersion: () => 'test',
				bulkCreate: async inputs => {
					const created = [];
					const skipped = [];
					for (const input of inputs) {
						try {
							created.push(await createViaService(input));
						} catch (error) {
							skipped.push({ reason: error.message });
						}
					}
					return { created, skipped, total: inputs.length };
				}
			}
		}
	});
	async function createViaService(input) {
		// Mirrors the service-level bulkCreate: backend.create validates each combo.
		if (input.browser === 'firefox') throw new EnvironmentValidationError('firefox is not available on iOS');
		return { ...SAMPLE, envId: `ENV-${input.browserVersion}` };
	}
	try {
		const { status, body } = await fx.json('/api/environments/bulk', {
			method: 'POST',
			json: { combinations: [
				{ platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151' },
				{ platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'firefox', browserVersion: '150' }
			] }
		});
		assert.equal(status, 201);
		assert.equal(body.total, 2);
		assert.equal(body.skipped.length, 1);
		assert.match(body.skipped[0].reason, /firefox/);
	} finally {
		await fx.close();
	}
});

test('POST /api/environments/bulk-toggle requires envIds array and toggles through the service', async () => {
	const updated = [];
	const fx = await startFixture({
		services: {
			environments: {
				seed: async () => ({}),
				list: async () => [],
				get: async () => null,
				create: async () => { throw new EnvironmentValidationError('unused'); },
				update: async () => null,
				facets: async () => ({ total: 0 }),
				availability: () => [],
				catalogVersion: () => 'test',
				bulkToggleActive: async (envIds, active) => {
					updated.push({ envIds, active });
					return { updated: envIds.map(envId => ({ envId, active })), missing: [], active };
				}
			}
		}
	});
	try {
		const bad = await fx.json('/api/environments/bulk-toggle', { method: 'POST', json: { envIds: 'nope' } });
		assert.equal(bad.status, 400);
		const ok = await fx.json('/api/environments/bulk-toggle', {
			method: 'POST',
			json: { envIds: ['ENV-A', 'ENV-B'], active: false }
		});
		assert.equal(ok.status, 200);
		assert.equal(ok.body.active, false);
		assert.deepEqual(updated, [{ envIds: ['ENV-A', 'ENV-B'], active: false }]);
	} finally {
		await fx.close();
	}
});

// ---------------------------------------------------------------------------
// #14275 (Phase 2): catalog meta + refresh endpoints
// ---------------------------------------------------------------------------

test('GET /api/catalog/meta returns version and providers without secrets', async () => {
	const fx = await startFixture();
	try {
		const res = await fx.json('/api/catalog/meta');
		assert.equal(res.status, 200);
		assert.equal(typeof res.body.catalogVersion, 'string');
		assert.ok(Array.isArray(res.body.providers));
		assert.ok(res.body.providers.some((p) => p.slug === 'builtin' && p.rowCount >= 2500 && p.rowCount <= 5000), 'builtin provider with real row count');
		assert.equal(typeof res.body.generatedAt, 'string');
		assert.ok(!JSON.stringify(res.body).match(/password|secret|token|access[_-]?key/i), 'no secret material in meta');
	} finally {
		await fx.close();
	}
});

test('POST /api/catalog/refresh invokes the service and returns its result', async () => {
	const calls = [];
	const fx = await startFixture({
		refreshCatalog: async () => {
			calls.push(1);
			return { refreshed: true, catalogVersion: '2027.03.0', attestations: 0, providers: [] };
		}
	});
	try {
		const res = await fx.json('/api/catalog/refresh', { method: 'POST' });
		assert.equal(res.status, 200);
		assert.equal(res.body.refreshed, true);
		assert.equal(calls.length, 1);
	} finally {
		await fx.close();
	}
});

test('POST /api/catalog/refresh is 403 for non-admin roles', async () => {
	// Mount an access layer that attributes requests to a pilot (non-admin)
	// identity, mirroring how embedded instance access stamps request.auth.
	const memberAccess = {
		mount(app) {
			app.use('/api', (request, response, next) => {
				request.auth = { ...TENANT, role: 'pilot' };
				next();
			});
		}
	};
	let refreshCalls = 0;
	const fx = await startFixture({
		access: memberAccess,
		refreshCatalog: async () => {
			refreshCalls += 1;
			return { refreshed: true };
		}
	});
	try {
		const res = await fx.json('/api/catalog/refresh', { method: 'POST' });
		assert.equal(res.status, 403);
		assert.match(res.body.error, /admin/i);
		assert.equal(refreshCalls, 0, 'service must not be invoked for non-admin');
	} finally {
		await fx.close();
	}
});
