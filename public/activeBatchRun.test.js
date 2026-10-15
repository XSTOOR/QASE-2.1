import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeBatchRunId } from './bulkProgress.js';

test('activeBatchRunId prefers the executing run', () => {
	const byId = new Map([
		['a', { id: 'a', status: 'done' }],
		['b', { id: 'b', status: 'running' }],
		['c', { id: 'c', status: 'queued' }]
	]);
	assert.equal(activeBatchRunId({ sessionIds: ['a', 'b', 'c'] }, byId), 'b');
});

test('falls back to most recent open run, then last session', () => {
	const byId = new Map([
		['a', { id: 'a', status: 'done' }],
		['b', { id: 'b', status: 'idle' }],
		['c', { id: 'c', status: 'error' }]
	]);
	assert.equal(activeBatchRunId({ sessionIds: ['a', 'b', 'c'] }, byId), 'b');
	assert.equal(activeBatchRunId({ sessionIds: ['a', 'c'] }, byId), 'c');
	assert.equal(activeBatchRunId({ sessionIds: [] }, new Map()), null);
	assert.equal(activeBatchRunId(null, new Map()), null);
});
