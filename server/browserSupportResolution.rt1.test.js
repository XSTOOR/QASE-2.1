import assert from 'node:assert/strict';
import test from 'node:test';
import {
	resolveBrowserSupport,
	resolveBrowserSupportSync,
	browserSupportReport,
	BROWSER_SUPPORT_STATUS
} from './browserSupportResolution.js';
import { setLocalRegistrySnapshot } from './browserSupportResolution.js';

function snapshotWith(brands) {
	return { probedAt: new Date().toISOString(), brands };
}

const INSTALLED = snapshotWith([
	{ code: 'chrome', label: 'Google Chrome', status: 'present', executablePath: '/usr/bin/google-chrome-stable', version: '151.0.7922.137', launchVerified: true, reason: null },
	{ code: 'brave', label: 'Brave', status: 'present', executablePath: '/usr/bin/brave-browser-stable', version: '154.1.96.61', launchVerified: true, reason: null },
	{ code: 'opera', label: 'Opera', status: 'present', executablePath: '/opt/opera-root/.../opera', version: '136.0.6008.80', launchVerified: true, reason: null },
	{ code: 'edge', label: 'Microsoft Edge', status: 'absent', executablePath: null, version: null, launchVerified: false, reason: 'Not installed: repository unreachable.' }
]);

test('branded binaries upgrade SUPPORTED with detected version and executable path (sync + async)', async () => {
	setLocalRegistrySnapshot(INSTALLED);
	const brave = resolveBrowserSupportSync('windows', 'brave');
	assert.equal(brave.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(brave.branded, true);
	assert.equal(brave.detectedVersion, '154.1.96.61');
	assert.equal(brave.executablePath, '/usr/bin/brave-browser-stable');
	assert.equal(brave.provider, 'local-playwright');
	assert.equal(brave.engineEquivalent, false);

	const asyncBrave = await resolveBrowserSupport('windows', 'brave');
	assert.equal(asyncBrave.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(asyncBrave.detectedVersion, '154.1.96.61');

	const opera = resolveBrowserSupportSync('windows', 'opera');
	assert.equal(opera.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(opera.branded, true);
	setLocalRegistrySnapshot(null);
});

test('edge without a binary is ENGINE_EQUIVALENT — never faked as branded', async () => {
	setLocalRegistrySnapshot(INSTALLED);
	const edge = resolveBrowserSupportSync('windows', 'edge');
	assert.equal(edge.status, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT);
	assert.equal(edge.branded, undefined);
	assert.match(edge.reason, /No branded Edge binary/);
	setLocalRegistrySnapshot(null);
});

test('safari stays engine-equivalent WebKit locally; never branded Safari', async () => {
	setLocalRegistrySnapshot(INSTALLED);
	const safari = resolveBrowserSupportSync('macos', 'safari');
	assert.equal(safari.status, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT);
	assert.equal(safari.engine, 'webkit');
	assert.equal(safari.branded, undefined);
	assert.match(safari.reason, /engine-equivalent to Safari/);
	setLocalRegistrySnapshot(null);
});

test('duckduckgo is NOT_SUPPORTED with the truthful reason regardless of registry', async () => {
	setLocalRegistrySnapshot(INSTALLED);
	const ddgSync = resolveBrowserSupportSync('android', 'duckduckgo');
	const ddgAsync = await resolveBrowserSupport('android', 'duckduckgo');
	for (const ddg of [ddgSync, ddgAsync]) {
		assert.equal(ddg.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED);
		assert.match(ddg.reason, /mobile-only browser/);
	}
	setLocalRegistrySnapshot(null);
});

// #15162: a failed launch probe is one probe attempt, not proof of
// unsupportability — the family stays SUPPORTED pre-run with
// launchVerified:false; the failure must surface in run results only.
test('a present-but-broken binary stays SUPPORTED (launchVerified:false) with the probe note', async () => {
	setLocalRegistrySnapshot(snapshotWith([
		{ code: 'chrome', status: 'present', executablePath: '/usr/bin/google-chrome-stable', version: '151', launchVerified: false, reason: 'Binary present but failed to launch: sandbox denied' }
	]));
	const chrome = resolveBrowserSupportSync('windows', 'chrome');
	assert.equal(chrome.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(chrome.launchVerified, false);
	assert.match(chrome.probeNote, /failed to launch: sandbox denied/);
	const chromeAsync = await resolveBrowserSupport('windows', 'chrome');
	assert.equal(chromeAsync.status, BROWSER_SUPPORT_STATUS.SUPPORTED);
	assert.equal(chromeAsync.launchVerified, false);
	setLocalRegistrySnapshot(null);
});

test('with no snapshot at all, branded codes fall back honestly (no launch claims)', async () => {
	setLocalRegistrySnapshot(null);
	const brave = resolveBrowserSupportSync('windows', 'brave');
	assert.equal(brave.status, BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT);
	assert.match(brave.reason, /No Brave binary on this host/);
});

test('unknown browsers resolve NOT_SUPPORTED', () => {
	const unknown = resolveBrowserSupportSync('windows', 'netscape');
	assert.equal(unknown.status, BROWSER_SUPPORT_STATUS.NOT_SUPPORTED);
	assert.match(unknown.reason, /Unknown browser/);
});

test('browserSupportReport lists all seven browsers with coherent statuses', async () => {
	setLocalRegistrySnapshot(INSTALLED);
	const report = await browserSupportReport('windows');
	assert.equal(report.length, 7);
	const byCode = Object.fromEntries(report.map((entry) => [entry.browser, entry]));
	assert.equal(byCode.chrome.status, 'supported');
	assert.equal(byCode.brave.status, 'supported');
	assert.equal(byCode.opera.status, 'supported');
	assert.equal(byCode.firefox.status, 'supported');
	assert.equal(byCode.safari.status, 'engine_equivalent');
	assert.equal(byCode.edge.status, 'engine_equivalent');
	assert.equal(byCode.duckduckgo.status, 'not_supported');
	setLocalRegistrySnapshot(null);
});
