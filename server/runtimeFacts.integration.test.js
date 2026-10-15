import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { existsSync } from 'node:fs';
import { attachBrowserBridge } from './browserBridge.js';
import { captureRuntimeFacts } from './runtimeCapture.js';
import { createQaTools } from './qaTools.js';

class FakeRunStore {
	commit() { return Promise.resolve(); }
	subscribe() { return () => undefined; }
	publish() {}
}

test('readRuntimeFacts reports the emulated iPhone UA and viewport honestly (integration)', { skip: !existsSync(webkit.executablePath()) && 'WebKit is not installed on this host.' }, async () => {
	const browser = await chromium.launch({ headless: true });
	// The bridge overrides ensureContext/ensurePage itself; a minimal service
	// that only knows how to launch the shared browser is enough.
	const service = {
		browser: undefined,
		context: undefined,
		activePage: undefined,
		options: { headless: true },
		pages() { return service.context?.pages?.() ?? []; },
		async ensureContext() {
			if (!service.context) {
				service.browser ??= browser;
				service.context = await service.browser.newContext();
			}
			return service.context;
		},
		async ensurePage() {
			const context = await service.ensureContext();
			if (!service.activePage || service.activePage.isClosed()) {
				service.activePage = await context.newPage();
			}
			return service.activePage;
		},
		registerPage(page) { service.activePage = page; },
		async snapshot() { return { elements: [] }; },
		async locator(page, input) { return page.locator('body'); },
		async fill() {},
		async typeText() {},
		async suspend() {},
		async restoreSession() {},
		async getDiagnostics() { return {}; }
	};
	const environment = {
		envId: 'ENV-IOS-IP16PRO-18.3-SAF-18.3',
		platform: 'ios',
		device: 'iPhone 16 Pro',
		osVersion: '18.3',
		browserCode: 'safari',
		deviceType: 'mobile',
		executionProvider: 'local',
		emulation: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
		permissionScenario: { camera: 'deny' },
		orientationScenario: 'portrait'
	};
	let bridge;
	try {
		bridge = await attachBrowserBridge({}, service, new FakeRunStore(), { environment });

		// Honest level facts are available immediately.
		assert.equal(bridge.execution.level, 'SIMULATED');
		assert.equal(bridge.execution.provider, 'local');
		assert.match(bridge.execution.emulatedUserAgent, /iPhone/);

		// The bridge's overridden ensureContext creates the emulated context.
		const context = await service.ensureContext();
		const page = await service.ensurePage();
		// Mobile WebKit uses a 980px layout viewport without a viewport meta
		// tag; use a responsive document when asserting the device CSS width.
		await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><main>Runtime identity fixture</main>');
		await page.evaluate(() => document.readyState);

		const facts = await bridge.readRuntimeFacts();
		assert.ok(facts, 'facts available once a page exists');
		assert.match(facts.userAgent, /iPhone/, 'the page actually saw the iPhone UA');
		assert.equal(facts.viewport.width, 393, 'observed viewport is the emulation viewport');
		assert.equal(facts.viewport.height, 852);
		// Desktop WebKit ports differ in reported touch-point count. Capture
		// the actual value, never fabricate the catalog's requested capability.
		assert.equal(facts.maxTouchPoints, await page.evaluate(() => navigator.maxTouchPoints), 'touch capability is reported honestly');
		assert.equal(facts.devicePixelRatio, 3, 'DPR 3 from the catalog profile');
		// Context-level cached facts (read at context creation) agree.
		assert.match(bridge.runtimeFacts.userAgent, /iPhone/);
		// Regression: finalize while still INSIDE the live turn, before cleanup.
		const session = { id: 'runtime-capture-integration', mode: 'qa', environmentSnapshot: environment, findings: [], todos: [{ text: 'Observe browser', status: 'completed' }], activities: [{ toolName: 'browser_snapshot', status: 'done' }] };
		const tools = createQaTools(session, new FakeRunStore(), { captureRuntimeFacts: () => captureRuntimeFacts(session, bridge) });
		assert.equal((await tools[1].run({ verdict: 'pass', summary: 'Browser identity observed.', covered: ['Browser observation'] })).verdict, 'pass');
		assert.match(session.report.runtimeIdentity.observedUserAgent, /iPhone/);
	} finally {
		try { bridge?.dispose?.(); } finally {
			await service.browser?.close().catch(() => {});
			await browser.close().catch(() => {});
		}
	}
});
