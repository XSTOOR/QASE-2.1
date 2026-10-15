import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { once } from 'node:events';
import { attachBrowserBridge } from './browserBridge.js';
import { createBrowserPolicy } from './browserPolicy.js';
import { mountDemoSite } from './demoSite.js';
import { resolveEngine } from './browserEngines.js';

const require = createRequire(import.meta.url);

const browserTests = process.env.QASE_RUN_BROWSER_TESTS === '1';

async function loadAutomation() {
	const sdkRoot = require.resolve('@cleanslate/sdk');
	const moduleUrl = new URL('./node/cleanSlateNodeBrowserAutomation.js', pathToFileURL(sdkRoot));
	const { CleanSlateNodeBrowserAutomation } = await import(moduleUrl);
	return { CleanSlateNodeBrowserAutomation };
}

async function setup(t, engine) {
	const app = express();
	mountDemoSite(app);
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const targetUrl = `http://127.0.0.1:${server.address().port}/demo`;
	const { CleanSlateNodeBrowserAutomation } = await loadAutomation();
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const session = { id: `engine-fixture-${engine}`, targetUrl, messages: [], status: 'running', engine };
	const events = [];
	const store = {
		publish(_session, type, payload) { events.push({ type, payload }); },
		async commit(_session, type, payload) { events.push({ type, payload }); }
	};
	const policy = createBrowserPolicy({
		getTargetUrl: () => targetUrl,
		environment: { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true' }
	});
	const bridge = await attachBrowserBridge(session, service, store, { policy });
	t.after(async () => {
		bridge.dispose?.();
		await service.dispose().catch(() => undefined);
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	});
	return { bridge, service, targetUrl, events, session, store };
}

for (const engineId of ['firefox', 'webkit']) {
	test(`the ${engineId} engine opens the demo site through the bridge`, { skip: !browserTests, timeout: 90000 }, async t => {
		const engine = await resolveEngine(engineId);
		if (!engine.available) {
			t.skip(`engine unavailable: ${engine.reason}`);
			return;
		}
		const { bridge, targetUrl } = await setup(t, engineId);
		const result = await bridge.service.open(`${targetUrl}/vuln/search`);
		assert.ok(result, 'service.open resolves');
		const page = bridge.service.activePage;
		assert.ok(page, 'active page exists');
		const title = await page.textContent('h1');
		assert.match(title, /Guestbook search/, 'demo page renders on ' + engineId);
	});

	test(`the ${engineId} engine reports findings tagged with the engine`, { skip: !browserTests, timeout: 90000 }, async t => {
		const engine = await resolveEngine(engineId);
		if (!engine.available) {
			t.skip(`engine unavailable: ${engine.reason}`);
			return;
		}
		const { bridge, events, targetUrl, session, store } = await setup(t, engineId);
		await bridge.service.open(`${targetUrl}/vuln/search`);
		// Commit a finding the way qaTools would.
		const finding = { id: 'f1', title: 'layout drift', severity: 'medium', expected: 'x', actual: 'y', engine: session.engine };
		await store.commit(session, 'finding', { finding });
		const committed = events.find(event => event.type === 'finding');
		assert.equal(committed.payload.finding.engine, engineId);
	});
}

test('chromium still launches through the bridge unchanged', { skip: !browserTests, timeout: 90000 }, async t => {
	const { bridge, targetUrl } = await setup(t, 'chromium');
	const result = await bridge.service.open(`${targetUrl}/vuln/search`);
	assert.ok(result);
	const title = await bridge.service.activePage.textContent('h1');
	assert.match(title, /Guestbook search/);
});

test('an unavailable engine fails browser_open with ENGINE_UNAVAILABLE, not a crash', { skip: !browserTests, timeout: 30000 }, async t => {
	// Force unavailability: request webkit with the GTK bundle hidden via env.
	const savedHome = process.env.PLAYWRIGHT_BROWSERS_PATH;
	process.env.PLAYWRIGHT_BROWSERS_PATH = '/nonexistent-playwright-path';
	try {
		// Re-import a fresh copy of the module so the env is read anew.
		const { resolveEngine: fresh } = await import(`./browserEngines.js?probe=${Date.now()}`);
		const engine = await fresh('webkit');
		assert.equal(engine.available, false);
		assert.ok(engine.reason);
	} finally {
		if (savedHome === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
		else process.env.PLAYWRIGHT_BROWSERS_PATH = savedHome;
	}
});
