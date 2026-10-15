import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildCatalogSeed } from './deviceCatalogSeed.js';
import { createLocalDeviceCatalogBackend } from './localDeviceCatalog.js';

function tempBackend() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-catalog-'));
	return createLocalDeviceCatalogBackend({ stateDir: dir, stateFile: path.join(dir, 'device-catalog.json') });
}

test('catalog seed covers all entities with unique natural keys', () => {
	const seed = buildCatalogSeed();
	for (const entity of Object.keys(seed)) {
		assert.ok(Array.isArray(seed[entity]), `${entity} must be an array`);
		const ids = seed[entity].map((row) => (entity === 'deviceOsCompatibility'
			? `${row.device_model_id}|${row.os_version_id}`
			: entity === 'browserPlatformSupport'
				? `${row.browser_id}|${row.platform}`
				: row.id));
		assert.equal(new Set(ids).size, ids.length, `${entity} ids must be unique`);
	}
	// iPhone 16 Pro and iPhone 17 Air from the request must be present
	const models = seed.deviceModels.map((row) => row.display_name);
	assert.ok(models.includes('iPhone 16 Pro'));
	assert.ok(models.includes('iPhone 17 Air'));
	assert.ok(models.includes('iPhone 16e'));
	// M-series chips M1..M5
	const chips = seed.hardware.map((row) => row.id);
	for (const chip of ['m1', 'm2', 'm3', 'm4', 'm5']) assert.ok(chips.includes(chip));
	// seven browsers
	assert.equal(seed.browsers.length, 7);
});

test('local seed is idempotent — double seed yields no duplicates', async () => {
	const backend = tempBackend();
	const first = await backend.seed();
	const second = await backend.seed();
	assert.equal(first.inserted, second.inserted);
	const models = await backend.list('deviceModels');
	assert.equal(new Set(models.map((row) => row.id)).size, models.length);
	const versions = await backend.list('browserVersions');
	assert.ok(versions.length >= 6, `expected browser version rows (one per family), got ${versions.length}`);
});

test('isCombinationSupported accepts valid and rejects invalid pairs (data-driven)', async () => {
	const backend = tempBackend();
	await backend.seed();
	const valid = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'chrome', browserVersion: '151'
	});
	assert.deepEqual(valid, { ok: true });

	const wrongOs = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '17.5', browserCode: 'safari'
	});
	assert.equal(wrongOs.ok, false);
	assert.match(wrongOs.reason, /does not support/);

	const crossPlatform = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'macos', osVersion: 'Sonoma', browserCode: 'chrome'
	});
	assert.equal(crossPlatform.ok, false);

	// 2026.10 expansion: Firefox is valid on iOS; Safari stays invalid on Android.
	const supportedBrowser = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'firefox'
	});
	assert.equal(supportedBrowser.ok, true);

	const unsupportedBrowser = await backend.isCombinationSupported({
		deviceSlug: 'GALS24', platform: 'android', osVersion: '15', browserCode: 'safari'
	});
	assert.equal(unsupportedBrowser.ok, false);
	assert.match(unsupportedBrowser.reason, /not (available|supported) on android/i);
});

test('adding a browser version via data makes it valid — no code change', async () => {
	const backend = tempBackend();
	await backend.seed();
	const before = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'chrome', browserVersion: '160'
	});
	assert.equal(before.ok, false);

	await backend.create('browserVersions', { browser_id: 'chrome', version: '160', sort_key: '000160' });
	const after = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'chrome', browserVersion: '160'
	});
	assert.equal(after.ok, true);
	// re-seed must not remove the operator-added version
	await backend.seed();
	const persisted = await backend.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'chrome', browserVersion: '160'
	});
	assert.equal(persisted.ok, true, 're-seed must not delete admin-added rows');
});

test('local backend persists across restarts', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-catalog-'));
	const stateFile = path.join(dir, 'device-catalog.json');
	const first = createLocalDeviceCatalogBackend({ stateDir: dir, stateFile });
	await first.seed();
	await first.create('browserVersions', { browser_id: 'firefox', version: '143', sort_key: '000143' });

	const second = createLocalDeviceCatalogBackend({ stateDir: dir, stateFile });
	const versions = await second.list('browserVersions', { browser_id: 'firefox' });
	assert.ok(versions.some((row) => row.version === '143'), 'operator-added version must survive restart');
});

test('environment validation switches to the DB-backed catalog when attached', async () => {
	const { normalizeEnvironmentInput } = await import('./environmentService.js');
	const catalogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-catalog-env-'));
	const catalog = createLocalDeviceCatalogBackend({ stateDir: catalogDir, stateFile: path.join(catalogDir, 'catalog.json') });
	await catalog.seed();

	// Operator adds Chrome 160 through data only.
	await catalog.create('browserVersions', { browser_id: 'chrome', version: '160', sort_key: '000160' });
	const withCatalog = await normalizeEnvironmentInput(
		{ platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '160' },
		{ catalogBackend: catalog }
	);
	assert.equal(withCatalog.envId, 'ENV-IOS-IP16PRO-18.3-CHR-160');

	// Same version WITHOUT the catalog attached (frozen module) must still fail —
	// proves the check actually went through the DB-backed backend above.
	const { EnvironmentValidationError } = await import('./environmentService.js');
	await assert.rejects(
		() => normalizeEnvironmentInput(
			{ platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '160' },
			{ catalogBackend: null }
		),
		(error) => error instanceof EnvironmentValidationError
	);

	// And a version the DB does NOT know must be rejected through the DB path too.
	await assert.rejects(
		() => normalizeEnvironmentInput(
			{ platform: 'ios', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'chrome', browserVersion: '999' },
			{ catalogBackend: catalog }
		),
		(error) => error instanceof EnvironmentValidationError && /999/.test(error.message)
	);
});
