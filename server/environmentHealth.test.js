import test from 'node:test';
import assert from 'node:assert/strict';

import {
	checkEnvironmentHealth,
	invalidateHealthCache,
	CHECK_STATUS,
	GATE_VERDICT
} from './environmentHealth.js';
import { setLocalRegistrySnapshot } from './browserSupportResolution.js';

const GOOD_ENGINE = async () => ({
	chromium: { launch: async () => ({ close: async () => {}, version: () => '150.0' }) },
	firefox: { launch: async () => ({ close: async () => {}, version: () => '150.0' }) },
	webkit: { launch: async () => ({ close: async () => {}, version: () => '26.0' }) }
});

function env(overrides = {}) {
	return {
		envId: 'ENV-IOS-IP17PRO-26.0-CHR-151',
		platform: 'ios',
		device: 'iPhone 17 Pro',
		os: 'iOS',
		osVersion: '26.0',
		browser: 'Chrome',
		browserCode: 'chrome',
		browserVersion: '151',
		deviceType: 'mobile',
		emulation: { viewport: { width: 402, height: 874 }, hasTouch: true, isMobile: true },
		...overrides
	};
}

test.beforeEach(() => { invalidateHealthCache(); setLocalRegistrySnapshot(null); });
test.afterEach(() => { invalidateHealthCache(); setLocalRegistrySnapshot(null); });

test('healthy environment → READY, all checks report real outcomes', async () => {
	const report = await checkEnvironmentHealth(env(), {
		playwrightModule: GOOD_ENGINE,
		engineLaunchProbe: async () => ({ ok: true, version: '150.0' }),
		targetUrl: 'https://example.com/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.READY);
	const names = report.checks.map((check) => check.name);
	assert.ok(names.includes('execution_service'));
	assert.ok(names.includes('engine_launch'));
	assert.ok(names.includes('network'));
	assert.ok(names.includes('emulation_apply'));
	for (const check of report.checks) {
		assert.ok([CHECK_STATUS.PASS, CHECK_STATUS.SKIPPED].includes(check.status),
			`${check.name} unexpectedly ${check.status}`);
		assert.ok(check.detail.length > 5, `${check.name} detail must be explicit`);
	}
});

test('engine that cannot launch → BLOCKED with the exact failing check named', async () => {
	const report = await checkEnvironmentHealth(env(), {
		engineLaunchProbe: async () => ({ ok: false, reason: 'Executable doesn\'t exist at /usr/bin/google-chrome-stable' }),
		targetUrl: 'https://example.com/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.BLOCKED);
	const launch = report.checks.find((check) => check.name === 'engine_launch');
	assert.equal(launch.status, CHECK_STATUS.FAIL);
	assert.match(report.reason, /engine_launch: chromium engine failed to launch: Executable doesn't exist/);
});

test('duckduckgo → BLOCKED at browser_support with the truthful reason, engine never probed', async () => {
	let probes = 0;
	const report = await checkEnvironmentHealth(env({ browserCode: 'duckduckgo', browser: 'DuckDuckGo' }), {
		engineLaunchProbe: async () => { probes += 1; return { ok: true }; },
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.BLOCKED);
	const support = report.checks.find((check) => check.name === 'browser_support');
	assert.equal(support.status, CHECK_STATUS.FAIL);
	assert.match(support.detail, /mobile-only browser/i);
	assert.equal(probes, 0, 'a NOT SUPPORTED browser must never trigger an engine launch');
});

test('unreachable network target → BLOCKED with network check detail', async () => {
	const report = await checkEnvironmentHealth(env(), {
		engineLaunchProbe: async () => ({ ok: true, version: '150.0' }),
		targetUrl: 'https://definitely-not-a-real-host.invalid/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.BLOCKED);
	const network = report.checks.find((check) => check.name === 'network');
	assert.equal(network.status, CHECK_STATUS.FAIL);
	assert.match(network.detail, /unreachable/);
});

test('malformed device profile → BLOCKED at emulation_apply', async () => {
	const report = await checkEnvironmentHealth(env({ emulation: { viewport: { width: 'wide', height: null } } }), {
		engineLaunchProbe: async () => ({ ok: true, version: '150.0' }),
		targetUrl: 'https://example.com/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.BLOCKED);
	const emulation = report.checks.find((check) => check.name === 'emulation_apply');
	assert.equal(emulation.status, CHECK_STATUS.FAIL);
});

test('a hung engine probe times out → FAIL, never a pass', async () => {
	const report = await checkEnvironmentHealth(env(), {
		engineLaunchProbe: () => new Promise(() => { /* never resolves */ }),
		targetUrl: 'https://example.com/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.BLOCKED);
	const launch = report.checks.find((check) => check.name === 'engine_launch');
	assert.equal(launch.status, CHECK_STATUS.FAIL);
	assert.match(launch.detail, /timed out/);
}, { timeout: 20_000 });

test('results are cached for the TTL window and force bypasses the cache', async () => {
	let calls = 0;
	const options = {
		engineLaunchProbe: async () => { calls += 1; return { ok: true, version: '150.0' }; },
		targetUrl: 'https://example.com/'
	};
	await checkEnvironmentHealth(env(), { ...options, force: true });
	await checkEnvironmentHealth(env(), options);
	assert.equal(calls, 1, 'second call must reuse the cached report');
	const fresh = await checkEnvironmentHealth(env(), { ...options, force: true });
	assert.equal(calls, 2, 'force must re-probe');
	assert.equal(fresh.verdict, GATE_VERDICT.READY);
});

test('branded binary environments probe the cited executable path', async () => {
	setLocalRegistrySnapshot({
		probedAt: new Date().toISOString(),
		brands: [{
			code: 'brave', label: 'Brave', status: 'present',
			executablePath: '/usr/bin/brave-browser-stable',
			version: '154.1.96.61', launchVerified: true, reason: null
		}]
	});
	const seen = [];
	const report = await checkEnvironmentHealth(env({ browserCode: 'brave', browser: 'Brave' }), {
		engineLaunchProbe: async (engine, executablePath) => {
			seen.push({ engine, executablePath });
			return { ok: true, version: '154.1.96.61' };
		},
		targetUrl: 'https://example.com/',
		force: true
	});
	assert.equal(report.verdict, GATE_VERDICT.READY);
	assert.equal(seen[0].engine, 'chromium');
	assert.equal(seen[0].executablePath, '/usr/bin/brave-browser-stable');
});
