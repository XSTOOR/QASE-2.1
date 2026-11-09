import assert from 'node:assert/strict';
import test from 'node:test';
import { blockedRunReason, runPresentationLabel, runPresentationStatus } from './runPresentation.js';
import { workflowStatus } from './workflowStatus.js';

test('a severe finding does not hide incomplete hybrid coverage behind Complete', () => {
  const session = { status: 'done', qaExecutionMode: 'hybrid', report: { verdict: 'fail', notCovered: ['Eight unexecuted checks'] } };
  assert.equal(runPresentationStatus(session), 'partial');
  assert.equal(runPresentationLabel(session), 'Completed with gaps');
  assert.equal(session.report.verdict, 'fail');
  assert.equal(runPresentationStatus({ ...session, qaExecutionMode: 'legacy' }), 'done');
  assert.equal(runPresentationStatus({ status: 'done', reportVerdict: 'fail', coverageIncomplete: true }), 'partial');
});

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

test('completed SQA uses its assurance verdict in full reports and lightweight lists', () => {
	const full = { mode: 'sqa', status: 'done', report: { verdict: 'pass' }, sqa: { assessment: { verdict: 'blocked' } } };
	assert.equal(runPresentationStatus(full), 'blocked');
	assert.equal(runPresentationLabel(full), 'Blocked');
	assert.equal(runPresentationStatus({ mode: 'sqa', status: 'done', sqaVerdict: 'blocked' }), 'blocked');
	assert.match(blockedRunReason(full), /unresolved controls/);
	assert.equal(workflowStatus(full).action, 'Review quality report');
	assert.equal(full.status, 'done', 'Presentation must not rewrite the durable execution lifecycle.');
});

test('old SQA verdicts do not override live runs or unrelated QA mode', () => {
	const old = { sqa: { assessment: { verdict: 'blocked' } } };
	assert.equal(runPresentationStatus({ ...old, mode: 'sqa', status: 'running' }), 'running');
	assert.equal(runPresentationStatus({ ...old, mode: 'qa', status: 'done', report: { verdict: 'pass' } }), 'done');
	assert.equal(runPresentationStatus({ mode: 'sqa', status: 'done', sqa: { assessment: { verdict: 'pass' } } }), 'done');
});

test('failed SQA controls remain visible in full and list presentation without changing lifecycle or ordinary QA', () => {
	const full = { mode: 'sqa', status: 'done', sqa: { assessment: { verdict: 'fail' } } };
	assert.equal(runPresentationStatus(full), 'failed');
	assert.equal(runPresentationLabel(full), 'Failed');
	assert.equal(runPresentationStatus({ mode: 'sqa', status: 'done', sqaVerdict: 'fail' }), 'failed');
	assert.equal(workflowStatus(full).action, 'Review quality report');
	assert.match(workflowStatus(full).description, /failed controls/);
	assert.equal(full.status, 'done');
	assert.equal(runPresentationStatus({ ...full, status: 'running' }), 'running');
	assert.equal(runPresentationLabel({ mode: 'qa', status: 'done', report: { verdict: 'fail' } }), 'Complete');
});

test('hybrid interruptions explain the real host pause reason without changing legacy guidance', () => {
	const hybrid = { status: 'interrupted', mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { pauseReason: 'reasoner model budget exhausted (300000 provider-reported tokens).' } };
	assert.match(workflowStatus(hybrid).description, /approved execution budget/);
	assert.match(workflowStatus(hybrid).description, /saved evidence/);
	assert.ok(workflowStatus(hybrid).resumeBlocked);
	assert.doesNotMatch(workflowStatus(hybrid).description, /Resume when/);
	assert.match(workflowStatus({ ...hybrid, qaExecutionMode: 'legacy' }).description, /Resume when/);
});
