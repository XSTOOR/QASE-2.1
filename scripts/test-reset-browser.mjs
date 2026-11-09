import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createSqaTestServer } from './sqa-test-runtime.mjs';

// Exercise the recovery-code entry point exposed by the current login form.
// All accounts and codes belong to this isolated, model-free fixture.
const output = fileURLToPath(new URL('../test-results/auth-reset/', import.meta.url));
const runtime = await createSqaTestServer(path.join(output, 'runtime-' + Date.now()), { authRequired: true });
const email = 'resetflow@example.test';
const originalPassword = 'a strong original password';
const errors = [], checks = [];
let browser, page;
try {
	await runtime.start();
	browser = await chromium.launch();
	const account = await browser.newContext();
	assert.equal((await account.request.post(runtime.base + '/api/auth/register', {
		data: { email, password: originalPassword, displayName: 'Reset fixture' }
	})).status(), 201);
	const owner = await account.newPage();
	owner.on('pageerror', error => errors.push(error.message));
	await owner.goto(runtime.base + '/#/account');
	await owner.locator('#profile-dialog').waitFor({ state: 'visible' });
	await owner.locator('#recovery-current-password').fill('incorrect password');
	await owner.locator('#recovery-generate').click();
	await owner.waitForFunction(() => document.querySelector('#profile-message').textContent.includes('incorrect'));
	assert.ok(await owner.locator('#recovery-codes-result').isHidden());
	await owner.locator('#recovery-current-password').fill(originalPassword);
	await owner.locator('#recovery-generate').click();
	await owner.locator('#recovery-codes-result').waitFor({ state: 'visible' });
	const codes = await owner.locator('#recovery-codes-list li').allTextContents();
	assert.equal(codes.length, 10);
	assert.ok(codes.every(code => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)));
	assert.deepEqual(await (await account.request.get(runtime.base + '/api/auth/recovery-codes')).json(), { total: 10, unused: 10 });
	await owner.reload();
	await owner.locator('#profile-dialog').waitFor({ state: 'visible' });
	assert.ok(await owner.locator('#recovery-codes-result').isHidden());
	checks.push('Code generation requires the current password, returns ten codes once, and exposes only counts afterwards.');

	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	page = await context.newPage();
	page.on('pageerror', error => errors.push(error.message));
	await page.goto(runtime.base);
	await page.locator('#auth-gate').waitFor({ state: 'visible' });
	const recover = page.locator('#auth-forgot-switch');
	assert.ok(await recover.isVisible());
	await page.locator('#auth-switch').click();
	assert.ok(await recover.isHidden());
	await page.locator('#auth-switch').click();
	await recover.click();
	await page.locator('#recover-panel').waitFor({ state: 'visible' });
	async function submitCode(accountEmail, code) {
		await page.locator('#recover-email').fill(accountEmail);
		await page.locator('#recover-code').fill(code);
		const received = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/recover' && response.request().method() === 'POST');
		await page.locator('#recover-submit').click();
		return received;
	}
	const invalidCode = '0000-0000-0000';
	const unknown = await submitCode('unknown@example.test', invalidCode);
	assert.equal(unknown.status(), 400);
	await page.locator('#recover-error').waitFor({ state: 'visible' });
	const wrong = await submitCode(email, invalidCode);
	assert.equal(wrong.status(), 400);
	assert.deepEqual(await wrong.json(), await unknown.json());
	checks.push('The login recovery form rejects wrong codes and gives the same response for unknown accounts.');
	const verified = await submitCode(email, codes[0]);
	assert.equal(verified.status(), 200);
	const authorization = (await verified.json()).authorization;
	assert.ok(authorization);
	await page.locator('#reset-panel').waitFor({ state: 'visible' });
	assert.ok(!page.url().includes(authorization));
	const reusedCode = await context.request.post(runtime.base + '/api/auth/recover', { data: { email, code: codes[0] } });
	assert.equal(reusedCode.status(), 400);
	checks.push('A valid recovery code is consumed once; reset authorization never enters the URL.');

	await page.locator('#reset-password').fill('seven7c');
	await page.locator('#reset-confirm').fill('seven7c');
	assert.equal(await page.locator('#reset-password').evaluate(node => node.checkValidity()), false);
	await page.locator('#reset-password').fill('eight8ch');
	await page.locator('#reset-confirm').fill('different8');
	await page.locator('#reset-submit').click();
	await page.locator('#reset-error').waitFor({ state: 'visible' });
	assert.match(await page.locator('#reset-error').textContent(), /do not match/i);
	await page.locator('#reset-confirm').fill('eight8ch');
	const resetResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/reset-password' && response.request().method() === 'POST');
	await page.locator('#reset-submit').click();
	const reset = await resetResponse;
	assert.equal(reset.status(), 200);
	assert.match((await reset.json()).message, /Password updated/i);
	await page.locator('#auth-form').waitFor({ state: 'visible' });
	await page.getByRole('status').filter({ hasText: /Password updated/i }).waitFor({ state: 'visible' });
	assert.equal((await account.request.get(runtime.base + '/api/profile')).status(), 401);
	checks.push('Password length and confirmation are enforced; reset revokes the existing signed-in session and visibly confirms success on sign-in.');
	await page.locator('#auth-email').fill(email);
	await page.locator('#auth-password').fill(originalPassword);
	await page.locator('#auth-submit').click();
	await page.locator('#auth-error').waitFor({ state: 'visible' });
	await page.locator('#auth-password').fill('eight8ch');
	await page.locator('#auth-submit').click();
	await page.locator('#auth-gate').waitFor({ state: 'hidden' });
	const reusedAuthorization = await browser.newContext();
	assert.equal((await reusedAuthorization.request.post(runtime.base + '/api/auth/reset-password', {
		data: { authorization, password: 'another8pw' }
	})).status(), 400);
	checks.push('Old credentials fail, the new password signs in, and reset authorization cannot be reused.');
	assert.deepEqual(errors, []);
	const result = { status: 'passed', checks, modelCalls: 0, mailSent: 0, pageErrors: errors };
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	await page?.screenshot({ path: path.join(output, 'failure.png'), mask: [page.locator('#recover-code'), page.locator('#reset-panel')] }).catch(() => {});
	await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', checks, error: error.message, pageErrors: errors }, null, 2));
	throw error;
} finally {
	await browser?.close();
	await runtime.stop();
}
