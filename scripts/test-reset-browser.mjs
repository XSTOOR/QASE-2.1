import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// End-to-end browser test for the forgot/reset password flow (#15673).
// The fixture server runs with the MOCK mailer: the reset link lands in the
// outbox file (.qase/outbox.json inside the fixture cwd), which the test
// reads directly — the link is never surfaced in the UI.
const repo = fileURLToPath(new URL('../', import.meta.url));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-reset-browser-'));
const base = 'http://127.0.0.1:5191';
const server = spawn(process.execPath, [path.join(repo, 'server/index.js')], {
	cwd: directory, windowsHide: true,
	env: {
		...process.env, PORT: '5191', QASE_HOST: '127.0.0.1', NODE_ENV: 'test',
		QASE_RUN_STORE: 'local', QASE_EXECUTION_MODE: 'local', QASE_AUTH_REQUIRED: 'true',
		QASE_MAIL_MODE: 'mock', QASE_PUBLIC_URL: base
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', chunk => output += chunk);
server.stderr.on('data', chunk => output += chunk);

async function readOutboxLink() {
	const outbox = JSON.parse(await fs.readFile(path.join(directory, '.qase/outbox.json'), 'utf8'));
	const last = outbox.at(-1);
	const match = last?.text?.match(/https?:\/\/\S+token=([A-Za-z0-9_-]+)/);
	assert.ok(match, 'reset link found in mock outbox');
	return { link: match[0].replace(/token=.*/, 'token=' + match[1]), token: match[1] };
}

let browser;
try {
	let ready = false;
	for (let attempt = 0; attempt < 60; attempt++) {
		if (server.exitCode !== null) throw new Error(output);
		try { if ((await fetch(`${base}/healthz`)).ok) { ready = true; break; } } catch {}
		await new Promise(resolve => setTimeout(resolve, 200));
	}
	assert.ok(ready, 'fixture server starts');

	// Seed a known account through the real API.
	const register = await fetch(`${base}/api/auth/register`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: 'resetflow@example.com', password: 'a strong original password' })
	});
	assert.equal(register.status, 201);

	browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const page = await context.newPage();
	const errors = [];
	page.on('pageerror', error => errors.push(error.message));

	await page.goto(base);
	await page.locator('#auth-gate').waitFor({ state: 'visible' });

	// "Forgot password?" is visible in login mode and hidden in register mode.
	const forgotSwitch = page.locator('#auth-forgot-switch');
	assert.ok(await forgotSwitch.isVisible(), 'forgot link visible in login mode');
	await page.locator('#auth-switch').click();
	assert.ok(await forgotSwitch.isHidden(), 'forgot link hidden in register mode');
	await page.locator('#auth-switch').click();

	// Unknown email → identical neutral message.
	await forgotSwitch.click();
	assert.ok(await page.locator('#forgot-panel').isVisible());
	await page.locator('#forgot-email').fill('nobody@example.com');
	await page.locator('#forgot-submit').click();
	await page.locator('#forgot-notice').waitFor({ state: 'visible' });
	const unknownNotice = await page.locator('#forgot-notice').textContent();

	// Known email → same neutral message, link delivered to the outbox.
	await page.locator('#forgot-email').fill('resetflow@example.com');
	await page.locator('#forgot-submit').click();
	await page.waitForFunction(() => document.querySelectorAll('#forgot-notice:not([hidden])').length > 0 && document.querySelector('#forgot-notice').textContent.length > 0);
	// Wait for the second outbox entry.
	await page.waitForTimeout(300);
	const knownNotice = await page.locator('#forgot-notice').textContent();
	assert.equal(unknownNotice.trim(), knownNotice.trim(), 'identical neutral message for unknown and known email');

	const { token } = await readOutboxLink();

	// Open the reset route directly (as the emailed link would). A full
	// navigation exercises the boot-time route; the hashchange listener
	// covers links opened into an already-loaded tab.
	await page.goto(`${base}/#reset-password?token=${token}`);
	await page.reload();
	await page.locator('#reset-panel').waitFor({ state: 'visible' });

	// 7-char password blocked by native validation.
	await page.locator('#reset-password').fill('seven7c');
	await page.locator('#reset-confirm').fill('seven7c');
	assert.equal(await page.locator('#reset-password').evaluate(node => node.checkValidity()), false, '7-char reset password rejected');

	// Mismatched confirm blocked inline before submit.
	await page.locator('#reset-password').fill('eight8ch');
	await page.locator('#reset-confirm').fill('different8');
	await page.locator('#reset-submit').click();
	assert.ok(await page.locator('#reset-error').isVisible(), 'mismatched confirm blocked inline');
	assert.match(await page.locator('#reset-error').textContent(), /do not match/i);

	// Matching 8-char passwords succeed.
	await page.locator('#reset-confirm').fill('eight8ch');
	await page.locator('#reset-submit').click();
	await page.locator('#reset-notice').waitFor({ state: 'visible' });
	assert.match(await page.locator('#reset-notice').textContent(), /Password updated/i);

	// Old password dead, new password works.
	await page.locator('#reset-back').click();
	await page.locator('#auth-email').fill('resetflow@example.com');
	await page.locator('#auth-password').fill('a strong original password');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-error').waitFor({ state: 'visible' });
	await page.locator('#auth-password').fill('eight8ch');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });

	// Token reuse fails with the generic error.
	const reuse = await fetch(`${base}/api/auth/reset-password`, {
		method: 'POST', headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ token, password: 'another8pw' })
	});
	assert.equal(reuse.status, 400);
	assert.match((await reuse.json()).error, /invalid or has expired/i);

	assert.deepEqual(errors, []);
	console.log('PASS: forgot/reset password browser flow — neutral responses, outbox link, 8-char minimum, mismatch block, old-password revocation, single-use token.');
} finally {
	await browser?.close();
	server.kill();
	await new Promise(resolve => server.exitCode !== null ? resolve() : server.once('exit', resolve));
	await fs.rm(directory, { recursive: true, force: true });
}
