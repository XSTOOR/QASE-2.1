import assert from 'node:assert/strict';
import test from 'node:test';
import {
	countSqaBrowserActivities,
	countSqaBrowserActivitiesSinceControlCheckpoint,
	sqaContextCompactionDue,
	SQA_BROWSER_WORKFLOW_CHECKPOINT,
	SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL,
	SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL
} from './sqaBrowserBudget.js';

function session(browserActivities, observations = 1) {
	return {
		mode: 'sqa',
		activities: Array.from({ length: browserActivities }, (_, index) => ({
			id: `browser-${index}`,
			toolName: index % 2 === 0 ? 'browser_snapshot' : 'browser_click',
			status: 'done'
		})),
		sqa: {
			observations: Array.from({ length: observations }, (_, index) => ({ controlId: `SQA-WEB-00${index + 1}` }))
		}
	};
}

test('SQA context compaction becomes due only after durable evidence and a bounded activity interval', () => {
	assert.equal(SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL, 1, 'every recorded browser workflow starts a compact continuation');
	assert.equal(countSqaBrowserActivities(session(24)), 24);
	assert.equal(sqaContextCompactionDue(session(23), 0, 24), false);
	assert.equal(sqaContextCompactionDue(session(24), 0, 24), true);
	assert.equal(sqaContextCompactionDue(session(47), 24, 24), false);
	assert.equal(sqaContextCompactionDue(session(48), 24, 24), true);
	assert.equal(sqaContextCompactionDue(session(48, 0), 0, 24), false);
});

test('SQA context compaction ignores other modes and finalized assessments', () => {
	const candidate = session(30);
	candidate.mode = 'qa';
	assert.equal(sqaContextCompactionDue(candidate, 0, 24), false);
	candidate.mode = 'sqa';
	candidate.sqa.finalizedAt = new Date().toISOString();
	assert.equal(sqaContextCompactionDue(candidate, 0, 24), false);
});

test('SQA context compaction also becomes due from cumulative input growth at a safe checkpoint', () => {
	const candidate = session(2);
	candidate.tokenUsage = { inputTokens: SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL };
	assert.equal(sqaContextCompactionDue(candidate, 0, 99, 0), true);
	assert.equal(sqaContextCompactionDue(candidate, 0, 99,
		SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL - 1), false);
});

test('workflow checkpoint counts only successful browser work after the latest control write', () => {
	const candidate = session(3);
	candidate.activities.push({ toolName: 'record_sqa_control', status: 'done' });
	candidate.activities.push(
		{ toolName: 'browser_snapshot', status: 'done' },
		{ toolName: 'browser_click', status: 'failed' },
		{ toolName: 'update_todo', status: 'done' },
		{ toolName: 'browser_diagnostics', status: 'done' }
	);
	assert.equal(countSqaBrowserActivitiesSinceControlCheckpoint(candidate), 2);
	assert.equal(SQA_BROWSER_WORKFLOW_CHECKPOINT >= 2, true);
});
