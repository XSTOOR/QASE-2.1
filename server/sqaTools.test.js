import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSqaState } from './sqaService.js';
import { createSqaTools, finishReadiness } from './sqaTools.js';
import { SQA_INPUT_TOKEN_BUDGET } from './sqaBrowserBudget.js';

const fixedNow = () => Date.parse('2026-08-17T00:00:00.000Z');

function session() {
	return {
		id: '123e4567-e89b-42d3-a456-426614174100',
		mode: 'sqa',
		messages: [],
		activities: [{
			id: 'browser-1', toolName: 'browser_snapshot', status: 'done', ts: fixedNow(), summary: 'Rendered entry page.'
		}],
		todos: [],
		sqa: createSqaState({
			authorizationConfirmed: true,
			profiles: ['core'],
			attributes: ['web_application', 'user_interface'],
			target: { name: 'Example', release: '1', environment: 'test' }
		}, fixedNow)
	};
}

function store() {
	return { async commit() {} };
}

test('SQA tool contract supports multi-evidence observations and bounded blocker batches', () => {
	const tools = createSqaTools(session(), store());
	const record = tools.find(tool => tool.name === 'record_sqa_control');
	const blockers = tools.find(tool => tool.name === 'record_sqa_blockers');
	assert.ok(record);
	assert.ok(blockers);
	assert.equal(record.parametersSchema.properties.evidence.type, 'array');
	assert.ok(record.parametersSchema.properties.evidence.items.properties.type.enum.includes('test_result'));
	assert.equal(record.parametersSchema.properties.evidence.items.properties.type.enum.includes('risk_register'), false);
	assert.equal(record.parametersSchema.properties.controls.maxItems, 12);
	assert.deepEqual(record.parametersSchema.required, []);
	assert.equal(blockers.parametersSchema.properties.controls.maxItems, 50);
});

test('SQA record tool accepts an atomic controls batch without a new runtime permission', async () => {
	const candidate = session();
	candidate.sqa.scope.applicableControlIds = ['SQA-QUA-001', 'SQA-TRC-002'];
	const record = createSqaTools(candidate, store()).find(tool => tool.name === 'record_sqa_control');
	const result = await record.run({ controls: [{
		control_id: 'SQA-QUA-001',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'A representative positive and negative browser workflow matched its oracle.' }]
	}, {
		control_id: 'SQA-TRC-002',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'The result contains reproducible steps and attributable execution context.' }]
	}] });
	assert.equal(result.success, true);
	assert.equal(result.count, 2);
	assert.deepEqual(result.results.map(item => item.control_id).sort(), ['SQA-QUA-001', 'SQA-TRC-002']);
});

test('SQA record tools keep non-technical work behind the six web controls', async () => {
	const candidate = session();
	const tools = createSqaTools(candidate, store());
	const record = tools.find(tool => tool.name === 'record_sqa_control');
	const blockers = tools.find(tool => tool.name === 'record_sqa_blockers');
	const premature = await record.run({
		control_id: 'SQA-QUA-001', status: 'blocked', rationale: 'No reviewed quality plan.'
	});
	assert.equal(premature.success, false);
	assert.match(premature.error, /Finish the six technical web controls first/);
	assert.match(premature.error, /SQA-WEB-001/);
	const prematureBatch = await blockers.run({ controls: [{
		control_id: 'SQA-GOV-001', rationale: 'No reviewed risk register.'
	}] });
	assert.equal(prematureBatch.success, false);
	assert.match(prematureBatch.error, /Finish the six technical web controls first/);
});

test('finish readiness reports missing controls, incomplete work, and recent in-flight browser tools', () => {
	const candidate = session();
	candidate.todos = [
		{ text: 'Exercise representative workflow', status: 'pending' },
		{ text: 'Finish SQA assessment', status: 'in_progress' }
	];
	candidate.activities.push({ id: 'browser-2', toolName: 'browser_wait', status: 'running', ts: fixedNow() - 10_000 });
	const readiness = finishReadiness(candidate, fixedNow());
	assert.ok(readiness.pendingControlIds.includes('SQA-WEB-001'));
	assert.deepEqual(readiness.incompleteTodos.map(item => item.text), ['Exercise representative workflow']);
	assert.deepEqual(readiness.activeActivities.map(item => item.id), ['browser-2']);
});

test('finish tool refuses to publish a partial assessment', async () => {
	const candidate = session();
	const finish = createSqaTools(candidate, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const result = await finish.run({});
	assert.equal(result.success, false);
	assert.ok(result.pending_control_ids.includes('SQA-WEB-001'));
	assert.equal(candidate.sqa.finalizedAt, undefined);
});

test('safety closeout is rejected early and finishes exhausted runs in one call', async () => {
	const early = session();
	early.todos = [{ text: 'Run technical checks', status: 'pending' }];
	let finish = createSqaTools(early, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const rejected = await finish.run({ close_after_safety_limit: true });
	assert.equal(rejected.success, false);
	assert.match(rejected.error, /only after.*limit is exhausted/i);
	assert.equal(early.sqa.observations.length, 0);

	const exhausted = session();
	exhausted.todos = [{ text: 'Run technical checks', status: 'pending' }];
	exhausted.tokenUsage = { inputTokens: SQA_INPUT_TOKEN_BUDGET };
	finish = createSqaTools(exhausted, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const result = await finish.run({ close_after_safety_limit: true });
	assert.equal(result.success, true);
	assert.equal(result.published, true);
	assert.equal(result.safety_closeout, true);
	assert.equal(result.safety_closed_control_ids.length, exhausted.sqa.scope.applicableControlIds.length);
	assert.ok(exhausted.sqa.finalizedAt);
	assert.equal(exhausted.todos.every(todo => todo.status === 'completed'), true);
	assert.deepEqual(finishReadiness(exhausted, fixedNow()).pendingControlIds, []);
	assert.equal(exhausted.sqa.observations.every(item => item.status === 'blocked'), true);
	assert.ok(exhausted.sqa.observations.every(item => item.rationale.startsWith('Stopped early: budget reached.')));
	assert.ok(exhausted.sqa.observations[0].rationale.includes(`${SQA_INPUT_TOKEN_BUDGET}/${SQA_INPUT_TOKEN_BUDGET}`));
});

test('authentication-blocked representative scope requires a user decision before finish', async () => {
	const candidate = session();
	candidate.sqa.scope.applicableControlIds = ['SQA-WEB-001', 'SQA-WEB-002'];
	candidate.sqa.observations = [
		{ controlId: 'SQA-WEB-001', status: 'blocked', rationale: 'Representative workflow is behind authentication and no credentials were supplied.', evidence: [] },
		{ controlId: 'SQA-WEB-002', status: 'blocked', rationale: 'Navigation requires sign in credentials.', evidence: [] }
	];
	const finish = createSqaTools(candidate, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const result = await finish.run({});
	assert.equal(result.success, false);
	assert.equal(result.requires_user_input, true);
	assert.equal(candidate.sqa.finalizedAt, undefined);
	candidate.tokenUsage = { inputTokens: SQA_INPUT_TOKEN_BUDGET };
	const safetyResult = await finish.run({ close_after_safety_limit: true });
	assert.equal(safetyResult.success, false);
	assert.equal(safetyResult.requires_user_input, true, 'safety closeout cannot bypass authentication scope');
	assert.equal(candidate.sqa.finalizedAt, undefined);

	candidate.messages.push({ role: 'user', text: 'Continue with an anonymous-only assessment.' });
	assert.deepEqual(finishReadiness(candidate, fixedNow()).authBlockedControlIds, []);
});

test('a confirmed finding prevents publication until every linked control is failed', async () => {
	const candidate = session();
	const tools = createSqaTools(candidate, store());
	const record = tools.find(tool => tool.name === 'record_sqa_control');
	const finish = tools.find(tool => tool.name === 'finish_sqa_assessment');
	assert.equal((await record.run({
		control_id: 'SQA-WEB-003',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'The form validation workflow was sampled.' }]
	})).success, true);
	candidate.findings = [{ id: 'finding-1', title: 'Stale validation message', controlIds: ['SQA-WEB-003'] }];
	const readiness = finishReadiness(candidate, fixedNow());
	assert.deepEqual(readiness.findingControlConflicts.map(item => item.controlId), ['SQA-WEB-003']);
	const rejected = await finish.run();
	assert.equal(rejected.success, false);
	assert.deepEqual(rejected.finding_control_conflicts.map(item => item.controlId), ['SQA-WEB-003']);
	assert.equal(candidate.sqa.finalizedAt, undefined);

	assert.equal((await record.run({
		control_id: 'SQA-WEB-003',
		status: 'fail',
		rationale: 'A confirmed stale success state violates the form recovery objective.',
		evidence: [{ type: 'test_result', summary: 'The stale success message remained after invalid submission.' }]
	})).success, true);
	assert.deepEqual(finishReadiness(candidate, fixedNow()).findingControlConflicts, []);
});
