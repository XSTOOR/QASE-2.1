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
test('a broken preferred browser falls back to the next healthy engine', async () => {
	const result = await chooseAutomaticBrowser(catalog, { health: async env => ({ verdict: env.browserCode === 'firefox' ? 'READY' : 'BLOCKED' }) });
	assert.equal(result.selection.browserCode, 'firefox');
	assert.ok(result.selection.attempts.some(a => a.verdict === 'BLOCKED'));
});
test('unavailable browsers fail clearly instead of creating a fake running session', async () => {
	await assert.rejects(chooseAutomaticBrowser(catalog, { health: async () => ({ verdict: 'BLOCKED' }) }), { code: 'AUTOMATIC_BROWSER_UNAVAILABLE' });
});
test('inactive, unsupported and real-device-only rows are not automatic candidates', async () => {
	let probes = 0;
	await assert.rejects(chooseAutomaticBrowser({ list: async () => [{ active: false }, { isRealDevice: true }, { browserSupport: { status: 'not_supported' } }] }, { health: async () => { probes++; } }));
	assert.equal(probes, 0);
});
