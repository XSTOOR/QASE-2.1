import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles, model, serverApp] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8'),
	readFile(new URL('./qaConfigMatrix.js', import.meta.url), 'utf8'),
	readFile(new URL('../server/app.js', import.meta.url), 'utf8')
]);

/* #16045: device category chips contract — Phones/Tablets/Desktops dimension
 * composing with platform tabs; server forwards deviceType. */

test('model exports the category vocabulary', () => {
	assert.match(model, /export const DEVICE_CATEGORIES/);
	assert.match(model, /\{ id: 'mobile', label: 'Phones' \}/);
	assert.match(model, /\{ id: 'tablet', label: 'Tablets' \}/);
	assert.match(model, /\{ id: 'desktop', label: 'Desktops' \}/);
});

test('window fetch allow-list includes deviceType', () => {
	assert.match(model, /'browserCode', 'search', 'deviceType'\]/);
});

test('server route forwards deviceType in both branches', () => {
	const routeIndex = serverApp.indexOf("app.get('/api/qa-configurations'");
	// the route handler ends at the next route registration after it
	const nextRoute = serverApp.indexOf('app.get(', routeIndex + 10);
	const routeBlock = serverApp.slice(routeIndex, nextRoute === -1 ? undefined : nextRoute);
	const forwardCount = (routeBlock.match(/deviceType: query\.deviceType/g) ?? []).length;
	assert.equal(forwardCount, 2, 'both groupBy=device and plain branches forward deviceType');
});

test('filters state carries deviceType', () => {
	assert.match(app, /filters: \{ search: '', platform: '', manufacturer: '', osVersion: '', orientation: '', deviceType: '' \}/);
});

test('category chip row renders above the platform tabs', () => {
	assert.match(app, /qa-matrix-category-chips/);
	assert.match(app, /aria-label', 'Device categories'/);
	const categoryIndex = app.indexOf("className = 'qa-matrix-category-chips'");
	const tabsIndex = app.indexOf("className = 'qa-matrix-platform-tabs'");
	assert.ok(categoryIndex !== -1 && tabsIndex !== -1);
	assert.ok(categoryIndex < tabsIndex, 'chips render before platform tabs');
});

test('chips are pressed-state buttons with counts that cross-reference the active platform', () => {
	assert.match(app, /dataset\.role = 'category-chip'/);
	assert.match(app, /chip\.setAttribute\('aria-pressed', String\(activeCategory === id\)\)/);
	// chip counts respect the active platform tab
	assert.match(app, /if \(qaMatrixState\.filters\.platform && configuration\.platform !== qaMatrixState\.filters\.platform\) continue;/);
	// tab counts respect the active category
	assert.match(app, /if \(activeCategory && configuration\.deviceType !== activeCategory\) continue;/);
});

test('chip click resets the window and reloads from offset 0', () => {
	const chipIndex = app.indexOf("chip.dataset.role = 'category-chip'");
	const chipBlock = app.slice(chipIndex, chipIndex + 1600);
	assert.match(chipBlock, /qaMatrixState\.filters\.deviceType = id;/);
	assert.match(chipBlock, /qaMatrixLoadWindow\(0, qaMatrixState\.abort\?\.signal\)/);
});

test('windowed request sends the active category', () => {
	assert.match(app, /deviceType: qaMatrixState\.filters\.deviceType \|\| undefined/);
});

test('styles define chip row, active and focus states', () => {
	assert.match(styles, /\.qa-matrix-category-chips \{/);
	assert.match(styles, /\.qa-matrix-category-chip\.is-active \{/);
	assert.match(styles, /\.qa-matrix-category-chip:focus-visible \{/);
});

/* #16046: grouped sections + popular quick-picks contracts. */

test('shared row builder keeps the pinned row contract', () => {
	// deviceRows.test.js pins these on the FLAT list; the builder must keep
	// them so grouped/popular rendering is identical markup.
	assert.match(app, /const qaMatrixDeviceRow = \(device\) => \{/);
	assert.match(app, /dataset\.role = 'device-row'/);
	assert.match(app, /toggleDevice\(next, device\.key, !selection\.deviceKeys\.has\(device\.key\)\)/);
});

test('grouped sections render when no category is active; single section otherwise', () => {
	assert.match(app, /qa-matrix-device-group-header/);
	assert.match(app, /dataset\.role = 'device-group-header'/);
	assert.match(app, /if \(activeCategory\) \{\s*appendSection\(null, deviceList\);/);
	// the All view splits by DEVICE_CATEGORIES with counts
	assert.match(app, /deviceList\.filter\(\(device\) => device\.deviceType === category\.id\)/);
	assert.match(app, /appendSection\('Other', others\)/);
});

test('popular quick-picks render only catalog-matched curated devices', () => {
	assert.match(app, /const POPULAR_DEVICE_NAMES = \[/);
	assert.match(app, /popularMatches\.length >= 6\) break;/);
	assert.match(app, /configuration\.device === deviceName && isSelectable\(configuration\)/);
	// strip hidden entirely when nothing matches
	assert.match(app, /if \(popularMatches\.length > 0\) \{/);
	assert.match(app, /dataset\.role = 'popular-device'/);
});

test('popular chips reuse the exact device-row semantics in both modes', () => {
	const popularIndex = app.indexOf("dataset.role = 'popular-device'");
	const chipBlock = app.slice(popularIndex - 2000, popularIndex + 3000);
	// same window (row.click) or direct model actions (filtered-out fallback)
	assert.match(app, /qaMatrixDeviceRow\(target\)\.click\(\)/);
	assert.match(app, /toggleDevice\(next, entry\.key, !selection\.deviceKeys\.has\(entry\.key\)\)/);
	assert.match(app, /assignDevice\(qaMatrixState\.selection, qaMatrixState\.index, activeFamily, entry\.key\)/);
	// selected state mirrors the device row state
	assert.match(app, /chip\.classList\.toggle\('is-selected', isSelectedPopular\)/);
});

test('styles define popular strip and group headers', () => {
	assert.match(styles, /\.qa-matrix-popular \{/);
	assert.match(styles, /\.qa-matrix-popular-chip\.is-selected \{/);
	assert.match(styles, /\.qa-matrix-device-group-header \{/);
});
