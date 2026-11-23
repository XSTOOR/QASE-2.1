/**
 * Device × browser matrix for QA, SQA and Founder.
 *
 * Covers every platform × browser × device type the catalog offers (the newest
 * OS of each), in two layers:
 *
 *   1. Launch: each mode's start route accepts the combination with the right
 *      engine (Safari and every iPhone/iPad browser → WebKit, Firefox → Gecko,
 *      the rest → Chromium), or refuses it before a run exists with a reason
 *      (DuckDuckGo has no automation channel; an engine not installed here).
 *   2. Browser: the shared run browser really is that device: the engine that
 *      launched, its user agent, viewport, pixel ratio and touch points match
 *      the selection, the page lays out at the device width, the agent's
 *      click and tap both reach the page, and live-view frames are captured.
 *
 * Engines not installed on this machine are listed as not run; pass
 * --require-all (CI) to make that a failure.
 *
 *   node scripts/test-device-matrix.mjs [--engines chromium,firefox,webkit] [--require-all] [--output-dir dir]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { request } from 'playwright';
import { generateEnvironments } from '../server/environmentCatalog.js';
import { environmentEmulationOptions } from '../server/browserstackProvider.js';
import { resolveEngine } from '../server/browserEngines.js';
import { createQaBrowser, primaryProfile } from '../server/qa/browser.js';
import { engineForEnvironment, checkRuntimeIdentity, RuntimeUnavailableError } from '../server/runRuntime.js';
import { createSqaTestServer } from './sqa-test-runtime.mjs';

const { values } = parseArgs({ options: {
	engines: { type: 'string', default: 'chromium,firefox,webkit' },
	'require-all': { type: 'boolean', default: false },
	'output-dir': { type: 'string' }
} });
const wanted = new Set(values.engines.split(',').map(item => item.trim()).filter(Boolean));
const output = path.resolve(values['output-dir'] ?? 'test-results/device-matrix');
await fs.mkdir(output, { recursive: true });

// One environment per platform × browser × device type: the newest OS.
const byKey = new Map();
for (const env of generateEnvironments()) {
	if (!env.active) continue;
	const key = `${env.platform}|${env.browserCode}|${env.deviceType}`;
	const current = byKey.get(key);
	if (!current || Number.parseFloat(env.osVersion) >= Number.parseFloat(current.osVersion)) byKey.set(key, env);
}
const combos = [...byKey.values()];
const installed = {};
for (const id of ['chromium', 'firefox', 'webkit']) installed[id] = (await resolveEngine(id)).available;

// A probe page: responsive layout, a button that counts clicks and touch taps.
const probe = http.createServer((req, res) => {
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Device probe</title>
<style>body{margin:0;font:16px sans-serif}main{max-width:100%;padding:12px;box-sizing:border-box}.wide{display:none}@media (min-width:1024px){.wide{display:block}}button{width:100%;padding:14px}</style></head>
<body><main><h1>Device probe</h1><p class="wide">Desktop layout</p><button id="act">Act</button><p id="out">0</p></main>
<script>let clicks=0,touches=0;const b=document.getElementById('act');b.addEventListener('click',()=>{clicks++;out()});b.addEventListener('touchstart',()=>{touches++;out()},{passive:true});function out(){document.getElementById('out').textContent=clicks+':'+touches}</script></body></html>`);
});
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${probe.address().port}/`;
const env = { ...process.env, QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', QASE_AGENT_CURSOR: 'false' };

const results = [];
const failures = [];
const fail = (combo, layer, message) => { failures.push(`${label(combo)} [${layer}]: ${message}`); };
const label = combo => `${combo.platform} ${combo.deviceType} · ${combo.device} · ${combo.browser}`;

// ── Layer 1: each mode's start route ───────────────────────────────────
const runtime = await createSqaTestServer(path.join(output, `runtime-${Date.now()}`), { env: { QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' } });
let api;
try {
	await runtime.start();
	api = await request.newContext({ baseURL: runtime.base });
	assert.equal((await api.post('/api/auth/register', { data: { email: `matrix-${randomUUID()}@example.test`, displayName: 'Matrix', password: `Matrix fixture ${randomUUID()}` } })).status(), 201);
	const csrf = decodeURIComponent((await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf').value);
	const headers = { Origin: runtime.base, 'X-CSRF-Token': csrf };
	const routes = {
		QA: { path: '/api/sessions', body: env => ({ environmentId: env.envId, selectedTests: undefined }) },
		SQA: { path: '/api/sqa/sessions', body: env => ({ environmentId: env.envId, authorizationConfirmed: true }) },
		Founder: { path: '/api/founder/sessions', body: env => ({ environmentId: env.envId, authorizationConfirmed: true, targetUrl: target }) }
	};
	// The browser picker shows each combination as runnable only when it is.
	const picker = await (await api.get('/api/qa-configurations?index=1&limit=1')).json();
	const pickerRows = new Map((picker.index ?? []).map(row => [row.envId, row]));
	for (const combo of combos) {
		const row = pickerRows.get(combo.envId);
		const expected = engineForEnvironment(combo);
		if (!row) { fail(combo, 'picker', 'missing from the browser picker'); continue; }
		if (row.executionEngine !== expected && combo.browserCode !== 'duckduckgo') fail(combo, 'picker', `picker engine ${row.executionEngine}, run engine ${expected}`);
		const runnable = combo.browserCode !== 'duckduckgo' && installed[expected];
		if (runnable !== (row.availability === 'AVAILABLE')) fail(combo, 'picker', `shown ${row.availability} (${row.availabilityReason ?? ''}) but ${runnable ? 'runnable' : 'not runnable'} here`);
	}
	for (const combo of combos) {
		const expected = engineForEnvironment(combo);
		const unrunnable = combo.browserCode === 'duckduckgo';
		for (const [mode, route] of Object.entries(routes)) {
			const response = await api.post(route.path, { headers, data: route.body(combo) });
			const body = await response.json().catch(() => ({}));
			const row = { layer: 'launch', mode, combo: label(combo), envId: combo.envId, status: response.status(), engine: body.engine ?? null, expected };
			results.push(row);
			if (unrunnable || !installed[expected]) {
				if (response.status() !== 422) fail(combo, `launch ${mode}`, `expected a refusal (422) before the run exists, got ${response.status()}`);
				else if (!/cannot start/i.test(body.error ?? '')) fail(combo, `launch ${mode}`, `refusal has no reason: ${body.error}`);
				row.refused = body.error;
			} else if (response.status() !== 201) fail(combo, `launch ${mode}`, `expected 201, got ${response.status()} ${body.error ?? ''}`);
			else if (body.engine !== expected) fail(combo, `launch ${mode}`, `run engine ${body.engine}, expected ${expected}`);
			if (body.id) await api.delete(`/api/sessions/${body.id}`, { headers });
		}
	}
} finally {
	await api?.dispose();
	await runtime.stop();
}

// ── Layer 2: the run browser is the selected device ────────────────────
const notRun = new Set();
for (const combo of combos) {
	const expected = engineForEnvironment(combo);
	const session = { id: randomUUID(), targetUrl: target, environmentSnapshot: combo, engine: expected };
	if (combo.browserCode === 'duckduckgo') {
		const refused = await createQaBrowser({ session, env }).then(b => b.close().then(() => false), error => error instanceof RuntimeUnavailableError || error.code === 'RUNTIME_UNAVAILABLE');
		if (!refused) fail(combo, 'browser', 'an unrunnable browser was launched instead of refused');
		results.push({ layer: 'browser', combo: label(combo), refused: true });
		continue;
	}
	if (!wanted.has(expected) || !installed[expected]) { notRun.add(expected); results.push({ layer: 'browser', combo: label(combo), engine: expected, notRun: true }); continue; }
	const emulation = environmentEmulationOptions(combo);
	const profile = primaryProfile(session);
	let browser;
	const row = { layer: 'browser', combo: label(combo), envId: combo.envId, engine: expected };
	try {
		browser = await createQaBrowser({ session, env });
		const facts = await browser.observeRuntime(profile);
		row.userAgent = facts.userAgent;
		if (facts.launchedEngineId !== expected) fail(combo, 'browser', `launched ${facts.launchedEngineId}, expected ${expected}`);
		const identity = checkRuntimeIdentity(combo, facts);
		if (!identity.ok) fail(combo, 'browser', identity.note);
		if (facts.viewport?.width !== emulation.viewport.width) fail(combo, 'browser', `viewport width ${facts.viewport?.width}, expected ${emulation.viewport.width}`);
		if (Math.abs((facts.devicePixelRatio ?? 0) - (emulation.deviceScaleFactor ?? 1)) > 0.01) fail(combo, 'browser', `pixel ratio ${facts.devicePixelRatio}, expected ${emulation.deviceScaleFactor ?? 1}`);
		if (Boolean(emulation.hasTouch) !== (facts.maxTouchPoints > 0)) fail(combo, 'browser', `touch points ${facts.maxTouchPoints}, touch expected ${Boolean(emulation.hasTouch)}`);

		const { page, log } = await browser.openPage(profile);
		await browser.goto(page, target, log, { quietMs: 200 });
		const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1, desktop: getComputedStyle(document.querySelector('.wide')).display !== 'none' }));
		if (layout.width !== emulation.viewport.width) fail(combo, 'browser', `page laid out at ${layout.width}px, device is ${emulation.viewport.width}px`);
		if (layout.overflow) fail(combo, 'browser', 'horizontal overflow on a page that fits');
		if (layout.desktop !== (emulation.viewport.width >= 1024)) fail(combo, 'browser', `responsive layout ${layout.desktop ? 'desktop' : 'mobile'} at ${emulation.viewport.width}px`);
		// The agent presses controls through browser.activate: a tap on touch screens.
		await browser.interact(() => browser.activate(page.locator('#act'), { timeout: 5000 }));
		const [clicks, touches] = (await page.locator('#out').innerText()).split(':').map(Number);
		if (clicks < 1) fail(combo, 'browser', 'the agent press did not reach the page as a click');
		if (emulation.hasTouch && touches < 1) fail(combo, 'browser', 'the agent pressed with a mouse on a touch device (no touch event)');
		if (!emulation.hasTouch && touches > 0) fail(combo, 'browser', 'touch events on a device without a touch screen');
		const shot = await page.screenshot({ type: 'jpeg', quality: 50 });
		if (shot.length < 1000) fail(combo, 'browser', 'live-view frame is empty');
		if (log.pageErrors.length) fail(combo, 'browser', `page errors: ${log.pageErrors.map(item => item.message).join('; ')}`);
		row.layout = layout; row.clicks = clicks; row.touches = touches;
	} catch (error) {
		fail(combo, 'browser', `crashed: ${String(error?.message ?? error).split('\n')[0]}`);
	} finally {
		await browser?.close().catch(() => {});
	}
	results.push(row);
}
probe.close();

const missing = [...notRun].filter(id => wanted.has(id));
const summary = {
	ok: failures.length === 0 && (!values['require-all'] || missing.length === 0),
	combinations: combos.length,
	launchChecks: results.filter(row => row.layer === 'launch').length,
	browserChecked: results.filter(row => row.layer === 'browser' && !row.notRun && !row.refused).length,
	refused: combos.filter(combo => combo.browserCode === 'duckduckgo').map(label),
	notRunHere: missing.length ? { engines: missing, combinations: results.filter(row => row.notRun).length } : null,
	failures
};
await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
