import test from 'node:test';
import assert from 'node:assert/strict';
import {
	browserstackConnectOptions,
	browserstackCredentials,
	connectBrowserstack,
	environmentEmulationOptions,
	resolveExecution
} from './browserstackProvider.js';
import { generateEnvironments } from './environmentCatalog.js';
import { engineForBrowser } from './browserstackProvider.js';

const CREDENTIALS = { username: 'qase_user', accessKey: 'qase_key' };

test('credentials require both values; half-configured integrations return null', () => {
	assert.deepEqual(browserstackCredentials({
		BROWSERSTACK_USERNAME: 'user', BROWSERSTACK_ACCESS_KEY: 'key'
	}), { username: 'user', accessKey: 'key' });
	assert.equal(browserstackCredentials({ BROWSERSTACK_USERNAME: 'user' }), null);
	assert.equal(browserstackCredentials({ BROWSERSTACK_ACCESS_KEY: 'key' }), null);
	assert.equal(browserstackCredentials({}), null);
	// Whitespace-only values count as missing.
	assert.equal(browserstackCredentials({ BROWSERSTACK_USERNAME: '  ', BROWSERSTACK_ACCESS_KEY: ' ' }), null);
});

test('connect options carry the environment capability map verbatim', () => {
	const environments = generateEnvironments();
	const iPhone = environments.find(env => env.envId === 'ENV-IOS-IP16PRO-18.3-CHR-151');
	assert.ok(iPhone, 'catalog contains the spec example environment');
	const options = browserstackConnectOptions(iPhone, CREDENTIALS);
	assert.equal(options.endpointURL, 'https://cdp.browserstack.com/playwright');
	assert.deepEqual(options.httpCredentials, { username: 'qase_user', password: 'qase_key' });
	assert.deepEqual(options.capabilities, iPhone.runtimeCapabilities);
	assert.equal(options.capabilities.deviceName, 'iPhone 16 Pro');
	assert.equal(options.capabilities.realMobile, true);
});

test('connect options refuse environments that cannot execute on BrowserStack', () => {
	assert.equal(browserstackConnectOptions(null, CREDENTIALS), null);
	assert.equal(browserstackConnectOptions({ executionProvider: 'local' }, CREDENTIALS), null);
	assert.equal(browserstackConnectOptions({ executionProvider: 'environment' }, null), null);
	assert.equal(
		browserstackConnectOptions({ executionProvider: 'environment', runtimeCapabilities: null }, CREDENTIALS),
		null
	);
});

test('resolveExecution: browserstack envs with credentials execute remotely', async () => {
	const environments = generateEnvironments();
	// 2027.01.0 (#14273): macOS devices are hardware models; pick a
	// MacBook Pro on Sonoma instead of the retired pseudo-device.
	const macChrome = environments.find(env => env.envId === 'ENV-MAC-MACMBP14-M3-SONOMA-CHR-151');
	const resolved = await resolveExecution(macChrome, CREDENTIALS);
	assert.equal(resolved.mode, 'environment');
	assert.match(resolved.label, /environment runtime/);
	assert.equal(resolved.connectOptions.capabilities.os, 'OS X');
	assert.equal(resolved.connectOptions.capabilities.osVersion, 'Sonoma');
});

test('resolveExecution: without credentials a browserstack env downgrades to labeled emulation', async () => {
	const environments = generateEnvironments();
	const iPhoneSafari = environments.find(env => env.envId === 'ENV-IOS-IP16PRO-18.0-SAF-18.0');
	const resolved = await resolveExecution(iPhoneSafari, null);
	assert.equal(resolved.mode, 'emulated');
	assert.match(resolved.label, /local engine-equivalent webkit/);
	assert.deepEqual(resolved.emulation.viewport, { width: 402, height: 874 });
	assert.equal(resolved.emulation.isMobile, true);
	assert.equal(resolved.emulation.hasTouch, true);
});

test('R3: engineForBrowser maps every browser family to its real engine', () => {
	assert.equal(engineForBrowser('chrome'), 'chromium');
	assert.equal(engineForBrowser('edge'), 'chromium');
	assert.equal(engineForBrowser('opera'), 'chromium');
	assert.equal(engineForBrowser('brave'), 'chromium');
	assert.equal(engineForBrowser('duckduckgo'), 'chromium');
	assert.equal(engineForBrowser('firefox'), 'firefox');
	assert.equal(engineForBrowser('safari'), 'webkit');
	assert.equal(engineForBrowser('unknown'), null);
});

test('R3: a REAL_DEVICE request without a configured runtime BLOCKS — no silent emulation', async () => {
	const environments = generateEnvironments();
	const env = environments.find(env => env.envId === 'ENV-IOS-IP16PRO-18.3-CHR-151');
	const blocked = await resolveExecution({ ...env, executionLevelRequested: 'REAL_DEVICE' }, null);
	assert.equal(blocked.mode, 'blocked');
	assert.match(blocked.reason, /REAL DEVICE UNAVAILABLE/);
	assert.match(blocked.label, /REAL DEVICE UNAVAILABLE/);
	const virtual = await resolveExecution({ ...env, executionLevelRequested: 'VIRTUAL_DEVICE' }, null);
	assert.equal(virtual.mode, 'blocked');
	// An explicit SIMULATED choice still runs locally, honestly labeled.
	const simulated = await resolveExecution({ ...env, executionLevelRequested: 'SIMULATED' }, null);
	assert.equal(simulated.mode, 'emulated');
	assert.equal(simulated.executionEngine, 'chromium');
});

test('R3: emulated resolution carries the selected browser\u2019s actual engine', async () => {
	const environments = generateEnvironments();
	const firefoxEnv = environments.find(env => env.envId.startsWith('ENV-WIN') && env.browserCode === 'firefox');
	const resolved = await resolveExecution(firefoxEnv, null);
	assert.equal(resolved.mode, 'emulated');
	assert.equal(resolved.executionEngine, 'firefox');
});

test('resolveExecution: no environment keeps the legacy default mode', async () => {
	const resolved = await resolveExecution(undefined, CREDENTIALS);
	assert.equal(resolved.mode, 'default');
	assert.equal(resolved.label, 'local browser (no environment)');
});

test('environmentEmulationOptions: desktop uses the default viewport; mobile uses catalog hints', () => {
	const environments = generateEnvironments();
	const mac = environments.find(env => env.platform === 'macos');
	assert.deepEqual(environmentEmulationOptions(mac), { viewport: { width: 1440, height: 900 }, acceptDownloads: true });

	const iPad = environments.find(env => env.platform === 'ipados');
	const options = environmentEmulationOptions(iPad);
	assert.equal(options.hasTouch, true);
	assert.equal(options.isMobile, true);
	assert.ok(options.viewport.width > 0);
	assert.equal(environmentEmulationOptions(undefined), undefined);
});

test('connectBrowserstack delegates to chromium.connectOverCDP with auth + capabilities', async () => {
	const calls = [];
	const fakeChromium = {
		connectOverCDP: async (endpointURL, options) => {
			calls.push({ endpointURL, options });
			return { fakeBrowser: true };
		}
	};
	const connectOptions = browserstackConnectOptions(
		generateEnvironments().find(env => env.envId === 'ENV-IOS-IP16PRO-18.3-CHR-151'), CREDENTIALS);
	const browser = await connectBrowserstack(fakeChromium, connectOptions);
	assert.equal(browser.fakeBrowser, true);
	assert.equal(calls[0].endpointURL, 'https://cdp.browserstack.com/playwright');
	assert.equal(calls[0].options.httpCredentials.username, 'qase_user');
	assert.equal(calls[0].options.capabilities.browserName, 'chrome');
	await assert.rejects(() => connectBrowserstack({}, connectOptions), /Playwright chromium API/);
});
