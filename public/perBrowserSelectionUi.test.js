import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test('browser selection stays mutually exclusive on repeated clicks', () => {
	const h = pickerHarness(); h.click('browser-firefox'); h.click('browser-firefox');
	assert.deepEqual(h.ids(), ['ff']);
});
test('changing browser chooses one compatible device when the previous one is incompatible', () => {
	const h = pickerHarness(); h.click('device-Google|android|Pixel 9'); h.click('browser-firefox');
	assert.deepEqual(h.ids(), ['ff']); assert.match(h.text(h.hosts.summary), /Desktop/);
});
test('switching browser retains filters explicitly even when no matching devices remain', () => {
	const h = pickerHarness(); h.filter('manufacturer', 'Google'); h.click('browser-firefox');
	assert.equal(h.get('manufacturer').value, 'Google'); assert.match(h.text(h.hosts.devices), /no compatible devices/);
	assert.deepEqual(h.ids(), ['ff']);
});
test('custom and recommended modes are distinct from optional checks in the page', async () => {
	const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
	assert.ok(html.indexOf('id="qa-matrix-fieldset"') < html.indexOf('id="qa-customize"'));
	assert.match(html, /Chrome on one default desktop/); assert.doesNotMatch(picker, /Mix & match|One device per browser/);
});
