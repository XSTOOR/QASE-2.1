import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
test("device category counts are unique devices rather than configurations", () => {
	assert.ok(picker.includes("devices.filter(device"), "devices.filter(device");
	assert.ok(picker.includes("device.type === id"), "device.type === id");
	assert.ok(picker.includes("Device categories"), "Device categories");
});

test("category and OS filters compose without changing selections", () => {
	assert.ok(picker.includes("view.category = id; view.limit = 10; render()"), "view.category = id; view.limit = 10; render()");
	assert.ok(picker.includes("view.platform = platform.value; view.limit = 10; render()"), "view.platform = platform.value; view.limit = 10; render()");
});

test("local filtering uses the complete compact index", () => {
	assert.ok(picker.includes("matrixDevices(index)"), "matrixDevices(index)");
	assert.ok(picker.includes("visibleMatrixDevices(devices"), "visibleMatrixDevices(devices");
	assert.ok(picker.includes("filtered.slice(0, view.limit)"), "filtered.slice(0, view.limit)");
});

test("starter recipes replace selection with actual available catalog rows", () => {
	assert.ok(picker.includes("matrixRecipe(index, id)"), "matrixRecipe(index, id)");
	assert.ok(picker.includes("REPLACES SELECTION"), "REPLACES SELECTION");
	assert.ok(picker.includes("pick.disabled = total === 0"), "pick.disabled = total === 0");
});

test("selected-only view preserves selections outside current filters", () => {
	assert.ok(picker.includes("selectedOnly"), "selectedOnly");
	assert.ok(picker.includes("Filters never change your selection"), "Filters never change your selection");
	assert.ok(picker.includes("No matching devices"), "No matching devices");
});
