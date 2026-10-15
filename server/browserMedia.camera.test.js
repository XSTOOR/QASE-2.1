/**
 * RT4 (#14756) · media unit tests — verdict mapping, engine capability,
 * honest UNAVAILABLE reasons. No browser launch (integration covers that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	SYNTHETIC_MEDIA_UNAVAILABLE_REASON,
	syntheticMediaCapability,
	mediaProbeVerdict
} from './browserMedia.js';

test('synthetic media capability is honest per engine', () => {
	const chromium = syntheticMediaCapability('chromium');
	assert.equal(chromium.available, true);
	assert.equal(chromium.reason, null);

	for (const engine of ['webkit', 'firefox']) {
		const capability = syntheticMediaCapability(engine);
		assert.equal(capability.available, false, `${engine} must not claim synthetic media`);
		assert.ok(capability.reason.length > 40, `${engine} reason must be explicit`);
		assert.match(capability.reason, /Chromium-only/i);
		assert.match(capability.reason, /UNAVAILABLE/i);
	}

	const unknown = syntheticMediaCapability('enginename-that-does-not-exist');
	assert.equal(unknown.available, false);
	assert.match(unknown.reason, /enginename-that-does-not-exist/);
});

test('frozen verbatim reasons stay stable (they appear verbatim in results)', () => {
	assert.ok(SYNTHETIC_MEDIA_UNAVAILABLE_REASON.webkit.includes('WebKit exposes no fake-device launch flag'));
	assert.ok(SYNTHETIC_MEDIA_UNAVAILABLE_REASON.firefox.includes('Firefox headless'));
});

test('mediaProbeVerdict maps outcomes to the honest vocabulary', () => {
	const capability = syntheticMediaCapability('chromium');

	// Real capture with detected signal → GRANTED.
	assert.deepEqual(
		mediaProbeVerdict({ outcome: 'captured', signalDetected: true }, capability),
		{ status: 'GRANTED', reason: null }
	);

	// Capture opened but no signal in frames → EXECUTION_FAILED (never PASS).
	const noSignal = mediaProbeVerdict({ outcome: 'captured', signalDetected: false }, capability);
	assert.equal(noSignal.status, 'EXECUTION_FAILED');
	assert.match(noSignal.reason, /no signal/);

	// Denial path executed correctly → DENIED (distinct from failure).
	const denied = mediaProbeVerdict({ outcome: 'rejected', error: 'NotAllowedError' }, capability);
	assert.equal(denied.status, 'DENIED');
	assert.match(denied.reason, /denied/i);

	// Missing device → EXECUTION_FAILED.
	assert.equal(mediaProbeVerdict({ outcome: 'rejected', error: 'NotFoundError' }, capability).status, 'EXECUTION_FAILED');

	// Other rejection → EXECUTION_FAILED with the error name.
	const timeout = mediaProbeVerdict({ outcome: 'rejected', error: 'TimeoutError' }, capability);
	assert.equal(timeout.status, 'EXECUTION_FAILED');
	assert.match(timeout.reason, /TimeoutError/);

	// No probe result → EXECUTION_FAILED.
	assert.equal(mediaProbeVerdict(null, capability).status, 'EXECUTION_FAILED');
});

test('mediaProbeVerdict puts engine-unavailable FIRST — a probe result can never outrank it', () => {
	const capability = syntheticMediaCapability('webkit');
	// Even a "successful" probe against an unavailable engine is UNAVAILABLE.
	assert.equal(mediaProbeVerdict({ outcome: 'captured', signalDetected: true }, capability).status, 'UNAVAILABLE');
	assert.equal(mediaProbeVerdict({ outcome: 'rejected', error: 'NotAllowedError' }, capability).status, 'UNAVAILABLE');
	assert.match(mediaProbeVerdict(null, capability).reason, /Chromium-only/);
});
