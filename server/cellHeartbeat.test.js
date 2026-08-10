import assert from 'node:assert/strict';
import test from 'node:test';
import { createCellHeartbeatConfig, createCellHeartbeatController, parseCellMetrics } from './cellHeartbeat.js';

const ID = '4a7f5cf0-813d-4e3c-8d5d-4b4b9fc88c10';
const TOKEN = 'heartbeat-test-token-with-at-least-32-bytes';
function environment(overrides = {}) {
	return {
		QASE_CELL_ID: ID,
		QASE_CELL_NAME: 'cell one',
		QASE_CELL_REGION: 'ap-south-1',
		QASE_CELL_PUBLIC_URL: 'https://qase.example.test',
		QASE_CONTROL_URL: 'http://control.qase.svc.cluster.local:5180',
		QASE_CELL_METRICS_URL: 'http://api.qase.svc.cluster.local:5173/metrics',
		QASE_CONTROL_API_WRITE_TOKEN: TOKEN,
		QASE_METRICS_TOKEN: `${TOKEN}-metrics`,
		...overrides
	};
}

test('heartbeat configuration validates identity, endpoints and credentials', () => {
	const config = createCellHeartbeatConfig(environment());
	assert.equal(config.id, ID);
	assert.equal(config.capacityWeight, 100);
	assert.throws(() => createCellHeartbeatConfig(environment({ QASE_CELL_ID: 'bad' })), /canonical UUID/);
	assert.throws(() => createCellHeartbeatConfig(environment({ QASE_CONTROL_API_WRITE_TOKEN: 'short' })), /32 bytes/);
	assert.throws(() => createCellHeartbeatConfig(environment({ QASE_CELL_METRICS_URL: 'http://host/not-metrics' })), /end with \/metrics/);
	assert.throws(() => createCellHeartbeatConfig(environment({ QASE_CELL_PUBLIC_URL: 'http://qase.test' })), /must use HTTPS/);
});

test('metrics parser selects only authoritative queue signals', () => {
	assert.deepEqual(parseCellMetrics([
		'qase_execution_jobs{status="queued"} 17',
		'qase_execution_oldest_queued_age_seconds 2.5',
		'qase_process_uptime_seconds 99'
	].join('\n')), { queueDepth: 17, oldestQueuedAgeSeconds: 2.5 });
	assert.throws(() => parseCellMetrics('qase_process_uptime_seconds 1'), /Required metric/);
});

test('controller registers once then publishes bounded observations', async () => {
	const calls = [];
	const fetchImpl = async (url, options = {}) => {
		calls.push({ url, options });
		if (url.endsWith('/metrics')) return new Response([
			'qase_execution_jobs{status="queued"} 4',
			'qase_execution_oldest_queued_age_seconds 1.25'
		].join('\n'));
		return new Response('{}', { headers: { 'content-type': 'application/json' } });
	};
	let scheduled;
	const controller = createCellHeartbeatController({
		environment: environment(), fetchImpl, now: () => 1_000,
		setTimer: callback => { scheduled = callback; return 1; }, clearTimer: () => undefined,
		random: () => 0.5
	});
	await controller.start();
	assert.equal(calls.length, 3);
	assert.match(calls[0].url, new RegExp(`/cells/${ID}$`));
	assert.deepEqual(JSON.parse(calls[2].options.body), { queueDepth: 4, oldestQueuedAgeSeconds: 1.25 });
	assert.equal(controller.getState().ready, true);
	await scheduled();
	assert.equal(calls.length, 5);
	assert.ok(calls.every(call => !JSON.stringify(call).includes('undefined')));
	controller.stop();
});

test('controller fails closed and never exposes credentials in state', async () => {
	const errors = [];
	const controller = createCellHeartbeatController({
		environment: environment(), fetchImpl: async () => new Response('', { status: 503 }),
		onError: error => errors.push(error.message)
	});
	assert.equal(await controller.runOnce(), false);
	assert.equal(controller.getState().ready, false);
	assert.equal(controller.getState().consecutiveFailures, 1);
	assert.equal(JSON.stringify(controller.getState()).includes(TOKEN), false);
	assert.deepEqual(errors, ['Upstream request failed with HTTP 503.']);
});

test('controller retries registration after an unavailable control plane', async () => {
	let attempts = 0;
	let scheduled;
	const fetchImpl = async url => {
		attempts += 1;
		if (attempts === 1) return new Response('', { status: 503 });
		if (url.endsWith('/metrics')) return new Response([
			'qase_execution_jobs{status="queued"} 0',
			'qase_execution_oldest_queued_age_seconds 0'
		].join('\n'));
		return new Response('{}');
	};
	const controller = createCellHeartbeatController({
		environment: environment(), fetchImpl,
		setTimer: callback => { scheduled = callback; return 1; }, clearTimer: () => undefined,
		random: () => 0.5
	});
	await controller.start();
	assert.equal(controller.getState().registered, false);
	await scheduled();
	assert.equal(controller.getState().registered, true);
	assert.equal(attempts, 4);
	controller.stop();
});
