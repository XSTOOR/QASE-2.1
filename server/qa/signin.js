/**
 * Optional test-account sign-in. Credentials are supplied when the run is
 * created, stored in the per-run vault and resolved only here, at the
 * keyboard. The sign-in submit is the single write the engine permits; the
 * signed-in browser state is then reused for every later page.
 */
import { resolveSecrets } from '../secrets.js';

const LOGIN_HINT = /log ?in|sign ?in|account|auth/i;
const SUBMIT_HINT = /^\s*(log ?in|sign ?in|continue|next|submit|enter)\b/i;
const USER_FIELD = ['input[type=email]', 'input[autocomplete=username]', 'input[name*=user i]', 'input[name*=email i]', 'input[name*=login i]', 'input[type=text]'].map(selector => `${selector}:visible`).join(', ');

/**
 * True when the page shows a sign-in form: a visible password field inside a
 * form with a submit control, or next to a "Sign in"/"Log in" button. A lone
 * password field (a settings page, a demo widget) is not a sign-in wall.
 */
export async function hasLoginForm(page) {
	return page.evaluate(hint => {
		const hintRe = new RegExp(hint, 'i');
		const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
		for (const field of document.querySelectorAll('input[type=password]')) {
			if (!visible(field)) continue;
			const form = field.closest('form');
			if (form && form.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')) return true;
			if ([...document.querySelectorAll('button, [role=button], input[type=submit]')].some(button => visible(button) && hintRe.test(button.innerText || button.value || button.getAttribute('aria-label') || ''))) return true;
		}
		return false;
	}, SUBMIT_HINT.source).catch(() => false);
}

/**
 * What the page tells us about authentication, without submitting anything:
 * a password form, an identifier-first step (email, then "Continue"), sign-in
 * links, sign-out controls, single-sign-on buttons and human-only challenges.
 */
export async function detectAuth(page) {
	return page.evaluate(({ hint, submit }) => {
		const hintRe = new RegExp(hint, 'i');
		const submitRe = new RegExp(submit, 'i');
		const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
		const label = element => (element.innerText || element.value || element.getAttribute('aria-label') || '').trim();
		const password = [...document.querySelectorAll('input[type=password]')].some(visible);
		const identifierStep = !password && [...document.querySelectorAll('form')].some(form => {
			const id = [...form.querySelectorAll('input[type=email], input[autocomplete=username], input[name*=email i], input[name*=user i], input[name*=login i]')].find(visible);
			const button = [...form.querySelectorAll('button, input[type=submit]')].find(item => visible(item) && submitRe.test(label(item)));
			return Boolean(id && button && form.querySelectorAll('input:not([type=hidden])').length <= 3);
		});
		const anchors = [...document.querySelectorAll('a[href]')].filter(visible);
		const loginLinks = anchors.filter(a => /^(log ?in|sign ?in|login|signin|my account|account)$/i.test(label(a)) || /\/(log-?in|sign-?in|auth\/login)(\/|$|\?)/i.test(new URL(a.href, location.href).pathname)).map(a => a.href).slice(0, 5);
		const logout = [...document.querySelectorAll('a, button, [role=button]')].some(item => visible(item) && /^(log ?out|sign ?out|logout|signout)$/i.test(label(item)));
		const sso = [...document.querySelectorAll('a, button')].filter(item => visible(item) && /continue with|sign in with|log in with/i.test(label(item))).map(label).slice(0, 4);
		const text = document.body?.innerText ?? '';
		const challenge = document.querySelector('iframe[src*=captcha], iframe[src*=turnstile], iframe[src*=hcaptcha], [class*=captcha i], .g-recaptcha') ? 'captcha'
			: document.querySelector('input[autocomplete=one-time-code]') || /verification code|authenticator code|two-factor|one-time code/i.test(text) ? 'mfa' : undefined;
		return { password, identifierStep, loginLinks, logout, sso, challenge, loginPath: hintRe.test(location.pathname) };
	}, { hint: LOGIN_HINT.source, submit: SUBMIT_HINT.source }).catch(() => ({ password: false, identifierStep: false, loginLinks: [], logout: false, sso: [] }));
}

/** True when the page is a sign-in form of either kind (password or identifier-first). */
export async function isSignInPage(page) {
	const auth = await detectAuth(page);
	return Boolean((auth.password && await hasLoginForm(page)) || auth.identifierStep);
}

async function findLoginPage(browser, profile, candidates) {
	// Pages whose URL looks like a sign-in route are tried first.
	const ordered = [...candidates.filter(url => LOGIN_HINT.test(new URL(url).pathname)), ...candidates.filter(url => !LOGIN_HINT.test(new URL(url).pathname))];
	for (const url of ordered) {
		const { page, log } = await browser.openPage(profile);
		try {
			await browser.goto(page, url, log, { timeoutMs: 20000 });
			if (await isSignInPage(page)) return { page, log, url: page.url() };
			// A "Sign in" link on the page leads to the form.
			const link = page.locator('a, button').filter({ hasText: LOGIN_HINT }).first();
			if (await link.count()) {
				await link.click({ timeout: 4000 }).catch(() => {});
				await browser.settle(page, { quietMs: 1500 });
				if (await isSignInPage(page)) return { page, log, url: page.url() };
			}
		} catch { /* try the next candidate */ }
		await page.close().catch(() => {});
	}
	return undefined;
}

const SIGN_IN_WAIT_MS = 20000;
const TELEMETRY = /analytics|plausible|\/rum\b|\/rum\/|logs?\.|\/logs?\/|telemetry|track|collect|sentry|beacon|segment|mixpanel/i;
const ERROR_TEXT = /invalid|incorrect|wrong|not (?:recogni[sz]ed|found|match)|failed|unable|denied|locked|try again|doesn.t match|does not match|too many/i;

/** Waits until the page leaves the sign-in form, shows an error, or the wait ends. */
async function waitForOutcome(page, startUrl, baseline = []) {
	const end = Date.now() + SIGN_IN_WAIT_MS;
	let gone = 0;
	while (Date.now() < end) {
		await page.waitForTimeout(500);
		const state = await page.evaluate(errorSource => {
			const errorRe = new RegExp(errorSource, 'i');
			const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
			const password = [...document.querySelectorAll('input[type=password]')].some(visible);
			const messages = [...document.querySelectorAll('[role=alert], [aria-live], .error, .alert, [class*=error i], [class*=invalid i], form p, form span, form div')]
				.filter(element => visible(element) && element.children.length < 4)
				.map(element => (element.innerText || '').trim()).filter(text => text && text.length < 200 && errorRe.test(text));
			const verification = /captcha|verify (?:you|that you)|one-time|2fa|two-factor|authenticat(?:or|ion) code|verification code|check your (?:email|inbox)/i.test(document.body?.innerText ?? '')
				|| Boolean(document.querySelector('iframe[src*=captcha], iframe[src*=turnstile], iframe[src*=hcaptcha], [class*=captcha i], input[autocomplete=one-time-code]'));
			return { password, error: messages.find(Boolean), messages, verification };
		}, ERROR_TEXT.source).catch(() => ({ password: true }));
		// The form must stay gone for two checks: some apps re-render it while submitting.
		gone = state.password ? 0 : gone + 1;
		if (gone >= 2) return { kind: 'left_form', moved: page.url().split('#')[0] !== startUrl.split('#')[0] };
		if (state.verification) return { kind: 'verification', message: state.error };
		if (state.error && !baseline.includes(state.error)) return { kind: 'error', message: state.error };
	}
	return { kind: 'timeout' };
}

/** Turns what was observed into a reason the owner can act on. retry: whether asking for another account helps. */
function diagnose(outcome, responses, failed, sent = []) {
	const auth = responses.filter(item => !TELEMETRY.test(item.url)).at(-1);
	if (outcome.kind === 'verification') return { retry: false, reason: 'The site asked for extra verification (a CAPTCHA or a one-time code), which QASE cannot complete automatically.' };
	if (outcome.kind === 'error') return { retry: true, reason: `The site rejected the sign-in and showed: "${outcome.message.slice(0, 140).replace(/[.!]+$/, '')}"${auth ? ` (${auth.method} ${new URL(auth.url).pathname} → HTTP ${auth.status})` : ''}.` };
	if (auth && auth.status >= 400) return { retry: auth.status === 401 || auth.status === 403 || auth.status === 400, reason: `The sign-in request ${new URL(auth.url).pathname} answered HTTP ${auth.status}${auth.status === 401 || auth.status === 403 ? ' (credentials rejected)' : ''}.` };
	const blocked = failed.filter(item => !TELEMETRY.test(item.url));
	if (blocked.length) return { retry: false, reason: `The sign-in request ${new URL(blocked[0].url).pathname} did not complete (${blocked[0].error ?? 'network error'}).` };
	if (!auth && sent.length) return { retry: false, reason: `The sign-in request ${new URL(sent.at(-1).url).pathname} got no answer within 20 seconds.` };
	if (!auth) return { retry: false, reason: 'Clicking the sign-in button sent no sign-in request within 20 seconds (the form may need a field QASE did not fill, or the button stayed disabled).' };
	return { retry: false, reason: `The sign-in request answered HTTP ${auth.status}, but the page still shows the sign-in form after 20 seconds.` };
}

/** Returns { ok, url, reason, retry }. Never throws for an ordinary sign-in failure. */
export async function signIn({ browser, profile, session, candidates }) {
	const username = resolveSecrets(session.id, '{{QA_USERNAME}}');
	const password = resolveSecrets(session.id, '{{QA_PASSWORD}}');
	if (!username || !password || username.includes('{{') || password.includes('{{')) return { ok: false, reason: 'The test-account credentials were not available in this run\'s vault.' };
	const found = await findLoginPage(browser, profile, [...new Set([session.qaAuth?.loginUrl, ...candidates].filter(Boolean))]);
	if (!found) return { ok: false, reason: 'No sign-in form was found on the target or its common sign-in routes.' };
	const { page, url } = found;
	const steps = [];
	try {
		// Identifier-first sign-in: fill the email/username, continue, wait for the password step.
		if (!await page.locator('input[type=password]:visible').count()) {
			const idField = page.locator(USER_FIELD).first();
			if (!await idField.count()) return { ok: false, url, retry: false, reason: 'The sign-in page shows no username or password field QASE could fill.' };
			await idField.fill(username, { timeout: 4000 });
			const idScope = idField.locator('xpath=ancestor::form[1]');
			const next = (await idScope.count() ? idScope : page).locator('button, [role=button], input[type=submit]').filter({ hasText: SUBMIT_HINT }).first();
			await browser.permitWritesFor(15000, async () => {
				if (await next.count()) await next.click({ timeout: 5000 }); else await idField.press('Enter');
				await page.locator('input[type=password]:visible').first().waitFor({ timeout: 12000 }).catch(() => {});
			});
			steps.push('identifier');
			if (!await page.locator('input[type=password]:visible').count()) {
				const state = await detectAuth(page);
				if (state.challenge) return { ok: false, url, retry: false, human: state.challenge, steps, reason: 'The site asked for extra verification (a CAPTCHA or a one-time code), which needs a person to complete.' };
				return { ok: false, url, retry: true, steps, reason: 'After entering the username, the site did not show a password step.' };
			}
		}
		const passwordField = page.locator('input[type=password]:visible').first();
		const form = passwordField.locator('xpath=ancestor::form[1]');
		const scope = await form.count() ? form : page;
		// Prefer the button that says "Sign in"/"Log in"; an icon button inside the form
		// (show password) must never be mistaken for the submit control.
		const hinted = scope.locator('button, [role=button], input[type=submit]').filter({ hasText: SUBMIT_HINT }).first();
		const typed = scope.locator('button[type=submit], input[type=submit]').first();
		const submitButton = await hinted.count() ? hinted : await typed.count() ? typed : scope.locator('button:not([type])').last();
		const userField = scope.locator(USER_FIELD).first();
		if (await userField.count() && !await userField.inputValue().catch(() => '')) await userField.fill(username, { timeout: 4000 });
		steps.push('password');
		await passwordField.fill(password, { timeout: 4000 });
		// Watch what the sign-in actually does: the requests it sends (and how the site
		// answers), whether the page leaves the form, and any error message it shows.
		const authResponses = [];
		const onResponse = response => {
			const request = response.request();
			if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && ['fetch', 'xhr', 'document'].includes(request.resourceType())) authResponses.push({ url: response.url(), status: response.status(), method: request.method() });
		};
		const sent = [];
		const onRequest = request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !TELEMETRY.test(request.url())) sent.push({ url: request.url(), method: request.method() }); };
		page.on('request', onRequest);
		const failed = [];
		const onFailed = request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) failed.push({ url: request.url(), error: request.failure()?.errorText }); };
		page.on('response', onResponse);
		page.on('requestfailed', onFailed);
		const startUrl = page.url();
		// Messages already on the page before submitting are not the site's answer.
		const baseline = await page.evaluate(errorSource => [...document.querySelectorAll('[role=alert], [aria-live], .error, .alert, [class*=error i], [class*=invalid i], form p, form span, form div')]
			.map(element => (element.innerText || '').trim()).filter(text => text && text.length < 200 && new RegExp(errorSource, 'i').test(text)), ERROR_TEXT.source).catch(() => []);
		let outcome;
		// The write window stays open until the outcome is known (slow auth APIs,
		// client-side redirects and follow-up session requests all fit in it).
		await browser.permitWritesFor(SIGN_IN_WAIT_MS + 5000, async () => {
			if (await submitButton.count()) await submitButton.click({ timeout: 5000 });
			else await passwordField.press('Enter');
			outcome = await waitForOutcome(page, startUrl, baseline);
			// Let a redirect after a successful sign-in finish and cookies settle.
			if (outcome.kind === 'left_form') await browser.settle(page, { quietMs: 1500 });
		});
		page.off('response', onResponse);
		page.off('requestfailed', onFailed);
		page.off('request', onRequest);
		const expected = session.qaAuth?.expectedUrl;
		if (outcome.kind === 'left_form' && expected && !page.url().startsWith(expected)) {
			return { ok: false, url, retry: false, reason: `Signed in, but the browser reached ${page.url()} instead of the expected ${expected}.` };
		}
		if (outcome.kind !== 'left_form') return { ok: false, url, steps, ...(outcome.kind === 'verification' ? { human: 'verification' } : {}), ...diagnose(outcome, authResponses, failed, sent) };
		// Verify the session from what the page shows, not only from the form disappearing.
		const after = await detectAuth(page);
		const verified = { leftForm: true, logoutControl: after.logout, leftLoginPath: !after.loginPath, cookies: (await page.context().cookies()).length };
		// Let the app finish storing its tokens (SPAs often write them just after the redirect).
		await browser.settle(page, { quietMs: 1500 }).catch(() => {});
		const context = page.context();
		const state = await context.storageState({ indexedDB: true }).catch(() => context.storageState());
		const tabStorage = await page.evaluate(() => ({ origin: location.origin, items: Object.fromEntries(Object.entries(sessionStorage)) })).catch(() => undefined);
		verified.storage = { cookies: state.cookies?.length ?? 0, localStorageOrigins: state.origins?.length ?? 0, indexedDB: (state.origins ?? []).some(item => item.indexedDB?.length), sessionStorageKeys: Object.keys(tabStorage?.items ?? {}).length };
		await browser.useSignedInState(state, { sessionStorage: tabStorage, keep: context });
		return { ok: true, url: page.url(), steps, verified };
	} catch (error) {
		return { ok: false, url, reason: `Sign-in failed: ${String(error.message).split('\n')[0].slice(0, 160)}` };
	} finally {
		await page.close().catch(() => {});
	}
}
