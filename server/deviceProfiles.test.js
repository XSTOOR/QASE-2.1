import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_PROFILES, DEFAULT_DEVICE_ID, isDeviceId, getDeviceProfile, publicDeviceProfile, contextOptionsFor, describeDeviceForPrompt } from './deviceProfiles.js';

test('DEFAULT_DEVICE_ID is desktop', () => {
	assert.equal(DEFAULT_DEVICE_ID, 'desktop');
});

test('every profile has viewport, kind, id, label', () => {
	for (const profile of DEVICE_PROFILES) {
		assert.ok(profile.id, 'id');
		assert.ok(profile.label, 'label');
		assert.ok(['desktop', 'mobile', 'tablet'].includes(profile.kind), 'kind');
		assert.ok(profile.viewport?.width > 0 && profile.viewport?.height > 0, 'viewport');
	}
});

test('isDeviceId accepts known ids and rejects unknown', () => {
	assert.equal(isDeviceId('desktop'), true);
	assert.equal(isDeviceId('iphone-15-pro'), true);
	assert.equal(isDeviceId('not-a-device'), false);
	assert.equal(isDeviceId(undefined), false);
	assert.equal(isDeviceId(null), false);
	assert.equal(isDeviceId(123), false);
});

test('getDeviceProfile falls back to the default profile', () => {
	assert.equal(getDeviceProfile('bogus').id, DEFAULT_DEVICE_ID);
	assert.equal(getDeviceProfile('iphone-15-pro').id, 'iphone-15-pro');
});

test('publicDeviceProfile is a bounded shape without internal descriptor', () => {
	const dto = publicDeviceProfile('iphone-15-pro');
	assert.deepEqual(Object.keys(dto).sort(), ['hasTouch', 'id', 'isMobile', 'kind', 'label', 'viewport'].sort());
	assert.equal(dto.isMobile, true);
	assert.equal(dto.hasTouch, true);
});

test('contextOptionsFor(desktop) is undefined so the SDK keeps its own defaults', () => {
	assert.equal(contextOptionsFor('desktop'), undefined);
});

test('contextOptionsFor(mobile) returns real emulation options, not just a viewport', () => {
	const options = contextOptionsFor('iphone-15-pro');
	assert.ok(options.userAgent && /iPhone/.test(options.userAgent), 'mobile UA');
	assert.equal(options.isMobile, true);
	assert.equal(options.hasTouch, true);
	assert.equal(options.deviceScaleFactor, 3);
	assert.equal(options.viewport.width, 393);
	assert.equal(options.viewport.height, 852);
	assert.equal(options.acceptDownloads, true);
});

test('describeDeviceForPrompt is empty for desktop and non-trivial for mobile', () => {
	assert.equal(describeDeviceForPrompt('desktop'), '');
	const text = describeDeviceForPrompt('iphone-15-pro');
	assert.match(text, /Emulated device/);
	assert.match(text, /touch/i);
	assert.match(text, /not a resized desktop window/);
});

test('new presets are present with plausible viewport shapes', () => {
	const ids = new Set(DEVICE_PROFILES.map(p => p.id));
	assert.ok(ids.has('iphone-15-pro-max'));
	assert.ok(ids.has('galaxy-s24'));
	assert.ok(ids.has('ipad-pro-11'));
	const ipad = getDeviceProfile('ipad-pro-11');
	assert.equal(ipad.kind, 'tablet');
	assert.equal(ipad.viewport.width, 834);
});

test('contextOptionsFor with landscape swaps viewport dimensions', () => {
	const portrait = contextOptionsFor('iphone-15-pro');
	const landscape = contextOptionsFor('iphone-15-pro', { landscape: true });
	assert.equal(portrait.viewport.width, 393);
	assert.equal(portrait.viewport.height, 852);
	assert.equal(landscape.viewport.width, 852);
	assert.equal(landscape.viewport.height, 393);
});

test('describeDeviceForPrompt says landscape when requested and includes swapped dims', () => {
	const text = describeDeviceForPrompt('ipad-pro-11', { landscape: true });
	assert.match(text, /landscape/);
	assert.match(text, /1194.*834/);
});

test('desktop ignores landscape flag and remains passthrough', () => {
	assert.equal(contextOptionsFor('desktop', { landscape: true }), undefined);
	assert.equal(describeDeviceForPrompt('desktop', { landscape: true }), '');
});
