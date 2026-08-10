import { createHash } from 'node:crypto';

const WORKLOADS = new Set(['control-placement']);
const EVIDENCE_KEYS = new Set([
	'schemaVersion', 'workload', 'targetAlias', 'releaseId', 'startedAt',
	'durationSeconds', 'requests', 'successes', 'failures', 'errorRate',
	'requestsPerSecond', 'latencyMs', 'maximumVus', 'checksPassed'
]);
const LATENCY_KEYS = new Set(['p50', 'p95', 'p99', 'max']);
const POLICY_KEYS = new Set([
	'schemaVersion', 'workload', 'minimumDurationSeconds', 'minimumRequests',
	'minimumRequestsPerSecond', 'maximumErrorRate', 'maximumP95Ms',
	'maximumP99Ms', 'minimumCheckRate'
]);

function object(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
	return value;
}

function exactKeys(value, keys, label) {
	const unknown = Object.keys(value).filter(key => !keys.has(key));
	const missing = [...keys].filter(key => !(key in value));
	if (unknown.length || missing.length) throw new TypeError(`${label} fields are invalid.`);
}

function number(value, label, minimum, maximum, integer = false) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
		throw new TypeError(`${label} is invalid.`);
	}
	return value;
}

function releaseIdentifier(value) {
	if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value) || value.includes('://')) {
		throw new TypeError('releaseId is invalid.');
	}
	return value;
}

function targetAlias(value) {
	if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new TypeError('targetAlias is invalid.');
	return value;
}

function workload(value) {
	if (!WORKLOADS.has(value)) throw new TypeError('workload is unsupported.');
	return value;
}

function close(actual, expected) {
	return Math.abs(actual - expected) <= Math.max(0.000001, Math.abs(expected) * 0.02);
}

export function normalizeCapacityEvidence(input) {
	const value = object(input, 'capacity evidence');
	exactKeys(value, EVIDENCE_KEYS, 'capacity evidence');
	if (value.schemaVersion !== 1) throw new TypeError('capacity evidence schemaVersion is unsupported.');
	const started = new Date(value.startedAt);
	if (typeof value.startedAt !== 'string' || !Number.isFinite(started.getTime()) || started.toISOString() !== value.startedAt) {
		throw new TypeError('startedAt must be a canonical ISO timestamp.');
	}
	const durationSeconds = number(value.durationSeconds, 'durationSeconds', 1, 86_400);
	const requests = number(value.requests, 'requests', 1, 100_000_000, true);
	const successes = number(value.successes, 'successes', 0, requests, true);
	const failures = number(value.failures, 'failures', 0, requests, true);
	if (successes + failures !== requests) throw new TypeError('successes plus failures must equal requests.');
	const errorRate = number(value.errorRate, 'errorRate', 0, 1);
	if (!close(errorRate, failures / requests)) throw new TypeError('errorRate is inconsistent with request counts.');
	const requestsPerSecond = number(value.requestsPerSecond, 'requestsPerSecond', 0, 10_000_000);
	if (!close(requestsPerSecond, requests / durationSeconds)) throw new TypeError('requestsPerSecond is inconsistent with duration and request count.');
	const latency = object(value.latencyMs, 'latencyMs');
	exactKeys(latency, LATENCY_KEYS, 'latencyMs');
	const normalizedLatency = {
		p50: number(latency.p50, 'latencyMs.p50', 0, 3_600_000),
		p95: number(latency.p95, 'latencyMs.p95', 0, 3_600_000),
		p99: number(latency.p99, 'latencyMs.p99', 0, 3_600_000),
		max: number(latency.max, 'latencyMs.max', 0, 3_600_000)
	};
	if (!(normalizedLatency.p50 <= normalizedLatency.p95
		&& normalizedLatency.p95 <= normalizedLatency.p99
		&& normalizedLatency.p99 <= normalizedLatency.max)) throw new TypeError('latency percentiles must be monotonic.');
	return Object.freeze({
		schemaVersion: 1,
		workload: workload(value.workload),
		targetAlias: targetAlias(value.targetAlias),
		releaseId: releaseIdentifier(value.releaseId),
		startedAt: value.startedAt,
		durationSeconds,
		requests,
		successes,
		failures,
		errorRate,
		requestsPerSecond,
		latencyMs: Object.freeze(normalizedLatency),
		maximumVus: number(value.maximumVus, 'maximumVus', 1, 100_000, true),
		checksPassed: number(value.checksPassed, 'checksPassed', 0, 1)
	});
}

export function normalizeCapacityPolicy(input) {
	const value = object(input, 'capacity policy');
	exactKeys(value, POLICY_KEYS, 'capacity policy');
	if (value.schemaVersion !== 1) throw new TypeError('capacity policy schemaVersion is unsupported.');
	const normalized = {
		schemaVersion: 1,
		workload: workload(value.workload),
		minimumDurationSeconds: number(value.minimumDurationSeconds, 'minimumDurationSeconds', 60, 86_400),
		minimumRequests: number(value.minimumRequests, 'minimumRequests', 100, 100_000_000, true),
		minimumRequestsPerSecond: number(value.minimumRequestsPerSecond, 'minimumRequestsPerSecond', 0.1, 10_000_000),
		maximumErrorRate: number(value.maximumErrorRate, 'maximumErrorRate', 0, 0.1),
		maximumP95Ms: number(value.maximumP95Ms, 'maximumP95Ms', 1, 3_600_000),
		maximumP99Ms: number(value.maximumP99Ms, 'maximumP99Ms', 1, 3_600_000),
		minimumCheckRate: number(value.minimumCheckRate, 'minimumCheckRate', 0.9, 1)
	};
	if (normalized.maximumP95Ms > normalized.maximumP99Ms) throw new TypeError('maximumP95Ms cannot exceed maximumP99Ms.');
	return Object.freeze(normalized);
}

export function evaluateCapacityEvidence(evidenceInput, policyInput) {
	const evidence = normalizeCapacityEvidence(evidenceInput);
	const policy = normalizeCapacityPolicy(policyInput);
	if (evidence.workload !== policy.workload) throw new TypeError('Evidence workload does not match capacity policy.');
	const checks = [
		['minimum_duration_seconds', evidence.durationSeconds, policy.minimumDurationSeconds, evidence.durationSeconds >= policy.minimumDurationSeconds],
		['minimum_requests', evidence.requests, policy.minimumRequests, evidence.requests >= policy.minimumRequests],
		['minimum_requests_per_second', evidence.requestsPerSecond, policy.minimumRequestsPerSecond, evidence.requestsPerSecond >= policy.minimumRequestsPerSecond],
		['maximum_error_rate', evidence.errorRate, policy.maximumErrorRate, evidence.errorRate <= policy.maximumErrorRate],
		['maximum_p95_ms', evidence.latencyMs.p95, policy.maximumP95Ms, evidence.latencyMs.p95 <= policy.maximumP95Ms],
		['maximum_p99_ms', evidence.latencyMs.p99, policy.maximumP99Ms, evidence.latencyMs.p99 <= policy.maximumP99Ms],
		['minimum_check_rate', evidence.checksPassed, policy.minimumCheckRate, evidence.checksPassed >= policy.minimumCheckRate]
	].map(([name, actual, threshold, passed]) => Object.freeze({ name, actual, threshold, passed }));
	const evidenceSha256 = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
	return Object.freeze({
		schemaVersion: 1,
		workload: evidence.workload,
		targetAlias: evidence.targetAlias,
		releaseId: evidence.releaseId,
		evidenceSha256,
		passed: checks.every(check => check.passed),
		checks: Object.freeze(checks)
	});
}
