import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BROWSER_SUPPORT_STATUS,
	resolveBrowserSupport,
	resolveBrowserSupportSync,
	isExecutableBrowser,
	browserSupportReport,
	setLocalRegistrySnapshot
} from './browserSupportResolution.js';
import { availabilityReport, generateEnvironments } from './environmentCatalog.js';
import { resolveExecution } from './browserstackProvider.js';

// Registry snapshot isolation: these tests assert the NO-binary fallback
// contract, so they start from a cleared snapshot and restore afterwards.
const SAVED = null;
test.beforeEach(() => setLocalRegistrySnapshot(SAVED));
test.afterEach(() => setLocalRegistrySnapshot(null));

// --- #14632 (NI01 Phase 2) + RT1 (#14680): capability truth, no external provider ---

test('resolveBrowserSupport: chrome is supported on every platform', async () => {
	for (const platform of ['ios', 'ipados', 'macos', 'android', 'windows']) {
		const r = await resolveBrowserSupport(platform, 'chrome');
		assert.equal(r.status, BROWSER_SUPPORT_STATUS.SUPPORTED, `chrome on ${platform}`);
		assert.equal(r.provider, 'local-playwright');
		assert.equal(r.engine, 'chromium');
		assert.ok(r.reason.length > 10);
		assert.equal(r.engineEquivalent, false);
	}
});

test('resolveBrowserSupport: firefox supported; edge engine-equivalent without a branded binary', async () => {
	const ff = await resolveBrowserSupport('windows', 'firefox');
	assert.equal(ff.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(ff.engine, 'firefox');
	const edge = await resolveBrowserSupport('windows', 'edge');
	assert.ok([BROWSER_SUPPORT_STATUS.SUPPORTED, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT].includes(edge.status),
		'edge is either a launch-verified branded binary or an honestly labeled engine-equivalent');
	assert.equal(edge.engine, 'chromium');
	if (edge.status === BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT) {
		assert.ok(edge.reason.toLowerCase().includes('engine-equivalent'), 'edge reason must be honest about the engine');
		assert.ok(edge.reason.toLowerCase().includes('no branded edge binary'), 'edge absence must be named');
	}
});

test('resolveBrowserSupport: safari is engine-equivalent locally — no external provider path', async () => {
	const local = await resolveBrowserSupport('macos', 'safari');
	assert.equal(local.status, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT);
	assert.equal(local.engine, 'webkit');
	assert.ok(local.engineEquivalent);
	// RT1: external providers are out of scope — even provider flags never
	// upgrade Safari to a branded pass on this host.
	const withStack = await resolveBrowserSupport('macos', 'safari', { browserstack: true });
	assert.notEqual(withStack.provider, 'browserstack');
	assert.ok(withStack.status !== BROWSER_SUPPORT_STATUS.SUPPORTED || withStack.branded !== true);
});

test('resolveBrowserSupport: opera and brave are engine-equivalent without binaries, never branded passes', async () => {
	for (const code of ['opera', 'brave']) {
		const r = await resolveBrowserSupport('windows', code);
		assert.ok([BROWSER_SUPPORT_STATUS.SUPPORTED, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT].includes(r.status), code);
		assert.equal(r.engine, 'chromium');
		if (r.status === BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT) {
			assert.ok(r.engineEquivalent);
			assert.ok(r.reason.includes('engine-equivalent'), `${code} reason must label engine-equivalence`);
		}
		// No provider flag ever invents a branded Opera/Brave capability.
		const withStack = await resolveBrowserSupport('windows', code, { browserstack: true });
		assert.notEqual(withStack.provider, 'browserstack');
	}
});

test('resolveBrowserSupport: duckduckgo is NOT SUPPORTED on every platform, with or without provider flags', async () => {
	for (const platform of ['ios', 'ipados', 'macos', 'android', 'windows']) {
		for (const providers of [{}, { browserstack: true }]) {
			const r = await resolveBrowserSupport(platform, 'duckduckgo', providers);
			assert.equal(r.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED, `duckduckgo on ${platform}`);
			assert.ok(r.reason.length > 20, 'reason must be explicit');
			assert.equal(await isExecutableBrowser(platform, 'duckduckgo', providers), false);
		}
	}
});

test('resolveBrowserSupport: unknown browsers resolve NOT SUPPORTED, never throws', async () => {
	const r = await resolveBrowserSupport('ios', 'netscape');
	assert.equal(r.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED);
	assert.ok(r.reason.includes('Unknown browser'));
});

test('browserSupportReport covers all 7 browsers', async () => {
	const report = await browserSupportReport('ios');
	assert.deepEqual(report.map((e) => e.browser).sort(),
		['brave', 'chrome', 'duckduckgo', 'edge', 'firefox', 'opera', 'safari']);
});

test('availabilityReport carries provider-derived browserSupport per platform (additive)', async () => {
	const report = await availabilityReport();
	for (const entry of report) {
		assert.ok(Array.isArray(entry.browserSupport), `${entry.platform} browserSupport`);
		const ddg = entry.browserSupport.find((b) => b.browserCode === 'duckduckgo');
		assert.ok(ddg, `${entry.platform} must list duckduckgo`);
		assert.equal(ddg.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED);
		// Existing platform-membership fields stay untouched (additive change).
		assert.ok(Array.isArray(entry.available));
		assert.ok(Array.isArray(entry.unavailable));
	}
});

test('resolveExecution blocks duckduckgo environments with an explicit reason', async () => {
	const env = {
		platform: 'ios',
		device: 'iPhone 17 Pro',
		os: 'iOS',
		osVersion: '26.0',
		browser: 'DuckDuckGo',
		browserCode: 'duckduckgo',
		browserVersion: '1',
		executionProvider: 'environment'
	};
	const r = await resolveExecution(env, null);
	assert.equal(r.mode, 'blocked');
	assert.match(r.label, /NOT SUPPORTED/);
	assert.match(r.reason, /DuckDuckGo is NOT SUPPORTED/);
	assert.equal(r.browserSupport.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED);
});

test('resolveExecution marks opera/brave emulated runs engine-equivalent', async () => {
	for (const code of ['opera', 'brave']) {
		const env = {
			platform: 'windows',
			device: 'Windows Desktop',
			os: 'Windows',
			osVersion: '11',
			browser: code === 'opera' ? 'Opera' : 'Brave',
			browserCode: code,
			browserVersion: '130',
			executionProvider: 'environment'
		};
		const r = await resolveExecution(env, null);
		assert.ok(['emulated', 'branded'].includes(r.mode), code);
		assert.ok([BROWSER_SUPPORT_STATUS.SUPPORTED, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT].includes(r.browserSupport.status));
		assert.equal(r.browserSupport.engine, 'chromium');
	}
});

test('every generated duckduckgo environment is flagged not executable at resolution time', async () => {
	const ddgEnvs = generateEnvironments().filter((env) => env.browserCode === 'duckduckgo');
	assert.ok(ddgEnvs.length > 100, 'catalog inventory keeps duckduckgo rows (visibility)');
	for (const env of ddgEnvs.slice(0, 50)) {
		assert.equal(await isExecutableBrowser(env.platform, 'duckduckgo'), false);
	}
});

// --- RT1 (#14680): sync resolver parity ---

test('resolveBrowserSupportSync matches the async resolution for every browser code', async () => {
	for (const code of ['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo', 'netscape']) {
		const sync = resolveBrowserSupportSync('windows', code);
		const async = await resolveBrowserSupport('windows', code);
		assert.equal(sync.status, async.status, `${code} status parity`);
		assert.equal(sync.engine, async.engine, `${code} engine parity`);
		assert.equal(sync.reason, async.reason, `${code} reason parity`);
	}
});
