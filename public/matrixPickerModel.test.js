import test from 'node:test';
import assert from 'node:assert/strict';
import { createSelectionState, computeExplicitSelection, deviceKeyOf, createSelectionStore } from './qaConfigMatrix.js';
import { changeMatrixPairs, exactMatrixSelection, matrixDevices, matrixRecipe, visibleMatrixDevices, onePerBrowserSelection } from './matrixPickerModel.js';
const row = (id, device, browserCode, extra = {}) => ({ envId: id, device, manufacturer: 'Test', browserCode, browser: browserCode, platform: device === 'Phone' ? 'ios' : 'windows', deviceType: device === 'Phone' ? 'mobile' : 'desktop', availability: 'AVAILABLE', osVersion: '1', browserVersion: '100', ...extra });
const index = [row('dc1', 'Desktop', 'chrome'), row('dc2', 'Desktop', 'chrome', { browserVersion: '101' }), row('df', 'Desktop', 'firefox'), row('pc', 'Phone', 'chrome'), row('ps', 'Phone', 'safari'), row('pf', 'Phone', 'firefox', { availability: 'NOT_SUPPORTED' })];
const key = name => deviceKeyOf(index.find(row => row.device === name));
const ids = state => computeExplicitSelection(index, state).sort();

test('one-device mode keeps already chosen devices instead of switching to catalog defaults', () => {
	const state = exactMatrixSelection(index, ['pc', 'ps']);
	const next = onePerBrowserSelection(index, state);
	assert.equal(next.deviceAssignments.chrome, key('Phone'));
	assert.deepEqual(ids(next), ['pc', 'ps']);
});

test('one cell adds only that pair, never unrelated cross-product combinations', () => {
	const original = exactMatrixSelection(index, ['dc1', 'ps']);
	const next = changeMatrixPairs(index, original, [[key('Phone'), 'chrome']], true);
	assert.deepEqual(ids(next), ['dc1', 'pc', 'ps']);
	assert.deepEqual(ids(original), ['dc1', 'ps'], 'input state is immutable');
});
test('a partial cell selects all its versions, and clearing removes only that cell', () => {
	const start = exactMatrixSelection(index, ['dc1', 'ps']);
	const checked = changeMatrixPairs(index, start, [[key('Desktop'), 'chrome']], true);
	assert.deepEqual(ids(checked), ['dc1', 'dc2', 'ps']);
	assert.deepEqual(ids(changeMatrixPairs(index, checked, [[key('Desktop'), 'chrome']], false)), ['ps']);
});
test('unsupported combinations never become selected', () => {
	assert.deepEqual(ids(changeMatrixPairs(index, createSelectionState(), [[key('Phone'), 'firefox']], true)), []);
});
test('bulk actions touch only explicitly shown pairs and retain off-screen selections', () => {
	const state = exactMatrixSelection(index, ['ps']);
	const pairs = [[key('Desktop'), 'chrome'], [key('Desktop'), 'firefox']];
	const next = changeMatrixPairs(index, state, pairs, true);
	assert.deepEqual(ids(next), ['dc1', 'dc2', 'df', 'ps']);
	assert.deepEqual(ids(changeMatrixPairs(index, next, pairs, false)), ['ps']);
});
test('device counts deduplicate browser and OS versions', () => {
	assert.equal(matrixDevices(index).length, 2);
	assert.equal(matrixDevices(index)[0].pairs.get('chrome').length, 2);
});
test('recipes choose one real configuration per available category, not every version', () => {
	assert.equal(ids(matrixRecipe(index, 'desktop')).length, 1);
	assert.equal(ids(matrixRecipe(index, 'mobile')).length, 1);
	assert.equal(ids(matrixRecipe(index, 'balanced')).length, 2, 'absent tablet is not invented');
	assert.equal(ids(matrixRecipe([], 'balanced')).length, 0);
});
test('filters compose, search versions, and never mutate selection', () => {
	const devices = matrixDevices(index); const selected = new Set(['dc1', 'ps']);
	assert.equal(visibleMatrixDevices(devices, { category: 'mobile', platform: 'ios', search: 'safari', selectedOnly: true }, selected).length, 1);
	assert.equal(visibleMatrixDevices(devices, { search: '101' }, selected)[0].name, 'Desktop');
	assert.equal(visibleMatrixDevices(devices, { search: 'absent' }, selected).length, 0);
	assert.deepEqual([...selected], ['dc1', 'ps']);
});
test('single-config removal does not broaden partial selections', () => {
	const state = exactMatrixSelection(index, ['dc1', 'dc2', 'ps']);
	assert.deepEqual(ids(exactMatrixSelection(index, ['dc2', 'ps'], state)), ['dc2', 'ps']);
});
test('exact pairing selection survives storage and ignores removed catalog entries', () => {
	const memory = new Map(); const storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
	const saved = exactMatrixSelection(index, ['dc1', 'ps']);
	createSelectionStore(storage, () => index).save(saved);
	assert.deepEqual(ids(createSelectionStore(storage, () => index).get()), ['dc1', 'ps']);
	assert.deepEqual(computeExplicitSelection(index.filter(row => row.envId !== 'ps'), saved), ['dc1']);
});
