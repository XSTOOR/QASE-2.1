/**
 * Optional test-account sign-in. Credentials are supplied when the run is
 * created, stored in the per-run vault and resolved only here, at the
 * keyboard. The sign-in submit is the single write the engine permits; the
 * signed-in browser state is then reused for every later page.
 */
import { resolveSecrets } from '../secrets.js';

const LOGIN_HINT = /log ?in|sign ?in|account|auth/i;

async function findLoginPage(browser, profile, candidates) {
	for (const url of candidates) {
		const { page, log } = await browser.openPage(profile);
		try {
			await browser.goto(page, url, log, { timeoutMs: 20000 });
			if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) return { page, log, url };
			// A "Sign in" link on the page leads to the form.
			const link = page.locator('a, button').filter({ hasText: LOGIN_HINT }).first();
			if (await link.count()) {
				await link.click({ timeout: 4000 }).catch(() => {});
				await browser.settle(page, { quietMs: 1500 });
				if (await page.locator('input[type=password]').first().isVisible().catch(() => false)) return { page, log, url: page.url() };
			}
		} catch { /* try the next candidate */ }
		await page.close().catch(() => {});
	}
	return undefined;
}

/** Returns { ok, url, reason }. Never throws for an ordinary sign-in failure. */
export async function signIn({ browser, profile, session, candidates }) {
	const username = resolveSecrets(session.id, '{{QA_USERNAME}}');
	const password = resolveSecrets(session.id, '{{QA_PASSWORD}}');
	if (!username || !password || username.includes('{{') || password.includes('{{')) return { ok: false, reason: 'The test-account credentials were not available in this run\'s vault.' };
	const found = await findLoginPage(browser, profile, [...new Set([session.qaAuth?.loginUrl, ...candidates].filter(Boolean))]);
	if (!found) return { ok: false, reason: 'No sign-in form was found on the target or its common sign-in routes.' };
	const { page, url } = found;
	try {
		const passwordField = page.locator('input[type=password]').first();
		const form = passwordField.locator('xpath=ancestor::form[1]');
		const scope = await form.count() ? form : page;
		const userField = scope.locator('input[type=email], input[autocomplete=username], input[name*=user i], input[name*=email i], input[name*=login i], input[type=text]').first();
		if (await userField.count()) await userField.fill(username, { timeout: 4000 });
		await passwordField.fill(password, { timeout: 4000 });
		await browser.permitWritesFor(10000, async () => {
			const submit = scope.locator('button[type=submit], input[type=submit], button:not([type])').first();
			if (await submit.count()) await submit.click({ timeout: 4000 });
			else await passwordField.press('Enter');
			await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
			await browser.settle(page, { quietMs: 2000 });
		});
		const stillOnForm = await page.locator('input[type=password]').first().isVisible().catch(() => false);
		const expected = session.qaAuth?.expectedUrl;
		const reachedExpected = expected ? page.url().startsWith(expected) : undefined;
		if (stillOnForm || reachedExpected === false) {
			return { ok: false, url, reason: `Sign-in did not complete: ${stillOnForm ? 'the sign-in form is still shown (credentials rejected or extra verification such as MFA/CAPTCHA required)' : `the browser did not reach ${expected}`}.` };
		}
		await browser.useSignedInState(await page.context().storageState());
		return { ok: true, url: page.url() };
	} catch (error) {
		return { ok: false, url, reason: `Sign-in failed: ${String(error.message).split('\n')[0].slice(0, 160)}` };
	} finally {
		await page.close().catch(() => {});
	}
}
