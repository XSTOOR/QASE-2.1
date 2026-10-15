import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedRunReason, runPresentationLabel, runPresentationStatus } from './runPresentation.js';

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
