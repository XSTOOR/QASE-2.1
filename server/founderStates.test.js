import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeFounderLifecycle } from '../public/founderPresentation.js';

/**
 * Phase 5 — reliable states: every founder-mode UI state must carry an
 * actionable message and preserve context (inputs/last valid result are
 * preserved by the persistence layer, pinned in founderProjectState.test.js).
 */
test('lifecycle: complete state reports coverage detail', () => {
	const lifecycle = describeFounderLifecycle(
		{ finalizedAt: '2026-09-30T00:00:00.000Z', scope: { categories: Array.from({ length: 17 }, (_, i) => `cat-${i}`) }, report: { coverage: { categoriesReviewed: Array.from({ length: 17 }, (_, i) => `cat-${i}`), evidenceBackedObservations: 24 } } },
		'done', 40
	);
	assert.equal(lifecycle.phase, 'complete');
	assert.equal(lifecycle.finalized, true);
	assert.match(lifecycle.detail, /17\/17 lenses reviewed/);
	assert.match(lifecycle.detail, /24 evidence-backed observations/);
});

test('lifecycle: running state explains why no brief is visible yet', () => {
	const lifecycle = describeFounderLifecycle({ observations: [{}, {}] }, 'running', 10);
	assert.equal(lifecycle.phase, 'running');
	assert.match(lifecycle.message, /collecting browser evidence/i);
	assert.match(lifecycle.message, /only after finalization/i);
	assert.match(lifecycle.detail, /2 observations captured/);
});

test('lifecycle: awaiting-input state tells the founder what to answer', () => {
	const lifecycle = describeFounderLifecycle({}, 'awaiting_input', 5);
	assert.equal(lifecycle.phase, 'waiting');
	assert.match(lifecycle.message, /needs your context/i);
});

test('lifecycle: error state is actionable and preserves evidence', () => {
	const lifecycle = describeFounderLifecycle({ observations: [{}, {}, {}] }, 'error', 12);
	assert.equal(lifecycle.phase, 'error');
	assert.match(lifecycle.message, /Resolve the reported error/);
	assert.match(lifecycle.message, /continue from the saved evidence/);
	// Model/provider failure lands in this state: inputs and observations are
	// preserved by the session store; only the turn failed.
	assert.match(lifecycle.detail, /no Founder brief was published/);
});

test('lifecycle: interrupted state keeps observations and offers resume', () => {
	const lifecycle = describeFounderLifecycle({ observations: [{}, {}] }, 'interrupted', 9);
	assert.equal(lifecycle.phase, 'interrupted');
	assert.match(lifecycle.detail, /2 observations remain saved/);
	assert.match(lifecycle.message, /Send an instruction to resume/);
});

test('lifecycle: paused and ready states guide the next action', () => {
	const paused = describeFounderLifecycle({ observations: [{}] }, 'idle', 3);
	assert.equal(paused.phase, 'paused');
	assert.match(paused.message, /Send an instruction to continue/);
	const ready = describeFounderLifecycle({}, 'idle', 0);
	assert.equal(ready.phase, 'ready');
	assert.match(ready.message, /Send the target URL to begin/);
});
