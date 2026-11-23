import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEnvironments } from './environmentCatalog.js';
import { engineForEnvironment, resolveRunRuntime, RuntimeUnavailableError, checkRuntimeIdentity, runtimeName } from './runRuntime.js';
import { userAgentFor } from './deviceRuntimeProfiles.js';
import { primaryProfile } from './qa/browser.js';
import { availabilityFor } from './qaConfigurations.js';

const all = generateEnvironments();
const pick = (platform, browserCode, deviceType) => all.find(env => env.platform === platform && env.browserCode === browserCode && (!deviceType || env.deviceType === deviceType));
const installed = { chromium: true, firefox: true, webkit: true };
const resolver = available => async id => ({ id, available: available[id] !== false, reason: available[id] === false ? `${id} missing` : null });

test('the engine follows the selected browser, and every iPhone/iPad browser is WebKit', () => {
	assert.equal(engineForEnvironment(pick('windows', 'edge')), 'chromium');
	assert.equal(engineForEnvironment(pick('android', 'firefox')), 'firefox');
	assert.equal(engineForEnvironment(pick('macos', 'safari')), 'webkit');
	for (const code of ['safari', 'chrome', 'firefox', 'edge', 'opera', 'brave']) {
		assert.equal(engineForEnvironment(pick('ios', code)), 'webkit', `${code} on iPhone`);
		assert.equal(engineForEnvironment(pick('ipados', code)), 'webkit', `${code} on iPad`);
	}
	assert.equal(engineForEnvironment(undefined), null);
});

test('a run plan sends the device\'s own user agent and refuses what cannot run', async () => {
	const plan = await resolveRunRuntime({ environment: pick('android', 'chrome', 'mobile') }, { engineResolver: resolver(installed) });
	assert.equal(plan.engineId, 'chromium');
	assert.match(plan.userAgent, /Android .*Mobile Safari/);
	await assert.rejects(resolveRunRuntime({ environment: pick('ios', 'duckduckgo') }, { engineResolver: resolver(installed) }),
		error => error instanceof RuntimeUnavailableError && error.code === 'RUNTIME_UNAVAILABLE');
	await assert.rejects(resolveRunRuntime({ environment: pick('ios', 'chrome') }, { engineResolver: resolver({ webkit: false }) }),
		error => error.code === 'ENGINE_UNAVAILABLE' && error.engineId === 'webkit');
	// No environment: the stored engine is kept (old runs and the legacy device picker).
	assert.equal((await resolveRunRuntime({ engine: 'firefox' }, { engineResolver: resolver(installed) })).engineId, 'firefox');
});

test('the primary profile is the environment\'s device: viewport, touch, user agent and landscape', () => {
	const phone = pick('ios', 'chrome', 'mobile');
	const profile = primaryProfile({ environmentSnapshot: phone });
	assert.match(profile.userAgent, /iPhone.*CriOS/);
	assert.equal(profile.hasTouch, true);
	assert.equal(profile.name, 'device');
	const landscape = primaryProfile({ environmentSnapshot: phone, deviceLandscape: true });
	assert.ok(landscape.viewport.width > landscape.viewport.height);
	const desktop = primaryProfile({ environmentSnapshot: pick('windows', 'firefox', 'desktop') });
	assert.match(desktop.userAgent, /Windows NT.*Firefox\//);
	assert.equal(desktop.hasTouch, false);
});

test('every runnable environment\'s user agent passes the identity check (Brave may look like Chrome)', () => {
	for (const env of all) {
		if (env.browserCode === 'duckduckgo') continue;
		const result = checkRuntimeIdentity(env, { userAgent: userAgentFor(env.platform, env.osVersion, env.browserCode, env.browserVersion) });
		assert.equal(result.ok, true, `${env.envId}: ${result.note}`);
	}
	const mismatch = checkRuntimeIdentity(pick('ios', 'safari'), { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
	assert.equal(mismatch.ok, false);
	assert.match(mismatch.note, /does not fully match/);
});

test('the conversation names the selected browser and the engine that runs it', () => {
	assert.equal(runtimeName(pick('windows', 'edge', 'desktop'), { engine: 'chromium', version: '140.0', plan: {} }).startsWith('Edge'), true);
	assert.match(runtimeName(pick('ios', 'chrome'), { engine: 'webkit', version: '26.0', plan: {} }), /Chrome .*iOS .*WebKit engine, emulated/);
	assert.equal(runtimeName(undefined, { engine: 'chromium', version: '140.0.1' }), 'Chrome 140');
});

test('the browser picker marks a combination unavailable when its engine is not installed', () => {
	const iphoneChrome = { ...pick('ios', 'chrome'), browserSupport: { status: 'engine_equivalent', engine: 'webkit' } };
	assert.deepEqual(availabilityFor(iphoneChrome, new Map(), [], { chromium: true, webkit: true }).availability, 'AVAILABLE');
	const missing = availabilityFor(iphoneChrome, new Map(), [], { chromium: true, webkit: false });
	assert.equal(missing.availability, 'UNAVAILABLE');
	assert.match(missing.reason, /WebKit .*npm run install-browser/);
	// A verified branded binary does not need the bundled engine.
	assert.equal(availabilityFor({ ...pick('windows', 'chrome'), browserSupport: { status: 'supported', engine: 'chromium', branded: true } }, new Map(), [], { chromium: false }).availability, 'AVAILABLE');
});
