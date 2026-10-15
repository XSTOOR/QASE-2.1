import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	resolveActiveRuntimeEnvironment,
	browserKeyFor,
	parseResolution,
	orientationFor,
	deviceKindFor,
	runtimeStatusFor,
	executionTypeFor,
	viewForSelection
} from './activeRuntimeEnvironment.js';

const ENV = Object.freeze({
	envId: 'ENV-IP17P-IOS26-SAF-26',
	platform: 'ios',
	platformLabel: 'Apple',
	device: 'iPhone 17 Pro',
	os: 'iOS',
	osVersion: '26.0',
	browser: 'Safari',
	browserCode: 'safari',
	browserVersion: '26.0',
	deviceType: 'mobile',
	screenResolution: '1179x2556',
	orientation: 'portrait',
	executionProvider: 'environment',
	active: true
});

test('environment snapshot wins and is shown verbatim (no fallback text)', () => {
	const are = resolveActiveRuntimeEnvironment({
		session: { id: 's1', status: 'running', environmentSnapshot: ENV, device: 'desktop', targetUrl: 'https://example.com' }
	});
	assert.equal(are.device, 'iPhone 17 Pro');
	assert.equal(are.os, 'iOS');
	assert.equal(are.osVersion, '26.0');
	assert.equal(are.browser, 'Safari');
	assert.equal(are.browserVersion, '26.0');
	assert.equal(are.browserKey, 'safari');
	assert.equal(are.deviceType, 'phone');
	assert.equal(are.source, 'environmentSnapshot');
	assert.deepEqual(are.resolution, { width: 1179, height: 2556 });
	assert.equal(are.orientation, 'portrait');
});

test('wrong-device rule: a snapshot never mixes with legacy profile values', () => {
	// Legacy desktop profile present — snapshot must still own the view.
	const are = resolveActiveRuntimeEnvironment({
		session: { id: 's2', status: 'running', environmentSnapshot: ENV, device: 'galaxy-s25' }
	});
	assert.equal(are.device, 'iPhone 17 Pro');
	assert.equal(are.source, 'environmentSnapshot');
});

test('executionType is attestation-gated, never name-inferred', () => {
	// Real-device env but no runtime facts yet → at most simulated.
	const unproven = resolveActiveRuntimeEnvironment({ session: { id: 's3', status: 'running', environmentSnapshot: { ...ENV, executionProvider: 'browserstack', isRealDevice: true } } });
	assert.equal(unproven.executionType, 'simulated');
	assert.equal(unproven.executionTypeAttested, false);

	// Attested real runtime → real_device.
	const real = resolveActiveRuntimeEnvironment({
		session: {
			id: 's4', status: 'running', environmentSnapshot: { ...ENV, executionProvider: 'browserstack', isRealDevice: true },
			runtimeFacts: { executionLevel: 'REAL_DEVICE', provider: 'browserstack', runtimeSessionId: 'RT-1', attestation: { verified: true } }
		}
	});
	assert.equal(real.executionType, 'real_device');
	assert.equal(real.executionTypeAttested, true);

	// Virtual attested → virtual.
	const virt = resolveActiveRuntimeEnvironment({
		session: { id: 's5', status: 'running', runtimeFacts: { executionLevel: 'VIRTUAL_DEVICE' } }
	});
	assert.equal(virt.executionType, 'virtual_device');
});

test('runtime status vocabulary maps session/device-session/availability', () => {
	assert.equal(runtimeStatusFor({ sessionStatus: 'queued' }), 'queued');
	assert.equal(runtimeStatusFor({ deviceSessionStatus: 'created', sessionStatus: 'running' }), 'connecting');
	assert.equal(runtimeStatusFor({ deviceSessionStatus: 'queued' }), 'queued');
	assert.equal(runtimeStatusFor({ sessionStatus: 'awaiting_input' }), 'connected');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running' }), 'running');
	assert.equal(runtimeStatusFor({ sessionStatus: 'done' }), 'completed');
	assert.equal(runtimeStatusFor({ sessionStatus: 'error' }), 'failed');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', availability: 'OFFLINE' }), 'device_unavailable');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', availability: 'NOT_EXECUTABLE' }), 'device_unavailable');
	assert.equal(runtimeStatusFor({}), 'queued');
});

test('a terminal blocked report stays blocked in the live-view status', () => {
	const view = resolveActiveRuntimeEnvironment({
		session: {
			status: 'done',
			report: { verdict: 'blocked' },
			environmentSnapshot: { envId: 'blocked-env', device: 'Desktop', browser: 'Chrome' }
		}
	});
	assert.equal(view.runtimeStatus, 'blocked');
});

test('browser keys cover the required browsers incl. substring fallback', () => {
	assert.equal(browserKeyFor('Safari'), 'safari');
	assert.equal(browserKeyFor('Mobile Safari'), 'safari');
	assert.equal(browserKeyFor('Chrome'), 'chrome');
	assert.equal(browserKeyFor('Firefox'), 'firefox');
	assert.equal(browserKeyFor('Microsoft Edge'), 'edge');
	assert.equal(browserKeyFor('Edge'), 'edge');
	assert.equal(browserKeyFor('Opera'), 'opera');
	assert.equal(browserKeyFor('Brave'), 'brave');
	assert.equal(browserKeyFor('DuckDuckGo'), 'duckduckgo');
	assert.equal(browserKeyFor('Konqueror'), 'other');
	assert.equal(browserKeyFor(''), 'other');
	assert.equal(browserKeyFor(null), 'other');
});

test('resolution parsing and orientation derivation', () => {
	assert.deepEqual(parseResolution('1179x2556'), { width: 1179, height: 2556 });
	assert.deepEqual(parseResolution('2064×2752'), { width: 2064, height: 2752 });
	assert.equal(parseResolution('wide'), null);
	assert.equal(parseResolution(null), null);
	assert.equal(orientationFor({ orientation: 'landscape', resolution: { width: 100, height: 200 } }), 'landscape');
	assert.equal(orientationFor({ resolution: { width: 3840, height: 2160 } }), 'landscape');
	assert.equal(orientationFor({ resolution: { width: 100, height: 200 } }), 'portrait');
	assert.equal(orientationFor({}), 'portrait');
});

test('device kind maps categories and platforms', () => {
	assert.equal(deviceKindFor({ deviceType: 'mobile' }), 'phone');
	assert.equal(deviceKindFor({ deviceType: 'tablet' }), 'tablet');
	assert.equal(deviceKindFor({ deviceType: 'desktop' }), 'desktop');
	assert.equal(deviceKindFor({ platform: 'windows' }), 'desktop');
	assert.equal(deviceKindFor({ platform: 'macos' }), 'desktop');
	assert.equal(deviceKindFor({}), 'phone');
});

test('runtime facts fill gaps when no environment snapshot exists', () => {
	const are = resolveActiveRuntimeEnvironment({
		session: {
			id: 's6', status: 'running',
			runtimeFacts: { deviceName: 'Pixel 9', platform: 'android', viewport: { width: 412, height: 915 }, executionLevel: 'SIMULATED' }
		}
	});
	assert.equal(are.device, 'Pixel 9');
	assert.equal(are.source, 'runtimeFacts');
	assert.deepEqual(are.resolution, { width: 412, height: 915 });
	assert.equal(are.orientation, 'portrait');
});

test('legacy emulation profile resolved via device list, nothing invented otherwise', () => {
	const are = resolveActiveRuntimeEnvironment({
		session: { id: 's7', status: 'idle', device: 'iphone-15' },
		environments: [{ id: 'iphone-15', label: 'iPhone 15', kind: 'mobile' }]
	});
	assert.equal(are.device, 'iPhone 15');
	assert.equal(are.source, 'legacyDevice');
	assert.equal(are.resolution, null);
	assert.equal(are.executionType, 'none');

	const empty = resolveActiveRuntimeEnvironment({ session: { id: 's8', status: 'idle' } });
	assert.equal(empty, null);
});

test('runtime id and board availability travel through', () => {
	const are = resolveActiveRuntimeEnvironment({
		session: { id: 's9', status: 'running', environmentSnapshot: ENV, runtimeFacts: { runtimeSessionId: 'RT-8F21A' } },
		runtimeBoard: [{ envId: ENV.envId, status: 'BUSY' }]
	});
	assert.equal(are.runtimeSessionId, 'RT-8F21A');
	assert.equal(are.runtimeStatus, 'running');
});

test('executionTypeFor edge cases', () => {
	assert.equal(executionTypeFor({ runtimeFacts: null, environment: null }), 'none');
	assert.equal(executionTypeFor({ runtimeFacts: null, environment: ENV }), 'simulated');
	assert.equal(executionTypeFor({ runtimeFacts: { executionLevel: 'SIMULATED' }, environment: ENV }), 'simulated');
});

/* ── viewForSelection (#14077) ──────────────────────────────────────── */

test('viewForSelection returns null for empty selection', () => {
	assert.equal(viewForSelection(null), null);
	assert.equal(viewForSelection(undefined), null);
});

test('viewForSelection mirrors the resolve shape for a store selection', () => {
	const view = viewForSelection({
		envId: 'ENV-X', device: 'iPhone 17 Pro Max', deviceType: 'mobile', platform: 'ios',
		os: 'iOS', osVersion: '26.0', browser: 'Safari', browserVersion: '26.0',
		resolution: '1179x2556', orientation: 'portrait', executionType: 'simulated'
	});
	assert.equal(view.device, 'iPhone 17 Pro Max');
	assert.equal(view.deviceType, 'phone');
	assert.equal(view.os, 'iOS');
	assert.equal(view.osVersion, '26.0');
	assert.equal(view.browser, 'Safari');
	assert.equal(view.browserKey, 'safari');
	assert.deepEqual(view.resolution, { width: 1179, height: 2556 });
	assert.equal(view.orientation, 'portrait');
	assert.equal(view.executionType, 'simulated');
	assert.equal(view.source, 'selection');
});

test('viewForSelection is honest: never attested, unknown device fallback', () => {
	const view = viewForSelection({ device: 'Pixel 9 Pro', deviceType: 'phone', platform: 'android', executionType: 'real_device' });
	assert.equal(view.executionTypeAttested, false, 'selection view must never claim attestation');
	assert.equal(view.device, 'Pixel 9 Pro');
	assert.equal(view.os, null);
	assert.ok(['unknown', 'other'].includes(view.browserKey), 'no browser → neutral key, got ' + view.browserKey);
	assert.equal(view.runtimeStatus, 'queued');
});

test('viewForSelection survives sparse selections with defaults', () => {
	const view = viewForSelection({ device: 'Windows Desktop', deviceType: 'desktop', platform: 'windows' });
	assert.equal(view.executionType, 'none');
	assert.equal(view.orientation, 'portrait'); // default when no orientation/resolution given
	assert.ok(['unknown', 'other'].includes(view.browserKey), 'no browser → neutral key, got ' + view.browserKey);
});
