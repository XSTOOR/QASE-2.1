import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createLocalDeviceCatalogBackend } from './localDeviceCatalog.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

/** Minimal services object with a REAL local device catalog backend seeded. */
async function startFixture(catalogOverride = null) {
	const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-catalog-api-'));
	const deviceCatalog = catalogOverride ?? createLocalDeviceCatalogBackend({
		stateDir: catalogDir,
		stateFile: path.join(catalogDir, 'device-catalog.json')
	});
	if (!catalogOverride) await deviceCatalog.seed();

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
		feedback: { create: async () => undefined, get: async () => undefined, list: async () => [], update: async () => undefined, remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		deviceCatalog,
		environments: {
			seed: async () => ({ inserted: 0 }),
			list: async () => [],
			get: async () => null,
			create: async () => { throw new Error('unused'); },
			update: async () => null,
			facets: async () => ({ total: 0 }),
			availability: () => [],
			catalogVersion: () => 'test'
		}
	};
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;

	async function json(pathName, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		let body = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(requestOptions.json);
		}
		const response = await fetch(`${origin}${pathName}`, { ...requestOptions, headers, body });
		let parsed = null;
		try { parsed = await response.json(); } catch { parsed = null; }
		return { status: response.status, body: parsed };
	}
	async function close() {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
	}
	return { json, close };
}

test('GET /api/catalog lists seeded entities', async () => {
	const fixture = await startFixture();
	try {
		const devices = await fixture.json('/api/catalog/deviceModels');
		assert.equal(devices.status, 200);
		assert.ok(devices.body.count >= 25, `expected 25+ devices, got ${devices.body.count}`);

		const browsers = await fixture.json('/api/catalog/browsers');
		assert.equal(browsers.body.count, 7);

		const chips = await fixture.json('/api/catalog/hardware');
		assert.ok(chips.body.rows.some((row) => row.id === 'm5'));

		const filtered = await fixture.json('/api/catalog/deviceModels?category_id=iphone');
		assert.ok(filtered.body.rows.every((row) => row.category_id === 'iphone'));
	} finally {
		await fixture.close();
	}
});

test('GET unknown catalog entity → 400', async () => {
	const fixture = await startFixture();
	try {
		const result = await fixture.json('/api/catalog/notAnEntity');
		assert.equal(result.status, 400);
		assert.equal(result.body.code, 'QASE_CATALOG_UNKNOWN_ENTITY');
	} finally {
		await fixture.close();
	}
});

// #14648 (NI01 Phase 2): meta MUST be registered before the :entity wildcard —
// otherwise 'meta' resolves as an unknown entity and the endpoint 400s.
test('GET /api/catalog/meta is reachable and carries the browser support report (#14648)', async () => {
	const fixture = await startFixture();
	try {
		const result = await fixture.json('/api/catalog/meta');
		assert.equal(result.status, 200);
		assert.ok(result.body.catalogVersion, 'catalogVersion missing');
		assert.ok(Array.isArray(result.body.providers), 'providers missing');
		const support = result.body.browserSupport;
		assert.ok(Array.isArray(support), 'browserSupport report must be an array');
		assert.equal(support.length, 7);
		const duck = support.find((entry) => entry.browser === 'duckduckgo');
		assert.ok(duck, 'duckduckgo entry missing');
		assert.equal(duck.status, 'not_supported', 'duckduckgo must resolve not_supported');
		assert.ok(duck.reason, 'duckduckgo reason missing');
		const opera = support.find((entry) => entry.browser === 'opera');
		// RT1 (#14680): opera is 'supported' when a launch-verified branded
		// binary exists on this host, 'engine_equivalent' otherwise — never a
		// fabricated branded pass. Accept both truthful outcomes.
		assert.ok(['supported', 'engine_equivalent'].includes(opera.status),
			`opera resolved unexpected status ${opera.status}`);
		if (opera.status === 'supported') {
			assert.ok(opera.branded === true && opera.executablePath,
				'a supported opera must cite the real binary');
		}
	} finally {
		await fixture.close();
	}
});

test('POST /api/catalog/browserVersions adds Chrome 160, then env validation accepts it', async () => {
	const fixture = await startFixture();
	try {
		const created = await fixture.json('/api/catalog/browserVersions', {
			method: 'POST',
			json: { browser_id: 'chrome', version: '160' }
		});
		assert.equal(created.status, 201);
		assert.equal(created.body.id, 'chrome:160');

		const duplicate = await fixture.json('/api/catalog/browserVersions', {
			method: 'POST',
			json: { browser_id: 'chrome', version: '160' }
		});
		assert.equal(duplicate.status, 409);
		assert.equal(duplicate.body.code, 'QASE_CATALOG_CONFLICT');

		const verdict = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=18.3&browser=chrome&browserVersion=151');
		assert.deepEqual(verdict.body, { ok: true });

		const before = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=18.3&browser=chrome&browserVersion=999');
		assert.equal(before.body.ok, false);
	} finally {
		await fixture.close();
	}
});

test('POST /api/catalog/osVersions adds iOS 26.1 and compatibility accepts it once linked', async () => {
	const fixture = await startFixture();
	try {
		const created = await fixture.json('/api/catalog/osVersions', {
			method: 'POST',
			json: { os_family_id: 'ios', version: '26.1' }
		});
		assert.equal(created.status, 201);
		assert.equal(created.body.display, 'iOS 26.1');

		const missingLink = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=26.1&browser=chrome');
		assert.equal(missingLink.body.ok, false, 'device-OS link not yet added');

		const link = await fixture.json('/api/catalog/deviceOsCompatibility', {
			method: 'POST',
			json: { device_model_id: 'IP16PRO', os_version_id: 'ios:26.1' }
		});
		assert.equal(link.status, 201);

		const verdict = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=26.1&browser=chrome&browserVersion=151');
		assert.deepEqual(verdict.body, { ok: true });
	} finally {
		await fixture.close();
	}
});

test('POST /api/catalog/deviceModels validates category + hardware references', async () => {
	const fixture = await startFixture();
	try {
		const badCategory = await fixture.json('/api/catalog/deviceModels', {
			method: 'POST',
			json: { display_name: 'iPhone 18 Pro', category_id: 'nope' }
		});
		assert.equal(badCategory.status, 422);
		assert.equal(badCategory.body.code, 'QASE_CATALOG_INVALID');

		const created = await fixture.json('/api/catalog/deviceModels', {
			method: 'POST',
			json: {
				display_name: 'iPhone 18 Pro',
				category_id: 'iphone',
				screen_size: '6.3 inch',
				screen_resolution: '1200x2600',
				is_real_device: true,
				hardware_id: 'a19'
			}
		});
		assert.equal(created.status, 201);
		assert.equal(created.body.slug, 'IPHONE18PRO');

		const duplicate = await fixture.json('/api/catalog/deviceModels', {
			method: 'POST',
			json: { display_name: 'iPhone 18 Pro', category_id: 'iphone' }
		});
		assert.equal(duplicate.status, 409);
	} finally {
		await fixture.close();
	}
});

test('POST validation: missing required fields → 422; unknown browser for version → 422', async () => {
	const fixture = await startFixture();
	try {
		const missing = await fixture.json('/api/catalog/browserVersions', {
			method: 'POST',
			json: { browser_id: 'chrome' }
		});
		assert.equal(missing.status, 422);

		const unknownBrowser = await fixture.json('/api/catalog/browserVersions', {
			method: 'POST',
			json: { browser_id: 'netscape', version: '1' }
		});
		assert.equal(unknownBrowser.status, 422);
		assert.match(unknownBrowser.body.error, /Unknown browser/);
	} finally {
		await fixture.close();
	}
});

test('GET /api/catalog/validate rejects invalid pairs with reasons', async () => {
	const fixture = await startFixture();
	try {
		const valid = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=18.3&browser=chrome&browserVersion=151');
		assert.deepEqual(valid.body, { ok: true });

		const crossPlatform = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=macos&osVersion=Sonoma&browser=chrome');
		assert.equal(crossPlatform.body.ok, false);

		// 2026.10 expansion: Firefox IS available on iOS now — assert the new
		// truth and keep a genuinely invalid pair (Safari on Android).
		const goodBrowser = await fixture.json('/api/catalog/validate?device=IP16PRO&platform=ios&osVersion=18.3&browser=firefox');
		assert.equal(goodBrowser.body.ok, true);

		const badBrowser = await fixture.json('/api/catalog/validate?device=GALS24&platform=android&osVersion=15&browser=safari');
		assert.equal(badBrowser.body.ok, false);
		assert.match(badBrowser.body.reason, /not (available|supported) on android/i);

		const noDevice = await fixture.json('/api/catalog/validate');
		assert.equal(noDevice.status, 400);
	} finally {
		await fixture.close();
	}
});

test('GET /api/catalog/:entity/:id returns one row or 404', async () => {
	const fixture = await startFixture();
	try {
		const row = await fixture.json('/api/catalog/hardware/m3');
		assert.equal(row.status, 200);
		assert.equal(row.body.display_name, 'Apple M3');

		const missing = await fixture.json('/api/catalog/hardware/m99');
		assert.equal(missing.status, 404);
	} finally {
		await fixture.close();
	}
});

// ---------------------------------------------------------------------------
// Phase 3: facets, model→OS resolution, browser version listing
// ---------------------------------------------------------------------------

function stubCatalog(list) {
	return { list: async (entity, filters = {}) => list(entity, filters ?? {}) };
}

test('GET /api/catalog/facets returns catalog-wide counts', async () => {
	const fixture = await startFixture(stubCatalog((entity) => ({
		deviceCategories: [{ id: 'iphone', display_name: 'iPhone' }, { id: 'ipad', display_name: 'iPad' }],
		deviceModels: [
			{ id: 'IP16PRO', category_id: 'iphone', display_name: 'iPhone 16 Pro' },
			{ id: 'IP17', category_id: 'iphone', display_name: 'iPhone 17' },
			{ id: 'IPADAIRM2', category_id: 'ipad', display_name: 'iPad Air (M2)' }
		],
		osVersions: [
			{ id: 'ios:18.3', os_family_id: 'ios' }, { id: 'ios:26.1', os_family_id: 'ios' },
			{ id: 'macos:Sonoma', os_family_id: 'macos' }
		],
		browsers: [{ id: 'chrome' }, { id: 'safari' }]
	})[entity] ?? []));
	try {
		const { status, body } = await fixture.json('/api/catalog/facets');
		assert.equal(status, 200);
		assert.equal(body.totalDeviceModels, 3);
		assert.equal(body.totalOsVersions, 3);
		assert.equal(body.totalBrowsers, 2);
		const iphone = body.deviceCategories.find((f) => f.value === 'iphone');
		assert.equal(iphone.count, 2);
		const ios = body.osFamilies.find((f) => f.value === 'ios');
		assert.equal(ios.count, 2);
	} finally {
		await fixture.close();
	}
});

test('GET /api/catalog/deviceModels/:id/osVersions resolves through the compatibility table', async () => {
	let compatQueriedFor = null;
	const fixture = await startFixture(stubCatalog((entity, filters = {}) => {
		if (entity === 'deviceModels') return filters.id === 'IP16PRO'
			? [{ id: 'IP16PRO', category_id: 'iphone' }]
			: [];
		if (entity === 'deviceCategories') return [{ id: 'iphone', platform: 'ios' }];
		if (entity === 'osVersions') return filters.os_family_id === 'ios'
			? [{ id: 'ios:18.3', display: 'iOS 18.3' }, { id: 'ios:26.1', display: 'iOS 26.1' }]
			: [];
		if (entity === 'deviceOsCompatibility') {
			compatQueriedFor = filters.device_model_id ?? null;
			return [{ device_model_id: 'IP16PRO', os_version_id: 'ios:18.3' }];
		}
		return [];
	}));
	try {
		const unknown = await fixture.json('/api/catalog/deviceModels/IP99/osVersions');
		assert.equal(unknown.status, 404);
		const { status, body } = await fixture.json('/api/catalog/deviceModels/IP16PRO/osVersions');
		assert.equal(status, 200);
		assert.equal(compatQueriedFor, 'IP16PRO');
		assert.deepEqual(body.rows.map((r) => r.id), ['ios:18.3'], 'only the explicitly linked version passes');
	} finally {
		await fixture.close();
	}
});

test('GET /api/catalog/browsers/:id/versions lists versions for a browser', async () => {
	const fixture = await startFixture(stubCatalog((entity, filters = {}) => {
		if (entity === 'browsers') return filters.id === 'chrome' ? [{ id: 'chrome', display_name: 'Chrome' }] : [];
		if (entity === 'browserVersions') return filters.browser_id === 'chrome'
			? [{ id: 'chrome:153', version: '153' }, { id: 'chrome:160', version: '160' }]
			: [];
		return [];
	}));
	try {
		const unknown = await fixture.json('/api/catalog/browsers/netscape/versions');
		assert.equal(unknown.status, 404);
		const { status, body } = await fixture.json('/api/catalog/browsers/chrome/versions');
		assert.equal(status, 200);
		assert.equal(body.count, 2);
		assert.deepEqual(body.rows.map((r) => r.version), ['153', '160']);
	} finally {
		await fixture.close();
	}
});
