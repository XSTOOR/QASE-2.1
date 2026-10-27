import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { attachBrowserBridge, selectSnapshotElements } from './browserBridge.js';
import { BROWSER_POLICY_CODES, createBrowserPolicy } from './browserPolicy.js';

test('snapshot selection finds late controls without renumbering or exceeding its budget', () => {
	const nodes = Array.from({ length: 600 }, (_, i) => ({ id: `e${i + 1}`, tagName: 'div' }));
	nodes.push({ id: 'e601', tagName: 'button', interactive: true });
	nodes.push({ id: 'e602', tagName: 'input', interactive: true });
	const selected = selectSnapshotElements(nodes, 20);
	assert.equal(selected.length, 20);
	assert.deepEqual(selected.slice(0, 2).map(node => node.id), ['e601', 'e602']);
	assert.equal(new Set(selected.map(node => node.id)).size, 20);
	assert.equal(selectSnapshotElements(nodes, 999).length, 500);
	assert.equal(selectSnapshotElements(nodes, NaN).length, 150);
	assert.equal(selectSnapshotElements(nodes, 0).length, 1);
});

function fakeLocator(descriptor = {}, options = {}) {
	const locator = {
		filter: () => locator,
		count: async () => typeof options.count === 'function' ? options.count() : options.count ?? 1,
		first: () => locator,
		waitFor: async () => {
			if (options.waitError) throw options.waitError;
			options.onWait?.();
		},
		boundingBox: async () => undefined,
		evaluate: async () => { options.onEvaluate?.(); return descriptor; },
		evaluateAll: async () => [],
		click: async () => {
			if (options.trialError) throw options.trialError;
		}
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

test('QA macros honor the active run cancellation before dispatch and after queued preview capture', async () => {
  const { service } = fakeService();
  const bridge = await attachBrowserBridge({ id: 'qa-cancel', targetUrl: service.activePage.url(), messages: [] }, service, fakeRunStore());
  const first = new AbortController();
  first.abort(new Error('Run cancelled'));
  bridge.setAbortSignal(first.signal);
  await assert.rejects(bridge.runQaCheck({ action: 'inspect' }), /Run cancelled/);
  const next = new AbortController();
  bridge.setAbortSignal(next.signal);
  let release;
  bridge.frameCapture = new Promise(resolve => { release = resolve; });
  const pending = bridge.runQaCheck({ action: 'inspect' });
  next.abort(new Error('Run paused during preview'));
  release();
  await assert.rejects(pending, /Run paused during preview/);
  assert.equal(bridge.qaOperationActive, false);
  bridge.dispose();
});

test('hybrid context blocks target writes and WebSocket connections before forwarding', async () => {
  const { service, context } = fakeService();
  const session = { id: 'hybrid-policy', qaExecutionMode: 'hybrid', targetUrl: service.activePage.url(), messages: [] };
  const bridge = await attachBrowserBridge(session, service, fakeRunStore());
  await service.ensurePage();
  let forwarded = false, aborted = false;
  await context.routeHandler({ request: () => ({ method: () => 'POST', url: () => 'https://app.example.test/records', resourceType: () => 'fetch' }), continue: async () => { forwarded = true; }, abort: async () => { aborted = true; } });
  assert.equal(forwarded, false); assert.equal(aborted, true);
  let connected = false, closed = false;
  await context.webSocketHandler({ connectToServer() { connected = true; }, async close() { closed = true; } });
  assert.equal(connected, false); assert.equal(closed, true);
  assert.ok(bridge.securityBlocks.some(item => item.code === 'HYBRID_WRITE_REQUEST_BLOCKED'));
  bridge.dispose();
});

test('diagnostics capture uncaught exceptions and failed requests once, with provenance and clear semantics', async () => {
  const { service } = fakeService();
  const events = new EventEmitter();
  service.activePage.on = events.on.bind(events);
  service.activePage.evaluate = async () => undefined;
  service.getDiagnostics = async () => ({ success: true, console: [], network: [] });
  service.registerPage = () => {};
  const session = { id: 'diagnostic-fixture', targetUrl: service.activePage.url(), messages: [] };
  const bridge = await attachBrowserBridge(session, service, fakeRunStore());
  service.registerPage(service.activePage); service.registerPage(service.activePage);
  assert.equal(events.listenerCount('pageerror'), 1);
  const exception = new Error('Fixture uncaught error');
  exception.stack = 'Error: Fixture uncaught error\n at https://app.example.test/app.js:12:3';
  events.emit('pageerror', exception);
  const request = { url: () => 'https://app.example.test/required.js', method: () => 'GET', resourceType: () => 'script', headers: () => ({ authorization: 'never-export', cookie: 'private', purpose: 'prefetch' }), isNavigationRequest: () => false, failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }) };
  events.emit('request', request);
  const first = await service.getDiagnostics('ide', { clear: true });
  assert.equal(first.console.length, 1);
  assert.equal(first.console[0].kind, 'pageerror');
  assert.equal(first.console[0].sourceId, 'https://app.example.test/app.js');
  assert.equal(first.console[0].pageUrl, session.targetUrl);
  assert.equal(first.network[0].speculative, true);
  assert.doesNotMatch(JSON.stringify(first), /never-export|private/);
  events.emit('requestfailed', request);
  const second = await service.getDiagnostics('ide', { clear: true });
  assert.equal(second.console.length, 0);
  assert.equal(second.network.length, 1, 'In-flight completion remains visible after the initial request was cleared.');
  assert.match(second.network[0].error, /CONNECTION_RESET/);
  assert.deepEqual((await service.getDiagnostics('ide')).network, []);
  await bridge.dispose();
});

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
		resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
		now: () => clock
	});
	const bridge = await attachBrowserBridge(session, service, runStore, { policy });
	const qaExternal = await bridge.runQaCheck({ action: 'navigation', selector: '#external', expected: 'https://outside.example.test/' });
	assert.equal(qaExternal.success, false);
	assert.equal(qaExternal.code, BROWSER_POLICY_CODES.OUT_OF_SCOPE_NAVIGATION);
	const originalLocator = service.locator;
	service.locator = async () => fakeLocator({ text: 'Delete project', tagName: 'BUTTON' });
	const qaRisky = await bridge.runQaCheck({ action: 'disclosure', selector: '#delete-project' });
	assert.equal(qaRisky.code, 'QA_RISKY_CONTROL');
	service.locator = originalLocator;

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

test('browser bridge fails ambiguous and obscured click targets before the driver timeout', async () => {
	const session = {
		id: '00000000-0000-4000-8000-000000000004',
		targetUrl: 'https://app.example.test/start',
		messages: []
	};
	const { service, calls } = fakeService();
	const bridge = await attachBrowserBridge(session, service, fakeRunStore(), {
		policy: createBrowserPolicy({
			getTargetUrl: () => session.targetUrl,
			environment: { NODE_ENV: 'test' }
		})
	});

	service.locator = async () => fakeLocator({ text: 'Cancel' }, { count: 3 });
	const ambiguous = await service.click('ide', { text: 'Cancel' });
	assert.equal(ambiguous.success, false);
	assert.equal(ambiguous.code, 'BROWSER_TARGET_AMBIGUOUS');
	assert.equal(ambiguous.matches, 3);
	assert.equal(calls.click, 0);

	service.locator = async () => fakeLocator(
		{ text: 'Create Meeting' },
		{ trialError: new Error('overlay intercepts pointer events') }
	);
	const obscured = await service.click('ide', { selector: '#create-meeting' });
	assert.equal(obscured.success, false);
	assert.equal(obscured.code, 'BROWSER_TARGET_OBSCURED');
	assert.match(obscured.error, /overlay or another element/);
	assert.equal(calls.click, 0);

	let appeared = false;
	service.locator = async () => fakeLocator(
		{ text: 'Delayed control' },
		{ count: () => appeared ? 1 : 0, onWait: () => { appeared = true; } }
	);
	const delayed = await service.click('ide', { selector: '#delayed' });
	assert.equal(delayed.success, true);
	assert.equal(calls.click, 1);

	service.locator = async () => fakeLocator(
		{ text: 'Disabled control' },
		{ trialError: new Error('element is not enabled') }
	);
	const disabled = await service.click('ide', { selector: '#disabled' });
	assert.equal(disabled.success, false);
	assert.equal(disabled.code, 'BROWSER_TARGET_NOT_ACTIONABLE');
	assert.doesNotMatch(disabled.error, /overlay/);

	let missingDescriptorReads = 0;
	const timeout = new Error('Timeout 2500ms exceeded');
	timeout.name = 'TimeoutError';
	service.locator = async () => fakeLocator(
		{},
		{ waitError: timeout, onEvaluate: () => { missingDescriptorReads++; } }
	);
	const started = Date.now();
	const missing = await service.click('ide', { selector: '#never-renders' });
	assert.equal(missing.success, false);
	assert.equal(missing.code, 'BROWSER_TARGET_NOT_FOUND');
	assert.equal(missingDescriptorReads, 0);
	assert.ok(Date.now() - started < 100, 'fixture should take the bounded preflight path without descriptor auto-wait');
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
	const bridge = await attachBrowserBridge(session, service, runStore, { policy });
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
	const bridge = await attachBrowserBridge(session, service, runStore, {
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

test('hybrid preview reads the existing page without SDK ensurePage or viewport mutation and skips active QA timers', async () => {
	const session = { id: 'preview-hybrid', qaExecutionMode: 'hybrid', targetUrl: 'https://app.example.test/', messages: [] };
	const { service } = fakeService(), runStore = fakeRunStore();
	let screenshots = 0;
	service.screenshot = async () => { throw new Error('SDK screenshot must not prepare or restore the page'); };
	service.activePage.screenshot = async options => {
		assert.equal(options.timeout, 1200); assert.equal(options.animations, 'allow'); assert.equal(options.caret, 'initial');
		screenshots++; return Buffer.from('read-only-preview');
	};
	const bridge = await attachBrowserBridge(session, service, runStore, { policy: createBrowserPolicy({ getTargetUrl: () => session.targetUrl, environment: { NODE_ENV: 'test' } }) });
	bridge.qaOperationActive = true;
	await bridge.captureFrame(); assert.equal(screenshots, 0);
	await bridge.captureFrame({ withinQaCheck: true }); assert.equal(screenshots, 1);
	assert.equal(bridge.qaOperationActive, true, 'Preview reads cannot release execution ownership.');
	const frame = runStore.events.find(event => event.type === 'frame').payload.frame;
	assert.equal(frame.url, service.activePage.url()); assert.equal(frame.title, 'Target');
	assert.deepEqual(frame.viewport, { width: 1440, height: 900 });
	service.activePage.screenshot = async () => { throw new Error('Fixture screenshot timeout'); };
	await bridge.captureFrame({ withinQaCheck: true });
	assert.equal(bridge.getLastFrame(), frame, 'Failed preview keeps the last honest frame, without failing the QA action.');
	bridge.dispose();
});
