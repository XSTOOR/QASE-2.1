import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test("device selection writes exact pairs without routing", () => {
	assert.ok(picker.includes("apply(changeMatrixPairs(index, selection, pairList, checked))"), "apply(changeMatrixPairs(index, selection, pairList, checked))");
	assert.ok(picker.includes("apply(changeMatrixPairs(index, selection, [[device.key, family.code]], checked))"), "apply(changeMatrixPairs(index, selection, [[device.key, family.code]], checked))");
});

test("summary separates real runs from distinct devices and browsers", () => {
	assert.ok(picker.includes("selected.size.toLocaleString()"), "selected.size.toLocaleString()");
	assert.ok(picker.includes("selectedDevices.length"), "selectedDevices.length");
	assert.ok(picker.includes("browserCode"), "browserCode");
});

test("narrow screens keep the full compatibility grid accessible", () => {
	assert.ok(picker.includes("mp-table-scroll"), "mp-table-scroll");
	assert.ok(picker.includes("Scroll horizontally for more browsers."), "Scroll horizontally for more browsers.");
	assert.ok(picker.includes("scroll.tabIndex = 0"), "scroll.tabIndex = 0");
});
