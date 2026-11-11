import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAutomaticBrowser } from './automaticBrowser.js';

const catalog = { list: async query => [{ envId: `${query.platform}-${query.browserCode}`, deviceType: 'desktop', platform: query.platform, browserCode: query.browserCode, executionType: 'SIMULATED', active: true }] };
test('automatic mode chooses a launch-checked catalog environment, not a pinned device ID', async () => {
	const { environment, selection } = await chooseAutomaticBrowser(catalog, { host: 'darwin', health: async () => ({ verdict: 'READY' }) });
	assert.equal(environment.envId, 'macos-chrome');
	assert.equal(selection.mode, 'automatic');
});
test('creation plans a desktop without launching probes outside the execution slot', async () => {
	let probes = 0;
	const result = await chooseAutomaticBrowser(catalog, { probe: false, health: async () => { probes++; } });
	assert.equal(probes, 0); assert.equal(result.selection.phase, 'planned');
});
test('desktop preference rejects tablets and picks newer catalog browser/OS versions', async () => {
	const result = await chooseAutomaticBrowser({ list: async () => [
		{ envId: 'tablet', deviceType: 'tablet' },
		{ envId: 'older', deviceType: 'desktop', osVersion: '7', browserVersion: '100' },
		{ envId: 'newer', deviceType: 'desktop', osVersion: '11', browserVersion: '151' }
	] }, { health: async () => ({ verdict: 'READY' }) });
	assert.equal(result.environment.envId, 'newer');
});
test('a broken default Chrome fails without probing or launching another engine or device', async () => {
	const probes = [];
	await assert.rejects(chooseAutomaticBrowser(catalog, { health: async env => { probes.push(env); return { verdict: 'BLOCKED' }; } }), { code: 'AUTOMATIC_BROWSER_UNAVAILABLE' });
	assert.equal(probes.length, 1);
	assert.equal(probes[0].browserCode, 'chrome');
});
test('unavailable browsers fail clearly instead of creating a fake running session', async () => {
	await assert.rejects(chooseAutomaticBrowser(catalog, { health: async () => ({ verdict: 'BLOCKED' }) }), { code: 'AUTOMATIC_BROWSER_UNAVAILABLE' });
});
test('#18482: the health gate reason reaches the user instead of a generic Chrome failure', async () => {
	// An unreachable target URL must surface AS the reason — the old generic
	// "Chrome could not start" blamed the browser for the customer's URL and
	// pushed a meaningless retry loop.
	const error = await chooseAutomaticBrowser(catalog, { health: async () => ({ verdict: 'BLOCKED', reason: 'network: Target unreachable (http://192.168.99.99/): timed out' }) })
		.then(() => null, error => error);
	assert.equal(error.code, 'AUTOMATIC_BROWSER_UNAVAILABLE');
	assert.match(error.message, /Target unreachable \(http:\/\/192\.168\.99\.99\/\): timed out/);
	assert.match(error.message, /The test could not start/);
	// The internal check-name prefix ("network: ") is stripped for readability.
	assert.doesNotMatch(error.message, /network:/);
});
test('#18482: with no reason available the stable guidance message is kept', async () => {
	const error = await chooseAutomaticBrowser(catalog, { health: async () => ({ verdict: 'BLOCKED' }) })
		.then(() => null, error => error);
	assert.equal(error.code, 'AUTOMATIC_BROWSER_UNAVAILABLE');
	assert.match(error.message, /Chrome could not start on the default desktop/);
});
test('inactive, unsupported and real-device-only rows are not automatic candidates', async () => {
	let probes = 0;
	await assert.rejects(chooseAutomaticBrowser({ list: async () => [{ active: false }, { isRealDevice: true }, { browserSupport: { status: 'not_supported' } }] }, { health: async () => { probes++; } }));
	assert.equal(probes, 0);
});
