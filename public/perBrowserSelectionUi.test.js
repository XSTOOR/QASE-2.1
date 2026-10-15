import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test("both modes are explicit and have accessible pressed state", () => {
	assert.ok(picker.includes("Mix & match"), "Mix & match");
	assert.ok(picker.includes("One device per browser"), "One device per browser");
	assert.ok(picker.includes("onePerBrowserSelection(index, selection)"), "onePerBrowserSelection(index, selection)");
	assert.ok(picker.includes("aria-pressed"), "aria-pressed");
});

test("every selected browser has its own labeled device dropdown", () => {
	assert.ok(picker.includes("for (const family of chosen)"), "for (const family of chosen)");
	assert.ok(picker.includes("Device for ${family.label}"), "Device for ${family.label}");
	assert.ok(picker.includes("mp-assignment"), "mp-assignment");
});

test("per-browser dropdowns contain only compatible devices and retain filtered assignments", () => {
	assert.ok(picker.includes("device.key === assignedKey"), "device.key === assignedKey");
	assert.ok(picker.includes("device.pairs.get(family.code)?.some(isSelectable)"), "device.pairs.get(family.code)?.some(isSelectable)");
	assert.ok(picker.includes("Choose a compatible device"), "Choose a compatible device");
});

test("assignment changes use the validated model and support clearing", () => {
	assert.ok(picker.includes("assignDevice(selection, index, family.code, select.value)"), "assignDevice(selection, index, family.code, select.value)");
	assert.ok(picker.includes("unassignDevice(selection, family.code)"), "unassignDevice(selection, family.code)");
	assert.ok(picker.includes("next.deselectedEnvIds.delete(config.envId)"), "next.deselectedEnvIds.delete(config.envId)");
});

test("mode changes preserve exact selection on returning to grid", () => {
	assert.ok(picker.includes("exactMatrixSelection(index, selected, selection)"), "exactMatrixSelection(index, selected, selection)");
	assert.ok(picker.includes("else if (perBrowser)"), "else if (perBrowser)");
	assert.ok(picker.includes("const pairs = visible.flatMap"), "const pairs = visible.flatMap");
});
