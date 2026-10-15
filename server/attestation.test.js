import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeIntegrity, attestationFor } from './qaTools.js';
import { createArtifactStore } from './artifactStore.js';

const baseSession = () => ({
	id: 'run-1',
	environmentSnapshot: { envId: 'ENV-IOS-IP17-26-SAF-26', platform: 'ios', device: 'iPhone 17 Pro', os: 'iOS', osVersion: '26.0', browser: 'Safari', browserVersion: '26.0' },
	activities: [{ id: 'a1', toolName: 'browser_snapshot', status: 'done' }],
	deviceSessionId: 'QASE-DR-AB12',
	runtimeFacts: {
		executionLevel: 'REAL_DEVICE',
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)',
		os: 'iOS',
		capturedAt: '2026-09-30T07:00:00Z',
		runtimeSessionId: 'QASE-DR-AB12',
		attestation: {
			execution_type: 'REAL_DEVICE', device_id: 'iphone-17-pro', manufacturer: 'Apple',
			model: 'iPhone 17 Pro', os: 'iOS', os_version: '26.0', browser: 'Safari', browser_version: '26.0',
			runtime_session_id: 'QASE-DR-AB12', connected_at: '2026-09-30T07:00:00Z', capabilities_verified: true
		}
	}
});

test('runtimeIntegrity: fully attested REAL_DEVICE run passes all 7 checks', () => {
	const result = runtimeIntegrity(baseSession());
	assert.equal(result.ok, true);
	assert.deepEqual(result.failedChecks, []);
});

test('runtimeIntegrity: REAL_DEVICE without attestation fails identity + evidence checks', () => {
	const session = baseSession();
	delete session.runtimeFacts.attestation;
	const result = runtimeIntegrity(session);
	assert.equal(result.ok, false);
	assert.ok(result.failedChecks.includes('deviceIdentityVerified'));
	assert.ok(result.failedChecks.includes('evidenceBelongsToSession'));
	assert.equal(result.reason, 'Device runtime could not be verified.');
});

test('runtimeIntegrity: missing runtime facts fails runtimeConnected', () => {
	const session = baseSession();
	session.runtimeFacts = null;
	session.deviceSessionId = null;
	const result = runtimeIntegrity(session);
	assert.equal(result.ok, false);
	assert.ok(result.failedChecks.includes('runtimeConnected'));
});

test('runtimeIntegrity: no browser execution recorded fails executed check', () => {
	const session = baseSession();
	session.activities = [];
	const result = runtimeIntegrity(session);
	assert.equal(result.ok, false);
	assert.ok(result.failedChecks.includes('executed'));
});

test('attestationFor mirrors the spec shape', () => {
	const att = attestationFor(baseSession());
	assert.equal(att.execution_type, 'REAL_DEVICE');
	assert.equal(att.manufacturer, 'Apple');
	assert.equal(att.model, 'iPhone 17 Pro');
	assert.equal(att.runtime_session_id, 'QASE-DR-AB12');
	assert.equal(att.capabilities_verified, true);
});

test('artifact sidecar carries attestation + evidence header with runtime session', () => {
	const store = createArtifactStore({ root: '.qase/test-artifacts-d3' });
	const meta = store.save(baseSession(), {
		type: 'screenshot',
		fileName: 'evidence-d3.jpg',
		bytes: Buffer.from('test'),
		label: 'Evidence'
	});
	assert.equal(meta.attestation.execution_type, 'REAL_DEVICE');
	assert.equal(meta.runtimeSessionId, 'QASE-DR-AB12');
	assert.match(meta.evidenceHeader, /^REAL DEVICE · iPhone 17 Pro · iOS 26\.0 · Safari 26\.0 · Runtime QASE-DR-AB12$/);
});
