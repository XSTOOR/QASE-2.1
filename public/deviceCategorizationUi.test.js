import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';

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

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test('compatible device count deduplicates versions', () => {
	const h = pickerHarness(); assert.match(h.text(h.hosts.devices), /2 compatible devices/);
});
test('type, OS and manufacturer filters compose without changing selection', () => {
	const h = pickerHarness(); h.filter('category', 'mobile'); h.filter('platform', 'android'); h.filter('manufacturer', 'Google');
	assert.match(h.text(h.hosts.devices), /1 compatible device/); assert.deepEqual(h.ids(), ['desktop']);
});
test('search uses the complete compatible device list and preserves selection', () => {
	const h = pickerHarness(); h.search('pixel google'); assert.match(h.text(h.hosts.devices), /Pixel 9/);
	assert.deepEqual(h.ids(), ['desktop']);
});
test('multi-device recipes are removed rather than generating hidden jobs', () => {
	const h = pickerHarness(); for (const key of ['recipe-balanced', 'recipe-desktop', 'mode-cross']) assert.equal(h.get(key), undefined);
});
test('empty filters offer reset without clearing the selected pair', () => {
	const h = pickerHarness(); h.filter('platform', 'android'); h.filter('category', 'desktop');
	assert.match(h.text(h.hosts.devices), /No devices match/); h.click('reset-filters');
	assert.deepEqual(h.ids(), ['desktop']); assert.match(h.text(h.hosts.devices), /2 compatible devices/);
});
