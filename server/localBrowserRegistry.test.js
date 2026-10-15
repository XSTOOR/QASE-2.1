import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import {
	probeLocalBrowsers,
	lastLocalBrowserProbe,
	invalidateLocalBrowserCache,
	localBrowserEntry,
	isExecutableLocalBrand,
	DUCKDUCKGO_LOCAL_RESOLUTION,
	playwrightLaunchProbe
} from './localBrowserRegistry.js';

test('registry probes brands: present binaries carry detected versions, absent ones carry install reasons', async () => {
	invalidateLocalBrowserCache();
	const probe = await probeLocalBrowsers({ force: true, findBinary: paths => paths[0], versionFor: async () => '151.0.1' });
	const codes = probe.brands.map((b) => b.code);
	assert.deepEqual(codes, ['chrome', 'brave', 'opera', 'edge']);

	const chrome = probe.brands.find((b) => b.code === 'chrome');
	const brave = probe.brands.find((b) => b.code === 'brave');
	const opera = probe.brands.find((b) => b.code === 'opera');
	const edge = probe.brands.find((b) => b.code === 'edge');

	// On THIS host: chrome/brave/opera/edge are all installed (RT1; Edge
	// installed 2026-10-05 from the official .deb after the MS repo became
	// reachable). A missing binary is exercised in the stubbed tests below.
	assert.equal(chrome.status, 'present');
	assert.match(chrome.version, /^\d+\.\d+/);
	assert.ok(chrome.executablePath?.startsWith('/usr/bin/'));
	assert.equal(brave.status, 'present');
	assert.match(brave.version, /^\d+\.\d+/);
	assert.ok(brave.executablePath?.includes('/workspace/.local-browsers/brave/'));
	assert.equal(opera.status, 'present');
	assert.match(opera.version, /^\d+\.\d+/);
	assert.ok(opera.executablePath?.includes('/workspace/.local-browsers/opera/'));
	assert.equal(edge.status, 'present');
	assert.match(edge.version, /^\d+\.\d+/);
	assert.ok(edge.executablePath?.includes('/workspace/.local-browsers/edge/'));
});

test('launch probe verifies and records failures honestly', async () => {
	invalidateLocalBrowserCache();
	const probe = await probeLocalBrowsers({
		force: true,
		findBinary: paths => paths[0],
		versionFor: async () => '151.0.1',
		launchProbe: async (path) => path.includes('brave')
			? { ok: false, error: 'sandbox denied' }
			: { ok: true }
	});
	const brave = probe.brands.find((b) => b.code === 'brave');
	assert.equal(brave.launchVerified, false);
	assert.match(brave.reason, /Binary present but failed to launch: sandbox denied/);
	const chrome = probe.brands.find((b) => b.code === 'chrome');
	assert.equal(chrome.launchVerified, true);
	assert.equal(chrome.reason, null);
	// Broken binaries are NOT executable.
	assert.equal(isExecutableLocalBrand(brave), false);
	assert.equal(isExecutableLocalBrand(chrome), true);
});

test('probe results are cached with a TTL and invalidated on demand', async () => {
	invalidateLocalBrowserCache();
	const first = await probeLocalBrowsers({ force: true });
	const cached = await probeLocalBrowsers({}); // no force → cache hit
	assert.equal(cached, first);
	assert.equal(lastLocalBrowserProbe(), first);
	invalidateLocalBrowserCache();
	assert.equal(lastLocalBrowserProbe(), null);
});

test('localBrowserEntry returns one brand or null; unknown codes are null', async () => {
	invalidateLocalBrowserCache();
	const entry = await localBrowserEntry('opera', {});
	assert.ok(entry);
	assert.equal(entry.code, 'opera');
	assert.equal(await localBrowserEntry('netscape', {}), null);
});

test('duckduckgo local resolution is static NOT_SUPPORTED with a truthful reason', () => {
	assert.equal(DUCKDUCKGO_LOCAL_RESOLUTION.status, 'not_supported');
	assert.match(DUCKDUCKGO_LOCAL_RESOLUTION.reason, /mobile-only browser/);
	assert.match(DUCKDUCKGO_LOCAL_RESOLUTION.reason, /no Linux desktop build/);
});

test('playwrightLaunchProbe really launches installed Chromium headless', async () => {
	const probe = playwrightLaunchProbe();
	const result = await probe(chromium.executablePath());
	assert.equal(result.ok, true);
}, { timeout: 30_000 });

test('playwrightLaunchProbe reports a missing binary honestly', async () => {
	const probe = playwrightLaunchProbe();
	const result = await probe('/nonexistent/browser-binary');
	assert.equal(result.ok, false);
	assert.ok(result.error);
});
