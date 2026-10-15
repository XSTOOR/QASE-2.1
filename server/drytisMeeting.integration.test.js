import assert from 'node:assert/strict';
import test from 'node:test';
import { attachBrowserBridge } from './browserBridge.js';
import { createBrowserPolicy } from './browserPolicy.js';

const enabled = process.env.QASE_RUN_BROWSER_TESTS === '1';
const path = '/meeting/mtg-Aajxsxmsq9bGgW';
const targetUrl = `https://studio.drytis.ai${path}`;
const destination = `https://meeting.drytis.dev${path}?workspaceUrl=https%3A%2F%2Fstudio.drytis.ai&guest=true`;

async function setup(t) {
	const { CleanSlateNodeBrowserAutomation } = await import(new URL('./node/cleanSlateNodeBrowserAutomation.js', import.meta.resolve('@cleanslate/sdk')));
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const context = await service.ensureContext();
	// Keep the real bridge network handler in control. Replace only its successful
	// network continuation with fixture responses; never contact or join a meeting.
	const register = context.route.bind(context);
	context.route = (pattern, handler) => register(pattern, route => {
		const fixtureRoute = new Proxy(route, { get(object, key) {
			if (key === 'continue') return async () => {
				const url = new URL(route.request().url());
				if (url.origin === 'https://studio.drytis.ai' && url.searchParams.has('redirect')) {
					return route.fulfill({ contentType: 'text/html', body: `<script>location.replace(${JSON.stringify(destination)})</script>` });
				}
				return route.fulfill({ contentType: 'text/html', body: url.origin === 'https://studio.drytis.ai'
					? `<title>Guest entry fixture</title><button id="guest" onclick='location.href=${JSON.stringify(destination)}'>Continue as Guest</button><button id="blocked" onclick='location.href="https://unrelated.example/"'>Continue elsewhere</button>`
					: '<title>Meeting fixture</title><h1>Guest navigation completed</h1><button>Join meeting</button>' });
			};
			const value = Reflect.get(object, key, object);
			return typeof value === 'function' ? value.bind(object) : value;
		} });
		return handler(fixtureRoute);
	});
	const session = { id: 'drytis-navigation-fixture', targetUrl, device: 'desktop', messages: [], status: 'running' };
	const policy = createBrowserPolicy({ getTargetUrl: () => targetUrl, environment: { NODE_ENV: 'production' }, resolveHost: async () => [{ address: '93.184.216.34', family: 4 }] });
	const bridge = await attachBrowserBridge(session, service, { publish() {}, async commit() {} }, { policy });
	t.after(async () => { bridge.dispose(); await service.dispose(); });
	await service.open(targetUrl);
	bridge.stopFrames();
	return { service };
}

test('Drytis guest button may navigate to the declared meeting alias while unrelated destinations stay blocked', { skip: !enabled, timeout: 30000 }, async t => {
	const { service } = await setup(t);
	const result = await service.click('ide', { selector: '#guest' });
	assert.notEqual(result.success, false, JSON.stringify(result));
	assert.equal(service.activePage.url(), destination);
	assert.equal(await service.activePage.title(), 'Meeting fixture');
	assert.equal((await service.click('ide', { text: 'Join meeting' })).code, 'DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED');
	await service.open(targetUrl);
	assert.equal((await service.click('ide', { selector: '#blocked' })).code, 'BROWSER_OUT_OF_SCOPE_NAVIGATION');
});

test('Drytis client-side route redirect reaches the identical meeting on the meeting host', { skip: !enabled, timeout: 30000 }, async t => {
	const { service } = await setup(t);
	const result = await service.open(`${targetUrl}?redirect=1`);
	assert.notEqual(result?.success, false, JSON.stringify(result));
	assert.equal(service.activePage.url(), destination);
});

test('Drytis new-tab navigation permits the same meeting and blocks different meetings', { skip: !enabled, timeout: 30000 }, async t => {
	const { service } = await setup(t);
	const result = await service.newTab('ide', { url: destination });
	assert.notEqual(result.success, false, JSON.stringify(result));
	assert.equal(service.activePage.url(), destination);
	assert.equal((await service.newTab('ide', { url: 'https://meeting.drytis.dev/meeting/mtg-another' })).code, 'BROWSER_OUT_OF_SCOPE_NAVIGATION');
});
