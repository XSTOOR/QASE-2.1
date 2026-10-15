import assert from 'node:assert/strict';
import test from 'node:test';
import { createOperationalLogger } from './operationalLogger.js';

test('production logger emits bounded structured fields and drops unknown sensitive metadata', () => {
	const lines = [];
	const logger = createOperationalLogger({
		component: 'qase-api', environment: { NODE_ENV: 'production' },
		now: () => new Date('2026-08-11T00:00:00.000Z'), write: line => lines.push(line)
	});
	logger.info('http.request.completed', {
		requestId: 'request-1', method: 'GET', route: '/api/sessions/:id', statusCode: 200,
		durationMs: 12.5, token: 'must-not-appear', body: 'must-not-appear'
	});
	assert.deepEqual(JSON.parse(lines[0]), {
		timestamp: '2026-08-11T00:00:00.000Z', severity: 'info', component: 'qase-api',
		event: 'http.request.completed', requestId: 'request-1', method: 'GET',
		route: '/api/sessions/:id', statusCode: 200, durationMs: 12.5
	});
	assert.doesNotMatch(lines[0], /must-not-appear/);
});

test('logger whitelists keepalive and run-resume diagnostic fields', () => {
	const lines = [];
	const logger = createOperationalLogger({
		component: 'qase-keepalive', environment: { NODE_ENV: 'production' },
		now: () => new Date('2026-08-11T00:00:00.000Z'), write: line => lines.push(line)
	});
	logger.info('keepalive.ping.ok', {
		url: 'https://qase.example.dev/healthz', ip: '203.0.113.7', status: 200,
		intervalMs: 60_000, quietAfterMs: 120_000, snapshotBody: 'must-not-appear'
	});
	assert.deepEqual(JSON.parse(lines[0]), {
		timestamp: '2026-08-11T00:00:00.000Z', severity: 'info', component: 'qase-keepalive',
		event: 'keepalive.ping.ok', url: 'https://qase.example.dev/healthz',
		ip: '203.0.113.7', status: 200, intervalMs: 60_000, quietAfterMs: 120_000
	});
	lines.length = 0;
	logger.info('runresume.resumed', {
		runId: '07d674ce-2774-4091-a86a-2cd735f91cb9', attempt: 2, attempts: 3,
		resumed: 1, reason: 'recovered', outcome: 'continued', transcript: 'must-not-appear'
	});
	assert.deepEqual(JSON.parse(lines[0]), {
		timestamp: '2026-08-11T00:00:00.000Z', severity: 'info', component: 'qase-keepalive',
		event: 'runresume.resumed',
		runId: '07d674ce-2774-4091-a86a-2cd735f91cb9', attempt: 2, attempts: 3,
		resumed: 1, reason: 'recovered', outcome: 'continued'
	});
	assert.doesNotMatch(lines[0], /must-not-appear/);
});

test('logger validates configuration and honors severity thresholds', () => {
	const lines = [];
	const logger = createOperationalLogger({ component: 'qase-worker', level: 'warn', write: line => lines.push(line) });
	logger.info('worker.started', { workerId: 'worker-1' });
	logger.error('worker.failed', { errorName: 'Error' });
	assert.equal(lines.length, 1);
	assert.match(lines[0], /worker.failed/);
	assert.throws(() => createOperationalLogger({ component: 'QASE API' }), /component/);
	assert.throws(() => createOperationalLogger({ component: 'qase-api', format: 'xml' }), /json or text/);
});
