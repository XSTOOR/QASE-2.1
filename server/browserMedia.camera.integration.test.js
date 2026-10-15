/**
 * RT4 (#14756) · Live camera / screen-share / call-controls integration.
 * Runs ONLY with QASE_RUN_BROWSER_TESTS=1 — real Chromium launches with
 * synthetic media devices (a real browser capability, never a mock).
 *
 * Honesty contract under test:
 *   - camera GRANTED path: real capture, real frame pixels read back.
 *   - camera DENIED path: NotAllowedError recorded as DENIED, not failed.
 *   - recovery: deny → grant → capture succeeds (track state transitions).
 *   - call controls: app-owned stream mute/camera-off toggles observed.
 *   - screen share: virtual-desktop track with real frame.
 *   - defect fixture: deny→grant flow leaves join disabled (reproduces).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { attachBrowserBridge } from './browserBridge.js';
import { createBrowserPolicy } from './browserPolicy.js';
import { getDefectFixture } from './defectFixtures.js';

const require = createRequire(import.meta.url);

const browserTests = process.env.QASE_RUN_BROWSER_TESTS === '1';

// RT4: load the SDK the same way multiEngine.integration.test.js does —
// createRequire + pathToFileURL. (import.meta.resolve of the package name is
// unreliable inside node --test child processes for this file.)
async function loadAutomation() {
	const sdkRoot = require.resolve('@cleanslate/sdk');
	const moduleUrl = new URL('./node/cleanSlateNodeBrowserAutomation.js', pathToFileURL(sdkRoot));
	const { CleanSlateNodeBrowserAutomation } = await import(moduleUrl);
	return { CleanSlateNodeBrowserAutomation };
}

const fixture = `<!doctype html><html><head><title>Camera fixture</title></head><body>
<button id="request">Enable camera</button><button id="mute">Mute mic</button><button id="cam-off">Camera off</button>
<p id="status">Ready</p><video id="preview" autoplay muted playsinline></video>
<script>
const status = document.querySelector('#status');
window.stream = null;
document.querySelector('#request').onclick = async () => {
 try { window.stream = await navigator.mediaDevices.getUserMedia({video:true,audio:true});
   document.querySelector('#preview').srcObject = window.stream; status.textContent='Active'; }
 catch(error) { status.textContent = error.name; }
};
document.querySelector('#mute').onclick = () => { window.stream?.getAudioTracks().forEach(t=>t.enabled=!t.enabled); status.textContent='Mute toggled'; };
document.querySelector('#cam-off').onclick = () => { window.stream?.getVideoTracks().forEach(t=>t.enabled=!t.enabled); status.textContent='Camera toggled'; };
</script></body></html>`;

async function setup(t, html = fixture) {
	const server = createServer((_request, response) => {
		response.setHeader('content-type', 'text/html');
		response.end(html);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const targetUrl = `http://127.0.0.1:${server.address().port}/`;
	const { CleanSlateNodeBrowserAutomation } = await loadAutomation();
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const session = { id: 'camera-fixture', targetUrl, device: 'desktop', messages: [], status: 'running' };
	const policy = createBrowserPolicy({
		getTargetUrl: () => targetUrl,
		environment: {
			NODE_ENV: 'test',
			QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: process.env.QASE_BROWSER_ALLOWED_PRIVATE_HOSTS ?? '127.0.0.1'
		}
	});
	const bridge = await attachBrowserBridge(session, service, { publish() {}, async commit() {} }, { policy });
	t.after(async () => { bridge.dispose(); await service.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
	await service.open(targetUrl);
	bridge.stopFrames();
	return { service, bridge, targetUrl };
}

test('camera: denial is DENIED, grant captures a real frame, recovery works, call controls respond', { skip: !browserTests, timeout: 90000 }, async t => {
	const { service, bridge } = await setup(t);

	// --- denial path: camera permission denied before the probe ---
	await bridge.media({ action: 'set_permission', permission: 'denied', target: 'camera' });
	const deniedProbe = await bridge.media({ action: 'probe_camera', durationMs: 400 });
	assert.equal(deniedProbe.verdict.status, 'DENIED', JSON.stringify(deniedProbe));
	assert.equal(deniedProbe.probe.error, 'NotAllowedError');
	assert.equal(deniedProbe.probe.tracksStopped, true, 'no track may leak after denial');

	// application sees the same denial
	await service.click('ide', { selector: '#request' });
	await service.activePage.waitForFunction(() => document.querySelector('#status').textContent === 'NotAllowedError');
	const deniedInspect = await bridge.media({ action: 'inspect' });
	assert.equal(deniedInspect.observed.requests.at(-1).error, 'NotAllowedError');
	assert.equal(deniedInspect.observed.requests.at(-1).source, 'application');

	// --- recovery: re-grant → both probe and application capture succeed ---
	await bridge.media({ action: 'set_permission', permission: 'granted', target: 'camera' });
	await bridge.media({ action: 'set_permission', permission: 'granted', target: 'microphone' });
	const grantedProbe = await bridge.media({ action: 'probe_camera', durationMs: 1500 });
	assert.equal(grantedProbe.verdict.status, 'GRANTED', JSON.stringify(grantedProbe.probe));
	assert.equal(grantedProbe.probe.videoTracks, 1);
	assert.ok(grantedProbe.probe.frameNonEmpty, 'a real frame must have been read back from the synthetic device');
	assert.ok(grantedProbe.probe.signalDetected, 'frame pixels must be non-empty');
	assert.equal(grantedProbe.probe.tracksStopped, true);

	await service.click('ide', { selector: '#request' });
	await service.activePage.waitForFunction(() => document.querySelector('#status').textContent === 'Active');

	// --- call controls: mute + camera-off toggle REAL track state ---
	const before = await bridge.media({ action: 'call_controls' });
	assert.equal(before.callControls.active, true);
	assert.equal(before.callControls.tracks.length, 2, 'video + audio tracks');
	await service.click('ide', { selector: '#mute' });
	await service.click('ide', { selector: '#cam-off' });
	const after = await bridge.media({ action: 'call_controls' });
	const audio = after.callControls.tracks.find(track => track.kind === 'audio');
	const video = after.callControls.tracks.find(track => track.kind === 'video');
	assert.equal(audio.enabled, false, 'mute must disable the audio track');
	assert.equal(video.enabled, false, 'camera-off must disable the video track');
	assert.equal(after.callControls.tracks.every(track => track.readyState === 'live'), true, 'tracks stay live while disabled');
});

test('screen share: virtual desktop capture returns a real track and frame', { skip: !browserTests, timeout: 60000 }, async t => {
	const { bridge } = await setup(t);
	const result = await bridge.media({ action: 'probe_screen_share', durationMs: 1200 });
	assert.equal(result.verdict.status, 'GRANTED', JSON.stringify(result.probe));
	assert.equal(result.probe.videoTracks, 1);
	assert.ok(result.probe.frameNonEmpty, 'a real frame must be sampled from the virtual desktop');
	assert.equal(result.probe.tracksStopped, true, 'capture must be released');
	assert.match(result.limitations, /Virtual desktop/);
});

test('meeting-media-permission-recovery fixture reproduces via deny→grant under real execution', { skip: !browserTests, timeout: 120000 }, async () => {
	// The fixture reproduces when the page's own deny→grant flow leaves the
	// join button disabled. We drive the flow through a real Chromium with
	// synthetic media devices (a real browser capability, never a mock).
	const { chromium } = await import('playwright');
	const { environmentEmulationOptions } = await import('./browserstackProvider.js');
	const { generateEnvironments } = await import('./environmentCatalog.js');
	const fixture = getDefectFixture('meeting-media-permission-recovery');
	assert.ok(fixture, 'fixture must be registered');

	// A representative desktop environment (chrome).
	const envs = generateEnvironments();
	const desktop = envs.find((e) => e.platform === 'windows' && e.deviceType === 'desktop' && e.browserCode === 'chrome');
	assert.ok(desktop, 'windows/chrome environment exists');

	// Serve the fixture page (captured from the real mount router).
	const captured = [];
	const router = { get(path, handler) { captured.push({ path, handler }); } };
	const { mountDefectFixtures } = await import('./defectFixtures.js');
	mountDefectFixtures(router);
	const fixtureRoute = captured.find((route) => route.path === '/demo/defects/meeting-media-permission-recovery');
	assert.ok(fixtureRoute, 'fixture route must be mounted');
	const server = createServer((request, response) => {
		if (request.url === '/demo/defects/meeting-media-permission-recovery') {
			fixtureRoute.handler(request, response);
		} else {
			response.statusCode = 404;
			response.end('not found');
		}
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const baseUrl = `http://127.0.0.1:${server.address().port}`;

	// Media permissions only behave on a headful browser under this runtime's
	// virtual display (headless Chromium answers getUserMedia with
	// NotSupportedError — same launcher behavior as the production bridge:
	// DISPLAY set → headless=false).
	const display = process.env.QASE_TEST_DISPLAY ?? ':77';
	const browser = await chromium.launch({
		args: ['--use-fake-device-for-media-stream', '--no-sandbox', '--auto-select-desktop-capture-source=Entire screen'],
		headless: false,
		env: { ...process.env, DISPLAY: display }
	});
	try {
		const contextOptions = environmentEmulationOptions(desktop) ?? {};
		const context = await browser.newContext({
			viewport: contextOptions.viewport ?? undefined
		});
		const page = await context.newPage();
		await page.goto(`${baseUrl}/demo/defects/meeting-media-permission-recovery`, { waitUntil: 'load' });

		// Drive the KNOWN defect flow: deny first, then grant and retry.
		// Real CDP permission mechanics (the same path the production
		// setMediaPermission uses — Playwright's clearPermissions cannot
		// express a DENIED state for media in this runtime).
		const t0 = await context.newCDPSession(page);
		const { targetInfo: { browserContextId } } = await t0.send('Target.getTargetInfo');
		await t0.detach();
		const cdp = await browser.newBrowserCDPSession();
		const setPerm = async (setting) => {
			for (const name of ['camera', 'microphone']) {
				await cdp.send('Browser.setPermission', { origin: baseUrl, permission: { name }, setting, browserContextId });
			}
		};
		await setPerm('denied');
		await page.click('#fixture-request-camera');
		await page.waitForFunction(() => document.querySelector('#fixture-media-ledger').dataset.state.startsWith('denied'));
		await setPerm('granted');
		await page.click('#fixture-request-camera');
		await page.waitForFunction(() => document.querySelector('#fixture-media-ledger').dataset.state === 'denied-then-granted');

		const probe = await page.evaluate(new Function(`return (${fixture.verify})()`));
		assert.equal(probe.evaluated, true);
		assert.equal(probe.reproduced, true, 'defect must reproduce: join disabled after deny→grant');
		assert.deepEqual(probe.evidence, { flow: 'denied-then-granted', joinDisabled: true });
	} finally {
		await browser.close().catch(() => {});
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
});

test('meeting_controls drives the page join/mute/camera/leave with real track evidence', { skip: !browserTests, timeout: 90000 }, async t => {
	// The MEETING fixture page (registers __qaseMeetingControls on load).
	const { renderDefectFixturePage } = await import('./defectFixtures.js');
	const meetingHtml = renderDefectFixturePage('meeting-media-permission-recovery');
	assert.ok(meetingHtml, 'fixture page must render');
	const { service, bridge, targetUrl } = await setup(t, meetingHtml);

	// Grant media so the join flow can succeed, then capture via the page's
	// own request control and join.
	await bridge.media({ action: 'set_permission', permission: 'granted', target: 'camera' });
	await bridge.media({ action: 'set_permission', permission: 'granted', target: 'microphone' });
	await service.activePage.click('#fixture-request-camera');
	await service.activePage.waitForFunction(() => document.querySelector('#fixture-media-ledger').dataset.state === 'granted');

	const result = await bridge.media({ action: 'meeting_controls', joinSelector: '#fixture-join-btn', controls: ['mute', 'unmute', 'cameraOff', 'cameraOn', 'leave'] });
	assert.equal(result.success, true, JSON.stringify(result.meeting?.steps));
	const join = result.meeting.steps.find(step => step.control === 'join');
	assert.equal(join.status, 'OK', 'join must produce an active stream');
	const mute = result.meeting.steps.find(step => step.control === 'mute');
	assert.equal(mute.status, 'OK', JSON.stringify(mute));
	assert.equal(mute.after.audioEnabled, false, 'mute must disable the real audio track');
	const unmute = result.meeting.steps.find(step => step.control === 'unmute');
	assert.equal(unmute.after.audioEnabled, true, 'unmute must re-enable the audio track');
	const cameraOff = result.meeting.steps.find(step => step.control === 'cameraOff');
	assert.equal(cameraOff.after.videoEnabled, false, 'camera off must disable the real video track');
	const cameraOn = result.meeting.steps.find(step => step.control === 'cameraOn');
	assert.equal(cameraOn.after.videoEnabled, true, 'camera on must re-enable the video track');
	const leave = result.meeting.steps.find(step => step.control === 'leave');
	assert.equal(leave.status, 'OK', 'leave must end the stream');
	assert.equal(result.meeting.callState.joined, false, 'call state after leave shows no active stream');
});

test('meeting_recovery reproduces the known recovery defect through the bridge', { skip: !browserTests, timeout: 90000 }, async t => {
	const { renderDefectFixturePage } = await import('./defectFixtures.js');
	const meetingHtml = renderDefectFixturePage('meeting-media-permission-recovery');
	const { service, bridge } = await setup(t, meetingHtml);

	const result = await bridge.media({
		action: 'meeting_recovery',
		requestSelector: '#fixture-request-camera',
		targets: ['camera', 'microphone']
	});
	assert.equal(result.success, true);
	const recovery = result.recovery;
	assert.equal(recovery.deniedObservable, true, 'the denial must be observable (NotAllowedError path)');
	assert.equal(recovery.recovered, true, 'the synthetic stream itself recovers after re-grant');
	const grantStep = recovery.steps.find(step => step.step === 'grant+retry');
	assert.ok(grantStep.pageLedger.startsWith('denied-then-granted'), `ledger: ${grantStep.pageLedger}`);
	// The KNOWN DEFECT: the page's join control stays disabled after recovery.
	const joinDisabled = await service.activePage.evaluate(() => document.querySelector('#fixture-join-btn').disabled);
	assert.equal(joinDisabled, true, 'known defect must still reproduce: join disabled after deny→grant');
});
