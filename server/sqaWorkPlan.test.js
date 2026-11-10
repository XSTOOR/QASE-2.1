import './testWorkingDirectory.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqaState } from './sqaService.js';
import { SQA_TECHNICAL_CONTROL_IDS, getSqaControl } from './sqaCatalog.js';
import { buildSqaWorkPlan, readSqaWorkPage, sqaWorkBrief } from './sqaWorkPlan.js';
import { evaluateSqaAssessment, buildSqaReportMarkdown } from './sqaAssessment.js';
import { createSqaTools } from './sqaTools.js';
import { BROWSER_WORKFLOW_GUIDANCE } from './browserWorkflowPrompt.js';

const state = () => createSqaState({ authorizationConfirmed: true, target: { name: 'Queue fixture', release: '1', environment: 'test' } });
test('technical checks precede a bounded risk-prioritized browser queue without reducing scope', () => {
	const sqa = state(), original = structuredClone(sqa);
	const initial = buildSqaWorkPlan(sqa);
	assert.deepEqual(initial.activeControls.map(c => c.id), SQA_TECHNICAL_CONTROL_IDS);
	assert.equal(initial.pendingBrowserCount, 13);
	assert.equal(initial.pendingReviewerOnlyCount, 17);
	assert.equal(initial.reviewerRequests.length, 23);
	for (const id of ['SQA-QUA-002', 'SQA-QUA-003', 'SQA-QUA-004', 'SQA-QUA-006', 'SQA-QUA-008']) {
		assert.ok(initial.reviewerRequests.some(r => r.controlId === id));
		assert.ok(!initial.pendingBrowserControls.some(c => c.id === id));
		assert.ok(sqa.scope.applicableControlIds.includes(id), 'reviewer ownership cannot remove a scoped control');
	}
	assert.deepEqual(sqa, original);
	sqa.observations = SQA_TECHNICAL_CONTROL_IDS.map(controlId => ({ controlId, status: 'blocked' }));
	const next = buildSqaWorkPlan(sqa);
	assert.equal(next.phase, 'browser');
	assert.equal(next.activeControls.length, 4);
	assert.ok(next.activeControls.every(control => control.requirements.some(r => r.owner === 'browser')));
	assert.equal(next.activeControls[0].severity, 'critical');
	assert.equal(new Set([...next.activeControls, ...next.planningIndex].map(c => c.id)).size, next.pendingBrowserCount);
	const ids = next.activeControls.map(c => c.id);
	sqa.observations.push(...ids.map(controlId => ({ controlId, status: 'blocked' })));
	assert.ok(buildSqaWorkPlan(sqa).activeControls.every(c => !ids.includes(c.id)));
	assert.deepEqual(sqa.scope, original.scope);
});

test('all browser objectives and exact reviewer contracts remain readable in bounded pages', () => {
	const sqa = state(), plan = buildSqaWorkPlan(sqa), ids = [];
	let offset = 0, revision;
	do { const page = readSqaWorkPage(sqa, { sqa_view: 'browser', offset, revision });
		assert.ok(page.items.length <= 4); assert.ok(JSON.stringify(page).length < 10000);
		ids.push(...page.items.map(c => c.id)); offset = page.next_offset; revision = page.revision;
	} while (offset !== null);
	assert.equal(new Set(ids).size, plan.pendingBrowserCount);
	const change = plan.reviewerRequests.find(r => r.controlId === 'SQA-CHG-001');
	assert.equal(change.type, 'approval_record');
	assert.deepEqual({ id: change.id, minimum: change.minimum, description: change.description },
		(({ id, minimum, description }) => ({ id, minimum, description }))(getSqaControl('SQA-CHG-001').evidenceRequirements.find(r => r.type === 'approval_record')));
	assert.throws(() => readSqaWorkPage(sqa, { sqa_view: 'reviewer', offset: -1 }));
	assert.throws(() => readSqaWorkPage(sqa, { sqa_view: 'reviewer', offset: 0.5 }));
	assert.match(sqaWorkBrief(sqa), /not authorized scope/);
});

test('a stale page cannot skip the next controls after a durable disposition changes the queue', () => {
	const sqa = state(), page = readSqaWorkPage(sqa, { sqa_view: 'browser' });
	sqa.observations.push({ controlId: page.items[0].id, status: 'blocked' });
	assert.throws(() => readSqaWorkPage(sqa, { sqa_view: 'browser', offset: page.next_offset, revision: page.revision }), /Restart at offset 0/);
	const fresh = readSqaWorkPage(sqa, { sqa_view: 'browser' });
	assert.notEqual(fresh.revision, page.revision);
	assert.equal(fresh.items[0].id, page.items[1].id);
});

test('published and budget-closed work plans cannot reopen exploration or mutate saved evidence', () => {
	const sqa = state();
	for (const patch of [{ budgetCloseout: { trigger: 'input_tokens' } }, { finalizedAt: '2026-11-10T00:00:00Z' }]) {
		const closed = { ...sqa, ...patch }, before = structuredClone(closed);
		assert.deepEqual(buildSqaWorkPlan(closed).activeControls, []);
		assert.equal(readSqaWorkPage(closed, { sqa_view: 'browser' }).closed, true);
		assert.deepEqual(closed, before);
	}
});

test('configured-provider SQA can read contracts and complete media guidance without running a browser or writing state', async () => {
	const session = { sqa: state() }, before = structuredClone(session);
	const read = createSqaTools(session, { async commit() { throw Error('Read must not persist'); } }).find(tool => tool.name === 'read_sqa_work_plan');
	const page = await read.run({ sqa_view: 'media' });
	assert.equal(page.success, true); assert.equal(page.items[0].guidance, BROWSER_WORKFLOW_GUIDANCE);
	assert.equal((await read.run({ sqa_view: 'browser', offset: 1001 })).success, false);
	assert.deepEqual(session, before);
});

test('request register separates browser work from reviewer artifacts using assessed requirement snapshots', () => {
	const sqa = state();
	sqa.assessment = evaluateSqaAssessment({ target: sqa.scope.target, assessedAt: '2026-11-10T00:00:00.000Z', profiles: sqa.scope.profiles, attributes: sqa.scope.attributes, observations: [] });
	const before = structuredClone(sqa.assessment), markdown = buildSqaReportMarkdown(sqa.assessment);
	assert.match(markdown, /\| SQA-CHG-001 \| reviewer \| change-release-approval \| approval_record \/ 1 \| Authorized change/);
	assert.match(markdown, /\| SQA-WEB-001 \| browser \|/);
	sqa.assessment.results.find(r => r.controlId === 'SQA-CHG-001').evidenceCoverage.requirements.find(r => r.type === 'approval_record').satisfied = true;
	assert.ok(!buildSqaWorkPlan(sqa).reviewerRequests.some(r => r.controlId === 'SQA-CHG-001'));
	assert.equal(before.verdict, 'blocked');
});
