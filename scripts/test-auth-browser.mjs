import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-auth-browser-'));
const base = 'http://127.0.0.1:5189';
const server = spawn(process.execPath, [path.join(repo, 'server/index.js')], {
	cwd: directory, windowsHide: true,
	env: { ...process.env, PORT: '5189', QASE_HOST: '127.0.0.1', NODE_ENV: 'test', QASE_RUN_STORE: 'local', QASE_EXECUTION_MODE: 'local', QASE_AUTH_REQUIRED: 'true' },
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => output += chunk);
server.stderr.on('data', chunk => output += chunk);
let browser;
try {
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		if (server.exitCode !== null) throw new Error(output);
		try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	assert.ok(ready, 'fixture server starts');
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(base);
	await page.locator('#auth-gate').waitFor({ state: 'visible' });
	assert.equal(await page.locator('.auth-drytis').textContent(), 'CREATED FOR DRYTIS');
	assert.equal(await page.locator('.app').evaluate(node => node.inert), true);
	await fs.mkdir(path.join(repo, 'artifacts/auth'), { recursive: true });
	await page.screenshot({ path: path.join(repo, 'artifacts/auth/desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	await page.screenshot({ path: path.join(repo, 'artifacts/auth/mobile.png'), fullPage: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#auth-switch').click();
	await page.locator('#auth-email').fill('alice@example.com');
	await page.locator('#auth-password').fill('a strong original password');
	await page.locator('#auth-display').fill('Alice');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });
	await page.locator('#composer-input').waitFor({ state: 'visible' });
	await page.waitForFunction(() => document.querySelectorAll('#run-list [data-id]').length > 0 || document.querySelector('#chat-title').textContent !== '');
	const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
		const csrf = document.cookie.match(/(?:^|; )qase_csrf=([^;]+)/)?.[1];
		const response = await fetch('/api' + url, { method, headers: { 'Content-Type':'application/json', 'X-CSRF-Token':decodeURIComponent(csrf ?? '') }, body: body ? JSON.stringify(body) : undefined });
		return { status:response.status, body:response.status === 204 ? null : await response.json() };
	}, { url, method, body });
	assert.equal((await api('/config', 'PUT', { provider:'custom', baseUrl:'https://example.com', model:'alice-model', apiKey:'alice-secret-key' })).status, 200);
	await page.locator('#qa-close').click();
	assert.equal((await api('/sessions', 'POST', {})).status, 201);
	await page.locator('#open-profile').click();
	await page.locator('#profile-name').fill('Alice QA');
	await page.locator('#profile-timezone').fill('Asia/Kolkata');
	await page.locator('#profile-form button').click();
	await page.waitForFunction(() => document.querySelector('#profile-message').textContent === 'Profile saved.');
	await page.locator('#memory-key').fill('test-preference');
	await page.locator('#memory-value').fill('Prioritize keyboard navigation');
	await page.locator('#memory-form button').click();
	await page.waitForFunction(() => document.querySelector('#profile-memory').textContent.includes('Prioritize keyboard'));
	const aliceRuns = (await api('/sessions')).body;
	assert.ok(aliceRuns.length);
	const bob = await browser.newContext();
	const registration = await bob.request.post(base + '/api/auth/register', { data: { email:'bob@example.com',password:'bob strong original password',displayName:'Bob' } });
	assert.equal(registration.status(), 201);
	assert.deepEqual(await (await bob.request.get(base + '/api/sessions')).json(), []);
	assert.deepEqual(await (await bob.request.get(base + '/api/memory')).json(), []);
	assert.equal((await bob.request.get(base + '/api/sessions/' + aliceRuns[0].id)).status(), 404);
	assert.equal((await (await bob.request.get(base + '/api/config')).json()).hasApiKey, false);
	assert.equal((await bob.request.put(base + '/api/profile', { data: { displayName:'forged' } })).status(), 403);
	await page.locator('#current-password').fill('a strong original password');
	await page.locator('#new-password').fill('a strong replacement password');
	await page.locator('#password-form button').click();
	await page.locator('#auth-gate').waitFor({ state:'visible' });
	assert.equal((await context.request.get(base + '/api/profile')).status(), 401);
	await page.locator('#auth-email').fill('alice@example.com');
	await page.locator('#auth-password').fill('a strong replacement password');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state:'hidden' });
	if (await page.locator('#qa-start').isVisible()) await page.locator('#qa-close').click();
	await page.locator('#sign-out').click();
	await page.locator('#auth-gate').waitFor({ state:'visible' });
	assert.equal(await page.locator('.app').evaluate(node => node.inert), true);
	assert.equal((await context.request.get(base + '/api/sessions')).status(), 401);
	assert.deepEqual(errors, []);
	console.log('PASS: desktop/mobile entry, registration, profile, memory, encrypted settings, two-user isolation, CSRF, password rotation, login and logout.');
} finally {
	await browser?.close();
	server.kill();
	await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
	await fs.rm(directory, { recursive:true, force:true });
}
