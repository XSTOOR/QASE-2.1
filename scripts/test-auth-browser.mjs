import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSqaTestServer } from './sqa-test-runtime.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(repo, 'test-results/auth');
const server = await createSqaTestServer(path.join(output, 'runtime-' + Date.now()), { authRequired: true });
const base = server.base;
let browser, page;
const errors = [];
try {
	await server.start();
	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(base);
	await page.locator('#auth-gate').waitFor({ state: 'visible' });
	await page.getByRole('link', { name: 'QASE home', exact: true }).waitFor();
	assert.equal(await page.locator('.app').evaluate(node => node.inert), true);
	await page.locator('#auth-theme-select').selectOption('dark');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
	await page.reload();
	await page.locator('#auth-gate').waitFor({state:'visible'});
	assert.equal(await page.locator('#auth-theme-select').inputValue(), 'dark');
	await page.locator('#auth-theme-select').selectOption('light');
	assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
	await fs.mkdir(path.join(repo, 'test-results/auth'), { recursive: true });
	await page.screenshot({ path: path.join(repo, 'test-results/auth/desktop.png'), fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
	assert.ok(await page.locator('#auth-theme-select').isVisible());
	await page.locator('#auth-theme-select').selectOption('system');
	await page.screenshot({ path: path.join(repo, 'test-results/auth/mobile.png'), fullPage: true });
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.locator('#auth-switch').click();
	// Signup-side 8-char boundary (ticket #15672): a 7-character password must
	// fail native validation in register mode; an 8-character one must pass.
	await page.locator('#auth-password').fill('seven7c');
	assert.equal(await page.locator('#auth-password').evaluate(node => node.minLength), 8, 'register mode enforces minLength 8');
	assert.equal(await page.locator('#auth-password').evaluate(node => node.checkValidity()), false, '7-char password rejected in register mode');
	await page.locator('#auth-password').fill('eight8ch');
	assert.equal(await page.locator('#auth-password').evaluate(node => node.checkValidity()), true, '8-char password accepted in register mode');
	await page.locator('#auth-email').fill('alice@example.com');
	await page.locator('#auth-password').fill('a strong original password');
	await page.locator('#auth-display').fill('Alice');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });
	await page.locator('#sidebar-open-profile').waitFor({ state: 'visible' });
	const api = (url, method = 'GET', body) => page.evaluate(async ({ url, method, body }) => {
		const csrf = document.cookie.match(/(?:^|; )qase_csrf=([^;]+)/)?.[1];
		const response = await fetch('/api' + url, { method, headers: { 'Content-Type':'application/json', 'X-CSRF-Token':decodeURIComponent(csrf ?? '') }, body: body ? JSON.stringify(body) : undefined });
		return { status:response.status, body:response.status === 204 ? null : await response.json() };
	}, { url, method, body });
	assert.equal((await api('/config', 'PUT', { provider:'custom', baseUrl:'https://example.com', model:'alice-model', apiKey:'alice-secret-key' })).status, 200);
	// A fresh workspace no longer ambushes with the blocking QA modal — the
	// welcome toast points at the composer instead (bootWorkspace change).
	// Close it only if a previous step happened to open it.
	if (await page.locator('#qa-start').isVisible()) await page.locator('#qa-close').click();
	assert.equal((await api('/sessions', 'POST', {})).status, 201);
	await page.locator('#sidebar-open-profile').click();
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
	// Change-password form enforces the same 8-char minimum.
	await page.locator('#new-password').fill('seven7c');
	assert.equal(await page.locator('#new-password').evaluate(node => node.checkValidity()), false, '7-char new password rejected');
	await page.locator('#new-password').fill('a strong replacement password');
	await page.locator('#password-form button').click();
	await page.locator('#auth-gate').waitFor({ state:'visible' });
	assert.equal((await context.request.get(base + '/api/profile')).status(), 401);
	await page.locator('#auth-email').fill('alice@example.com');
	await page.locator('#auth-password').fill('a strong replacement password');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state:'hidden' });
	// Password rotation reloads the account URL. Wait for that route to be
	// restored after sign-in, then leave it through the same control users use.
	const accountPage = page.locator('#profile-dialog');
	await page.waitForURL('**/#/account');
	await accountPage.waitFor({ state: 'visible' });
	await accountPage.getByRole('button', { name: 'Back to tests' }).click();
	await accountPage.waitFor({ state: 'hidden' });
	await page.locator('#sidebar-sign-out').click();
	await page.locator('#auth-gate').waitFor({ state:'visible' });
	assert.equal(await page.locator('.app').evaluate(node => node.inert), true);
	assert.equal((await context.request.get(base + '/api/sessions')).status(), 401);
	assert.deepEqual(errors, []);
	const result = { status: 'passed', checks: ['desktop/mobile entry and theme persistence', 'registration and password validation', 'profile and memory', 'per-account settings and run isolation', 'CSRF protection', 'password rotation, login and logout'], modelCalls: 0, pageErrors: errors };
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	await page?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', error: error.message, pageErrors: errors }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await server.stop();
}
