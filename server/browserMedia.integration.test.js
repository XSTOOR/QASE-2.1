import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { attachBrowserBridge } from './browserBridge.js';
import { createBrowserPolicy } from './browserPolicy.js';

const browserTests = process.env.QASE_RUN_BROWSER_TESTS === '1';
const fixture = `<!doctype html><html><head><title>Meeting and microphone fixture</title></head><body>
<a id="meeting" href="/meeting">Test meeting</a>
<a id="invalid" href="/invalid">Expired meeting</a>
<a id="popup" href="/meeting" target="_blank">Open popup</a>
<a id="external" href="https://meet.google.com/abc-defg-hij">External meeting</a>
<a id="hidden" href="/meeting" style="visibility:hidden">Hidden meeting</a>
<button id="start">Enable microphone</button><button id="mute">Mute microphone</button>
<button id="stop">Stop microphone</button><button id="join">Join meeting</button>
<p id="status">Ready</p><script>
const status = document.querySelector('#status');
document.querySelector('#start').onclick = async () => {
 try { window.stream = await navigator.mediaDevices.getUserMedia({audio:true}); status.textContent = 'Microphone active'; }
 catch(error) { status.textContent = error.name; }
};
document.querySelector('#mute').onclick = () => { stream.getAudioTracks().forEach(t=>t.enabled=false); status.textContent='Muted'; };
document.querySelector('#stop').onclick = () => { stream.getTracks().forEach(t=>t.stop()); status.textContent='Stopped'; };
document.querySelector('#join').onclick = () => { status.textContent='Joined'; };
</script></body></html>`;

async function setup(t, device = 'desktop') {
	const server = createServer((request, response) => {
		response.setHeader('content-type', 'text/html');
		response.end(request.url === '/meeting' ? '<title>Meeting lobby</title><h1>Ready to join</h1><button>Join meeting</button>' :
			request.url === '/invalid' ? '<title>Expired meeting</title><h1>This meeting link has expired</h1>' : fixture);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const targetUrl = `http://127.0.0.1:${server.address().port}/`;
	const { CleanSlateNodeBrowserAutomation } = await import(new URL('./node/cleanSlateNodeBrowserAutomation.js', import.meta.resolve('@cleanslate/sdk')));
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const session = { id: 'media-fixture', targetUrl, device, messages: [], status: 'running' };
	const events = [];
	const store = { publish(_session, type, payload) { events.push({ type, payload }); }, async commit(_session, type, payload) { events.push({ type, payload }); } };
	const policy = createBrowserPolicy({ getTargetUrl: () => targetUrl, environment: { NODE_ENV: 'test' } });
	const bridge = attachBrowserBridge(session, service, store, { policy });
	t.after(async () => { bridge.dispose(); await service.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	await service.open(targetUrl);
	bridge.stopFrames();
	return { service, bridge, targetUrl, events, session };
}

test('native synthetic microphone exercises denied capture, signal, application mute and track cleanup', { skip: !browserTests, timeout: 45000 }, async t => {
	const { service, bridge, events } = await setup(t);
	const initial = await bridge.media({ action: 'inspect' });
	assert.equal(initial.synthetic, true);
	assert.equal(initial.permission, 'prompt');
	assert.equal((await bridge.media({ action: 'probe' })).code, 'BROWSER_MICROPHONE_PERMISSION_REQUIRED');
	assert.equal((await bridge.media({ action: 'set_permission', permission: 'denied' })).permission, 'denied');
	await service.click('ide', { selector: '#start' });
	await service.activePage.waitForFunction(() => document.querySelector('#status').textContent === 'NotAllowedError');
	const denied = await bridge.media({ action: 'inspect' });
	assert.equal(denied.observed.requests.at(-1).source, 'application');
	assert.equal(denied.observed.requests.at(-1).error, 'NotAllowedError');
	const negativeProbe = await bridge.media({ action: 'probe' });
	assert.equal(negativeProbe.probe.error, 'NotAllowedError');
	assert.equal(negativeProbe.probe.tracksStopped, true);
	assert.equal((await bridge.media({ action: 'set_permission', permission: 'granted' })).permission, 'granted');
	const probe = await bridge.media({ action: 'probe', durationMs: 1600 });
	assert.equal(probe.probe.outcome, 'captured');
	assert.equal(probe.probe.audioTracks, 1);
	assert.equal(probe.probe.signalDetected, true, JSON.stringify(probe.probe));
	assert.equal(probe.probe.tracksStopped, true);
	await service.click('ide', { selector: '#start' });
	await service.activePage.waitForFunction(() => document.querySelector('#status').textContent === 'Microphone active');
	let media = await bridge.media({ action: 'inspect' });
	assert.deepEqual(media.observed.requests.at(-1).tracks[0], { kind: 'audio', enabled: true, muted: false, readyState: 'live' });
	await service.click('ide', { selector: '#mute' });
	media = await bridge.media({ action: 'inspect' });
	assert.equal(media.observed.requests.at(-1).tracks[0].enabled, false);
	await service.click('ide', { selector: '#stop' });
	media = await bridge.media({ action: 'inspect' });
	assert.equal(media.observed.requests.at(-1).tracks[0].readyState, 'ended');
	assert.equal((await bridge.media({ action: 'set_permission', permission: 'prompt' })).permission, 'prompt');
	assert.ok(events.some(event => event.type === 'browser_media'));
});

test('meeting link tools require a visible link, inspect prejoin and expired pages, and clicks adopt popups', { skip: !browserTests, timeout: 45000 }, async t => {
	const { service, bridge, targetUrl, events } = await setup(t);
	assert.equal((await bridge.testMeetingLink({ url: `${targetUrl}invented` })).success, false);
	assert.equal((await bridge.testMeetingLink({ selector: '#hidden' })).success, false);
	const opened = await bridge.testMeetingLink({ selector: '#meeting' });
	assert.equal(opened.success, true, JSON.stringify(opened));
	assert.equal(opened.joined, false);
	assert.equal(opened.title, 'Meeting lobby');
	assert.ok(opened.sourceTabId);
	const blockedJoin = await service.click('ide', { text: 'Join meeting' });
	assert.equal(blockedJoin.code, 'DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED');
	for (const label of ['Join', 'Ask to join']) {
		await service.activePage.locator('button').evaluate((element, text) => { element.textContent = text; }, label);
		assert.equal((await service.click('ide', { text: label })).code, 'DESTRUCTIVE_ACTION_CONFIRMATION_REQUIRED');
	}
	await service.selectTab('ide', opened.sourceTabId);
	const expired = await bridge.testMeetingLink({ selector: '#invalid' });
	assert.equal(expired.success, true);
	assert.match((await service.snapshot('ide')).bodyText, /expired/);
	await service.selectTab('ide', opened.sourceTabId);
	const popup = await service.click('ide', { selector: '#popup' });
	assert.equal(popup.openedTab, true, JSON.stringify(popup));
	assert.equal(popup.title, 'Meeting lobby');
	assert.equal(service.activePage.url(), `${targetUrl}meeting`);
	assert.equal((await service.listTabs('ide')).tabs.filter(tab => tab.active).length, 1);
	assert.ok(events.some(event => event.type === 'browser_meeting'));
});

test('synthetic media and mobile emulation survive browser suspend and restore', { skip: !browserTests, timeout: 45000 }, async t => {
	const { service, bridge } = await setup(t, 'iphone-15-pro');
	assert.equal(service.activePage.viewportSize().width, 393);
	await bridge.media({ action: 'set_permission', permission: 'granted' });
	await bridge.suspend();
	await service.ensurePage();
	assert.equal(service.activePage.viewportSize().width, 393);
	assert.equal(await service.activePage.evaluate(() => /iPhone/.test(navigator.userAgent)), true);
	const restored = await bridge.media({ action: 'inspect' });
	assert.equal(restored.synthetic, true);
	assert.equal(restored.permission, 'prompt');
	assert.equal(restored.observed.captureSupported, true);
});

test('diagnostics distinguish native invalid input from successful submission without leaking values', { skip: !browserTests, timeout: 15000 }, async t => {
	const {service}=await setup(t);
	await service.activePage.setContent('<form><label>Email<input id="email" type="email" required></label><button>Validate</button></form>');
	await service.fill('ide',{selector:'#email',value:'fixture-private-invalid'});
	let diagnostics=await service.getDiagnostics('ide');
	assert.deepEqual(diagnostics.formValidation.fields[0].failures,['typeMismatch']);
	assert.equal(diagnostics.formValidation.fields[0].valid,false);
	assert.ok(!JSON.stringify(diagnostics.formValidation).includes('fixture-private-invalid'));
	await service.fill('ide',{selector:'#email',value:'valid@example.test'});
	diagnostics=await service.getDiagnostics('ide');
	assert.equal(diagnostics.formValidation.fields[0].valid,true);
});
