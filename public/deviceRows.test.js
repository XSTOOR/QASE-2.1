import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/* #15969 Phase 2 — device selector: platform tabs + one-click rows.
 * Source-assertion suite (the launcher is a browser script), plus unit
 * tests for the new deviceListFromWindow model helper.
 */
const [app, styles, html] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8'),
	readFile(new URL('./index.html', import.meta.url), 'utf8')
]);

test('#15969: device rows are one-click toggles (role=option, aria-selected)', () => {
	assert.match(app, /dataset\.role = 'device-row'/);
	assert.match(app, /qa-matrix-device-row\$\{available \? '' : ' is-unavailable'\}/);
	assert.match(app, /row\.setAttribute\('aria-selected', String\(isSelected\)\)/);
	// Click on the row toggles the device exactly once through the model.
	const rowIndex = app.indexOf("row.dataset.role = 'device-row'");
	const rowBlock = app.slice(rowIndex, app.indexOf("rowList.append(row);"));
	assert.match(rowBlock, /toggleDevice\(next, device\.key, !selection\.deviceKeys\.has\(device\.key\)\)/);
	assert.match(rowBlock, /qaMatrixApplySelection\(next\)/);
});

test('#15969: the old clutter is gone — no checkbox, no View button, no version chips, no scope banner', () => {
	assert.doesNotMatch(app, /dataset\.role = 'device-select'/);
	assert.doesNotMatch(app, /dataset\.role = 'device-view'/);
	assert.doesNotMatch(app, /qa-matrix-scope-banner/);
	assert.doesNotMatch(app, /qa-matrix-version'\)/);
	assert.doesNotMatch(app, /Back to all devices/);
	// The three extra facet dropdowns are gone from the markup.
	assert.doesNotMatch(html, /id="qa-matrix-filter-manufacturer"/);
	assert.doesNotMatch(html, /id="qa-matrix-filter-os"/);
	assert.doesNotMatch(html, /id="qa-matrix-filter-orientation"/);
	assert.doesNotMatch(html, /id="qa-matrix-filter-platform"/);
	// Search input remains.
	assert.match(html, /id="qa-matrix-search"/);
});

test('#15969: platform tabs render with counts and drive the platform filter', () => {
	assert.match(app, /qa-matrix-platform-tabs/);
	assert.match(app, /role', 'tablist'/);
	assert.match(app, /makeTab\('all', 'All', allCount\)/);
	const tabBlock = app.slice(app.indexOf('const makeTab'), app.indexOf('deviceHeader.append(tabGroup);'));
	assert.match(tabBlock, /qaMatrixState\.filters\.platform = id === 'all' \? '' : id/);
	assert.match(tabBlock, /qaMatrixLoadWindow\(0, qaMatrixState\.abort\?\.signal\)/);
});

test('#15969: unavailable devices are disabled with an honest reason', () => {
	const rowIndex = app.indexOf("row.dataset.role = 'device-row'");
	const rowBlock = app.slice(rowIndex, app.indexOf("rowList.append(row);"));
	assert.match(rowBlock, /row\.disabled = true/);
	assert.match(rowBlock, /device\.unavailableReason \?\? 'No available configurations for this device\.'/);
});

test('#15969: styles define tab + row selected/unavailable/focus states', () => {
	assert.match(styles, /\.qa-matrix-platform-tab\.is-active/);
	assert.match(styles, /\.qa-matrix-device-row\.is-selected/);
	assert.match(styles, /\.qa-matrix-device-row\.is-unavailable/);
	assert.match(styles, /\.qa-matrix-device-row:focus-visible/);
	assert.match(styles, /\.qa-matrix-platform-tab:focus-visible/);
});

/* deviceListFromWindow — model unit tests (pure, no DOM). */
const { deviceListFromWindow } = await import(new URL('./qaConfigMatrix.js', import.meta.url));

const row = (overrides = {}) => ({
	envId: 'ENV-1',
	platform: 'ios',
	manufacturer: 'Apple',
	device: 'iPhone 17',
	deviceType: 'mobile',
	os: 'iOS',
	osVersion: '26',
	executionType: 'emulator',
	availability: 'AVAILABLE',
	availabilityReason: null,
	...overrides
});

test('#15969: deviceListFromWindow dedupes rows to one entry per device', () => {
	const list = deviceListFromWindow([
		row(),
		row({ envId: 'ENV-2', browserCode: 'chrome' }),
		row({ envId: 'ENV-3', osVersion: '18', browserCode: 'firefox' })
	]);
	assert.equal(list.length, 1);
	assert.equal(list[0].key, 'Apple|ios|iPhone 17');
	assert.equal(list[0].selectableCount, 3);
	assert.deepEqual(list[0].osVersions, ['26', '18']);
	assert.deepEqual(list[0].executionTypes, ['emulator']);
});

test('#15969: availability rolls up honestly — unavailable reason kept when nothing selectable', () => {
	const list = deviceListFromWindow([
		row({ envId: 'ENV-1', availability: 'NOT_SUPPORTED', availabilityReason: 'Family not supported on this device.' }),
		row({ envId: 'ENV-2', availability: 'UNAVAILABLE', availabilityReason: 'Environment offline.' })
	]);
	assert.equal(list.length, 1);
	assert.equal(list[0].selectableCount, 0);
	assert.equal(list[0].unavailableReason, 'Family not supported on this device.');
	const mixed = deviceListFromWindow([
		row({ envId: 'ENV-1', availability: 'UNAVAILABLE', availabilityReason: 'Offline.' }),
		row({ envId: 'ENV-2' })
	]);
	assert.equal(mixed[0].selectableCount, 1);
	assert.equal(mixed[0].unavailableReason, 'Offline.');
});

test('#15969: distinct devices stay distinct (key includes manufacturer+platform)', () => {
	const list = deviceListFromWindow([
		row(),
		row({ platform: 'android', manufacturer: 'Google', device: 'Pixel 10', os: 'Android', osVersion: '16', executionType: 'physical_device' })
	]);
	assert.equal(list.length, 2);
	assert.deepEqual(list[1].executionTypes, ['physical_device']);
});
