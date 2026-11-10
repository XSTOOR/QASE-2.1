import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSqaState, recordSqaSmokeActivity } from './sqaService.js';
import { createSqaTools, finishReadiness } from './sqaTools.js';
import { SQA_INPUT_TOKEN_BUDGET, SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD } from './sqaBrowserBudget.js';

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

async function addSmokeResult(candidate, id, result) {
	const activity = { id, toolName: 'browser_sqa_smoke', status: 'running', ts: fixedNow(), input: { action: result.action } };
	candidate.activities.push(activity);
	await recordSqaSmokeActivity(candidate, id, result, { status: 'done' }, {
		async updateActivity(_session, _id, patch) { Object.assign(activity, patch); }
	});
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
	assert.deepEqual(blockers.parametersSchema.required, ['close_remaining']);
	assert.deepEqual(blockers.parametersSchema.properties.close_remaining.enum, [true]);
	assert.equal(blockers.parametersSchema.properties.controls, undefined);
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

// #17997 regression: batched pass decisions must go through the bounded JEV
// verifier too (E2E run e4a0fe68 bypassed it entirely via the batch path).
test('SQA batch record verifies every pass decision through the JEV verifier', async () => {
	const verified = [];
	const jevVerifier = { verify: async input => { verified.push(input); return { challenge: null }; } };
	const candidate = session();
	// The coverage-r3 technical-first guard requires the six SQA-WEB controls
	// before non-technical work; keep this #17997 fixture off that path so it
	// exercises ONLY the JEV batch-verification behavior.
	candidate.sqa.scope.applicableControlIds = ['SQA-QUA-001', 'SQA-TRC-001'];
	const record = createSqaTools(candidate, store(), { jevVerifier }).find(tool => tool.name === 'record_sqa_control');
	const result = await record.run({ controls: [{
		control_id: 'SQA-QUA-001',
		status: 'pass',
		rationale: 'Verified representative workflow.',
		evidence: [{ type: 'test_result', summary: 'Positive and negative browser workflow matched its oracle.' }]
	}, {
		control_id: 'SQA-TRC-001',
		status: 'blocked',
		rationale: 'Missing prerequisite.',
		evidence: [{ type: 'test_result', summary: 'Browser check could not establish the prerequisite.' }]
	}] });
	assert.equal(result.success, true);
	assert.equal(verified.length, 1, 'only the pass decision is verified');
	assert.equal(verified[0].controlId, 'SQA-QUA-001');
	assert.equal(verified[0].status, 'pass');
	assert.ok(verified[0].rationale.length > 0, 'rationale is forwarded to JEV');
	assert.ok(Array.isArray(verified[0].evidence), 'evidence is forwarded to JEV');
	assert.equal(result.jev_verifications, undefined, 'no challenge entries when JEV is satisfied');
	// A challenge must surface per-control, never flip the result.
	const challenging = { verify: async input => ({ challenge: input.controlId === 'SQA-QUA-001' ? 'Evidence too thin.' : null }) };
	const challengingSession = session();
	challengingSession.sqa.scope.applicableControlIds = ['SQA-QUA-001'];
	const record2 = createSqaTools(challengingSession, store(), { jevVerifier: challenging }).find(tool => tool.name === 'record_sqa_control');
	const result2 = await record2.run({ controls: [{ control_id: 'SQA-QUA-001', status: 'pass', rationale: 'r', evidence: [{ type: 'test_result', summary: 's' }] }] });
	assert.equal(result2.results[0].status, 'pass', 'JEV challenge never flips the decision');
	assert.equal(result2.jev_verifications?.[0]?.control_id, 'SQA-QUA-001');
	assert.match(result2.jev_verifications?.[0]?.jev_verification ?? '', /too thin/);
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
	const prematureBatch = await blockers.run({ close_remaining: true });
	assert.equal(prematureBatch.success, false);
	assert.match(prematureBatch.error, /Finish browser-eligible SQA controls/);
});

test('final browser-backed result automatically closes reviewer-only prerequisites', async () => {
	const candidate = session();
	candidate.sqa.scope.applicableControlIds = ['SQA-WEB-001', 'SQA-GOV-001'];
	const commits = [];
	const runStore = { async commit(_session, type, payload) { commits.push({ type, payload }); } };
	const tools = createSqaTools(candidate, runStore);
	const record = tools.find(tool => tool.name === 'record_sqa_control');
	const result = await record.run({
		control_id: 'SQA-WEB-001',
		status: 'blocked',
		rationale: 'The controlled page did not expose a usable application shell.'
	});
	assert.equal(result.success, true, result.error);
	assert.deepEqual(result.reviewer_closeout, { closed_count: 1 });
	assert.deepEqual(candidate.sqa.observations.map(item => item.controlId), ['SQA-WEB-001', 'SQA-GOV-001']);
	assert.match(candidate.sqa.observations.at(-1).rationale, /risk_register \(product-risk-baseline\)/);
	assert.equal(commits.filter(item => item.payload?.reviewerCloseout).length, 1);
	assert.equal(tools.find(tool => tool.name === 'record_sqa_blockers').parametersSchema.properties.controls, undefined);
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
	assert.equal(exhausted.sqa.assessment.executionBudget.closeout.mode, 'safety_limit');
});

test('reserved closeout threshold publishes from saved evidence before hard exhaustion', async () => {
	const candidate = session();
	candidate.todos = [{ text: 'Run technical checks', status: 'pending' }];
	candidate.tokenUsage = { inputTokens: SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD };
	const finish = createSqaTools(candidate, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const result = await finish.run({ close_from_saved_evidence: true });
	assert.equal(result.success, true, result.error);
	assert.equal(result.safety_closeout, false);
	assert.equal(result.budget_closeout.mode, 'saved_evidence');
	assert.equal(result.budget_closeout.trigger, 'input_tokens');
	assert.equal(candidate.sqa.assessment.executionBudget.inputTokens.remainingBeforeCloseout, 0);
	assert.equal(candidate.sqa.assessment.executionBudget.closeout.mode, 'saved_evidence');
	assert.ok(candidate.sqa.observations.every(item => item.status === 'blocked'));
	assert.match(candidate.sqa.observations[0].rationale, /reserved closeout threshold was reached/);

	const early = session();
	const earlyFinish = createSqaTools(early, store()).find(tool => tool.name === 'finish_sqa_assessment');
	const rejected = await earlyFinish.run({ close_from_saved_evidence: true });
	assert.equal(rejected.success, false);
	assert.match(rejected.error, /closeout threshold is reached/i);
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
	const formResult = {
		success: true, action: 'form_validation', eligible: true,
		cases: ['empty', 'invalid_email', 'valid_email', 'invalid_after_valid'].map(name => ({
			name, validity: { valid: name === 'valid_email' }, submissionBlocked: name !== 'valid_email', feedbackChanged: name === 'valid_email'
		}))
	};
	await addSmokeResult(candidate, 'form-pass', formResult);
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

	await addSmokeResult(candidate, 'form-fail', { ...formResult, staleSuccessSignalAfterInvalid: true });
	assert.equal((await record.run({
		control_id: 'SQA-WEB-003',
		status: 'fail',
		rationale: 'A confirmed stale success state violates the form recovery objective.',
		evidence: [{ type: 'test_result', summary: 'The stale success message remained after invalid submission.' }]
	})).success, true);
	assert.deepEqual(finishReadiness(candidate, fixedNow()).findingControlConflicts, []);
});

test('legacy navigation and form verdicts require matching completed host receipts', async () => {
	const candidate = session();
	const record = createSqaTools(candidate, store()).find(tool => tool.name === 'record_sqa_control');
	const claim = (control_id, status) => record.run({ control_id, status, rationale: 'Claim from model', evidence: [{ type: 'test_result', summary: 'Claim from model' }] });
	await addSmokeResult(candidate, 'unavailable', { success: true, action: 'form_validation', eligible: false, cases: [] });
	assert.match((await claim('SQA-WEB-003', 'pass')).error, /matching host-observed form_validation/);
	assert.match((await claim('SQA-WEB-003', 'fail')).error, /matching host-observed form_validation/);
	assert.match((await claim('SQA-WEB-002', 'pass')).error, /matching host-observed navigation/);
	await addSmokeResult(candidate, 'missing-link', {
		success: true, action: 'navigation', originalUrl: 'https://example.test/', restoredUrl: 'https://example.test/',
		samples: [{ ok: false, status: 404, reason: 'http_error' }]
	});
	assert.match((await claim('SQA-WEB-002', 'pass')).error, /matching host-observed navigation/);
	assert.equal((await claim('SQA-WEB-002', 'fail')).success, true);
	assert.match(candidate.sqa.observations[0].evidence[0].reference, /activities\/missing-link\/evidence\//);
});
