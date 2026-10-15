import test from 'node:test';
import assert from 'node:assert/strict';
import { firstMatrixSessionId } from './matrixLaunch.js';

test('queue remains visible until the allocated runtime finishes initializing', () => {
	const item = { sessionId: 'session-ready', status: 'RUNNING', startupPhase: 'initializing' };
	assert.equal(firstMatrixSessionId({ items: [item] }), null);
	assert.equal(firstMatrixSessionId({ items: [{ ...item, startupPhase: 'ready' }] }), 'session-ready');
});

test('initialization errors can open their real session for diagnosis', () => {
	assert.equal(firstMatrixSessionId({ items: [{ sessionId: 'session-error', status: 'ERROR', startupPhase: 'initializing' }] }), 'session-error');
	assert.equal(firstMatrixSessionId(null), null);
	assert.equal(firstMatrixSessionId({ items: [{ status: 'QUEUED' }] }), null);
});

test('older runs remain compatible and an active session is preferred', () => {
	assert.equal(firstMatrixSessionId({ items: [{ sessionId: 'finished', status: 'PASSED' }, { sessionId: 'live', status: 'RUNNING' }] }), 'live');
});
