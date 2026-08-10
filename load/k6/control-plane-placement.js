import http from 'k6/http';
import { check } from 'k6';

const ACKNOWLEDGEMENT = 'I_OWN_THIS_STAGING_TARGET';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedNumber(value, fallback, minimum, maximum, label) {
	const result = value === undefined || value === '' ? fallback : Number(value);
	if (!Number.isFinite(result) || result < minimum || result > maximum) throw new Error(`${label} is invalid.`);
	return result;
}

function releaseIdentifier(value) {
	const result = String(value ?? '').trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(result) || result.includes('://')) throw new Error('QASE_RELEASE_ID is invalid.');
	return result;
}

function targetAlias(value) {
	const result = String(value ?? '').trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(result)) throw new Error('QASE_CAPACITY_TARGET_ALIAS is invalid.');
	return result;
}

const rateMultiplier = boundedNumber(__ENV.QASE_CAPACITY_RATE_MULTIPLIER, 1, 0.1, 100, 'QASE_CAPACITY_RATE_MULTIPLIER');
const rate = value => Math.max(1, Math.round(value * rateMultiplier));

export const options = {
	discardResponseBodies: true,
	summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
	scenarios: {
		placement_resolution: {
			executor: 'ramping-arrival-rate',
			startRate: rate(5),
			timeUnit: '1s',
			preAllocatedVUs: Math.min(500, rate(50)),
			maxVUs: Math.min(1_000, rate(200)),
			stages: [
				{ target: rate(10), duration: '2m' },
				{ target: rate(50), duration: '5m' },
				{ target: rate(100), duration: '10m' },
				{ target: rate(200), duration: '5m' },
				{ target: rate(100), duration: '5m' },
				{ target: 0, duration: '2m' }
			]
		}
	},
	thresholds: {
		http_req_failed: [{ threshold: 'rate<0.001', abortOnFail: true, delayAbortEval: '2m' }],
		http_req_duration: ['p(95)<500', 'p(99)<1000'],
		checks: ['rate>0.999']
	}
};

function configuration() {
	if (__ENV.QASE_CAPACITY_ACK !== ACKNOWLEDGEMENT) {
		throw new Error(`QASE_CAPACITY_ACK must exactly equal ${ACKNOWLEDGEMENT}.`);
	}
	let origin;
	try { origin = new URL(String(__ENV.QASE_CAPACITY_CONTROL_URL ?? '').trim()); }
	catch { throw new Error('QASE_CAPACITY_CONTROL_URL must be a valid URL.'); }
	if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
		|| origin.search || origin.hash) throw new Error('Capacity target must be an HTTPS origin without credentials or a path.');
	const allowedHosts = String(__ENV.QASE_CAPACITY_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
	if (allowedHosts.length === 0 || !allowedHosts.includes(origin.hostname.toLowerCase())) {
		throw new Error('Capacity target hostname is not in QASE_CAPACITY_ALLOWED_HOSTS.');
	}
	const organizationId = String(__ENV.QASE_CAPACITY_ORGANIZATION_ID ?? '').toLowerCase();
	const projectId = String(__ENV.QASE_CAPACITY_PROJECT_ID ?? '').toLowerCase();
	if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(projectId) || organizationId === projectId) {
		throw new Error('Capacity organization/project IDs must be distinct canonical UUIDs.');
	}
	const token = String(__ENV.QASE_CONTROL_API_READ_TOKEN ?? '').trim();
	if (token.length < 32) throw new Error('QASE_CONTROL_API_READ_TOKEN must contain at least 32 characters.');
	return {
		url: `${origin.origin}/internal/v1/placements/${organizationId}/${projectId}`,
		token,
		targetAlias: targetAlias(__ENV.QASE_CAPACITY_TARGET_ALIAS),
		releaseId: releaseIdentifier(__ENV.QASE_RELEASE_ID)
	};
}

export function setup() {
	return configuration();
}

export default function (config) {
	const response = http.get(config.url, {
		headers: { Authorization: `Bearer ${config.token}` },
		redirects: 0,
		tags: { name: '/internal/v1/placements/:organizationId/:projectId' },
		timeout: '5s'
	});
	check(response, { 'placement resolved': candidate => candidate.status === 200 });
}

function value(data, metric, statistic, fallback = 0) {
	return Number(data.metrics?.[metric]?.values?.[statistic] ?? fallback);
}

export function handleSummary(data) {
	const publicConfig = configuration();
	const requests = Math.round(value(data, 'http_reqs', 'count'));
	const errorRate = value(data, 'http_req_failed', 'rate');
	const failures = Math.round(requests * errorRate);
	const durationSeconds = Math.max(0, Number(data.state?.testRunDurationMs ?? 0) / 1_000);
	const evidence = {
		schemaVersion: 1,
		workload: 'control-placement',
		targetAlias: publicConfig.targetAlias,
		releaseId: publicConfig.releaseId,
		startedAt: new Date(Date.now() - (durationSeconds * 1_000)).toISOString(),
		durationSeconds,
		requests,
		successes: Math.max(0, requests - failures),
		failures,
		errorRate,
		requestsPerSecond: durationSeconds > 0 ? requests / durationSeconds : 0,
		latencyMs: {
			p50: value(data, 'http_req_duration', 'med'),
			p95: value(data, 'http_req_duration', 'p(95)'),
			p99: value(data, 'http_req_duration', 'p(99)'),
			max: value(data, 'http_req_duration', 'max')
		},
		maximumVus: Math.round(value(data, 'vus_max', 'max')),
		checksPassed: value(data, 'checks', 'rate')
	};
	const outputName = String(__ENV.QASE_CAPACITY_EVIDENCE_FILE ?? 'capacity-evidence.json').trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$/.test(outputName)) throw new Error('QASE_CAPACITY_EVIDENCE_FILE must be a safe JSON filename.');
	return {
		stdout: `${JSON.stringify({ ...evidence, targetUrl: undefined }, null, 2)}\n`,
		[outputName]: JSON.stringify(evidence, null, 2)
	};
}
