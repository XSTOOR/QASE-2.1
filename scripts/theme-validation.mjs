/**
 * #14386 validation matrix — persistence across reload for all three modes,
 * system follows OS, theme switch updates entire dashboard.
 */
import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:5173';
const cred = JSON.parse((await import('node:fs')).readFileSync('.drytis/cred.json', 'utf8'));

const browser = await chromium.launch();
const results = [];

async function bodyBg(page) {
	return page.evaluate(() => {
		const bg = getComputedStyle(document.body).backgroundColor;
		const dt = document.documentElement.dataset.theme;
		return { theme: dt, bg };
	});
}

async function login(page) {
	const email = page.locator('#auth-email, input[type="email"]').first();
	await email.fill(cred.accounts[0].email);
	await page.locator('#auth-password, input[type="password"]').first().fill(cred.accounts[0].password);
	await page.locator('#auth-submit').first().click();
	await page.waitForTimeout(1500);
}

// V4: persistence for each stored preference
for (const stored of ['dark', 'light']) {
	const page = await browser.newPage();
	await page.addInitScript((v) => { try { localStorage.setItem('qase.theme', v); } catch {} }, stored);
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(500);
	const state = await bodyBg(page);
	results.push({ check: `reload persists ${stored}`, ...state, pass: state.theme === stored });
	await page.close();
}

// V5: system follows OS (preference explicitly stored as 'system' — the
// spec's default with no stored value is 'dark', which ignores the OS)
{
	const page = await browser.newPage({ colorScheme: 'dark' });
	await page.addInitScript(() => { try { localStorage.setItem('qase.theme', 'system'); } catch {} });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.waitForTimeout(400);
	const darkState = await bodyBg(page);
	await page.emulateMedia({ colorScheme: 'light' });
	await page.waitForTimeout(800);
	const lightState = await bodyBg(page);
	results.push({
		check: 'system follows OS live',
		dark: darkState.theme, afterFlip: lightState.theme, bg: lightState.bg,
		pass: darkState.theme === 'dark' && lightState.theme === 'light'
	});
	await page.close();
}

// V1: switching updates whole dashboard instantly (computed across many elements)
{
	const page = await browser.newPage();
	await page.addInitScript(() => { try { localStorage.setItem('qase.theme', 'dark'); } catch {} });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await login(page);
	const darkSnapshot = await page.evaluate(() => {
		const out = {};
		for (const sel of ['body', '.runs', '.composer', '.chat', '.viewer', '.stage']) {
			const el = document.querySelector(sel);
			if (el) out[sel] = getComputedStyle(el).backgroundColor;
		}
		return out;
	});
	await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
	await page.waitForTimeout(300);
	const lightSnapshot = await page.evaluate(() => {
		const out = {};
		for (const sel of ['body', '.runs', '.composer', '.chat', '.viewer', '.stage']) {
			const el = document.querySelector(sel);
			if (el) out[sel] = getComputedStyle(el).backgroundColor;
		}
		return out;
	});
	const changed = Object.keys(darkSnapshot).filter((k) => darkSnapshot[k] !== lightSnapshot[k]);
	results.push({
		check: 'switch updates entire dashboard instantly',
		surfacesChanged: changed.length, of: Object.keys(darkSnapshot).length,
		pass: changed.length === Object.keys(darkSnapshot).length
	});
	await page.close();
}

await browser.close();
let fails = 0;
for (const r of results) {
	console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.check}`, JSON.stringify(r));
	if (!r.pass) fails++;
}
console.log(fails === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
