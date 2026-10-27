import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedRunReason, runPresentationLabel, runPresentationStatus } from './runPresentation.js';
import { workflowStatus } from './workflowStatus.js';

test('a partial review is completed with gaps, never a prerequisite blocker or pass', () => {
	const session = { status: 'done', report: { verdict: 'partial' } };
	assert.equal(runPresentationStatus(session), 'partial');
	assert.equal(runPresentationLabel(session), 'Completed with gaps');
	assert.equal(runPresentationLabel({ status: 'done', reportVerdict: 'partial' }), 'Completed with gaps');
	assert.equal(blockedRunReason(session), '');
	assert.equal(workflowStatus(session).action, 'Review coverage');
});

test('a terminal blocked report is presented as blocked rather than complete', () => {
	const session = {
		status: 'done',
		report: {
			verdict: 'blocked',
			summary: 'Login is required.',
			notCovered: ['Checkout: valid test credentials were unavailable.']
		}
	};
	assert.equal(runPresentationStatus(session), 'blocked');
	assert.equal(runPresentationLabel(session), 'Blocked');
	assert.equal(blockedRunReason(session), 'Checkout: valid test credentials were unavailable.');
});

test('ordinary completed and live runs retain their lifecycle presentation', () => {
	assert.equal(runPresentationStatus({ status: 'done', report: { verdict: 'pass' } }), 'done');
	assert.equal(runPresentationLabel({ status: 'done', report: { verdict: 'fail' } }), 'Complete');
	assert.equal(runPresentationStatus({ status: 'running' }), 'running');
	assert.equal(runPresentationLabel({ status: 'awaiting_input' }), 'Waiting for you');
});

test('list summaries can carry the lightweight report verdict', () => {
	assert.equal(runPresentationStatus({ status: 'done', reportVerdict: 'BLOCKED' }), 'blocked');
});

test('hybrid interruptions explain the real host pause reason without changing legacy guidance', () => {
	const hybrid = { status: 'interrupted', mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { pauseReason: 'reasoner model budget exhausted (300000 provider-reported tokens).' } };
	assert.match(workflowStatus(hybrid).description, /approved execution budget/);
	assert.match(workflowStatus(hybrid).description, /saved evidence/);
	assert.ok(workflowStatus(hybrid).resumeBlocked);
	assert.doesNotMatch(workflowStatus(hybrid).description, /Resume when/);
	assert.match(workflowStatus({ ...hybrid, qaExecutionMode: 'legacy' }).description, /Resume when/);
});
