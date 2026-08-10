import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCapacityEvidence, normalizeCapacityEvidence, normalizeCapacityPolicy } from './capacityEvidence.js';

function evidence(overrides = {}) {
	return {
		schemaVersion: 1,
		workload: 'control-placement',
		targetAlias: 'staging-cell-a',
		releaseId: 'sha256:reviewed-image',
		startedAt: '2026-08-11T00:00:00.000Z',
		durationSeconds: 1_000,
		requests: 100_000,
		successes: 99_950,
		failures: 50,
		errorRate: 0.0005,
		requestsPerSecond: 100,
		latencyMs: { p50: 50, p95: 200, p99: 400, max: 900 },
		maximumVus: 200,
		checksPassed: 0.9995,
		...overrides
	};
}
function policy(overrides = {}) {
	return {
		schemaVersion: 1,
		workload: 'control-placement',
		minimumDurationSeconds: 900,
		minimumRequests: 10_000,
		minimumRequestsPerSecond: 50,
		maximumErrorRate: 0.001,
		maximumP95Ms: 500,
		maximumP99Ms: 1_000,
		minimumCheckRate: 0.999,
		...overrides
	};
}

test('valid evidence passes every explicit capacity threshold with a stable hash', () => {
	const first = evaluateCapacityEvidence(evidence(), policy());
	const second = evaluateCapacityEvidence(evidence(), policy());
	assert.equal(first.passed, true);
	assert.ok(first.checks.every(check => check.passed));
	assert.match(first.evidenceSha256, /^[0-9a-f]{64}$/);
	assert.equal(first.evidenceSha256, second.evidenceSha256);
	assert.doesNotMatch(JSON.stringify(first), /https:|token|authorization/i);
});

test('policy failures are reported without changing or hiding measurements', () => {
	const report = evaluateCapacityEvidence(evidence(), policy({ maximumP95Ms: 100 }));
	assert.equal(report.passed, false);
	assert.deepEqual(report.checks.find(check => check.name === 'maximum_p95_ms'), {
		name: 'maximum_p95_ms', actual: 200, threshold: 100, passed: false
	});
});

test('evidence rejects unknown fields and internally inconsistent measurements', () => {
	assert.throws(() => normalizeCapacityEvidence(evidence({ authorization: 'must-not-survive' })), /fields are invalid/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ successes: 99_949 })), /must equal requests/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ errorRate: 0.02 })), /inconsistent/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ requestsPerSecond: 1 })), /inconsistent/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ latencyMs: { p50: 10, p95: 9, p99: 20, max: 30 } })), /monotonic/);
	assert.throws(() => normalizeCapacityPolicy(policy({ unexpected: true })), /fields are invalid/);
	assert.throws(() => normalizeCapacityPolicy(policy({ maximumP95Ms: 2_000, maximumP99Ms: 1_000 })), /cannot exceed/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ targetAlias: 'https://staging.example' })), /targetAlias/);
	assert.throws(() => normalizeCapacityEvidence(evidence({ releaseId: 'https://release.example' })), /releaseId/);
});
