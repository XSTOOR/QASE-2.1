#!/usr/bin/env node
/**
 * Theme coverage audit (#14385): loads the dashboard in LIGHT mode and walks
 * every visible section, reporting elements whose computed colors look like
 * leftover dark-theme values (dark backgrounds with dark text, near-black
 * surfaces in a light theme, unreadable text contrast).
 *
 * Usage: node scripts/audit-theme-light.mjs [baseURL]
 * Defaults to http://127.0.0.1:5173 (local server).
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';

const DARK_BG_THRESHOLD = 60; // rgb component average below this = dark surface in light mode
const results = [];

async function auditPage(page, label) {
	const report = await page.evaluate((darkBgThreshold) => {
		const problems = [];
		const els = document.querySelectorAll('body *');
		for (const el of els) {
			if (!(el instanceof HTMLElement)) continue;
			const cs = getComputedStyle(el);
			if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
			const r = el.getBoundingClientRect();
			if (r.width < 4 || r.height < 4) continue;
			const bg = cs.backgroundColor;
			const color = cs.color;
			const parse = (s) => {
				const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
				if (!m) return null;
				return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
			};
			const bgc = parse(bg);
			const tc = parse(color);
			if (!bgc || !tc) continue;
			if (bgc.a < 0.5) continue; // transparent-ish backgrounds inherit — skip
			const bgLum = (bgc.r + bgc.g + bgc.b) / 3;
			const textLum = (tc.r + tc.g + tc.b) / 3;
			// Dark surface in light mode
			if (bgLum < darkBgThreshold) {
				problems.push({ kind: 'dark-surface', sel: describe(el), bg, color, text: el.textContent?.slice(0, 40) });
				continue;
			}
			// Unreadable: light text on light bg or dark on dark
			if (Math.abs(bgLum - textLum) < 40 && textLum > 180) {
				problems.push({ kind: 'low-contrast', sel: describe(el), bg, color, text: el.textContent?.slice(0, 40) });
			}
		}
		function describe(el) {
			const id = el.id ? `#${el.id}` : '';
			const cls = el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '';
			return `${el.tagName.toLowerCase()}${id}${cls}`;
		}
		return problems.slice(0, 200);
	}, DARK_BG_THRESHOLD);
	results.push({ label, count: report.length, problems: report });
}

const browser = await chromium.launch();
const page = await browser.newPage();
try {
	await page.addInitScript(() => { try { localStorage.setItem('qase.theme', 'light'); } catch {} });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

	await auditPage(page, 'dashboard-auth');
	// Log in with the cred.json developer account to reach the full dashboard.
	const cred = JSON.parse((await import('node:fs')).readFileSync('.drytis/cred.json', 'utf8'));
	const account = cred.accounts[0];
	const emailField = page.locator('#auth-email, input[type="email"]').first();
	if (await emailField.count()) {
		await emailField.fill(account.email);
		await page.locator('#auth-password, input[type="password"]').first().fill(account.password);
		await page.locator('#auth-submit, button[type="submit"]').first().click();
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(1500);
		await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
	}
	await auditPage(page, 'dashboard-logged-in');

	// Visit each workspace section via its sidebar nav button id. JS click:
	// the run-list overlays the nav buttons in some viewports (pre-existing
	// layout), which would stall Playwright's actionability checks.
	for (const id of ['nav-test-cases', 'nav-device-matrix', 'nav-bulk-runs', 'nav-environments']) {
		try {
			await page.$eval(`#${id}`, (el) => el.click());
			await page.waitForTimeout(700);
			await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
			await auditPage(page, `section:${id}`);
		} catch { /* section not reachable */ }
	}
	// Modals: settings first; device picker via its open button if reachable.
	for (const open of ['open-settings']) {
		try {
			await page.click(`#${open}`, { timeout: 2000 });
			await page.waitForTimeout(300);
			await auditPage(page, `modal:${open}`);
			await page.keyboard.press('Escape');
		} catch { /* not present/clickable */ }
	}
} finally {
	await browser.close();
}

console.log(JSON.stringify(results, null, 2));
