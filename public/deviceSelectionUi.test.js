import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test('device selection updates the exact pair without a routing dependency', () => {
	const h = pickerHarness(); h.click('device-Google|android|Pixel 9');
	assert.deepEqual(h.ids(), ['phone']); assert.equal(h.applications(), 1);
});
test('summary states one browser, one device, one run', () => {
	const h = pickerHarness(); assert.match(h.text(h.hosts.summary), /1 browser · 1 device · 1 test run/);
});
test('narrow devices use a single column, not a horizontal compatibility table', async () => {
	const css = await readFile(new URL('./matrixPicker.css', import.meta.url), 'utf8');
	assert.match(css, /max-width: 540px/); assert.match(css, /mp-device-list.*grid-template-columns: minmax\(0, 1fr\)/);
	assert.doesNotMatch(picker, /el\('table'/);
});
