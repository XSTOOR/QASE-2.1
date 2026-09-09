import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AGENT_EVIDENCE_TYPES, createSqaState, createSqaTodoPlan } from './sqaService.js';
import { getSqaControl, SQA_PROFILES, SQA_PRODUCT_ATTRIBUTES } from './sqaCatalog.js';
import { createSqaTools } from './sqaTools.js';
import { buildSqaReportMarkdown } from './sqaAssessment.js';

// Deterministic workflow tests exercise real recording, evidence contracts,
// completion gates, and exported reports. Activity fixtures are simulated;
// live browser/media validation is performed by the separate browser suite.
for (const profiles of [...Object.keys(SQA_PROFILES).map(profile => [profile]), Object.keys(SQA_PROFILES)]) {
	test(`SQA ${profiles.join('+')} completes every scoped control while preserving reviewer-only prerequisites`, async () => {
		const session = {
			id: randomUUID(), mode: 'sqa', messages: [], activities: [],
			sqa: createSqaState({
				authorizationConfirmed: true, profiles, attributes: SQA_PRODUCT_ATTRIBUTES,
				target: { name: 'Deterministic meeting application fixture', release: 'test', environment: 'test' }
			})
		};
		session.todos = createSqaTodoPlan(session.sqa);
		const commits = [];
		const tools = createSqaTools(session, { async commit(_session, type, payload) { commits.push({ type, payload }); } });
		const record = tools.find(tool => tool.name === 'record_sqa_control');
		const finish = tools.find(tool => tool.name === 'finish_sqa_assessment');
		assert.equal((await finish.run()).success, false);
		let passed = 0;
		let blocked = 0;
		for (const controlId of session.sqa.scope.applicableControlIds) {
			const control = getSqaControl(controlId);
			const browserEligible = control.evidenceRequirements.every(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type));
			let input;
			if (browserEligible) {
				session.activities.push({ id: `check-${controlId}`, toolName: 'browser_snapshot', status: 'done', ts: Date.now(), summary: `Simulated successful ${controlId} browser check for deterministic contract validation.` });
				input = { control_id: controlId, status: 'pass', evidence: control.evidenceRequirements.flatMap(requirement => (
					Array.from({ length: requirement.minimum }, (_, index) => ({ type: requirement.type, summary: `Fixture result ${index + 1} for ${controlId}: ${requirement.type}.` }))
				)) };
				passed++;
			} else {
				input = { control_id: controlId, status: 'blocked', rationale: `Missing reviewed artifacts: ${control.evidenceRequirements.filter(requirement => !AGENT_EVIDENCE_TYPES.has(requirement.type)).map(requirement => requirement.type).join(', ')}.` };
				blocked++;
			}
			const result = await record.run(input);
			assert.equal(result.success, true, `${controlId}: ${result.error}`);
			assert.equal(result.status, input.status);
		}
		session.todos = session.todos.map(todo => ({ ...todo, status: 'completed' }));
		const final = await finish.run();
		assert.equal(final.success, true, final.error);
		assert.equal(final.verdict, 'blocked');
		assert.equal(final.coverage.observed, 100);
		assert.equal(session.sqa.assessment.summary.pass, passed);
		assert.equal(session.sqa.assessment.summary.blocked, blocked);
		assert.equal(session.sqa.assessment.summary.not_assessed, 0);
		assert.equal(session.sqa.assessment.technicalSummary.verdict, 'pass');
		assert.ok(session.sqa.finalizedAt);
		const markdown = buildSqaReportMarkdown(session.sqa.assessment);
		assert.match(markdown, /^# SQA assessment/);
		assert.match(markdown, /Missing reviewed artifacts/);
		assert.match(markdown, /not legal advice/);
		for (const id of session.sqa.scope.applicableControlIds) assert.ok(markdown.includes(id));
		const commitsBeforeReplay = commits.length;
		assert.equal((await finish.run()).already_finalized, true);
		assert.equal(commits.length, commitsBeforeReplay);
		assert.equal((await record.run({ control_id: session.sqa.scope.applicableControlIds[0], status: 'blocked', rationale: 'Late mutation' })).success, false);
	});
}
