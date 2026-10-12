import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserBridge } from './browserBridge.js';
import { generateEnvironments } from './environmentCatalog.js';
import { resolveExecution } from './browserstackProvider.js';

function minimalSession(overrides = {}) {
	return {
		id: '00000000-0000-4000-8000-000000000009',
		title: 'Env run',
		targetUrl: 'https://example.com/',
		device: 'desktop',
		deviceLandscape: false,
		...overrides
	};
}

function fakeService() {
	const page = {
		isClosed: () => false,
		url: () => 'https://example.com/start',
		title: async () => 'Target',
		viewportSize: () => ({ width: 1440, height: 900 }),
		waitForLoadState: async () => undefined
	};
	const context = {
		routes: [],
		addInitScript: async () => {},
		route: async () => { context.routes.push('route'); }
	};
	const browser = {
		contexts: () => [context],
		newContext: async () => context,
		close: async () => { browser.closed = true; }
	};
	return {
		page, context, browser,
		service: {
			activePage: page,
			context,
			options: {},
			snapshot: async () => ({ elements: [] }),
			ensurePage: async () => page,
			locator: async () => fakeLocator(),
			fill: async () => {},
			typeText: async () => {},
			open: async () => {},
			click: async () => {},
			close: async () => {}
		}
	};
}

function fakeLocator() {
	const locator = { filter: () => locator, count: async () => 0, first: () => locator };
	return locator;
}

test('a browserstack environment resolves remote execution and never launches local chromium', async t => {
	const environments = generateEnvironments();
	const snapshot = environments.find(env => env.envId === 'ENV-IOS-IP16PRO-18.3-CHR-151');
	const session = minimalSession({ environmentSnapshot: snapshot });
	const fake = fakeService();

	const execution = await resolveExecution(snapshot, { username: 'u', accessKey: 'k' });
	assert.equal(execution.mode, 'environment');

	// The bridge surfaces the execution plan for the UI/reports.
	const bridge = await attachBrowserBridge(session, fake.service, stubStore(), {
		execution,
		environment: snapshot
	});
	assert.equal(bridge.execution.mode, 'environment');
	assert.match(bridge.execution.label, /environment runtime/);
	t.after(() => bridge.dispose());
});

test('without credentials the same environment downgrades to emulated with the device viewport', async t => {
	const environments = generateEnvironments();
	const snapshot = environments.find(env => env.envId === 'ENV-IOS-IP16PRO-18.3-CHR-151');
	const session = minimalSession({ environmentSnapshot: snapshot });
	const fake = fakeService();

	const bridge = await attachBrowserBridge(session, fake.service, stubStore(), {
		environment: snapshot,
		browserstackCredentials: null
	});
	assert.equal(bridge.execution.mode, 'emulated');
	// RT1 (#14680): with a branded Chrome binary on this host the honest
	// local path is the REAL binary (engine-equivalent fallback otherwise —
	// never a fabricated remote claim without credentials).
	assert.match(bridge.execution.label, /local/i);
	assert.ok(/REAL .* binary|chromium/i.test(bridge.execution.label),
		`label must name the real binary or engine: ${bridge.execution.label}`);
	// R3 #14492: the engine follows the selected browser — Chrome → Chromium.
	assert.equal(bridge.execution.executionEngine, 'chromium');
	t.after(() => bridge.dispose());
});

function stubStore() {
	return { commit: async () => {}, addMessage: async () => {} };
}
