import assert from 'node:assert/strict';
import test from 'node:test';
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
test("summary shows the exact global run total, not a theoretical cross product", () => {
	assert.ok(picker.includes("selected.size.toLocaleString()"), "selected.size.toLocaleString()");
	assert.ok(picker.includes("selectedDevices.length"), "selectedDevices.length");
	assert.ok(picker.includes("new Set(index.filter(row => selected.has(row.envId)).map(row => row.browserCode)).size"), "new Set(index.filter(row => selected.has(row.envId)).map(row => row.browserCode)).size");
});

test("zero states tell users how to select a valid combination", () => {
	assert.ok(picker.includes("Choose at least one browser above"), "Choose at least one browser above");
	assert.ok(picker.includes("No configurations selected yet."), "No configurations selected yet.");
	assert.ok(picker.includes("No matching devices. Reset filters"), "No matching devices. Reset filters");
});

test("large selections explain runtime cost and batching", () => {
	assert.ok(picker.includes("MATRIX_BATCH_SIZE"), "MATRIX_BATCH_SIZE");
	assert.ok(picker.includes("Math.ceil(selected.size / MATRIX_BATCH_SIZE)"), "Math.ceil(selected.size / MATRIX_BATCH_SIZE)");
	assert.ok(picker.includes("More configurations take longer"), "More configurations take longer");
});

test("exact review includes all execution dimensions and supports removal", () => {
	assert.ok(picker.includes("config.osVersion"), "config.osVersion");
	assert.ok(picker.includes("config.browserVersion"), "config.browserVersion");
	assert.ok(picker.includes("config.orientation"), "config.orientation");
	assert.ok(picker.includes("executionTypeLabel(config.executionType)"), "executionTypeLabel(config.executionType)");
	assert.ok(picker.includes("ids.delete(config.envId)"), "ids.delete(config.envId)");
});

test("engine-equivalence notes are preserved for selected browser families", () => {
	assert.ok(picker.includes("family.note"), "family.note");
	assert.ok(picker.includes("selection.browserFamilies.has(family.code)"), "selection.browserFamilies.has(family.code)");
	assert.ok(picker.includes("notes.join"), "notes.join");
});
