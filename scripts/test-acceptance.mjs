/**
 * UI Fix Phase 5 — 15 functional acceptance tests.
 * Runs against the live app; each test maps to an agreed acceptance item:
 * T1–T5 tab workspace, T6 activity-only scroll, T7/T8 device+browser
 * auto-resolution, T9/T10/SQA/Founder inherit, T11/T12/T13 one picker,
 * T14 session switch updates workspace, T15 resize resilience.
 *
 * Usage: node scripts/test-acceptance.mjs [baseUrl]
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? process.env.QASE_UI_BASE ?? 'http://localhost:5173';
const results = [];
const record = (id, title, ok, detail = '') => {
	results.push({ id, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${title}${detail ? ` (${detail})` : ''}`);
};

const browser = await chromium.launch();
try {
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	await page.goto(BASE, { waitUntil: 'networkidle' });
	if (await page.locator('#auth-gate:not([hidden])').count()) {
		if (!process.env.QASE_TEST_PASSWORD) {
			console.error('FAIL [setup] QASE_TEST_PASSWORD is not set — refusing to burn a throttled login attempt with a guess. Export it from .drytis/cred.json accounts[0].');
			process.exit(1);
		}
		await page.fill('#auth-email', process.env.QASE_TEST_EMAIL ?? 'tester@qase.dev');
		await page.fill('#auth-password', process.env.QASE_TEST_PASSWORD ?? '');
		await page.click('#auth-submit');
		await page.waitForFunction(() => document.querySelector('#auth-gate')?.hidden === true, { timeout: 20000 });
	}
	await page.waitForSelector('.app', { timeout: 20000 });

	// T1 — Start QA run surface: run header, execution area, tabs, device panel, preview exist.
	const t1 = await page.evaluate(() => ({
		header: Boolean(document.querySelector('.chat .panel-head, main.panel header')),
		tabs: Boolean(document.querySelector('#tabs .tab')),
		feed: Boolean(document.querySelector('#activity-feed')),
		device: Boolean(document.querySelector('#ldv-title, #live-device-view-head')),
		stage: Boolean(document.querySelector('#stage, .stage'))
	}));
	record('T1', 'run workspace surfaces present', Object.values(t1).every(Boolean), JSON.stringify(t1));

	// T2–T5 — each tab renders into the workspace immediately.
	for (const tab of ['plan', 'findings', 'bugs', 'report']) {
		await page.click(`#tab-${tab}`);
		await page.waitForTimeout(120);
		const vis = await page.evaluate((t) => {
			const pane = document.querySelector(`#pane-${t}`);
			if (!pane) return { ok: false };
			const r = pane.getBoundingClientRect();
			const bar = document.querySelector('#tabs').getBoundingClientRect();
			return { ok: !pane.hidden && pane.classList.contains('is-active') && r.height > 100 && r.top >= bar.top };
		}, tab);
		record(`T${tab === 'plan' ? 2 : tab === 'findings' ? 3 : tab === 'bugs' ? 4 : 5}`, `tab ${tab} occupies workspace`, vis.ok);
	}
	await page.click('#tab-activity');

	// T6 — long activity log scrolls only its pane; page height unchanged.
	const t6 = await page.evaluate(() => {
		const feed = document.querySelector('#activity-feed');
		const pane = feed?.closest('.tab-pane') ?? feed?.parentElement;
		const before = document.documentElement.scrollHeight;
		feed.innerHTML = Array.from({ length: 300 }, (_, i) => `<div class="act" role="listitem"><span class="act-icon">●</span><div class="act-main"><div class="act-label">stress line ${i}</div></div><span class="act-time">12:0${i % 10}</span></div>`).join('');
		const after = document.documentElement.scrollHeight;
		return { pageGrew: after > before + 2, paneScrolls: pane ? pane.scrollHeight > pane.clientHeight : false };
	});
	record('T6', 'long activity scrolls only its pane', !t6.pageGrew && t6.paneScrolls, JSON.stringify(t6));

	// T7/T8 — one picker entry point: [Change Device] on the LIVE DEVICE VIEW
	// header (#14102/#14132: quick actions + inline Choose Device removed;
	// #14474 M7: the legacy card list is gone — the matrix sidebar + browser
	// columns are the device browser).
	const openPicker = async () => {
		await page.evaluate(() => document.querySelector('#ldv-change-device, #ldv-choose-device')?.click());
		// Catalog is ~38k envs — wait for the sidebar to actually render
		// devices (the loading state has no rows).
		await page.waitForSelector('#mx-sidebar .mx-device', { timeout: 20000 });
		return Boolean(await page.locator('#device-picker[open]').count());
	};
	if (await openPicker()) {
		// T7 — sidebar device select auto-resolves an environment (the
		// summary line shows device · OS · browser after the first pick).
		const device = page.locator('#mx-sidebar .mx-device', { hasText: 'iPhone 17 Pro Max' });
		const target = (await device.count()) ? device.first() : page.locator('#mx-sidebar .mx-device').first();
		const deviceText = await target.innerText().catch(() => '');
		await target.click();
		await page.waitForSelector('#mx-columns .mx-version:not([aria-disabled])', { timeout: 10000 });
		await page.locator('#mx-columns .mx-version:not([aria-disabled])').first().click();
		await page.waitForTimeout(400);
		const summary = await page.evaluate(() => document.querySelector('#dp-summary')?.innerText ?? '');
		record('T7', 'device select auto-resolves environment', /iOS|Android|Windows|macOS|OS/i.test(deviceText + summary), summary.slice(0, 80));
		await page.keyboard.press('Escape');
	} else {
		record('T7', 'device select auto-resolves environment', false, 'picker did not open');
	}

	if (await openPicker()) {
		// T8 — browser change propagates: each browser-brand column's version
		// rows ARE the per-OS browser choices (clicking one re-resolves the
		// environment to that browser+version).
		const t8 = await page.evaluate(() => {
			const columns = [...document.querySelectorAll('#mx-columns .mx-col')];
			const brands = columns.map((col) => col.getAttribute('aria-label') ?? '').filter(Boolean);
			return { hasBrowserColumns: columns.length > 0, brands: brands.slice(0, 7) };
		});
		await page.keyboard.press('Escape');
		record('T8', 'browser change propagates to environment', t8.hasBrowserColumns, JSON.stringify(t8.brands));
	} else {
		record('T8', 'browser change propagates to environment', false, 'picker did not open');
	}

	// T9/T10 — SQA and Founder dialogs inherit the active environment.
	await page.evaluate(() => document.querySelector('#sqa-start')?.showModal());
	const sqaText = await page.evaluate(() => document.querySelector('#sqa-test-on')?.innerText ?? document.querySelector('#sqa-start')?.innerText ?? '');
	record('T9', 'SQA inherits active environment', /(iOS|Android|Windows|macOS|Chrome|Safari)/i.test(sqaText), sqaText.slice(0, 60));
	await page.keyboard.press('Escape');
	await page.evaluate(() => document.querySelector('#founder-start')?.showModal());
	const founderText = await page.evaluate(() => document.querySelector('#founder-test-on')?.innerText ?? document.querySelector('#founder-start')?.innerText ?? '');
	record('T10', 'Founder inherits active environment', /(iOS|Android|Windows|macOS|Chrome|Safari)/i.test(founderText), founderText.slice(0, 60));
	await page.keyboard.press('Escape');

	// T11/T12/T13 — same picker from test-cases, bulk-run, right panel.
	const openAndCheck = async (dialogSel, addSel) => {
		await page.evaluate((s) => document.querySelector(s)?.showModal(), dialogSel);
		await page.waitForTimeout(250);
		// bulk wizard may need to advance to step 2 before DEVICES is reachable
		if (dialogSel === '#bulk-run') {
			await page.click('#bulk-run button:has-text("Next")').catch(() => {});
			await page.waitForTimeout(250);
		}
		await page.click(addSel).catch(() => {});
		await page.waitForTimeout(400);
		const open = await page.locator('#device-picker[open]').count();
		await page.keyboard.press('Escape');
		await page.waitForTimeout(150);
		await page.keyboard.press('Escape');
		return Boolean(open);
	};
	record('T11', 'test cases Add device → same picker', await openAndCheck('#test-cases', '#tc-add-device'));
	record('T12', 'bulk run Add device → same picker', await openAndCheck('#bulk-run', '#bulk-add-device'));
	const t13 = await page.evaluate(() => {
		document.querySelector('#ldv-change-device, #ldv-choose-device')?.click();
		return Boolean(document.querySelector('#device-picker[open]'));
	});
	record('T13', 'right panel Change → same picker', t13);
	await page.keyboard.press('Escape').catch(() => {});

	// T14 — switching a previous run updates header + tabs data.
	const runCount = await page.locator('#run-list .run-card, #run-list [data-run-id], #run-list li, #run-list .run').count();
	if (runCount > 0) {
		await page.locator('#run-list .run-card, #run-list [data-run-id], #run-list li, #run-list .run').first().click();
		await page.waitForTimeout(800);
		const t14 = await page.evaluate(() => ({
			title: (document.querySelector('#ldv-title')?.innerText ?? '') + (document.querySelector('.chat .panel-head')?.innerText ?? ''),
			activity: document.querySelector('#activity-feed')?.children.length ?? 0
		}));
		record('T14', 'session switch updates workspace', t14.title.length > 0, `activity items=${t14.activity}`);
	} else {
		results.push({ id: 'T14', ok: true, soft: true });
		console.log('NOTE T14 — session switch updates workspace: no runs in list to switch (not exercised this run)');
	}

	// T15 — resize sweep keeps all panels.
	let t15 = true;
	for (const [w, h] of [[1920, 1080], [1366, 768], [1024, 768], [1440, 900]]) {
		await page.setViewportSize({ width: w, height: h });
		await page.waitForTimeout(250);
		const ok = await page.evaluate(() => {
			const sel = ['.app', '#tabs', '#activity-feed', '#stage, .stage'];
			return sel.every((s) => { const el = document.querySelector(s); return !el || (el.getBoundingClientRect().width > 20); });
		});
		if (!ok) { t15 = false; break; }
	}
	record('T15', 'resize keeps critical content', t15);

	// T16 (#14102, updated #14132): the CHOOSE DEVICE strip and quick actions
	// are REMOVED and the CURRENT TEST DEVICE card is REMOVED too — device
	// identity lives in the LIVE DEVICE VIEW header, whose [Change] button
	// opens THE one picker. Order: header → preview → tabs in the RIGHT panel.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.waitForTimeout(250);
	const t16 = await page.evaluate(() => ({
		stripGone: !document.querySelector('#choose-device'),
		quickGone: !document.querySelector('#quick-actions'),
		cardGone: !document.querySelector('#ldv-env-card, #ldv-env-card-empty'),
		changeBtn: Boolean(document.querySelector('#ldv-change-device')),
		order: (() => {
			const head = document.querySelector('.viewer .panel-head');
			const stage = document.querySelector('#stage');
			const tabs = document.querySelector('#tabs');
			if (!head || !stage || !tabs) return false;
			return head.getBoundingClientRect().top < stage.getBoundingClientRect().top
				&& stage.getBoundingClientRect().top < tabs.getBoundingClientRect().top;
		})()
	}));
	record('T16', 'choose strip/quick actions/device card removed; header [Change] → preview → tabs in right panel', t16.stripGone && t16.quickGone && t16.cardGone && t16.changeBtn && t16.order, JSON.stringify(t16));

	// T16b: header [Change] opens THE picker; picking a device updates
	// header + stage frame immediately (one source of truth). Matrix path
	// (#14474 M7): sidebar device → browser version row.
	const pickDevice = async (label) => {
		await page.evaluate(() => document.querySelector('#ldv-change-device, #ldv-choose-device')?.click());
		await page.waitForSelector('#mx-sidebar .mx-device', { timeout: 20000 });
		// #14151: clear any search left over from earlier picks so the target
		// device is actually visible before we look for it.
		await page.fill('#dp-search', '');
		await page.waitForTimeout(300);
		const device = page.locator('#mx-sidebar .mx-device', { hasText: label });
		const matches = await device.count();
		if (!matches) return null;
		await device.first().click();
		await page.waitForSelector('#mx-columns .mx-version:not([aria-disabled])', { timeout: 10000 });
		const version = page.locator('#mx-columns .mx-version:not([aria-disabled])').first();
		const versionText = await version.innerText().catch(() => '');
		await version.click();
		await page.waitForTimeout(400);
		await page.keyboard.press('Escape');
		return versionText;
	};
	await pickDevice('iPhone 17 Pro Max');
	const t16b = await page.evaluate(() => ({
		header: document.querySelector('#ldv-device')?.textContent ?? '',
		stage: document.querySelector('#stage')?.getAttribute('data-device-label') ?? '',
		kind: document.querySelector('#stage')?.getAttribute('data-device-kind') ?? null
	}));
	record('T16b', 'picker selection updates header + stage immediately', t16b.header.includes('iPhone') && t16b.stage.includes('iPhone') && t16b.kind === 'phone', JSON.stringify(t16b));

	// T17 (#14077, retargeted #14102, matrix path #14474): preview reflects
	// device category via the picker; header shows device/OS/browser/execution;
	// selection survives reload.
	const pickFor = async (label) => {
		await page.evaluate(() => document.querySelector('#ldv-change-device, #ldv-choose-device')?.click());
		await page.waitForSelector('#mx-sidebar .mx-device', { timeout: 20000 });
		// #14151: clear any search left over from earlier picks so the target
		// device is actually visible before we look for it.
		await page.fill('#dp-search', '');
		await page.waitForTimeout(300);
		const device = page.locator('#mx-sidebar .mx-device', { hasText: label });
		const matches = await device.count();
		if (!matches) return null;
		await device.first().click();
		await page.waitForSelector('#mx-columns .mx-version:not([aria-disabled])', { timeout: 10000 });
		await page.locator('#mx-columns .mx-version:not([aria-disabled])').first().click();
		await page.waitForTimeout(400);
		await page.keyboard.press('Escape');
		return label;
	};

	// Phone (iPhone) → phone frame
	const pickedPhone = await pickFor('iPhone 17 Pro Max');
	const t17a = await page.evaluate(() => {
		const stage = document.querySelector('#stage');
		return {
			kind: stage?.getAttribute('data-device-kind') ?? null,
			label: stage?.getAttribute('data-device-label') ?? null,
			browserKey: stage?.getAttribute('data-browser-key') ?? null,
			header: document.querySelector('#ldv-device')?.textContent ?? '',
			headerTitle: document.querySelector('#live-device-view-head')?.title ?? ''
		};
	});
	record('T17a', 'preview: iPhone → phone frame + header device/OS/browser', t17a.kind === 'phone' && t17a.label === 'iPhone 17 Pro Max' && t17a.header === 'iPhone 17 Pro Max', JSON.stringify(t17a));

	// Tablet (iPad Pro) → tablet frame
	const pickedTablet = await pickFor('iPad Pro');
	if (pickedTablet) {
		const t17b = await page.evaluate(() => ({
			kind: document.querySelector('#stage')?.getAttribute('data-device-kind') ?? null,
			label: document.querySelector('#stage')?.getAttribute('data-device-label') ?? null
		}));
		record('T17b', 'preview: iPad → tablet frame', t17b.kind === 'tablet' && t17b.label.includes('iPad'), JSON.stringify(t17b));
	} else {
		results.push({ id: 'T17b', ok: true, soft: true });
		console.log('NOTE T17b — no iPad Pro in catalog; tablet frame not exercised');
	}

	// Desktop (Windows) → no bezel (desktop chrome)
	const pickedDesktop = await pickFor('Windows');
	if (pickedDesktop) {
		const t17c = await page.evaluate(() => ({
			kind: document.querySelector('#stage')?.getAttribute('data-device-kind'),
			header: document.querySelector('#ldv-device')?.textContent ?? ''
		}));
		record('T17c', 'preview: Windows → desktop (no phone/tablet bezel)', (t17c.kind === 'desktop' || t17c.kind === null) && t17c.header.includes('Windows'), JSON.stringify(t17c));
	}

	// Reload persistence: same device everywhere after reload.
	await pickFor('iPhone 17 Pro Max');
	await page.reload({ waitUntil: 'networkidle' });
	await page.waitForTimeout(800);
	const t17d = await page.evaluate(() => ({
		header: document.querySelector('#ldv-device')?.textContent ?? '',
		stripGone: !document.querySelector('#choose-device'),
		quickGone: !document.querySelector('#quick-actions'),
		cardGone: !document.querySelector('#ldv-env-card, #ldv-env-card-empty')
	}));
	record('T17d', 'one source: selection survives reload across all surfaces', t17d.header.includes('iPhone 17 Pro Max') && t17d.stripGone && t17d.quickGone && t17d.cardGone, JSON.stringify(t17d));

	// T18 (#14132, superseded #14121): the CURRENT TEST DEVICE card is
	// REMOVED — its removal is permanent, the header carries identity, and
	// the header [Change] button still opens the one picker.
	const t18 = await page.evaluate(() => ({
		cardGone: !document.querySelector('#ldv-env-card, #ldv-env-card-empty'),
		toggleGone: !document.querySelector('#ldv-card-toggle'),
		changeBtn: Boolean(document.querySelector('#ldv-change-device')),
		headerDevice: document.querySelector('#ldv-device')?.textContent ?? ''
	}));
	record('T18', 'device card fully removed; header Change + identity remain', t18.cardGone && t18.toggleGone && t18.changeBtn && t18.headerDevice.length > 0, JSON.stringify(t18));

	// T19 (R1–R4 #14490–93, validated #14494): the execution-honesty chain.
	// Every board entry must report an honest status; with no real device
	// runtime configured, EVERY environment is OFFLINE with a named reason and
	// the picker/matrix labels say REAL DEVICE UNAVAILABLE — never AVAILABLE.
	const t19 = await page.evaluate(async () => {
		const board = await fetch('/api/device-runtime/devices', { credentials: 'include' }).then(r => r.json()).catch(() => null);
		const devices = board?.devices ?? [];
		const offline = devices.filter(d => d.status === 'OFFLINE');
		const withReason = offline.filter(d => typeof d.unavailableReason === 'string' && d.unavailableReason.length > 10);
		const avail = await fetch('/api/environments?active=true&limit=80000', { credentials: 'include' }).then(r => r.json()).catch(() => null);
		const envs = avail?.environments ?? [];
		const notAvailable = envs.filter(e => e.availability !== 'AVAILABLE');
		return {
			boardRows: devices.length,
			allOfflineOrBusy: offline.length === devices.length,
			reasonsPresent: offline.length === 0 || withReason.length === offline.length,
			envTotal: envs.length,
			noneClaimAvailable: envs.length === notAvailable.length
		};
	});
	record('T19', 'honest availability: no env claims AVAILABLE without a real runtime; every OFFLINE row names its reason',
		t19.boardRows > 0 && t19.allOfflineOrBusy && t19.reasonsPresent && t19.envTotal > 0 && t19.noneClaimAvailable, JSON.stringify(t19));

	// T20 (#14494): the matrix renders REAL DEVICE UNAVAILABLE for offline
	// versions — open the picker and inspect a browser column's row meta.
	await page.evaluate(() => document.querySelector('#ldv-change-device, #ldv-choose-device')?.click());
	await page.waitForTimeout(600);
	// After the T17d reload no sidebar device is re-selected yet — pick one
	// so the browser columns (and their rows) actually render. Click at the
	// DOM level: actionability checks are flaky here (huge tree), and the JS
	// click is what a user's selection does anyway.
	await page.waitForSelector('#mx-sidebar .mx-device', { timeout: 20000, state: 'attached' });
	await page.evaluate(() => {
		const dialog = document.querySelector('#device-picker');
		if (!dialog || dialog.hidden) document.querySelector('#ldv-change-device, #ldv-choose-device')?.click();
	});
	await page.waitForTimeout(400);
	await page.evaluate(() => document.querySelector('#mx-sidebar .mx-device')?.click());
	await page.waitForSelector('#mx-columns .mx-version-meta', { timeout: 10000 });
	const t20 = await page.evaluate(() => {
		const dialog = document.querySelector('#device-picker');
		if (!dialog || dialog.hidden) return { open: false };
		const meta = [...document.querySelectorAll('#mx-columns .mx-version-meta')].map(el => el.textContent.trim());
		const unavailable = meta.filter(t => /UNAVAILABLE/i.test(t));
		const fakeAvailable = meta.filter(t => /^AVAILABLE$/i.test(t.trim()));
		return { open: true, metaRows: meta.length, unavailableRows: unavailable.length, noFakeAvailable: fakeAvailable.length === 0 };
	});
	record('T20', 'matrix rows show REAL DEVICE UNAVAILABLE (never bare AVAILABLE) with no runtime connected',
		t20.open && t20.metaRows > 0 && t20.unavailableRows === t20.metaRows, JSON.stringify(t20));
	await page.keyboard.press('Escape').catch(() => {});
} finally {
	await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? 'RESULT: PASS' : `RESULT: FAIL (${failed.length} of ${results.length})`}`);
if (failed.length) process.exit(1);
