import assert from 'node:assert/strict';
import test from 'node:test';
import {
	countSqaBrowserActivities,
	countSqaBrowserActivitiesSinceControlCheckpoint,
	guardSqaBrowserTool,
	sqaExecutionBudget,
	sqaWorkflowGate,
	sqaContextCompactionDue,
	SQA_BROWSER_EVIDENCE_LIMIT,
	SQA_BROWSER_TOOL_BUDGET,
	SQA_BROWSER_WORKFLOW_CHECKPOINT,
	SQA_CONTEXT_COMPACTION_ACTIVITY_INTERVAL,
	SQA_CONTEXT_COMPACTION_INPUT_TOKEN_INTERVAL,
	SQA_INPUT_TOKEN_BUDGET,
	SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD
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

function smokeActivity(action, status = 'done', summary) {
	return {
		toolName: 'browser_sqa_smoke',
		input: { action },
		status,
		summary
	};
}

function workflowSession(activities, observations = []) {
	return {
		mode: 'sqa',
		activities,
		sqa: {
			scope: { applicableControlIds: [
				'SQA-WEB-001', 'SQA-WEB-002', 'SQA-WEB-003',
				'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006'
			] },
			observations
		}
	};
}

test('SQA workflow gate permits only responsive smoke after accessibility completes', () => {
	const candidate = workflowSession([smokeActivity('accessibility')]);
	assert.equal(sqaWorkflowGate(candidate, 'browser_sqa_smoke', { action: 'responsive' }), undefined);
	const blocked = sqaWorkflowGate(candidate, 'browser_snapshot', {});
	assert.equal(blocked.code, 'SQA_NEXT_BOUNDED_WORKFLOW_REQUIRED');
	assert.equal(blocked.required_action, 'responsive');
});

test('SQA workflow gate requires presentation control results after responsive smoke', () => {
	const candidate = workflowSession([
		smokeActivity('accessibility'),
		smokeActivity('responsive')
	]);
	const blocked = sqaWorkflowGate(candidate, 'browser_snapshot', {});
	assert.equal(blocked.code, 'SQA_CONTROL_RESULT_REQUIRED');
	assert.deepEqual(blocked.control_ids, [
		'SQA-WEB-001', 'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006'
	]);
});

test('SQA workflow gate permits only form validation after navigation completes', () => {
	const observations = ['SQA-WEB-001', 'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006']
		.map(controlId => ({ controlId, status: 'pass' }));
	const candidate = workflowSession([smokeActivity('navigation')], observations);
	assert.equal(sqaWorkflowGate(candidate, 'browser_sqa_smoke', { action: 'form_validation' }), undefined);
	const blocked = sqaWorkflowGate(candidate, 'browser_qa_check', { action: 'inspect' });
	assert.equal(blocked.code, 'SQA_NEXT_BOUNDED_WORKFLOW_REQUIRED');
	assert.equal(blocked.required_action, 'form_validation');
});

test('SQA workflow gate stops form retries until interaction controls are recorded', () => {
	const observations = ['SQA-WEB-001', 'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006']
		.map(controlId => ({ controlId, status: 'pass' }));
	const candidate = workflowSession([
		smokeActivity('navigation'),
		smokeActivity('form_validation')
	], observations);
	const blocked = sqaWorkflowGate(candidate, 'browser_sqa_smoke', { action: 'form_validation' });
	assert.equal(blocked.code, 'SQA_CONTROL_RESULT_REQUIRED');
	assert.deepEqual(blocked.control_ids, ['SQA-WEB-002', 'SQA-WEB-003']);

	candidate.sqa.observations.push(
		{ controlId: 'SQA-WEB-002', status: 'pass' },
		{ controlId: 'SQA-WEB-003', status: 'blocked' }
	);
	assert.equal(sqaWorkflowGate(candidate, 'browser_snapshot', {}), undefined);
});

test('SQA workflow gate is enforced before the browser driver is invoked', async () => {
	const candidate = workflowSession([
		smokeActivity('accessibility'),
		smokeActivity('responsive')
	]);
	let driverCalls = 0;
	const guarded = guardSqaBrowserTool({
		name: 'browser_snapshot',
		run: async () => { driverCalls++; return { success: true }; }
	}, candidate);
	const result = await guarded.run({}, {});
	assert.equal(result.code, 'SQA_CONTROL_RESULT_REQUIRED');
	assert.equal(driverCalls, 0);
});

test('SQA workflow gate ignores rejected malformed smoke inputs', () => {
	const candidate = workflowSession([
		smokeActivity('accessibility', 'failed'),
		smokeActivity('navigation', 'failed')
	]);
	assert.equal(sqaWorkflowGate(candidate, 'browser_snapshot', {}), undefined);
});

test('SQA reserved thresholds stop browser work before the hard limits and expose remaining budget', async () => {
	const browserCandidate = session(SQA_BROWSER_EVIDENCE_LIMIT);
	let driverCalls = 0;
	const tool = { name: 'browser_snapshot', run: async () => { driverCalls++; return { success: true }; } };
	const browserBlocked = await guardSqaBrowserTool(tool, browserCandidate).run({}, {});
	assert.equal(browserBlocked.code, 'SQA_EVIDENCE_COLLECTION_COMPLETE');
	assert.equal(browserBlocked.threshold, SQA_BROWSER_EVIDENCE_LIMIT);
	assert.equal(browserBlocked.limit, SQA_BROWSER_TOOL_BUDGET);

	const tokenCandidate = session(0);
	tokenCandidate.tokenUsage = { inputTokens: SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD };
	const tokenBlocked = await guardSqaBrowserTool(tool, tokenCandidate).run({}, {});
	assert.equal(tokenBlocked.code, 'SQA_INPUT_TOKEN_CLOSEOUT_REQUIRED');
	assert.equal(tokenBlocked.threshold, SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD);
	assert.equal(tokenBlocked.limit, SQA_INPUT_TOKEN_BUDGET);
	assert.equal(driverCalls, 0);

	const budget = sqaExecutionBudget(tokenCandidate);
	assert.equal(budget.browserTools.remainingForEvidence, SQA_BROWSER_EVIDENCE_LIMIT);
	assert.equal(budget.inputTokens.remainingBeforeCloseout, 0);
});
