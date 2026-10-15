import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	availabilityMeta,
	executionTypeLabel,
	fallbackOptionsFor,
	describeQueue,
	boardByEnvId,
	lastRunByEnv,
	formatWhen
} from './deviceRuntimeUi.js';

test('availabilityMeta maps known statuses and degrades gracefully', () => {
	assert.equal(availabilityMeta('AVAILABLE').label, 'Available');
	assert.equal(availabilityMeta('BUSY').label, 'Busy');
	assert.equal(availabilityMeta('PREPARING').label, 'Preparing');
	assert.equal(availabilityMeta('RUNNING').label, 'Running');
	assert.equal(availabilityMeta('OFFLINE').label, 'Real device offline');
	assert.equal(availabilityMeta('ERROR').label, 'Error');
	assert.equal(availabilityMeta('UNAVAILABLE').label, 'Unavailable');
	assert.equal(availabilityMeta('NOT_EXECUTABLE').label, 'Not executable');
	// Unknown status renders as offline, never crashes.
	assert.equal(availabilityMeta('garbage').dot, 'offline');
	assert.equal(availabilityMeta(null).dot, 'offline');
});

test('executionTypeLabel renders honest labels per maximum level', () => {
	assert.equal(executionTypeLabel('REAL_DEVICE'), 'Real device');
	assert.equal(executionTypeLabel("VIRTUAL_DEVICE"), "Virtual device");
	assert.equal(executionTypeLabel('SIMULATED'), 'Simulated');
	assert.equal(executionTypeLabel(null), 'Not executable (real)');
	assert.equal(executionTypeLabel(undefined), 'Not executable (real)');
});

test('fallbackOptionsFor: real-device request with a provider and free device starts directly', () => {
	const board = { envId: 'E', status: 'AVAILABLE', maximumLevel: 'REAL_DEVICE' };
	const result = fallbackOptionsFor(board, 'REAL_DEVICE');
	assert.equal(result.available, true);
	assert.deepEqual(result.options, []);
});

test('fallbackOptionsFor: no real provider never offers REAL', () => {
	// Local-only world: nothing attests real devices.
	const board = { envId: 'E', status: 'AVAILABLE', maximumLevel: 'SIMULATED' };
	const result = fallbackOptionsFor(board, 'REAL_DEVICE');
	assert.equal(result.available, false);
	assert.ok(result.reason.includes('No provider'));
	const actions = result.options.map((o) => o.action);
	assert.ok(!actions.includes('run_real'), 'REAL option must never appear without attestation');
	assert.ok(actions.includes('run_simulated'), 'SIMULATED is always an honest option');
	assert.ok(!actions.includes('queue'), 'no queue when device is free');
});

test('fallbackOptionsFor: busy real device offers queue first, then downgrades', () => {
	const board = { envId: 'E', status: 'BUSY', maximumLevel: 'REAL_DEVICE' };
	const result = fallbackOptionsFor(board, 'REAL_DEVICE');
	assert.equal(result.available, false);
	assert.ok(result.reason.toLowerCase().includes('busy'));
	assert.equal(result.options[0].action, 'queue', 'queue comes first when busy');
	assert.deepEqual(result.options.map((o) => o.action), ['queue', 'run_real', 'run_virtual_device', 'run_simulated']);
});

test('fallbackOptionsFor: busy simulated-only device queues without offering REAL', () => {
	const board = { envId: 'E', status: 'BUSY', maximumLevel: 'SIMULATED' };
	const result = fallbackOptionsFor(board, 'REAL_DEVICE');
	assert.deepEqual(result.options.map((o) => o.action), ['queue', 'run_simulated']);
});

test('fallbackOptionsFor: null board entry (unknown environment) degrades to simulated', () => {
	const result = fallbackOptionsFor(null, 'REAL_DEVICE');
	assert.equal(result.available, false);
	assert.equal(result.maximumLevel, null);
	const actions = result.options.map((o) => o.action);
	assert.deepEqual(actions, ['run_simulated']);
});

test('describeQueue renders position and terminal states', () => {
	assert.equal(describeQueue({ status: 'queued', queuePosition: 3 }), 'Queued · position 3');
	assert.equal(describeQueue({ status: 'queued' }), 'Queued · position ?');
	assert.equal(describeQueue({ status: 'running' }), 'Running now');
	assert.equal(describeQueue({ status: 'done' }), 'Finished');
	assert.equal(describeQueue({ status: 'failed' }), 'Failed');
	assert.equal(describeQueue({ status: 'cancelled' }), 'Cancelled');
	assert.equal(describeQueue(null), null);
});

test('boardByEnvId joins device board entries by envId', () => {
	const map = boardByEnvId([
		{ envId: 'A', status: 'AVAILABLE' },
		{ envId: 'B', status: 'BUSY' }
	]);
	assert.equal(map.get('A').status, 'AVAILABLE');
	assert.equal(map.get('B').status, 'BUSY');
	assert.equal(map.size, 2);
});

test('lastRunByEnv keeps the newest run per environment and reads honest level', () => {
	const runs = [
		{ id: 'r2', createdAt: '2026-10-02T00:00:00Z', environmentId: 'ENV-1', status: 'done', runtimeFacts: { executionLevel: 'SIMULATED' } },
		{ id: 'r1', createdAt: '2026-10-01T00:00:00Z', environmentId: 'ENV-1', status: 'failed' },
		{ id: 'r3', createdAt: '2026-10-03T00:00:00Z', environmentSnapshot: { envId: 'ENV-2' }, report: { verdict: 'pass' } },
		{ id: 'r4', createdAt: '2026-10-04T00:00:00Z' } // no environment → skipped
	];
	const map = lastRunByEnv(runs);
	assert.equal(map.size, 2);
	assert.equal(map.get('ENV-1').executionLevel, 'SIMULATED');
	assert.equal(map.get('ENV-2').result, 'pass');
	assert.ok(!map.has(undefined));
});

test('formatWhen renders timestamps and falls back to em dash', () => {
	assert.equal(formatWhen(null), '—');
	assert.equal(formatWhen('not-a-date'), '—');
	for (const value of ['2026-10-01T12:00:00Z', 1760000000000]) {
		assert.equal(formatWhen(value), new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }), 'respects the local date order');
	}
});

test('fallbackOptionsFor: busy flag + busy session id surface for the DEVICE BUSY modal', () => {
	const busy = fallbackOptionsFor({ envId: 'E', status: 'BUSY', maximumLevel: 'REAL_DEVICE', currentSessionId: 'QASE-DR-AB12' }, 'REAL_DEVICE');
	assert.equal(busy.busy, true);
	assert.equal(busy.busySessionId, 'QASE-DR-AB12');
	const free = fallbackOptionsFor({ envId: 'E', status: 'AVAILABLE', maximumLevel: 'SIMULATED' }, 'REAL_DEVICE');
	assert.equal(free.busy, false);
	assert.equal(free.busySessionId, null);
});

test('executionTypeLabel uses strict D1 vocabulary', () => {
	assert.equal(executionTypeLabel('REAL_DEVICE'), 'Real device');
	assert.equal(executionTypeLabel('VIRTUAL_DEVICE'), 'Virtual device');
	assert.equal(executionTypeLabel('SIMULATED'), 'Simulated');
});
