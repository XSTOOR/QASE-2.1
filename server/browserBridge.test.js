import assert from 'node:assert/strict';
import test from 'node:test';
import { attachBrowserBridge } from './browserBridge.js';
import { BROWSER_POLICY_CODES, createBrowserPolicy } from './browserPolicy.js';

function fakeLocator(descriptor = {}) {
	const locator = {
		filter: () => locator,
		count: async () => 1,
		first: () => locator,
		boundingBox: async () => undefined,
		evaluate: async () => descriptor,
		evaluateAll: async () => []
	};
	return locator;
}

function fakeService() {
	let currentUrl = 'https://app.example.test/start';
	const page = {
		isClosed: () => false,
		url: () => currentUrl,
		title: async () => 'Target',
		viewportSize: () => ({ width: 1440, height: 900 }),
		waitForLoadState: async () => undefined,
		locator: () => fakeLocator()
	};
	const calls = { click: 0, open: 0 };
	const context = {
		routeHandler: undefined,
		webSocketHandler: undefined,
		initScripts: [],
		addInitScript: async script => { context.initScripts.push(script); },
		route: async (_pattern, handler) => { context.routeHandler = handler; },
		routeWebSocket: async (_pattern, handler) => { context.webSocketHandler = handler; }
	};
	const service = {
		activePage: page,
		context,
		snapshot: async () => ({ elements: [] }),
		locator: async (_page, input) => fakeLocator(
			input?.text === 'External identity'
				? { text: 'External identity', destination: 'https://identity.example.test/login' }
				: { text: input?.text, ariaLabel: input?.label }
		),
		hasLocator: input => Boolean(input?.text || input?.label || input?.selector),
		ensurePage: async () => page,
		click: async () => {
			calls.click += 1;
			currentUrl = `https://app.example.test/after-${calls.click}`;
			return { success: true, url: currentUrl };
		},
		fill: async () => ({ success: true }),
		typeText: async () => ({ success: true }),
		open: async url => {
			calls.open += 1;
			currentUrl = url;
			return { success: true, url };
		},
		screenshot: async () => ({ success: true, base64: '', mimeType: 'image/jpeg', url: currentUrl }),
		dispose: async () => undefined
	};
	return { service, calls, context };
}

function fakeRunStore() {
	return {
		events: [],
		publish(_session, type, payload) { this.events.push({ type, payload }); },
		async commit() {}
	};
}

test('browser bridge blocks out-of-scope navigation and gates destructive clicks before execution', async () => {
	let clock = 1_000;
	const session = {
		id: '00000000-0000-4000-8000-000000000001',
		targetUrl: 'https://app.example.test/start',
		messages: []
	};
	const { service, calls } = fakeService();
	const runStore = fakeRunStore();
	const policy = createBrowserPolicy({
		getTargetUrl: () => session.targetUrl,
		environment: { NODE_ENV: 'test' },
		now: () => clock
	});
	const bridge = attachBrowserBridge(session, service, runStore, { policy });

	const direct = await service.open('https://outside.example.test/');
	assert.equal(direct.success, false);
	assert.equal(direct.code, BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION);
	assert.equal(calls.open, 0);

	const link = await service.click('ide', { text: 'External identity' });
	assert.equal(link.success, false);
	assert.equal(link.code, BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION);
	assert.equal(calls.click, 0);

	const destructive = await service.click('ide', { text: 'Delete project' });
	assert.equal(destructive.success, false);
	assert.equal(destructive.code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);
	assert.equal(destructive.requiresConfirmation, true);
	assert.equal(calls.click, 0);

	clock += 1;
	session.messages.push({ role: 'user', text: 'Proceed.', ts: clock });
	const confirmed = await service.click('ide', { text: 'Delete project' });
	assert.equal(confirmed.success, true);
	assert.equal(calls.click, 1);
	assert.ok(runStore.events.some(event => event.type === 'browser_policy'));
	bridge.dispose();
});

test('browser bridge installs a context-wide route that blocks private subresources', async () => {
	const session = {
		id: '00000000-0000-4000-8000-000000000002',
		targetUrl: 'https://app.example.test/',
		messages: []
	};
	const { service, context } = fakeService();
	const runStore = fakeRunStore();
	const policy = createBrowserPolicy({
		getTargetUrl: () => session.targetUrl,
		environment: { NODE_ENV: 'production' },
		resolveHost: async () => [{ address: '93.184.216.34', family: 4 }]
	});
	const bridge = attachBrowserBridge(session, service, runStore, { policy });
	await service.ensurePage();
	assert.equal(typeof context.routeHandler, 'function');
	assert.equal(context.initScripts.length, 2);

	let aborted;
	let continued = false;
	await context.routeHandler({
		request: () => ({
			url: () => 'http://169.254.169.254/latest/meta-data',
			isNavigationRequest: () => false,
			frame: () => ({ parentFrame: () => null }),
			method: () => 'GET',
			resourceType: () => 'fetch'
		}),
		continue: async () => { continued = true; },
		abort: async reason => { aborted = reason; }
	});
	assert.equal(continued, false);
	assert.equal(aborted, 'blockedbyclient');
	assert.equal(runStore.events.at(-1)?.payload?.browserPolicy?.code, BROWSER_POLICY_CODES.PRIVATE_NETWORK);

	let socketClosed;
	let socketConnected = false;
	await context.webSocketHandler({
		url: () => 'ws://127.0.0.1/events',
		connectToServer: () => { socketConnected = true; },
		close: async options => { socketClosed = options; }
	});
	assert.equal(socketConnected, false);
	assert.equal(socketClosed?.code, 1008);
	await context.webSocketHandler({
		url: () => 'wss://events.example.test/socket',
		connectToServer: () => { socketConnected = true; },
		close: async () => { throw new Error('public socket should not close'); }
	});
	assert.equal(socketConnected, true);
	bridge.dispose();
});

test('browser bridge coalesces concurrent captures and does not publish identical frames', async () => {
	const session = {
		id: '00000000-0000-4000-8000-000000000003',
		targetUrl: 'https://app.example.test/',
		status: 'running',
		messages: []
	};
	const { service } = fakeService();
	const runStore = fakeRunStore();
	let screenshots = 0;
	let releaseFirst;
	service.screenshot = async () => {
		screenshots += 1;
		await new Promise(resolve => { releaseFirst = resolve; });
		return {
			success: true,
			base64: 'same-frame',
			mimeType: 'image/jpeg',
			url: 'https://app.example.test/',
			title: 'Target'
		};
	};
	const bridge = attachBrowserBridge(session, service, runStore, {
		policy: createBrowserPolicy({
			getTargetUrl: () => session.targetUrl,
			environment: { NODE_ENV: 'test' }
		})
	});

	const first = bridge.captureFrame();
	const concurrent = bridge.captureFrame();
	assert.equal(first, concurrent);
	await Promise.resolve();
	assert.equal(screenshots, 1);
	releaseFirst();
	await first;
	assert.equal(runStore.events.filter(event => event.type === 'frame').length, 1);

	service.screenshot = async () => ({
		success: true,
		base64: 'same-frame',
		mimeType: 'image/jpeg',
		url: 'https://app.example.test/',
		title: 'Target'
	});
	await bridge.captureFrame();
	assert.equal(runStore.events.filter(event => event.type === 'frame').length, 1);

	service.screenshot = async () => ({
		success: true,
		base64: 'changed-frame',
		mimeType: 'image/jpeg',
		url: 'https://app.example.test/',
		title: 'Target'
	});
	await bridge.captureFrame();
	assert.equal(runStore.events.filter(event => event.type === 'frame').length, 2);
	bridge.dispose();
});
