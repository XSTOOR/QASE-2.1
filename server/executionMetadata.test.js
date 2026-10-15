import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExecutionMetadata } from './environmentService.js';
import { generateEnvironments } from './environmentCatalog.js';

test('withExecutionMetadata emits strict execution types and full metadata field set', () => {
	const seeded = generateEnvironments();
	const apple = withExecutionMetadata(seeded.find((e) => e.platform === 'ios'));
	const android = withExecutionMetadata(seeded.find((e) => e.platform === 'android'));
	const windows = withExecutionMetadata(seeded.find((e) => e.platform === 'windows'));

	for (const env of [apple, android, windows]) {
		assert.ok(['REAL_DEVICE', 'VIRTUAL_DEVICE', 'SIMULATED'].includes(env.executionType));
		for (const field of [
			'executionType', 'deviceId', 'deviceManufacturer', 'deviceModel', 'hardwareIdentifier',
			'os', 'osVersion', 'browser', 'browserVersion', 'resolution', 'devicePixelRatio',
			'orientation', 'touchSupport', 'cameraSupport', 'microphoneSupport',
			'screenCaptureSupport', 'gpsSupport', 'networkProfile', 'availability',
			'runtimeSessionId', 'runtimeStatus', 'lastTested', 'lastResult'
		]) {
			assert.ok(field in env, `missing field ${field} on ${env.envId}`);
		}
	}
	assert.equal(apple.deviceManufacturer, 'Apple');
	assert.equal(windows.deviceManufacturer, 'Microsoft');
	assert.equal(apple.touchSupport, true);
	assert.equal(windows.touchSupport, false);
	assert.ok(apple.resolution, 'resolution derived');
	assert.ok(typeof apple.devicePixelRatio === 'number');
});

test('withExecutionMetadata maps legacy records without requested level to VIRTUAL_DEVICE and respects desktop defaults', () => {
	const legacy = withExecutionMetadata({ envId: 'ENV-X', platform: 'windows', device: 'Windows Laptop', deviceType: 'desktop', active: true });
	assert.equal(legacy.executionType, 'VIRTUAL_DEVICE');
	assert.equal(legacy.orientation, 'landscape');
	const simulated = withExecutionMetadata({ envId: 'ENV-Y', platform: 'ios', device: 'iPhone', deviceType: 'mobile', active: true, executionLevelRequested: 'SIMULATED' });
	assert.equal(simulated.executionType, 'SIMULATED');
});

test('sanitizeFilters expands platform groups (Apple/Android/Windows)', async () => {
	const { sanitizeFilters } = await import('./environmentService.js');
	const expanded = sanitizeFilters({ platform: 'ios,ipados,macos' });
	assert.deepEqual(expanded.platformGroup, ['ios', 'ipados', 'macos']);
	assert.equal(expanded.platform, undefined);
	const single = sanitizeFilters({ platform: 'android' });
	assert.equal(single.platform, 'android');
});
