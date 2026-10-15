import assert from 'node:assert/strict';
import test from 'node:test';
import { ENGINE_IDS, engineRegistry, isEngineId, resolveEngine, ensureXvfb } from './browserEngines.js';

test('engine registry exposes the three engines with stable ids', () => {
	const ids = engineRegistry().map(engine => engine.id).sort();
	assert.deepEqual(ids, ['chromium', 'firefox', 'webkit']);
	assert.deepEqual(ENGINE_IDS, ['chromium', 'firefox', 'webkit']);
});

test('isEngineId validates and rejects junk', () => {
	assert.equal(isEngineId('chromium'), true);
	assert.equal(isEngineId('firefox'), true);
	assert.equal(isEngineId('webkit'), true);
	assert.equal(isEngineId('safari'), false);
	assert.equal(isEngineId(''), false);
	assert.equal(isEngineId(null), false);
	assert.equal(isEngineId(42), false);
});

test('resolveEngine defaults unknown ids to chromium', async () => {
	const engine = await resolveEngine('internet-explorer');
	assert.equal(engine.id, 'chromium');
	assert.equal(engine.available, true);
});

test('resolveEngine returns the matching playwright launcher type', async () => {
	assert.equal((await resolveEngine('chromium')).type.name(), 'chromium');
	assert.equal((await resolveEngine('firefox')).type.name(), 'firefox');
	assert.equal((await resolveEngine('webkit')).type.name(), 'webkit');
});

test('webkit resolution supports native launch or Linux GTK with a useful unavailable reason', async () => {
	const engine = await resolveEngine('webkit');
	if (engine.available) {
		if (engine.launch.executablePath) {
			assert.equal(process.platform, 'linux');
			assert.ok(engine.launch.executablePath.includes('minibrowser-gtk'));
			assert.match(engine.launch.env.DISPLAY, /^:\d+$/);
		} else assert.deepEqual(engine.launch, {});
	} else {
		assert.ok(engine.reason && engine.reason.length > 10, 'unavailable engines carry a human reason');
	}
});

test('ensureXvfb is disabled via QASE_DISABLE_XVFB and reports null', async () => {
	const saved = process.env.QASE_DISABLE_XVFB;
	process.env.QASE_DISABLE_XVFB = 'true';
	try {
		const display = await ensureXvfb(':79');
		assert.equal(display, null);
	} finally {
		if (saved === undefined) delete process.env.QASE_DISABLE_XVFB;
		else process.env.QASE_DISABLE_XVFB = saved;
	}
});

test('engineRegistryResolved reports availability consistent with resolveEngine', async () => {
	const { engineRegistryResolved } = await import('./browserEngines.js');
	const registry = await engineRegistryResolved();
	assert.deepEqual(registry.map(entry => entry.id), ['chromium', 'firefox', 'webkit']);
	for (const entry of registry) {
		const resolved = await resolveEngine(entry.id);
		assert.equal(entry.available, resolved.available, `${entry.id} availability matches resolveEngine`);
		assert.equal(entry.reason ?? null, resolved.reason ?? null, `${entry.id} reason matches resolveEngine`);
	}
});

test('store.createSession accepts a valid engine and rejects junk', async () => {
	const { createSession } = await import('./store.js');
	const session = createSession('engine-check', { engine: 'firefox' });
	assert.equal(session.engine, 'firefox');
	assert.equal(createSession('default-engine', {}).engine, 'chromium');
	assert.throws(() => createSession('bad-engine', { engine: 'netscape' }), /unknown browser engine/);
});

test('firefox resolves unavailable when its actual executable is missing', async () => {
		const engine = await resolveEngine('firefox', { exists: () => false });
		assert.equal(engine.available, false);
		assert.match(engine.reason, /Firefox browser bundle is not installed/);
});

for (const platform of ['win32', 'darwin']) {
	test(`native WebKit on ${platform} never requires GTK, HOME, or Xvfb`, async () => {
		let displayCalls = 0;
		const engine = await resolveEngine('webkit', { platform, exists: () => true, ensureDisplay: async () => { displayCalls++; return null; } });
		assert.equal(engine.available, true);
		assert.deepEqual(engine.launch, {});
		assert.equal(displayCalls, 0);
	});
}
test('Linux GTK remains supported without hardcoding a Playwright revision', async () => {
	const engine = await resolveEngine('webkit', { platform: 'linux', exists: () => true, ensureDisplay: async () => ({ ready: true, display: ':88' }) });
	assert.equal(engine.available, true);
	assert.match(engine.launch.executablePath, /minibrowser-gtk/);
	assert.equal(engine.launch.env.DISPLAY, ':88');
});
test('missing native WebKit gives an actionable installation command', async () => {
	const engine = await resolveEngine('webkit', { platform: 'win32', exists: () => false });
	assert.equal(engine.available, false);
	assert.match(engine.reason, /npx playwright install webkit/);
});
