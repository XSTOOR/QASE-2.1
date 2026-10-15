/**
 * UI Fix Phase 5 — Responsive matrix suite.
 * Drives the real app at the six required resolutions and asserts:
 * no panel disappears, no horizontal overflow, no page-level scrolling,
 * center ≥ right column width, right column within 28–32% band (±tolerance
 * at 1024 where the slim grid intentionally runs wider columns).
 *
 * Usage: node scripts/test-ui-responsive.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.QASE_UI_BASE ?? 'http://localhost:5173';
const RESOLUTIONS = [
	[1920, 1080], [1600, 900], [1440, 900], [1366, 768], [1280, 800], [1024, 768]
];

const failures = [];
const note = (ok, label, detail) => {
	console.log(`${ok ? 'PASS' : 'FAIL'} [${label}] ${detail}`);
	if (!ok) failures.push(`${label}: ${detail}`);
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
	const errors = [];
	let authed = false;
	page.on('pageerror', (e) => errors.push(String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error' && !/status of 401|ERR_/.test(m.text())) errors.push(m.text());
	});
	page.on('response', (r) => {
		// 401s before authentication completes are expected (auth bootstrap).
		if (r.status() === 401 && !authed) return;
		if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`);
	});

	await page.goto(BASE, { waitUntil: 'networkidle' });

	// Authenticate if the gate is up (dev seed account; tests only).
	if (await page.locator('#auth-gate:not([hidden])').count()) {
		if (!process.env.QASE_TEST_PASSWORD) {
			console.error('FAIL [setup] QASE_TEST_PASSWORD is not set — refusing to burn a throttled login attempt with a guess. Export it from .drytis/cred.json accounts[0].');
			process.exit(1);
		}
		await page.fill('#auth-email', process.env.QASE_TEST_EMAIL ?? 'tester@qase.dev');
		await page.fill('#auth-password', process.env.QASE_TEST_PASSWORD ?? '');
		await page.click('#auth-submit');
		await page.waitForFunction(() => document.querySelector('#auth-gate')?.hidden === true, { timeout: 20000 });
	authed = true;
	}
	await page.waitForSelector('.app', { timeout: 20000 });

	for (const [w, h] of RESOLUTIONS) {
		await page.setViewportSize({ width: w, height: h });
		await page.waitForTimeout(350); // let layout settle
		const m = await page.evaluate(() => {
			const de = document.documentElement;
			const app = document.querySelector('.app');
			const cols = app ? getComputedStyle(app).gridTemplateColumns.split(' ').map(parseFloat) : [];
			const left = document.querySelector('.panel.sidebar, aside.panel, .panel:first-child');
			const center = document.querySelector('.panel.chat, main.panel');
			const right = document.querySelector('.panel.viewer, .viewer')?.closest('.panel') ?? document.querySelector('.viewer');
			const vis = (el) => {
				if (!el) return false;
				const r = el.getBoundingClientRect();
				return r.width > 40 && r.height > 40;
			};
			const stage = document.querySelector('#stage');
			const tabs = document.querySelector('#tabs');
			const tabBody = document.querySelector('.tab-body');
			const top = (el) => el ? Math.round(el.getBoundingClientRect().top) : null;
			const tops = [top(stage), top(tabs), top(tabBody)];
			// Exec panel order (#14074): stage (preview) → tabs → tab-body all
			// inside the RIGHT viewer panel, tab bar reachable without page scroll.
			const orderOk = Boolean(right) && [stage, tabs, tabBody].every((el) => el && right.contains(el))
				&& tops.every((v, i) => v !== null && (i === 0 || v >= tops[i - 1]));
			const tabsBottom = tabs ? Math.round(tabs.getBoundingClientRect().bottom) : -1;
			return {
				scrollW: de.scrollWidth, clientW: de.clientWidth,
				scrollH: de.scrollHeight, clientH: de.clientHeight,
				cols, leftOk: vis(left), centerOk: vis(center), rightOk: vis(right),
				centerRect: center?.getBoundingClientRect().toJSON(),
				rightRect: (right ?? document.querySelector('.viewer'))?.getBoundingClientRect().toJSON(),
				orderOk, orderDetail: `stage=${tops[0]} tabs=${tops[1]} tabBody=${tops[2]} inViewer=${[stage, tabs, tabBody].every((el) => el && right?.contains(el))}`,
				tabsReachable: tabsBottom >= 0 && tabsBottom <= window.innerHeight, tabsBottom
			};
		});

		const label = `${w}x${h}`;
		note(m.leftOk && m.centerOk && m.rightOk, `${label} panels`, `left=${m.leftOk} center=${m.centerOk} right=${m.rightOk}`);
		note(m.scrollW <= m.clientW + 1, `${label} h-overflow`, `scrollW=${m.scrollW} clientW=${m.clientW}`);
		note(m.scrollH <= m.clientH + 1, `${label} page-scroll`, `scrollH=${m.scrollH} clientH=${m.clientH}`);
		const cw = m.centerRect?.width ?? 0, rw = m.rightRect?.width ?? 0;
		note(cw >= rw - 1, `${label} center>=right`, `center=${Math.round(cw)}px right=${Math.round(rw)}px`);
		const rightShare = rw / w;
		// 28–32% band with small rounding tolerance.
		note(rightShare >= 0.27 && rightShare <= 0.325, `${label} right-share`, `${(rightShare * 100).toFixed(1)}% of ${w}px`);
		// Exec panel order (#14074): stage (preview) → tabs → tab-body all
		// inside the RIGHT viewer panel, tab bar reachable without page scroll.
		note(m.orderOk, `${label} exec-order`, m.orderDetail);
		note(m.tabsReachable, `${label} tabs-reachable`, `tabsBottom=${m.tabsBottom} viewport=${h}`);
	}

	// #14102: the inline Choose Device strip and quick actions are REMOVED.
	// Verify their absence at the smallest and widest resolutions — no empty
	// grid rows, no orphaned controls, and the card → preview → tabs order holds.
	for (const [w, h] of [[1920, 1080], [1024, 768]]) {
		await page.setViewportSize({ width: w, height: h });
		await page.waitForTimeout(250);
		const gone = await page.evaluate(() => {
			const de = document.documentElement;
			const head = document.querySelector('.viewer .panel-head');
			const stage = document.querySelector('#stage');
			const tabs = document.querySelector('#tabs');
			return {
				stripGone: !document.querySelector('#choose-device'),
				quickGone: !document.querySelector('#quick-actions'),
				order: head && stage && tabs
					? head.getBoundingClientRect().top < stage.getBoundingClientRect().top && stage.getBoundingClientRect().top < tabs.getBoundingClientRect().top
					: false,
				overflow: de.scrollWidth - de.clientWidth,
				pageScroll: de.scrollHeight - de.clientHeight
			};
		});
		note(gone.stripGone && gone.quickGone && gone.order && gone.overflow <= 1 && gone.pageScroll <= 1, `${w}x${h} strip-gone`, `strip=${gone.stripGone} quick=${gone.quickGone} order=${gone.order} hOverflow=${gone.overflow}px pageScroll=${gone.pageScroll}px`);
	}

	note(errors.length === 0, 'console', errors.length ? errors.slice(0, 3).join(' | ') : 'no page/console errors');
} finally {
	await browser.close();
}

if (failures.length) {
	console.error(`\nRESULT: FAIL (${failures.length})`);
	process.exit(1);
}
console.log('\nRESULT: PASS');
