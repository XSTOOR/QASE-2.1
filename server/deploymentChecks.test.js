import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createPlacementLoadConfig, createReleaseGateConfig, createSmokeConfig,
	runPlacementLoad, runReleaseGate, runSmokeChecks
} from './deploymentChecks.js';

const ORG = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c01';
const PROJECT = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c02';
const TOKEN = 'deployment-check-token-at-least-32-bytes';

test('smoke checks are read-only, bounded and report failures', async () => {
	const config = createSmokeConfig({ QASE_SMOKE_TARGETS: 'api=https://api.test/readyz,control=https://control.test/healthz' });
	const methods = [];
	const results = await runSmokeChecks({ config, fetchImpl: async (_url, options) => {
		methods.push(options.method);
		return methods.length === 1 ? new Response('{}') : new Response('{}', { status: 503 });
	} });
	assert.deepEqual(results.map(result => [result.name, result.ok, result.status]), [
		['api', true, 200], ['control', false, 503]
	]);
	assert.deepEqual(methods, [undefined, undefined]);
	assert.throws(() => createSmokeConfig({ QASE_SMOKE_TARGETS: 'api=https://api.test/admin' }), /unsupported path/);
});

test('placement load probe permits only bounded GET resolution traffic', async () => {
	const config = createPlacementLoadConfig({
		QASE_LOAD_CONTROL_URL: 'https://control.test',
		QASE_LOAD_ORGANIZATION_ID: ORG,
		QASE_LOAD_PROJECT_ID: PROJECT,
		QASE_CONTROL_API_READ_TOKEN: TOKEN,
		QASE_LOAD_REQUESTS: '8',
		QASE_LOAD_CONCURRENCY: '3'
	});
	let inFlight = 0;
	let maximum = 0;
	const report = await runPlacementLoad({ config, fetchImpl: async (_url, options) => {
		assert.match(options.headers.authorization, /^Bearer /);
		assert.equal(options.method, undefined);
		inFlight += 1;
		maximum = Math.max(maximum, inFlight);
		await new Promise(resolve => setTimeout(resolve, 2));
		inFlight -= 1;
		return new Response('{}');
	} });
	assert.equal(report.requests, 8);
	assert.deepEqual(report.statuses, { 200: 8 });
	assert.ok(maximum <= 3);
	assert.equal(JSON.stringify(report).includes(TOKEN), false);
	assert.throws(() => createPlacementLoadConfig({
		QASE_LOAD_CONTROL_URL: 'https://control.test', QASE_LOAD_ORGANIZATION_ID: ORG,
		QASE_LOAD_PROJECT_ID: PROJECT, QASE_CONTROL_API_READ_TOKEN: TOKEN, QASE_LOAD_CONCURRENCY: '201'
	}), /1 to 200/);
});

test('release gate repeats read-only readiness and emits sanitized pass/fail evidence', async () => {
	const config = createReleaseGateConfig({
		QASE_RELEASE_ID: 'sha256:reviewed-image-digest',
		QASE_SMOKE_TARGETS: 'api=https://api.test/readyz,control=https://control.test/readyz',
		QASE_RELEASE_ATTEMPTS: '3', QASE_RELEASE_INTERVAL_MS: '1',
		QASE_RELEASE_MAX_READY_P95_MS: '2000'
	});
	let requests = 0;
	const report = await runReleaseGate({
		config, delay: async () => undefined,
		fetchImpl: async () => {
			requests += 1;
			return new Response('{}', { status: requests === 4 ? 503 : 200 });
		}
	});
	assert.equal(requests, 6);
	assert.equal(report.passed, false);
	assert.equal(report.targets.find(target => target.name === 'control').passed, false);
	assert.equal(JSON.stringify(report).includes('https://'), false);
	assert.throws(() => createReleaseGateConfig({
		QASE_RELEASE_ID: 'unsafe release id', QASE_SMOKE_TARGETS: 'api=https://api.test/readyz'
	}), /release identifier/);
	assert.throws(() => createReleaseGateConfig({
		QASE_RELEASE_ID: 'https://release.example', QASE_SMOKE_TARGETS: 'api=https://api.test/readyz'
	}), /release identifier/);
});
