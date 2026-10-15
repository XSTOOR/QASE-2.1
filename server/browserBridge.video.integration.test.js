/**
 * RT5 (#14757) · Session video evidence integration test.
 *
 * A real Chromium session with the RT5 recordVideo context option produces a
 * webm artifact at context close; the video sink receives real bytes stamped
 * with the session's execution metadata. Firefox/WebKit recordVideo behavior
 * is engine-dependent — when unsupported the bridge records honestly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const browserTests = process.env.QASE_RUN_BROWSER_TESTS === '1';

async function loadAutomation() {
	const sdkRoot = require.resolve('@cleanslate/sdk');
	const moduleUrl = new URL('./node/cleanSlateNodeBrowserAutomation.js', pathToFileURL(sdkRoot));
	const { CleanSlateNodeBrowserAutomation } = await import(moduleUrl);
	return { CleanSlateNodeBrowserAutomation };
}

const page = '<!doctype html><h1>Video evidence page</h1><button id="b">Click</button>';

test('session records video and the video sink receives the webm artifact', { skip: !browserTests, timeout: 90000 }, async t => {
	const server = http.createServer((_request, response) => {
		response.setHeader('content-type', 'text/html');
		response.end(page);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const targetUrl = `http://127.0.0.1:${server.address().port}/`;

	const { attachBrowserBridge } = await import('./browserBridge.js');
	const { createBrowserPolicy } = await import('./browserPolicy.js');
	const { CleanSlateNodeBrowserAutomation } = await loadAutomation();
	const service = new CleanSlateNodeBrowserAutomation({ headless: true });
	const session = { id: 'video-session-1', targetUrl, device: 'desktop', messages: [], status: 'running' };
	const policy = createBrowserPolicy({
		getTargetUrl: () => targetUrl,
		environment: { NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' }
	});
	const bridge = await attachBrowserBridge(session, service, { publish() {}, async commit() {} }, { policy });
	t.after(async () => { bridge.dispose(); await service.dispose().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

	const saved = [];
	bridge.setVideoSink(async (bytes, meta) => {
		saved.push({ bytes, meta });
		return { artifactId: 'ART-VIDEO1', bytes: bytes.length };
	});

	await service.open(targetUrl);
	await service.activePage.click('#b').catch(() => {});
	bridge.stopFrames();

	// Suspend closes the context → the video finalizes → the sink receives it.
	await bridge.suspend();

	assert.equal(bridge.getVideoRecordingState(), 'SAVED', 'video must be recorded, finalized and handed to the sink');
	assert.equal(saved.length, 1, 'exactly one video artifact for the session');
	const { bytes, meta } = saved[0];
	assert.ok(bytes.length > 0, 'video bytes must be non-empty');
	assert.ok(meta.fileName.endsWith('.webm'), 'artifact is the webm Playwright produced');
	// The webm magic bytes prove it is a real media file, not fabricated.
	assert.equal(bytes.subarray(0, 4).toString(), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString(), 'EBML header present');
});
