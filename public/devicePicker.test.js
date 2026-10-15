import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	buildDeviceCards,
	filterDeviceCards,
	resolveDeviceEnvironment,
	cardBadge,
	platformGroupFor,
	rankEnvironments,
	browsersForOS,
	executionTypeText
} from './devicePicker.js';

const env = (over) => ({
	active: true, platform: 'ios', device: 'iPhone 17 Pro', deviceType: 'mobile',
	os: 'iOS', osVersion: '26.0', browser: 'Safari', browserVersion: '26.0', ...over
});
const ENVIRONMENTS = [
	env({ envId: 'A1' }),
	env({ envId: 'A2', browser: 'Chrome', browserVersion: '154.0' }),
	env({ envId: 'A3', osVersion: '25.0' }),
	{ ...env({ envId: 'P1', platform: 'android', device: 'Pixel 9', deviceType: 'mobile', os: 'Android', osVersion: '16', browser: 'Chrome', browserVersion: '154.0' }) },
	{ ...env({ envId: 'W1', platform: 'windows', device: 'Windows 11 Laptop', deviceType: 'desktop', os: 'Windows', osVersion: '11', browser: 'Edge', browserVersion: '154.0' }) },
	{ ...env({ envId: 'T1', platform: 'ipados', device: 'iPad Pro 13', deviceType: 'tablet', os: 'iPadOS', osVersion: '26.0', browser: 'Safari', browserVersion: '26.0' }) }
];

test('buildDeviceCards groups by device with honest badges and alternatives', () => {
	const board = new Map([['A1', { status: 'AVAILABLE', maximumLevel: 'REAL_DEVICE' }]]);
	const cards = buildDeviceCards(ENVIRONMENTS, board);
	assert.equal(cards.length, 4);
	const iphone = cards.find((c) => c.device === 'iPhone 17 Pro');
	assert.equal(iphone.group, 'apple');
	assert.equal(iphone.envCount, 3);
	assert.deepEqual(iphone.osVersions.sort(), ['25.0', '26.0']);
	assert.equal(iphone.browsers.length, 2);
	assert.equal(iphone.availability, 'AVAILABLE');
	assert.equal(iphone.maximumLevel, 'REAL_DEVICE');
	// Apple first, then Android, then Windows (group order)
	assert.deepEqual(cards.map((c) => c.group).filter((g, i, a) => a.indexOf(g) === i), ['apple', 'android', 'windows']);
});

test('rankEnvironments prefers attested level then newest osVersion', () => {
	const ranked = rankEnvironments([
		env({ envId: 'OLD', osVersion: '25.0' }),
		env({ envId: 'NEW', osVersion: '26.0' }),
		env({ envId: 'ATTESTED', osVersion: '26.0', runtimeAttestedLevel: 'REAL_DEVICE' })
	]);
	assert.equal(ranked[0].envId, 'ATTESTED');
	assert.equal(ranked[1].envId, 'NEW');
});

test('resolveDeviceEnvironment auto-resolves and follows browser/os overrides', () => {
	// AC1: device selection resolves the best env.
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'iPhone 17 Pro' }).envId, 'A1');
	// AC2: browser change re-resolves to the Chrome env.
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'iPhone 17 Pro', browser: 'Chrome' }).envId, 'A2');
	// AC3: device change switches everything.
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'Pixel 9' }).envId, 'P1');
	// osVersion constraint works.
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'iPhone 17 Pro', osVersion: '25.0' }).envId, 'A3');
	// Unknown combination falls back to the device's best env — never invented.
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'Pixel 9', browser: 'Safari' }).envId, 'P1');
	assert.equal(resolveDeviceEnvironment(ENVIRONMENTS, { device: 'Nokia 3310' }), null);
});

test('#14474: browserVersion override pins the exact matrix row (column click path)', () => {
	// Regression: matrix column rows pass {osVersion, browser, browserVersion};
	// without a version filter the resolver re-picked its ranked default
	// (Chrome 140 instead of the clicked Chrome 153/156).
	const many = [
		{ ...env({ envId: 'PX0', platform: 'android', device: 'Pixel 9', os: 'Android', osVersion: '16', browser: 'Chrome', browserVersion: '140.0' }) },
		{ ...env({ envId: 'PX1', platform: 'android', device: 'Pixel 9', os: 'Android', osVersion: '16', browser: 'Chrome', browserVersion: '153.0' }) },
		{ ...env({ envId: 'PX2', platform: 'android', device: 'Pixel 9', os: 'Android', osVersion: '16', browser: 'Chrome', browserVersion: '156.0' }) }
	];
	assert.equal(resolveDeviceEnvironment(many, { device: 'Pixel 9', osVersion: '16', browser: 'Chrome', browserVersion: '153.0' }).envId, 'PX1');
	assert.equal(resolveDeviceEnvironment(many, { device: 'Pixel 9', osVersion: '16', browser: 'Chrome', browserVersion: '156.0' }).envId, 'PX2');
	// Unknown combo (no such version) falls back to the device's best, never null.
	assert.ok(resolveDeviceEnvironment(many, { device: 'Pixel 9', browser: 'Chrome', browserVersion: '999.0' }));
});

test('filterDeviceCards: search, platform, device type', () => {
	const cards = buildDeviceCards(ENVIRONMENTS);
	assert.equal(filterDeviceCards(cards, { search: 'pixel' }).length, 1);
	assert.equal(filterDeviceCards(cards, { platform: 'apple' }).length, 2); // iPhone + iPad
	assert.equal(filterDeviceCards(cards, { deviceType: 'desktop' }).length, 1);
	assert.equal(filterDeviceCards(cards, { platform: 'windows', search: 'edge' }).length, 1);
	assert.equal(filterDeviceCards(cards, {}).length, 4);
	// #14151: search matches ANY supported browser, not only the card's best
	// env. The iPhone's best env is Safari — 'chrome' must still find it.
	assert.ok(filterDeviceCards(cards, { search: 'chrome' }).some((c) => c.device === 'iPhone 17 Pro'));
});

test('cardBadge is honest: real only when the board attests it', () => {
	const real = cardBadge({ maximumLevel: 'REAL_DEVICE', availability: 'AVAILABLE' });
	assert.equal(real.level, 'REAL DEVICE');
	assert.equal(real.availability, 'AVAILABLE');
	const none = cardBadge({ maximumLevel: null, availability: null });
	assert.equal(none.level, 'SIMULATED');
	const busy = cardBadge({ maximumLevel: 'REAL_DEVICE', availability: 'BUSY' });
	assert.equal(busy.availability, 'BUSY');
	assert.equal(platformGroupFor({ platform: 'ipados' }), 'apple');
});

test('browsersForOS lists only browsers that exist for device + OS', () => {
	const cards = buildDeviceCards(ENVIRONMENTS);
	const iphone = cards.find((c) => c.device === 'iPhone 17 Pro');
	// Device-wide: Safari + Chrome across both OS versions.
	assert.equal(iphone.browsers.length, 2);
	// On iOS 26.0: Safari 26 and Chrome 154 both exist.
	assert.equal(browsersForOS(iphone, '26.0').length, 2);
	// On iOS 25.0: only Safari exists as an active env — Chrome is not offered.
	assert.deepEqual(browsersForOS(iphone, '25.0').map((b) => b.browser), ['Safari']);
	// Unknown OS falls back to the device-wide list, never an empty picker.
	assert.equal(browsersForOS(iphone, null).length, 2);
});

test('executionTypeText is honest and never name-inferred', () => {
	assert.equal(executionTypeText({ executionType: 'REAL_DEVICE' }), 'REAL DEVICE');
	assert.equal(executionTypeText({ executionType: 'SIMULATED' }), 'SIMULATED');
	// No verified runtime facts at all → VIRTUAL (never claims REAL).
	assert.equal(executionTypeText({}), 'VIRTUAL DEVICE');
	assert.equal(executionTypeText(null), 'VIRTUAL DEVICE');
});
