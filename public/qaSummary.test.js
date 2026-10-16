import assert from 'node:assert/strict';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';
import { readFile } from 'node:fs/promises';

/* #15970 Phase 3 — live summary + Start gating copy. */
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

const { selectionDimensions } = await import(new URL('./qaConfigMatrix.js', import.meta.url));

const config = (envId, browserCode, device, platform = 'ios', manufacturer = 'Apple') => ({
	envId, browserCode, device, platform, manufacturer
});

test('#15970: selectionDimensions counts families, devices, runs', () => {
	const configurations = [
		config('E1', 'chrome', 'iPhone 11'),
		config('E2', 'firefox', 'iPhone 11'),
		config('E3', 'chrome', 'Pixel 10', 'android', 'Google'),
		config('E4', 'safari', 'MacBook Pro', 'macos')
	];
	assert.deepEqual(selectionDimensions(configurations, ['E1', 'E2', 'E3']), {
		families: 2, devices: 2, runs: 3
	});
	assert.deepEqual(selectionDimensions(configurations, []), { families: 0, devices: 0, runs: 0 });
	assert.deepEqual(selectionDimensions(configurations, ['E4']), { families: 1, devices: 1, runs: 1 });
	// Granular deselects reduce the run count (selection model interplay).
	assert.deepEqual(selectionDimensions(configurations, ['E1', 'E2', 'E3'].filter(id => id !== 'E1')), {
		families: 2, devices: 2, runs: 2
	});
});

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test('summary reports one actual selected environment, never a cross product', () => {
	const h = pickerHarness(); assert.equal(h.ids().length, 1); assert.match(h.text(h.hosts.summary), /1 browser · 1 device · 1 test run/);
});
test('empty filters explain how to recover without discarding the selected environment', () => {
	const h = pickerHarness(); h.search('no such device'); assert.match(h.text(h.hosts.devices), /Reset filters/); assert.deepEqual(h.ids(), ['desktop']);
});
test('bulk selections and version review are absent from the customer picker', () => {
	assert.doesNotMatch(picker, /MATRIX_BATCH_SIZE|config.browserVersion|Review exact configurations|Select shown devices/);
	assert.match(app, /selectedCount === 1/);
});
test('review keeps the exact browser and device and permits changing the selection', () => {
	const h = pickerHarness(); h.click('device-Google|android|Pixel 9'); assert.match(h.text(h.hosts.summary), /Pixel 9/);
	h.click('device-Microsoft|windows|Desktop'); assert.deepEqual(h.ids(), ['desktop']);
});
test('engine-equivalence notes remain visible rather than claiming branded hardware', () => {
	assert.match(picker, /catalogFamilies.find/); assert.match(picker, /familyNote/);
	assert.match(picker, /engine_equivalent/); assert.match(picker, /not the branded browser binary/);
	assert.match(picker, /not a physical device/);
});
