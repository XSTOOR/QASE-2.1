import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	EXECUTION_LEVELS,
	PLATFORM_RUNTIME_PROFILES,
	platformRuntimeProfile,
	normalizePermissionScenario,
	normalizeOrientationScenario,
	userAgentFor,
	resolveExecutionLevel
} from './deviceRuntimeProfiles.js';

test('execution levels are the three canonical values', () => {
	assert.equal(EXECUTION_LEVELS.SIMULATED, 'SIMULATED');
	assert.equal(EXECUTION_LEVELS.VIRTUAL_DEVICE, 'VIRTUAL_DEVICE');
	assert.equal(EXECUTION_LEVELS.REAL_DEVICE, 'REAL_DEVICE');
});

test('platform runtime profiles exist for every catalog platform and never invent hardware', () => {
	for (const platform of ['ios', 'ipados', 'macos', 'android', 'windows']) {
		const profile = platformRuntimeProfile(platform);
		assert.ok(profile, `${platform} has a runtime profile`);
		assert.ok(Array.isArray(profile.input) && profile.input.length > 0, `${platform} declares input`);
		assert.ok(profile.media.camera && profile.media.microphone, `${platform} declares media`);
	}
	// iOS screen share must be honestly limited/unsupported — never "supported".
	assert.notEqual(PLATFORM_RUNTIME_PROFILES.ios.media.screenShare.supported, true);
	assert.equal(PLATFORM_RUNTIME_PROFILES.ios.media.screenShare.localRuntime, 'unavailable');
	// Unknown platform gets an honest null, not a guessed profile.
	assert.equal(platformRuntimeProfile('webos'), null);
});

test('permission scenario accepts whitelisted names and decisions', () => {
	assert.deepEqual(
		normalizePermissionScenario({ camera: 'deny', microphone: 'allow', notifications: 'ask' }),
		{ camera: 'deny', microphone: 'allow', notifications: 'ask' }
	);
	assert.equal(normalizePermissionScenario(null), null);
	assert.equal(normalizePermissionScenario({}), null);
	// accepts the { scenario: {...} } wrapper too
	assert.deepEqual(normalizePermissionScenario({ scenario: { geolocation: 'deny' } }), { geolocation: 'deny' });
});

test('permission scenario rejects unknown names and bad decisions', () => {
	assert.throws(() => normalizePermissionScenario({ flashlight: 'allow' }), /Unknown permission "flashlight"/);
	assert.throws(() => normalizePermissionScenario({ camera: 'maybe' }), /decision must be one of/);
	assert.throws(() => normalizePermissionScenario('allow'), /object/);
});

test('orientation scenario validates and blocks rotate-during-test on desktops', () => {
	assert.equal(normalizeOrientationScenario('portrait', { deviceType: 'mobile' }), 'portrait');
	assert.equal(normalizeOrientationScenario('landscape', { deviceType: 'tablet' }), 'landscape');
	assert.equal(normalizeOrientationScenario('rotate-during-test', { deviceType: 'mobile' }), 'rotate-during-test');
	assert.throws(
		() => normalizeOrientationScenario('rotate-during-test', { deviceType: 'desktop' }),
		/not valid for desktop/
	);
	assert.throws(() => normalizeOrientationScenario('diagonal'), /portrait, landscape, rotate-during-test/);
	assert.equal(normalizeOrientationScenario(null, { deviceType: 'mobile' }), null);
});

test('userAgentFor builds real mobile UAs per platform, never desktop Chromium for phones', () => {
	const ios = userAgentFor('ios', '18.3', 'safari');
	assert.match(ios, /iPhone; CPU iPhone OS 18_3/);
	assert.match(ios, /Safari\/604/);
	assert.ok(!/Windows NT/.test(ios), 'iOS UA must not look like desktop');

	const android = userAgentFor('android', '15', 'chrome');
	assert.match(android, /Linux; Android 15/);
	assert.match(android, /Chrome\/\d+/);

	const winEdge = userAgentFor('windows', '11', 'edge');
	assert.match(winEdge, /Windows NT 10\.0/);
	assert.match(winEdge, /Edg\//);

	const mac = userAgentFor('macos', 'Sequoia', 'safari');
	assert.match(mac, /Macintosh; Intel Mac OS X/);

	assert.equal(userAgentFor('webos', '1', 'chrome'), null);
});

test('resolveExecutionLevel is evidence-based, never name-based', () => {
	// Local emulation is always SIMULATED — even for an env named "iPhone".
	assert.equal(resolveExecutionLevel({ mode: 'emulated' }), 'SIMULATED');
	assert.equal(resolveExecutionLevel({ mode: 'default' }), 'SIMULATED');
	// Remote runtime without a physical-device attestation is VIRTUAL_DEVICE.
	assert.equal(resolveExecutionLevel({ mode: 'browserstack', realMobileAttested: false }), 'VIRTUAL_DEVICE');
	// REAL DEVICE requires an explicit provider attestation.
	assert.equal(resolveExecutionLevel({ mode: 'browserstack', realMobileAttested: true }), 'REAL_DEVICE');
	// No environment at all cannot claim anything beyond local.
	assert.equal(resolveExecutionLevel({}), 'SIMULATED');
});
