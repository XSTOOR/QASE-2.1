/**
 * RT3 (#14705) · Real device-interaction API tests.
 *
 * Real execution against the live demo fixture page: touch contexts route to
 * the driver's touchscreen API; mouse contexts reject touch gestures with a
 * clear error (never fake success); orientation change is observable in the
 * recorded runtime facts.
 */
import test, { before, after } from 'node:test';
import express from 'express';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mountDefectFixtures } from './defectFixtures.js';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createInteractionApi, INTERACTION_ACTIONS } from './interactionApi.js';
import { generateEnvironments } from './environmentCatalog.js';
import { environmentEmulationOptions } from './browserstackProvider.js';

let FIXTURE_URL;
let fixtureServer;
before(async () => {
	const app = express();
	mountDefectFixtures(app);
	fixtureServer = app.listen(0, '127.0.0.1');
	await once(fixtureServer, 'listening');
	FIXTURE_URL = `http://127.0.0.1:${fixtureServer.address().port}/demo/defects/device-interactions`;
});
after(async () => {
	if (fixtureServer) await new Promise((resolve, reject) => fixtureServer.close(error => error ? reject(error) : resolve()));
});

const IPHONE = generateEnvironments().find((e) => e.envId === 'ENV-IOS-IP17PRO-26.0-SAF-26.0');
const DESKTOP = generateEnvironments().find((e) => e.platform === 'windows' && e.deviceType === 'desktop' && e.browserCode === 'chrome');

async function withInteractionApi(environment, fn) {
	const browser = await chromium.launch();
	try {
		const options = environmentEmulationOptions(environment) ?? {};
		const context = await browser.newContext({
			viewport: options.viewport ?? undefined,
			deviceScaleFactor: options.deviceScaleFactor ?? undefined,
			isMobile: options.isMobile ?? undefined,
			hasTouch: options.hasTouch ?? undefined
		});
		const page = await context.newPage();
		await page.goto(FIXTURE_URL, { waitUntil: 'load', timeout: 30_000 });
		const api = createInteractionApi({ context, page });
		return await fn(api, page);
	} finally {
		await browser.close().catch(() => {});
	}
}

async function ledger(page) {
	const events = await page.locator('#fixture-gesture-ledger').getAttribute('data-events');
	return events ?? '';
}

test('INTERACTION_ACTIONS vocabulary is complete and stable', () => {
	for (const action of ['tap', 'swipe', 'long_press', 'drag_to', 'type', 'press_key', 'scroll', 'upload', 'refresh', 'back', 'rotate', 'click']) {
		assert.ok(INTERACTION_ACTIONS.includes(action), `${action} must be exposed`);
	}
});

test('touch context: tap uses real touchscreen injection and the page records it', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const result = await api.tap('#fixture-tap-btn');
		assert.equal(result.success, true);
		assert.match(result.inputMethod, /touchscreen\.tap/);
		assert.equal(result.touch, true);
		await page.waitForTimeout(250);
		const events = await ledger(page);
		assert.match(events, /(^|,)tap/);
	});
});

test('touch context: long press opens the hold menu via real held input', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const result = await api.longPress('#fixture-longpress-btn', { durationMs: 900 });
		assert.equal(result.success, true);
		assert.equal(result.durationMs, 900);
		await page.waitForTimeout(250);
		const open = await page.locator('#fixture-longpress-menu').evaluate((el) => el.classList.contains('open'));
		assert.equal(open, true, 'long press must open the menu');
		assert.match(await ledger(page), /long_press/);
	});
});

test('touch context: swipe injects real pointer travel and the carousel scrolls', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const result = await api.swipe({ target: '#fixture-swipe-track', direction: 'left', distance: 260 });
		assert.equal(result.success, true);
		assert.equal(result.direction, 'left');
		await page.waitForTimeout(400);
		const scrollLeft = await page.locator('#fixture-swipe-track').evaluate((el) => el.scrollLeft);
		assert.ok(scrollLeft > 20, `carousel must have scrolled, got scrollLeft=${scrollLeft}`);
	});
});

test('touch context: orientation change is observable in the live viewport and runtime facts', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const before = page.viewportSize();
		const result = await api.setOrientation('landscape');
		assert.equal(result.success, true);
		assert.equal(result.status, undefined, 'touch context must not SKIP');
		assert.equal(result.applied, true, 'viewport swap must be applied and proven');
		const after = page.viewportSize();
		assert.equal(after.width, Math.max(before.width, before.height));
		assert.equal(after.height, Math.min(before.width, before.height));
		const observedOrientation = await page.evaluate(() => matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait');
		assert.equal(observedOrientation, 'landscape');
	});
});

test('drag_to reorders the list through real locator drag injection (touch context)', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const result = await api.dragTo('#fixture-drag-a', '#fixture-drag-c');
		assert.equal(result.success, true);
		await page.waitForTimeout(250);
		const order = await page.locator('#fixture-drag-list li').evaluateAll((nodes) => nodes.map((n) => n.id));
		assert.notEqual(order.indexOf('fixture-drag-a'), 0, `Item A must have moved (order: ${order.join(',')})`);
	});
});

test('mouse context: type and press_key reach the page via real keyboard injection', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api, page) => {
		await api.click('#fixture-type-input');
		const typed = await api.type('QA');
		assert.equal(typed.success, true);
		const pressed = await api.pressKey('Enter');
		assert.equal(pressed.success, true);
		await page.waitForTimeout(250);
		const value = await page.locator('#fixture-type-input').inputValue();
		assert.equal(value, 'QA');
		assert.match(await ledger(page), /type:Q/);
	});
});

test('mouse context: wheel scroll moves the real scroll area', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api, page) => {
		await api.click('#fixture-scroll-area');
		const result = await api.scroll({ direction: 'down', amount: 600 });
		assert.equal(result.success, true);
		await page.waitForTimeout(400);
		const scrollTop = await page.locator('#fixture-scroll-area').evaluate((el) => el.scrollTop);
		assert.ok(scrollTop > 50, `scroll area must have moved, scrollTop=${scrollTop}`);
	});
});

test('mouse context capabilities are honest: no touch actions advertised', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api) => {
		const report = await api.reportCapabilities();
		assert.equal(report.hasTouch, false);
		assert.deepEqual(report.available.touch, []);
		assert.ok(report.available.pointer.includes('click'));
		assert.ok(report.available.keyboard.includes('type'));
	});
});

test('mouse context: touch gestures degrade to LABELED pointer input, never fake touch', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api) => {
		// tap on a mouse context executes the pointer equivalent and LABELS it
		// — no code path may report a touch injection that did not happen.
		const result = await api.tap('#fixture-tap-btn');
		assert.equal(result.success, true);
		assert.equal(result.touch, false, 'must not claim touch');
		assert.match(result.inputMethod, /mouse\.click/, 'input method must name the mouse API');
	});
});

test('non-touch rotate returns SKIPPED with a reason, not an error or fake application', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api) => {
		const result = await api.setOrientation('landscape');
		assert.equal(result.status, 'SKIPPED');
		assert.ok(result.reason, 'a reason must be given');
		assert.notEqual(result.applied, true, 'orientation must not be claimed applied');
	});
});

test('upload assigns real files through the file input', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api, page) => {
		const result = await api.uploadFiles('#fixture-file-input', [fileURLToPath(import.meta.url)]);
		assert.equal(result.success, true);
		const files = await page.locator('#fixture-file-input').evaluate((el) => el.files.length);
		assert.equal(files, 1);
		assert.match(await ledger(page), /upload:1/);
	});
});

test('refresh and back are real navigations', { timeout: 60_000 }, async () => {
	await withInteractionApi(DESKTOP, async (api, page) => {
		const reloaded = await api.refresh();
		assert.equal(reloaded.success, true);
		assert.ok(reloaded.observed, 'refresh must observe the page state');
		await page.locator('#fixture-next-page').click();
		await page.waitForLoadState('domcontentloaded');
		const wentBack = await api.back();
		assert.equal(wentBack.success, true);
		assert.ok(wentBack.navigated, 'back must return to the fixture page');
		assert.ok(wentBack.urlAfter.includes('device-interactions'));
	});
});

test('offscreen/missing target refuses with position info, never a silent pass', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api) => {
		await assert.rejects(
			() => api.tap('#fixture-does-not-exist'),
			(error) => {
				assert.equal(error.name, 'GestureTargetNotFound');
				assert.match(error.message, /fixture-does-not-exist/);
				return true;
			}
		);
	});
});

test('capabilities report reflects the touch context truthfully', { timeout: 60_000 }, async () => {
	await withInteractionApi(IPHONE, async (api) => {
		const report = await api.reportCapabilities();
		assert.equal(report.hasTouch, true);
		assert.deepEqual(report.available.touch, ['tap', 'double_tap', 'long_press', 'swipe', 'rotate']);
		assert.equal(report.orientation, 'portrait');
	});
});
