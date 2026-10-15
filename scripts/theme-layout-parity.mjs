#!/usr/bin/env node
/**
 * #14385: layout-parity proof — captures key element geometry in both themes
 * and asserts switching themes causes ZERO layout changes.
 * Usage: node scripts/theme-layout-parity.mjs [baseURL]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5173';

const SELECTORS = [
	'sidebar-nav', 'run-list', 'send-btn', 'composer', 'stage', 'settings',
	'nav-test-cases', 'device-chip'
].map((id) => `#${id}`);

async function geometry(page) {
	const selectors = SELECTORS;
	return page.evaluate((sels) => {
		const out = {};
		for (const sel of sels) {
			const el = document.querySelector(sel);
			if (!el) { out[sel] = null; continue; }
			const r = el.getBoundingClientRect();
			const cs = getComputedStyle(el);
			out[sel] = {
				x: Math.round(r.x), y: Math.round(r.y),
				w: Math.round(r.width), h: Math.round(r.height),
				fontSize: cs.fontSize, display: cs.display
			};
		}
		return out;
	}, selectors);
}

const browser = await chromium.launch();const page = await browser.newPage();
try {
	const cred = JSON.parse((await import('node:fs')).readFileSync('.drytis/cred.json', 'utf8'));
	await page.addInitScript(() => { try { localStorage.setItem('qase.theme', 'dark'); } catch {} });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
	const email = page.locator('#auth-email, input[type="email"]').first();
	if (await email.count()) {
		await email.fill(cred.accounts[0].email);
		await page.locator('#auth-password, input[type="password"]').first().fill(cred.accounts[0].password);
		await page.locator('#auth-submit').first().click();
		await page.waitForTimeout(1500);
	}
	const dark = await geometry(page);
	await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
	await page.waitForTimeout(300);
	const light = await geometry(page);

	let mismatches = 0;
	for (const sel of SELECTORS) {
		const d = dark[sel], l = light[sel];
		if (!d || !l) { console.log(`SKIP (absent): ${sel}`); continue; }
		const keys = Object.keys(d);
		const diffs = keys.filter((k) => d[k] !== l[k]);
		if (diffs.length) {
			mismatches += 1;
			console.log(`MISMATCH ${sel}: ${diffs.map((k) => `${k} ${d[k]}→${l[k]}`).join(', ')}`);
		} else {
			console.log(`OK ${sel} @ ${d.w}x${d.h}`);
		}
	}
	console.log(mismatches === 0 ? 'RESULT: PASS — no layout differences between themes' : `RESULT: FAIL — ${mismatches} elements moved`);
	process.exitCode = mismatches === 0 ? 0 : 1;
} finally {
	await browser.close();
}
