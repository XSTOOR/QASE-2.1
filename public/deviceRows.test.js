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

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test("device rows and individual cells use native accessible checkboxes", () => {
	assert.ok(picker.includes("input.type = 'checkbox'"), "input.type = 'checkbox'");
	assert.ok(picker.includes("input.indeterminate"), "input.indeterminate");
	assert.ok(picker.includes("All selected browsers on"), "All selected browsers on");
	assert.ok(picker.includes("changeMatrixPairs(index, selection, [[device.key, family.code]], checked)"), "changeMatrixPairs(index, selection, [[device.key, family.code]], checked)");
});

test("device compatibility appears in a semantic table with OS metadata", () => {
	assert.ok(picker.includes("el('table', 'mp-table')"), "el('table', 'mp-table')");
	assert.ok(picker.includes("deviceCell.scope = 'row'"), "deviceCell.scope = 'row'");
	assert.ok(picker.includes("device.manufacturer"), "device.manufacturer");
	assert.ok(picker.includes("Filter operating system"), "Filter operating system");
});

test("unavailable cells are disabled with the catalog explanation", () => {
	assert.ok(picker.includes("input.disabled = available.length === 0"), "input.disabled = available.length === 0");
	assert.ok(picker.includes("availabilityReason"), "availabilityReason");
	assert.ok(picker.includes("This combination is unavailable."), "This combination is unavailable.");
});

test("large device catalogs are progressively disclosed without capping execution", () => {
	assert.ok(picker.includes("filtered.slice(0, view.limit)"), "filtered.slice(0, view.limit)");
	assert.ok(picker.includes("Show 10 more devices"), "Show 10 more devices");
	assert.ok(picker.includes("computeExplicitSelection(index, selection)"), "computeExplicitSelection(index, selection)");
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
