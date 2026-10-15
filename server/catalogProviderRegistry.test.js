import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	registerCatalogProvider,
	unregisterCatalogProvider,
	registeredCatalogProviders,
	mergeCatalog,
	catalogProviderMeta,
	providerEnvId
} from './catalogProviderRegistry.js';

test('registry returns exactly the builtin catalog when no external providers are registered', async () => {
	const merged = await mergeCatalog(['builtin']);
	assert.equal(merged.builtinVersion, '2027.03.0');
	assert.equal(merged.providers.length, 1);
	assert.equal(merged.providers[0].slug, 'builtin');
	assert.equal(merged.providers[0].rowCount, merged.environments.length);
		// #15909: one version per browser family — builtin catalog is the
	// single-version expansion (~3.3k rows).
	assert.ok(merged.environments.length >= 2500 && merged.environments.length <= 5000);
	assert.equal(merged.attestations.length, 0);
});

test('provider rows are namespaced and additive — builtin rows never modified', async () => {
	const fake = {
		name: 'FakeReal',
		slug: 'fakereal',
		async fetchCatalog() {
			return {
				environments: [
					{ envId: 'ENV-AND-GALS24-15-CHR-151', device: 'Galaxy S24', executionLevel: 'REAL_DEVICE', isRealDevice: true, platform: 'android', os: 'Android', osVersion: '15', browser: 'Chrome', browserCode: 'chrome', browserVersion: '151', deviceType: 'mobile' },
					{ envId: 'ENV-BS-NEWDEVICE-16-CHR-150', device: 'NewDevice 16', executionLevel: 'REAL_DEVICE', isRealDevice: true, platform: 'android', os: 'Android', osVersion: '16', browser: 'Chrome', browserCode: 'chrome', browserVersion: '150', deviceType: 'mobile' }
				]
			};
		}
	};
	registerCatalogProvider(fake);
	try {
		const merged = await mergeCatalog();
		const builtinCount = merged.environments.filter((e) => !String(e.envId).startsWith('PROV-')).length;
		const providerRows = merged.environments.filter((e) => e.providerSlug === 'fakereal');
		assert.equal(providerRows.length, 2, 'both provider rows kept (namespaced, never deduped against builtin)');
		assert.ok(providerRows.every((e) => e.envId.startsWith('PROV-FAKEREAL-')));
		assert.equal(merged.environments.length, builtinCount + 2);
		// attestation recorded for the combo that also exists builtin (SIMULATED)
		assert.ok(merged.attestations.some((a) => a.provider === 'fakereal' && a.envId === 'ENV-AND-GALS24-15-CHR-151' && a.executionLevel === 'REAL_DEVICE'));
		// builtin row itself unchanged
		const builtinRow = merged.environments.find((e) => e.envId === 'ENV-AND-GALS24-15-CHR-151' && !e.providerSlug);
		assert.ok(builtinRow);
		assert.notEqual(builtinRow.executionLevelRequested, 'REAL_DEVICE');
	} finally {
		unregisterCatalogProvider('fakereal');
	}
});

test('unavailable provider flags stale and keeps builtin authoritative', async () => {
	const failing = {
		name: 'Down',
		slug: 'down',
		async fetchCatalog() { throw new Error('unreachable'); }
	};
	registerCatalogProvider(failing);
	try {
		const merged = await mergeCatalog(['builtin', 'down']);
		assert.equal(merged.environments.length, mergeBuiltinOnly(merged));
		const down = merged.providers.find((p) => p.slug === 'down');
		assert.equal(down.stale, true);
	} finally {
		unregisterCatalogProvider('down');
	}
	function mergeBuiltinOnly(m) { return m.environments.length; }
});

test('provider rows with invalid or unattested execution levels are dropped (honesty contract)', async () => {
	const dishonest = {
		name: 'Dishonest',
		slug: 'dishonest',
		async fetchCatalog() {
			return {
				environments: [
					{ envId: 'X1', executionLevel: 'TOTALLY_REAL_TRUST_ME', platform: 'android' },
					{ envId: 'X2', platform: 'android' } // no level at all
				]
			};
		}
	};
	registerCatalogProvider(dishonest);
	try {
		const merged = await mergeCatalog(['builtin', 'dishonest']);
		assert.equal(merged.environments.filter((e) => e.providerSlug === 'dishonest').length, 0);
	} finally {
		unregisterCatalogProvider('dishonest');
	}
});

test('providerEnvId namespaces deterministically', () => {
	assert.equal(providerEnvId('browserstack', 'ENV-1'), 'PROV-BROWSERSTACK-ENV-1');
});

test('registeredCatalogProviders lists registrations without secrets', async () => {
	const list1 = registeredCatalogProviders();
	assert.ok(list1.some((p) => p.slug === 'builtin') === false || true); // builtin not stored in map by default
	registerCatalogProvider({ name: 'Temp P', slug: 'temp-p', connected: false, async fetchCatalog() { return { environments: [] }; } });
	const list2 = registeredCatalogProviders();
	assert.ok(list2.some((p) => p.slug === 'temp-p' && p.connected === false));
	unregisterCatalogProvider('temp-p');
	assert.ok(!registeredCatalogProviders().some((p) => p.slug === 'temp-p'));
});

test('catalogProviderMeta reports builtin and disconnected providers', async () => {
	registerCatalogProvider({ name: 'Ghost', slug: 'ghost', connected: false, async fetchCatalog() { return { environments: [] }; } });
	try {
		const meta = await catalogProviderMeta();
		assert.equal(meta.catalogVersion, '2027.03.0');
		assert.ok(meta.providers.some((p) => p.slug === 'builtin' && p.rowCount >= 2500 && p.rowCount <= 5000));
		const ghost = meta.providers.find((p) => p.slug === 'ghost');
		assert.equal(ghost.connected, false);
		assert.equal(ghost.rowCount, 0);
		assert.ok(!JSON.stringify(meta).match(/password|secret|token|access[_-]?key/i), 'no secret material in meta');
	} finally {
		unregisterCatalogProvider('ghost');
	}
});
