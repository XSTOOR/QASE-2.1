import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { attachBrowserBridge } from './browserBridge.js';
import { captureRuntimeFacts } from './runtimeCapture.js';
import { createQaTools } from './qaTools.js';

for (const mismatchedVersion of [false, true]) test(`actual Chromium identity is captured before finalization${mismatchedVersion ? ' and a mismatched selection stays blocked' : ''}`, async () => {
	const browser = await chromium.launch({ headless: true });
	// #17002 suite repair: the installed branded Chrome advances independently
	// of this fixture, and the branded-binary fact is runtime-authoritative
	// for version. Derive the *selected* major from the REAL installed binary
	// (the one the bridge launches for a chrome environment).
	const brandedVersion = execSync('/usr/bin/google-chrome-stable --version').toString();
	const brandedMajor = brandedVersion.match(/(\d+)\./)?.[1] ?? '151';
	const service = {
		browser, context: null, activePage: null, options: { headless: true },
		pages() { return this.context?.pages() ?? []; },
		async ensureContext() { return this.context ??= await browser.newContext(); },
		async ensurePage() { const context = await this.ensureContext(); return this.activePage ??= await context.newPage(); },
		registerPage(page) { this.activePage = page; },
		async snapshot() { return { elements: [] }; }, async getDiagnostics() { return {}; },
		async locator(page) { return page.locator('body'); }, async fill() {}, async typeText() {}, async suspend() {}, async restoreSession() {}
	};
	const environment = { envId: 'integration-mac-chrome', platform: 'macos', device: 'iMac test profile', os: 'macOS', browserCode: 'chrome', browserVersion: brandedMajor, deviceType: 'desktop', executionProvider: 'local', emulation: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false } };
	const session = { id: 'runtime-finalization-integration', mode: 'qa', environmentSnapshot: environment, findings: [{ severity: 'medium' }], todos: [{ text: 'Observe browser', status: 'completed' }], activities: [{ toolName: 'browser_snapshot', status: 'done' }] };
	const store = { async commit() {}, publish() {}, subscribe() { return () => {}; } };
	let bridge;
	try {
		// This fixture exercises a simulated profile on the installed bundled
		// engine. Host Chrome auto-updates are a separate registry contract;
		// selecting one implicitly made this test depend on the CI host image.
		environment.browserVersion = browser.version();
		bridge = await attachBrowserBridge(session, service, store, { environment, execution: { mode: 'emulated', executionEngine: 'chromium', brandedExecutablePath: null } });
		await service.ensurePage();
		assert.equal(session.runtimeFacts, undefined, 'reproduces lazy capture before finalization');
		const tools = createQaTools(session, store, { captureRuntimeFacts: async () => {
			await captureRuntimeFacts(session, bridge);
			if (mismatchedVersion) session.environmentSnapshot = { ...environment, browserVersion: '1' };
		} });
		const result = await tools[1].run({ verdict: 'pass_with_issues', summary: 'Browser observation recorded.', covered: ['Browser observation'], not_covered: ['Authentication not tested without credentials.'] });
		assert.equal(result.verdict, mismatchedVersion ? 'blocked' : 'pass_with_issues', JSON.stringify(session.report));
		assert.equal(session.report.runtimeIdentity.browserCode, 'chrome');
		assert.equal(session.report.runtimeIdentity.browserVersion.split('.')[0], environment.browserVersion.split('.')[0]);
		assert.equal(session.report.runtimeIdentity.platform, 'macos');
		assert.equal(session.report.attestation.execution_type, 'SIMULATED');
		assert.equal(session.report.bySeverity.medium, 1);
		if (mismatchedVersion) assert.ok(session.report.notCovered.some(text => text.includes('browser version mismatch')));
		else assert.deepEqual(session.report.notCovered, ['Authentication not tested without credentials.']);
	} finally {
		try { bridge?.dispose?.(); } finally {
			await service.browser?.close().catch(() => {});
			await browser.close().catch(() => {});
		}
	}
});
