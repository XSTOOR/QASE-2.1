import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { attachBrowserBridge } from './browserBridge.js';
import { captureRuntimeFacts } from './runtimeCapture.js';
import { createQaTools } from './qaTools.js';

test('actual Chromium identity is available to the finalizer before turn cleanup', async () => {
	const browser = await chromium.launch({ headless: true });
	const service = {
		browser, context: null, activePage: null, options: { headless: true },
		pages() { return this.context?.pages() ?? []; },
		async ensureContext() { return this.context ??= await browser.newContext(); },
		async ensurePage() { const context = await this.ensureContext(); return this.activePage ??= await context.newPage(); },
		registerPage(page) { this.activePage = page; },
		async snapshot() { return { elements: [] }; }, async getDiagnostics() { return {}; },
		async locator(page) { return page.locator('body'); }, async fill() {}, async typeText() {}, async suspend() {}, async restoreSession() {}
	};
	const environment = { envId: 'integration-mac-chrome', platform: 'macos', device: 'iMac test profile', os: 'macOS', browserCode: 'chrome', browserVersion: '151', deviceType: 'desktop', executionProvider: 'local', emulation: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } };
	const session = { id: 'runtime-finalization-integration', mode: 'qa', environmentSnapshot: environment, findings: [{ severity: 'medium' }], todos: [{ text: 'Observe browser', status: 'completed' }], activities: [{ toolName: 'browser_snapshot', status: 'done' }] };
	const store = { async commit() {}, publish() {}, subscribe() { return () => {}; } };
	let bridge;
	try {
		bridge = await attachBrowserBridge(session, service, store, { environment });
		await service.ensurePage();
		assert.equal(session.runtimeFacts, undefined, 'reproduces lazy capture before finalization');
		const tools = createQaTools(session, store, { captureRuntimeFacts: () => captureRuntimeFacts(session, bridge) });
		const result = await tools[1].run({ verdict: 'pass_with_issues', summary: 'Browser observation recorded.', covered: ['Browser observation'], not_covered: ['Authentication not tested without credentials.'] });
		assert.equal(result.verdict, 'pass_with_issues');
		assert.equal(session.report.runtimeIdentity.browserCode, 'chrome');
		assert.equal(session.report.runtimeIdentity.platform, 'macos');
		assert.equal(session.report.attestation.execution_type, 'SIMULATED');
		assert.equal(session.report.bySeverity.medium, 1);
		assert.deepEqual(session.report.notCovered, ['Authentication not tested without credentials.']);
	} finally {
		try { bridge?.dispose?.(); } finally {
			await service.browser?.close().catch(() => {});
			await browser.close().catch(() => {});
		}
	}
});
