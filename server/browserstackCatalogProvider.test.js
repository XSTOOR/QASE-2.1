import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBrowserstackCatalogProvider, mapBrowserstackEntry } from './browserstackCatalogProvider.js';

// Recorded fixtures of BrowserStack's /v5/browsers shape — never live calls.
const FIXTURE = [
	{ device: 'Samsung Galaxy S24', os: 'android', os_version: '14.0', browser: 'chrome', browser_version: '141.0', real_device: true },
	{ device: 'Google Pixel 8', os: 'android', os_version: '14.0', browser: 'chrome', browser_version: '141.0', real_device: true },
	{ os: 'windows', os_version: '11', browser: 'edge', browser_version: '140.0', real_device: false },
	{ device: null, os: 'os x', os_version: 'Sonoma', browser: 'safari', browser_version: '17.4', real_device: false }
];

test('mapBrowserstackEntry attests REAL_DEVICE only from real_device=true', () => {
	const real = mapBrowserstackEntry(FIXTURE[0]);
	assert.equal(real.executionLevel, 'REAL_DEVICE');
	assert.equal(real.isRealDevice, true);
	assert.equal(real.device, 'Samsung Galaxy S24');
	const virtual = mapBrowserstackEntry(FIXTURE[2]);
	assert.equal(virtual.executionLevel, 'VIRTUAL_DEVICE'); // honest — not guessed REAL
	assert.equal(virtual.isRealDevice, false);
});

test('mapBrowserstackEntry drops malformed entries instead of guessing', () => {
	assert.equal(mapBrowserstackEntry(null), null);
	assert.equal(mapBrowserstackEntry({ os: 'android', browser: 'chrome' }), null); // no version
	assert.equal(mapBrowserstackEntry({ os: 'android', browser_version: '1', browser: null }), null);
});

test('adapter without credentials is connected:false and contributes nothing', async () => {
	const provider = createBrowserstackCatalogProvider({ credentials: null });
	assert.equal(provider.connected, false);
	const fetched = await provider.fetchCatalog();
	assert.deepEqual(fetched.environments, []);
	assert.equal(provider.lastRowCount, 0);
});

test('adapter with credentials maps fixture rows honestly (no live calls)', async () => {
	const calls = [];
	const fetcher = async (url, init) => {
		calls.push({ url, init });
		return { ok: true, json: async () => FIXTURE };
	};
	const provider = createBrowserstackCatalogProvider({
		credentials: { username: 'u', accessKey: 'k' },
		fetcher
	});
	const fetched = await provider.fetchCatalog();
	assert.equal(fetched.environments.length, 4);
	assert.equal(fetched.environments.filter((e) => e.executionLevel === 'REAL_DEVICE').length, 2);
	assert.equal(provider.lastRowCount, 4);
	// basic auth header sent to the documented endpoint
	assert.equal(calls[0].url, 'https://api.browserstack.com/v5/browsers');
	assert.match(calls[0].init.headers.Authorization, /^Basic /);
});

test('adapter maps a non-2xx provider response to a thrown error (stale path)', async () => {
	const provider = createBrowserstackCatalogProvider({
		credentials: { username: 'u', accessKey: 'k' },
		fetcher: async () => ({ ok: false, status: 503 })
	});
	await assert.rejects(() => provider.fetchCatalog(), /503/);
});
