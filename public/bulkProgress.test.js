import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	loadBatches, saveBatches, recordBatch, aggregateBatch, batchRows
} from '../public/bulkProgress.js';

/** Minimal localStorage stub for unit tests. */
function fakeStore() {
	const map = new Map();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => map.set(k, String(v)),
		_map: map
	};
}

describe('bulkProgress · batch persistence', () => {
	test('recordBatch stores label, ids and titles; load restores', () => {
		const store = fakeStore();
		const batch = recordBatch({ label: 'FULL REGRESSION', sessionIds: ['s1', 's2'], testCaseTitles: { s1: 'TC-1 Login' } }, store);
		assert.equal(batch.label, 'FULL REGRESSION');
		const restored = loadBatches(store);
		assert.equal(restored.length, 1);
		assert.deepEqual(restored[0].sessionIds, ['s1', 's2']);
		assert.equal(restored[0].testCaseTitles.s1, 'TC-1 Login');
	});

	test('registry is capped and corrupted JSON restores as empty', () => {
		const store = fakeStore();
		for (let i = 0; i < 8; i += 1) recordBatch({ label: `b${i}`, sessionIds: [`${i}`] }, store);
		assert.ok(loadBatches(store).length <= 5);
		store.setItem('qase.bulkBatches', '{not json');
		assert.deepEqual(loadBatches(store), []);
	});
});

describe('bulkProgress · aggregation math', () => {
	const batch = { sessionIds: ['p', 'f', 'r', 'q', 'gone'] };
	const sessions = new Map([
		['p', { status: 'done', findings: [], report: { verdict: 'pass' } }],
		['f', { status: 'done', findings: [{ title: 'bug' }] }],
		['r', { status: 'running' }],
		['q', { status: 'queued' }]
	]);

	test('aggregateBatch → Completed/Running/Passed/Failed/Pending', () => {
		const agg = aggregateBatch(batch, sessions);
		assert.deepEqual(
			{ total: agg.total, passed: agg.passed, failed: agg.failed, running: agg.running, pending: agg.pending, completed: agg.completed },
			{ total: 5, passed: 1, failed: 1, running: 2, pending: 1, completed: 2 }
		);
		assert.equal(agg.percent, 40);
	});

	test('done session with no verdict and no findings counts as Passed; interrupted as Failed; never divide by zero', () => {
		const s = new Map([['x', { status: 'done', findings: [] }], ['y', { status: 'interrupted' }]]);
		assert.deepEqual(aggregateBatch({ sessionIds: ['x', 'y'] }, s), { total: 2, passed: 1, failed: 1, running: 0, pending: 0, completed: 2, percent: 100 });
		assert.equal(aggregateBatch({ sessionIds: [] }, new Map()).percent, 0);
	});

	test('deleted session mid-batch counts as Pending (no crash)', () => {
		const agg = aggregateBatch({ sessionIds: ['deleted-1'] }, new Map());
		assert.equal(agg.pending, 1);
		assert.equal(agg.completed, 0);
	});

	test('batchRows maps titles and envs, newest state honest', () => {
		const rows = batchRows({ sessionIds: ['p', 'r'], testCaseTitles: { p: 'TC-2 Checkout' } }, sessions);
		assert.equal(rows[0].title, 'TC-2 Checkout');
		assert.equal(rows[0].state, 'Passed');
		assert.equal(rows[1].state, 'Running');
	});
});

test('batchRows carries the honest execution level per environment record', () => {
	const batch = { sessionIds: ['s1', 's2'], testCaseTitles: {} };
	const sessions = new Map([
		['s1', { id: 's1', status: 'done', findingCount: 0, executionLevel: 'SIMULATED', environmentSnapshot: { device: 'iPhone 16 Pro' } }],
		['s2', { id: 's2', status: 'done', findingCount: 2, executionLevel: 'REAL_DEVICE', environmentSnapshot: { device: 'Galaxy S24' } }]
	]);
	const rows = batchRows(batch, sessions);
	assert.equal(rows[0].executionLevel, 'SIMULATED');
	assert.equal(rows[1].executionLevel, 'REAL_DEVICE');
	assert.equal(rows[1].state, 'Failed');
});
