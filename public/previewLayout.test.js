import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { previewCollapsed } from './previewLayout.js';
import { workflowStatus } from './workflowStatus.js';

test('active runs allow minimizing and expanding even after repeated live updates', () => {
	for (const status of ['running', 'awaiting_input']) {
		assert.equal(previewCollapsed({ available: true, hasSession: true, status }), false);
		for (let update = 0; update < 4; update++) {
			assert.equal(previewCollapsed({ available: true, hasSession: true, status, preference: true }), true);
			assert.equal(previewCollapsed({ available: true, hasSession: true, status, preference: false }), false);
		}
	}
});
test('terminal runs collapse by default but can show the saved preview', () => {
	for (const status of ['done', 'error', 'interrupted', 'cancelled']) {
		assert.equal(previewCollapsed({ available: true, hasSession: true, status }), true);
		assert.equal(previewCollapsed({ available: true, hasSession: true, status, preference: false }), false);
		assert.equal(previewCollapsed({ available: false, hasSession: true, status, preference: false }), true);
	}
});
test('switching runs retains independent preview preferences', () => {
	const preferences = new Map([['first', true], ['second', false]]);
	for (const id of ['first', 'second', 'first']) assert.equal(previewCollapsed({ available: true, hasSession: true, status: 'running', preference: preferences.get(id) }), id === 'first');
});
test('running guidance has no view-browser banner but input and results stay actionable', () => {
	assert.equal(workflowStatus({ status: 'running' }).hidden, true);
	assert.equal(workflowStatus({ status: 'running' }).destination, null);
	assert.equal(workflowStatus({ status: 'running', pendingQuestion: {} }).destination, 'question');
	assert.equal(workflowStatus({ status: 'done' }).destination, 'results');
});

test('live status wiring never resets explicit per-run preferences', () => {
	const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
	const sync = app.slice(app.indexOf('function syncStageCollapse('), app.indexOf('function toggleStageCollapse('));
	assert.doesNotMatch(sync, /\.delete\(|\.clear\(/);
	assert.match(app, /preference: state\.stageCollapsePreferences\.get\(state\.sessionId\)/);
	assert.match(app, /stageCollapsePreferences\.set\(state\.sessionId, !el\.viewer\.classList\.contains\('stage-collapsed'\)\)/);
	assert.doesNotMatch(app, /guidance\.destination === 'browser'/);
});
