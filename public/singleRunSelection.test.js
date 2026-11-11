import test from 'node:test';
import assert from 'node:assert/strict';
import { computeExplicitSelection, createSelectionState, deviceKeyOf } from './qaConfigMatrix.js';
import { preferredConfiguration, normalizeSingleSelection, singleSelection, singleDeviceOptions } from './singleRunSelection.js';

const row = (envId, device, browserCode, extra = {}) => ({ envId, device, browserCode, availability: 'AVAILABLE', deviceType: 'desktop', manufacturer: 'Microsoft', platform: 'windows', browserVersion: '100', osVersion: '10', ...extra });
const index = [row('old', 'Windows Desktop', 'chrome'), row('new', 'Windows Desktop', 'chrome', { browserVersion: '151', osVersion: '11' }), row('laptop', 'Surface Laptop 5', 'chrome'), row('ff', 'Windows Desktop', 'firefox'), row('phone', 'Pixel 9', 'chrome', { platform: 'android', deviceType: 'mobile', manufacturer: 'Google' }), row('blocked', 'Secret phone', 'firefox', { availability: 'UNAVAILABLE' })];
const ids = selection => computeExplicitSelection(index, selection);

test('default desktop is deterministic; latest versions do not create more jobs', () => {
	assert.equal(preferredConfiguration(index.filter(r => r.browserCode === 'chrome')).envId, 'new');
	assert.deepEqual(ids(singleSelection(index, index[1])), ['new']);
});
test('old multi-browser/device preferences migrate to one exact configuration', () => {
	const old = createSelectionState({ deviceKeys: index.map(deviceKeyOf), browserFamilies: ['chrome', 'firefox'] });
	assert.equal(ids(normalizeSingleSelection(index, old)).length, 1);
});
test('switching browser retains a compatible device and never retains another browser', () => {
	const state = normalizeSingleSelection(index, singleSelection(index, index[1]), 'firefox');
	assert.deepEqual(ids(state), ['ff']);
	assert.deepEqual([...state.browserFamilies], ['firefox']);
});
test('switching from an incompatible phone selects a compatible desktop once', () => {
	assert.deepEqual(ids(normalizeSingleSelection(index, singleSelection(index, index[4]), 'firefox')), ['ff']);
});
test('device list deduplicates versions and filters by type, OS, manufacturer and search', () => {
	assert.equal(singleDeviceOptions(index, 'chrome').length, 3);
	assert.deepEqual(singleDeviceOptions(index, 'chrome', { category: 'mobile', platform: 'android', manufacturer: 'Google', search: 'pixel google' }).map(r => r.envId), ['phone']);
	assert.deepEqual(singleDeviceOptions(index, 'firefox').map(r => r.envId), ['ff']);
	assert.deepEqual(singleDeviceOptions(index, 'chrome', { platform: 'android', category: 'desktop' }), []);
});
