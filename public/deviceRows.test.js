import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';

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
test('device controls have an explicit selected state and replace rather than accumulate', () => {
	const h = pickerHarness(); h.click('device-Google|android|Pixel 9'); assert.deepEqual(h.ids(), ['phone']);
	assert.equal(h.get('device-Google|android|Pixel 9').attributes['aria-pressed'], 'true');
	h.click('device-Microsoft|windows|Desktop'); assert.deepEqual(h.ids(), ['desktop']);
});
test('device labels retain manufacturer and OS without browser versions', () => {
	const h = pickerHarness(); assert.match(h.text(h.hosts.devices), /Google.*mobile|Google.*Phone/);
	assert.doesNotMatch(h.text(h.hosts.devices), /151|100/);
});
test('unavailable devices are not selectable or presented as supported', () => {
	const h = pickerHarness(); assert.equal(h.nodes().some(n => n.dataset.pickerFocus === 'device-Microsoft|windows|Phone'), false);
});
test('device filtering never clears the selected environment summary', () => {
	const h = pickerHarness(); h.search('no matching device');
	assert.match(h.text(h.hosts.summary), /Desktop/); assert.deepEqual(h.ids(), ['desktop']);
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
