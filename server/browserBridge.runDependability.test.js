import assert from 'node:assert/strict';
import test from 'node:test';
import { attachBrowserBridge } from './browserBridge.js';
import { BROWSER_POLICY_CODES, createBrowserPolicy } from './browserPolicy.js';

function fakeService(overrides = {}) {
	let currentUrl = 'https://app.example.test/start';
	const page = {
		isClosed: () => false,
		url: () => currentUrl,
		title: async () => 'Target',
		viewportSize: () => ({ width: 1440, height: 900 }),
		waitForLoadState: async () => undefined,
		locator: () => fakeLocator()
	};
	const calls = { click: 0, open: 0, wait: [], waitRaw: 0 };
	const context = {
		addInitScript: async () => undefined,
		route: async () => undefined,
		routeWebSocket: async () => undefined
	};
	const service = {
		activePage: page,
		context,
		snapshot: async () => ({ elements: [] }),
		locator: async (_page, input) => fakeLocator({ text: input?.text, ariaLabel: input?.label }),
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
		wait: async (surface, input) => {
			calls.waitRaw += 1;
			calls.wait.push({ ...input });
			return { success: true };
		},
		screenshot: async () => ({ success: true, base64: '', mimeType: 'image/jpeg', url: currentUrl }),
		dispose: async () => undefined,
		...overrides
	};
	return { service, calls };
}

function fakeRunStore() {
	return {
		events: [],
		publish(_session, type, payload) { this.events.push({ type, payload }); },
		async commit() {}
	};
}

function fakeLocator(descriptor = {}) {
	const locator = {
		count: async () => 1,
		first: () => locator,
		waitFor: async () => undefined,
		click: async () => undefined
	};
	return locator;
}

async function makeBridge(policy, overrides = {}) {
	const session = {
		id: '00000000-0000-4000-8000-000000000101',
		targetUrl: 'https://app.example.test/start',
		messages: []
	};
	const { service, calls } = fakeService(overrides);
	const bridge = await attachBrowserBridge(session, service, fakeRunStore(), { policy });
	return { session, service, calls, bridge };
}

function grantedPolicy() {
	let clock = 1_000;
	return createBrowserPolicy({
		getTargetUrl: () => 'https://app.example.test/start',
		environment: { NODE_ENV: 'test' },
		now: () => clock
	});
}

test('browser_wait clamps ms and timeoutMs to the documented 30000ms bound', async () => {
	const { service, calls, bridge } = await makeBridge(grantedPolicy());

	await service.wait('ide', { ms: 5_000_000 });
	await service.wait('ide', { timeoutMs: 600_000, url: 'https://app.example.test/done' });
	await service.wait('ide', { ms: 2_000, timeoutMs: 4_000 });

	assert.deepEqual(calls.wait, [
		{ ms: 30_000 },
		{ timeoutMs: 30_000, url: 'https://app.example.test/done' },
		{ ms: 2_000, timeoutMs: 4_000 }
	]);
	bridge.dispose();
});

test('abort during an in-flight browser action rejects immediately with AbortError', async () => {
	// The hung action must be in place BEFORE attachBrowserBridge wraps it.
	const { service, calls, bridge } = await makeBridge(grantedPolicy(), {
		click: () => new Promise(() => {}) // never settles — simulates a hung Playwright action
	});
	const controller = new AbortController();
	bridge.setAbortSignal(controller.signal);

	const pending = service.click('ide', { text: 'Read more' });
	setTimeout(() => controller.abort(new Error('stop requested')), 20);

	const started = Date.now();
	await assert.rejects(pending, error => error.name === 'AbortError');
	assert.ok(Date.now() - started < 2_000, 'abort must unwind within the abort window, not the action timeout');
	assert.equal(calls.click, 0);
	bridge.dispose();
});

test('a confirmed destructive action executes once; identical re-execution is refused with ACTION_ALREADY_EXECUTED', async () => {
	let clock = 1_000;
	const session = {
		id: '00000000-0000-4000-8000-000000000102',
		targetUrl: 'https://app.example.test/start',
		messages: []
	};
	const { service, calls } = fakeService();
	const policy = createBrowserPolicy({
		getTargetUrl: () => session.targetUrl,
		environment: { NODE_ENV: 'test' },
		now: () => clock
	});
	const bridge = await attachBrowserBridge(session, service, fakeRunStore(), { policy });

	// First attempt: blocked, confirmation required.
	const blocked = await service.click('ide', { text: 'Send message' });
	assert.equal(blocked.success, false);
	assert.equal(blocked.code, BROWSER_POLICY_CODES.CONFIRMATION_REQUIRED);

	// User approves.
	clock += 1;
	session.messages.push({ role: 'user', text: 'Proceed.', ts: clock });
	const executed = await service.click('ide', { text: 'Send message' });
	assert.equal(executed.success, true);
	assert.equal(calls.click, 1);

	// Recovery turn tries the SAME destructive action again after the grant's
	// two uses are exhausted → mechanical refusal, not another execution.
	const repeated = await service.click('ide', { text: 'Send message' });
	assert.equal(repeated.success, false);
	assert.equal(repeated.code, 'ACTION_ALREADY_EXECUTED');
	assert.match(String(repeated.error), /Verify the result/i);
	assert.equal(calls.click, 1, 'the destructive click must not execute twice');

	// Benign (non-destructive) repeats are untouched.
	const benign = await service.click('ide', { text: 'Read the docs' });
	assert.equal(benign.success, true);
	assert.equal(calls.click, 2);

	// Crash-restart simulation: ensureRuntime builds a FRESH bridge, but the
	// session record (persisted by the store) still carries the ledger. The
	// user "approves again" after restart — without the persisted ledger this
	// click would execute a SECOND destructive action (the dangerous re-planning
	// path). The fresh policy instance has no grant, so the ledger is the only
	// guard standing between the recovered turn and the repeat.
	clock += 1;
	session.messages.push({ role: 'user', text: 'Proceed again.', ts: clock });
	const { service: recoveredService, calls: recoveredCalls, bridge: recoveredBridge } = await (async () => {
		const built = fakeService();
		const attached = await attachBrowserBridge(session, built.service, fakeRunStore(), { policy });
		return { ...built, bridge: attached };
	})();
	const afterRestart = await recoveredService.click('ide', { text: 'Send message' });
	assert.equal(afterRestart.success, false);
	assert.equal(afterRestart.code, 'ACTION_ALREADY_EXECUTED');
	assert.equal(recoveredCalls.click, 0, 'recovered turn must not re-execute the destructive click');
	recoveredBridge.dispose();
	bridge.dispose();
});
