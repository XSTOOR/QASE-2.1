import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	describeSqaLifecycle,
	groupSqaUnresolvedResults,
	isSqaBudgetStopResult,
	SQA_AGENT_CAPABLE_EVIDENCE_TYPES
} from '../public/sqaPresentation.js';

const draft = {
	assessment: { verdict: 'blocked' },
	observations: []
};

test('snapshot-owned release reports are reviewer gaps while older snapshots retain their original classification', () => {
	const result = { controlId: 'SQA-QUA-006', status: 'blocked', automationLevel: 'agent_assisted', evidenceCoverage: { requirements: [{ type: 'security_report', satisfied: false, owner: 'reviewer' }] } };
	assert.equal(groupSqaUnresolvedResults([result]).reviewer.length, 1);
	const historical = structuredClone(result); delete historical.evidenceCoverage.requirements[0].owner;
	assert.equal(groupSqaUnresolvedResults([historical]).automated.length, 1);
});

test('an evidence-empty SQA draft is ready rather than a final blocked verdict', () => {
	const presentation = describeSqaLifecycle(draft, 'idle', 0);
	assert.equal(presentation.phase, 'ready');
	assert.equal(presentation.badge, 'ready');
	assert.equal(presentation.label, 'Ready to test');
	assert.equal(presentation.finalized, false);
});

test('unfinished SQA sessions communicate running, waiting, and provisional progress', () => {
	assert.equal(describeSqaLifecycle(draft, 'running', 0).phase, 'running');
	assert.equal(describeSqaLifecycle(draft, 'awaiting_input', 0).phase, 'waiting');
	assert.equal(describeSqaLifecycle(draft, 'idle', 1).phase, 'in_progress');
	assert.equal(describeSqaLifecycle({ ...draft, observations: [{ controlId: 'SQA-1' }] }, 'idle', 0).phase, 'in_progress');
});

test('blocked is shown only for a finalized deterministic SQA result', () => {
	const presentation = describeSqaLifecycle({
		...draft,
		finalizedAt: '2026-08-15T00:00:00.000Z'
	}, 'idle', 0);
	assert.equal(presentation.phase, 'finalized');
	assert.equal(presentation.badge, 'blocked');
	assert.equal(presentation.label, 'Blocked');
	assert.equal(presentation.finalized, true);
});

function unresolved({ id, automationLevel, types, status = 'blocked' }) {
	return {
		controlId: id,
		status,
		automationLevel,
		evidenceCoverage: {
			requirements: types.map(type => ({ type, satisfied: false }))
		}
	};
}

test('unresolved SQA controls distinguish reviewer, mixed, automated, and failed results', () => {
	assert.deepEqual(SQA_AGENT_CAPABLE_EVIDENCE_TYPES, [
		'assessment_record', 'configuration_record', 'security_report', 'test_result', 'wcag_report'
	]);
	const reviewer = unresolved({ id: 'reviewer', automationLevel: 'manual', types: ['approval_record'] });
	const mixed = unresolved({ id: 'mixed', automationLevel: 'hybrid', types: ['test_result', 'risk_register'] });
	const automated = unresolved({ id: 'automated', automationLevel: 'automated', types: ['test_result'] });
	const failure = unresolved({ id: 'failure', automationLevel: 'automated', types: ['test_result'], status: 'fail' });
	const budget = { ...unresolved({ id: 'budget', automationLevel: 'hybrid', types: ['test_result', 'risk_register'] }), rationale: 'Stopped early: budget reached. The host SQA input-token safety limit was exhausted.' };
	const groups = groupSqaUnresolvedResults([reviewer, mixed, automated, failure, budget, { status: 'pass' }]);
	assert.deepEqual(groups.reviewer, [reviewer]);
	assert.deepEqual(groups.mixed, [mixed]);
	assert.deepEqual(groups.automated, [automated]);
	assert.deepEqual(groups.failures, [failure]);
	assert.deepEqual(groups.budget, [budget]);
	assert.equal(isSqaBudgetStopResult(budget), true);
	assert.equal(isSqaBudgetStopResult({ rationale: 'The host SQA browser-tool safety limit was exhausted (120/120).' }), true, 'older published assessments remain classified');
});

test('a reviewer-only blocked verdict is presented as evidence incomplete without changing raw verdict', () => {
	const presentation = describeSqaLifecycle({
		finalizedAt: '2026-08-17T00:00:00.000Z',
		assessment: {
			verdict: 'blocked',
			summary: { fail: 0 },
			results: [unresolved({ id: 'reviewer', automationLevel: 'manual', types: ['approval_record'] })]
		}
	}, 'idle', 0);
	assert.equal(presentation.status, 'blocked');
	assert.equal(presentation.rawVerdict, 'blocked');
	assert.equal(presentation.label, 'Evidence incomplete');
	assert.equal(presentation.badge, 'evidence incomplete');
	assert.equal(presentation.evidenceIncomplete, true);
});

test('an automated blocker or real failure retains the blocked presentation', () => {
	for (const result of [
		unresolved({ id: 'automated', automationLevel: 'automated', types: ['test_result'] }),
		unresolved({ id: 'failure', automationLevel: 'manual', types: ['approval_record'], status: 'fail' })
	]) {
		const presentation = describeSqaLifecycle({
			finalizedAt: '2026-08-17T00:00:00.000Z',
			assessment: { verdict: 'blocked', results: [result] }
		}, 'idle', 0);
		assert.equal(presentation.label, 'Blocked');
		assert.equal(presentation.evidenceIncomplete, false);
	}
});
