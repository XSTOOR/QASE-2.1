import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createLocalEnvironmentBackend,
	createEnvironmentService,
	normalizeEnvironmentInput,
	EnvironmentValidationError,
	EnvironmentConflictError,
	withExecutionMetadata
} from './environmentService.js';

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'qase-env-'));
}

test('local backend seed is idempotent and preserves deprecations', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const first = await backend.seed();
	assert.ok(first.inserted >= 250);

	await backend.update(null, 'ENV-IOS-IP16PRO-18.3-CHR-151', { active: false });
	await backend.seed(); // reseed must not resurrect the deactivated row
	const env = await backend.get(null, 'ENV-IOS-IP16PRO-18.3-CHR-151');
	assert.equal(env.active, false, 'operator deprecation must survive reseed');
	assert.equal((await backend.list(null, {})).length >= 250, true);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend persists across restarts via .qase/environments.json', async () => {
	const dir = tempDir();
	const backendOne = createLocalEnvironmentBackend({ stateDir: dir });
	await backendOne.seed();
	// 2027.01.0 (#14273): macOS uses hardware models; envId carries the OS token.
	await backendOne.update(null, 'ENV-MAC-MACMBP14-M3-SONOMA-CHR-151', { active: false });

	const backendTwo = createLocalEnvironmentBackend({ stateDir: dir }); // fresh instance, same disk
	const env = await backendTwo.get(null, 'ENV-MAC-MACMBP14-M3-SONOMA-CHR-151');
	assert.ok(env, 'records survive a process restart');
	assert.equal(env.active, false, 'deprecation survives restart');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend filters match the documented dimensions', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await backend.seed();

	const hits = await backend.list(null, { platform: 'ios', osVersion: '18.3', browser: 'Chrome', browserVersion: '151' });
	assert.ok(hits.length > 0);
	for (const env of hits) {
		assert.equal(env.platform, 'ios');
		assert.equal(env.osVersion, '18.3');
		assert.equal(env.browser, 'Chrome');
		assert.equal(env.browserVersion, '151');
	}

	const search = await backend.list(null, { search: 'IP16PRO' });
	assert.ok(search.length > 0);
	assert.ok(search.every((env) => env.envId.includes('IP16PRO') || env.device.includes('iPhone 16 Pro')));
	fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend create enforces validation and uniqueness', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await backend.seed();

	await assert.rejects(
		() => backend.create(null, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'nonexistent' }),
		EnvironmentValidationError
	);
	const duplicate = await backend.create(null, { platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151' })
		.catch((error) => error);
	assert.ok(duplicate instanceof EnvironmentConflictError);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('environment service facade returns camelCase records and facets', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	await service.seed();

	const list = await service.list({ platform: 'macos' });
	assert.ok(list.length > 0);
	for (const env of list) {
		assert.ok(env.envId);
		assert.ok(env.runtimeCapabilities);
		assert.equal(typeof env.browserVersion, 'string');
		assert.equal(env.os, 'macOS');
		assert.ok(!('os_version' in env), 'no snake_case leakage');
	}

	const facets = await service.facets({ platform: 'ios' });
	assert.ok(facets.total >= 500);
	assert.ok(facets.browser.some((entry) => entry.value === 'Safari'));
	assert.ok(facets.browser.some((entry) => entry.value === 'Firefox'), 'Firefox appears on iOS after the 2026.10 expansion');
	// #14275: executionLevels + providers facets are present and counted.
	assert.ok(Array.isArray(facets.executionLevels) && facets.executionLevels.length > 0, 'executionLevels facet present');
	assert.ok(facets.executionLevels.every((entry) => typeof entry.count === 'number' && entry.count > 0));
	assert.ok(Array.isArray(facets.providers) && facets.providers.length > 0, 'providers facet present');
	const builtinProvider = facets.providers.find((entry) => entry.value === 'builtin');
	assert.ok(builtinProvider && builtinProvider.count === facets.total, 'all builtin-seeded rows report provider=builtin');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeEnvironmentInput rejects Safari on iOS 17 with wrong version', async () => {
	await assert.rejects(
		() => normalizeEnvironmentInput({ platform: 'ios', device: 'iPhone 15 Pro', osVersion: '17.0', browser: 'safari', browserVersion: '18' }),
		EnvironmentValidationError
	);
});

test('environment create carries screenResolution and orientation with device-type defaults', async () => {
	const mobile = await normalizeEnvironmentInput({
		platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151'
	});
	assert.equal(mobile.orientation, 'portrait', 'mobile defaults to portrait');
	assert.ok(mobile.screenResolution, 'mobile resolution derived from device viewport');

	const explicit = await normalizeEnvironmentInput({
		platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '151',
		screenResolution: '2622x1206', orientation: 'landscape'
	});
	assert.equal(explicit.screenResolution, '2622x1206');
	assert.equal(explicit.orientation, 'landscape');

	const desktop = await normalizeEnvironmentInput({
		platform: 'macos', device: 'MacBook Pro 14 (M3)', osVersion: 'Sonoma', browser: 'chrome', browserVersion: '151'
	});
	assert.equal(desktop.orientation, null, 'desktop has no orientation (not applicable)');
});

test('local backend create/update persists resolution, orientation and description', async () => {
	const dir = tempDir();
	// Fresh catalog with an operator-added version (Chrome 160) so the created
	// environment is valid but NOT already in the deterministic seed matrix.
	const { createLocalDeviceCatalogBackend } = await import('./localDeviceCatalog.js');
	const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-catalog-env-'));
	const catalog = createLocalDeviceCatalogBackend({ stateDir: catalogDir, stateFile: path.join(catalogDir, 'catalog.json') });
	await catalog.seed();
	await catalog.create('browserVersions', { browser_id: 'chrome', version: '160', sort_key: '000160' });

	const backend = createLocalEnvironmentBackend({ stateDir: dir, catalogBackend: catalog });
	await backend.seed();

	const created = await backend.create(null, {
		platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '160',
		screenResolution: '2622x1206', orientation: 'landscape', description: 'Portrait-first device lab iPhone'
	});
	assert.equal(created.screenResolution, '2622x1206');
	assert.equal(created.orientation, 'landscape');
	assert.equal(created.description, 'Portrait-first device lab iPhone');

	const updated = await backend.update(null, created.envId, { orientation: 'portrait', description: 'Updated note' });
	assert.equal(updated.orientation, 'portrait');
	assert.equal(updated.description, 'Updated note');
	assert.equal(updated.screenResolution, '2622x1206', 'resolution untouched by patch');
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(catalogDir, { recursive: true, force: true });
});

test('disable excludes an environment from picker queries; enable restores it', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await backend.seed();
	const envId = 'ENV-IOS-IP16PRO-18.3-CHR-151';

	await backend.update(null, envId, { active: false });
	const inactive = await backend.list(null, { active: 'true', limit: 20000 });
	assert.ok(!inactive.some((env) => env.envId === envId), 'disabled env must not appear in active=true picker query');
	// 2026.10 expansion: the catalog now has 3650 rows, so the unfiltered
	// history query must use the raised cap to see them all.
	const stillThere = await backend.list(null, { limit: 20000 });
	assert.ok(stillThere.some((env) => env.envId === envId), 'disabled env remains in unfiltered history');

	await backend.update(null, envId, { active: true });
	const restored = await backend.list(null, { active: 'true', limit: 20000 });
	assert.ok(restored.some((env) => env.envId === envId), 're-enabled env returns to the picker');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('availability leaves only the Safari gap on Android/Windows', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	const report = await service.availability();
	const mac = report.find((entry) => entry.platform === 'macos');
	assert.equal(mac.unavailable.length, 0, 'macOS has no gaps after expansion');
	const iosEntry = report.find((entry) => entry.platform === 'ios');
	assert.equal(iosEntry.unavailable.length, 0, 'iOS has no gaps after expansion');
	const android = report.find((entry) => entry.platform === 'android');
	assert.ok(android.unavailable.some((entry) => entry.browser === 'Safari'));
	const windows = report.find((entry) => entry.platform === 'windows');
	assert.ok(windows.unavailable.some((entry) => entry.browser === 'Safari'));
	fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeFilters drops empty values', async () => {
	const { sanitizeFilters } = await import('./environmentService.js');
	assert.deepEqual(sanitizeFilters({ platform: 'ios', osVersion: '', device: undefined, active: 'true' }), {
		platform: 'ios',
		active: 'true'
	});
});

// ---------------------------------------------------------------------------
// #14275 (Phase 2): refreshCatalog + registry-sourced seed
// ---------------------------------------------------------------------------

/** Fake registry module shaped like catalogProviderRegistry.js. */
function fakeRegistry(rows, { attestations = [] } = {}) {
	return {
		async mergeCatalog() {
			return {
				builtinVersion: '2027.01.0',
				environments: rows,
				attestations,
				providers: [{ name: 'builtin', slug: 'builtin', kind: 'builtin', connected: true, stale: false, rowCount: 36619 }]
			};
		}
	};
}

test('refreshCatalog upserts only PROV- rows and reports provider metadata', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	const upserted = [];
	const spyBackend = { ...backend, upsertProviderRow: async (_tenant, row) => {
		upserted.push(row.envId);
		return backend.upsertProviderRow(_tenant, row);
	} };
	const spyService = createEnvironmentService(spyBackend);
	const rows = [
		{ envId: 'ENV-IOS-IP16PRO-18.3-CHR-151', platform: 'ios' },
		{ envId: 'PROV-FAKE-A', platform: 'android' },
		{ envId: 'PROV-FAKE-B', platform: 'android' }
	];
	const result = await spyService.refreshCatalog(fakeRegistry(rows));
	assert.equal(result.refreshed, true);
	assert.equal(result.catalogVersion, '2027.01.0');
	assert.deepEqual(upserted.sort(), ['PROV-FAKE-A', 'PROV-FAKE-B'], 'builtin rows are never upserted');
	const stored = await spyBackend.get(null, 'PROV-FAKE-A');
	assert.ok(stored, 'provider row landed in the store');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('refreshCatalog is rate-limited to one call per minute', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	const registry = fakeRegistry([]);
	const first = await service.refreshCatalog(registry);
	assert.equal(first.refreshed, true);
	const second = await service.refreshCatalog(registry);
	assert.equal(second.refreshed, false);
	assert.equal(second.reason, 'rate-limited');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('refreshCatalog preserves operator active state on re-upsert (idempotent)', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const row = { envId: 'PROV-FAKE-A', platform: 'android', active: true, device: 'Fake One' };
	await backend.upsertProviderRow(null, row);
	// Operator deactivates the provider row via the public update path.
	await backend.update(null, 'PROV-FAKE-A', { active: false });
	// Refresh upserts the same row again — active must stay false.
	await backend.upsertProviderRow(null, { ...row, device: 'Fake One v2' });
	const stored = await backend.get(null, 'PROV-FAKE-A');
	assert.equal(stored.active, false, 'provider refresh must not resurrect a deactivated row');
	assert.equal(stored.device, 'Fake One v2', 'descriptive fields refresh');
	fs.rmSync(dir, { recursive: true, force: true });
});

test('local backend upsertProviderRow rejects non-PROV envIds', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	await assert.rejects(
		() => backend.upsertProviderRow(null, { envId: 'ENV-IOS-IP16PRO-18.3-CHR-151', platform: 'ios' }),
		EnvironmentValidationError
	);
	fs.rmSync(dir, { recursive: true, force: true });
});

test('seed merges registry provider overlays and is idempotent across reseeds', async () => {
	const { registerCatalogProvider, unregisterCatalogProvider } = await import('./catalogProviderRegistry.js');
	registerCatalogProvider({
		name: 'SeedFake',
		slug: 'seedfake',
		async fetchCatalog() {
			return {
				environments: [
					{ envId: 'SEEDFAKE-1', executionLevel: 'REAL_DEVICE', isRealDevice: true, platform: 'android', device: 'Seed Fake', os: 'Android', osVersion: '15', browser: 'Chrome', browserCode: 'chrome', browserVersion: '151', deviceType: 'mobile' }
				],
				attestations: []
			};
		}
	});
	try {
		const dir = tempDir();
		const backend = createLocalEnvironmentBackend({ stateDir: dir });
		const first = await backend.seed();
		assert.equal(first.providerRows, 1, 'provider overlay row seeded');
		const stored = await backend.get(null, 'PROV-SEEDFAKE-SEEDFAKE-1');
		assert.ok(stored, 'namespaced provider row present after seed');
		// Operator deactivates it; a reseed must not resurrect it.
		await backend.update(null, 'PROV-SEEDFAKE-SEEDFAKE-1', { active: false });
		await backend.seed();
		const after = await backend.get(null, 'PROV-SEEDFAKE-SEEDFAKE-1');
		assert.equal(after.active, false, 'provider deprecation survives reseed');
		fs.rmSync(dir, { recursive: true, force: true });
	} finally {
		unregisterCatalogProvider('seedfake');
	}
});

// ---------------------------------------------------------------------------
// R1 #14490 · Honest availability metadata
// ---------------------------------------------------------------------------

test('R1: withExecutionMetadata never defaults a catalog row to AVAILABLE', () => {
	const env = withExecutionMetadata({ envId: 'X', platform: 'ios', device: 'iPhone 16 Pro', os: 'iOS', osVersion: '18.3', browser: 'Chrome', browserVersion: '151', active: true });
	assert.equal(env.availability, 'UNAVAILABLE', 'no runtime board entry → REAL DEVICE · UNAVAILABLE, never AVAILABLE');
	assert.equal(env.runtimeSessionId, null);
});

/* iPadOS manufacturer regression (#15013 review finding): Apple platforms must
 * never fall through to the Microsoft branch. */
test('enriched ipadOS rows carry manufacturer Apple', async () => {
	const dir = tempDir();
	// NOTE: the backend option is `stateDir` — `dataDirectory` is ignored and
	// silently falls back to the real workspace .qase state (#15123).
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	await service.seed(); // fresh temp dir → must seed the builtin catalog first
	const rows = await service.list({ platform: 'ipados', limit: 50 });
	assert.ok(rows.length > 0);
	for (const row of rows) {
		assert.equal(row.deviceManufacturer, 'Apple', `row ${row.envId} should be Apple`);
	}
});

/* #15123: android manufacturer comes from the catalog row (Samsung, Google…),
 * never from the first word of the device name ("Galaxy Galaxy S24"). */
test('enriched android rows carry catalog manufacturer, not device-name prefix', async () => {
	const dir = tempDir();
	const backend = createLocalEnvironmentBackend({ stateDir: dir });
	const service = createEnvironmentService(backend);
	await service.seed();
	const rows = await service.list({ platform: 'android', limit: 80000 });
	assert.ok(rows.length > 0);
	const seen = new Set(rows.map((row) => row.deviceManufacturer));
	assert.ok(seen.has('Samsung'), `expected Samsung, saw ${[...seen].join(', ')}`);
	assert.ok(seen.has('Google'), `expected Google, saw ${[...seen].join(', ')}`);
});
