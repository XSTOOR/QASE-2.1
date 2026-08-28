import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	collectFounderAssumptions,
	describeFounderLifecycle,
	founderEvidenceSummary,
	groupFounderObservations,
	resolveFounderQuickWins
} from '../public/founderPresentation.js';

test('Founder lifecycle never presents an unfinished review as complete', () => {
	assert.equal(describeFounderLifecycle({}, 'idle', 0).phase, 'ready');
	assert.equal(describeFounderLifecycle({ observations: [] }, 'running', 0).phase, 'running');
	assert.equal(describeFounderLifecycle({ observations: [] }, 'awaiting_input', 0).phase, 'waiting');
	assert.equal(describeFounderLifecycle({ observations: [{ id: 'o1' }] }, 'idle', 0).phase, 'paused');
	assert.equal(describeFounderLifecycle({ observations: [] }, 'error', 0).phase, 'error');
	assert.equal(describeFounderLifecycle({ observations: [{ id: 'o1' }] }, 'interrupted', 1).phase, 'interrupted');
	assert.match(describeFounderLifecycle({ observations: [{ id: 'o1' }] }, 'idle', 1).message, /paused/i);
	assert.equal(describeFounderLifecycle({ finalizedAt: '2026-08-18T00:00:00.000Z' }, 'done', 0).finalized, false);
	assert.equal(describeFounderLifecycle({
		finalizedAt: '2026-08-18T00:00:00.000Z',
		report: { coverage: { categoriesReviewed: ['user_experience'], totalCategories: 17, evidenceBackedObservations: 1 } }
	}, 'done', 0).finalized, true);
});

test('Founder observations are grouped by type, category, and product surface', () => {
	const observations = [
		{ id: 'strength', category: 'visual_interface', type: 'strength' },
		{ id: 'friction', category: 'onboarding', type: 'friction' },
		{ id: 'opportunity', category: 'monetization_pricing', type: 'opportunity' },
		{ id: 'risk', category: 'trust_security', type: 'risk' }
	];
	const groups = groupFounderObservations(observations);
	assert.deepEqual(groups.strengths.map(item => item.id), ['strength']);
	assert.deepEqual(groups.frictions.map(item => item.id), ['friction']);
	assert.deepEqual(groups.opportunities.map(item => item.id), ['opportunity']);
	assert.deepEqual(groups.risks.map(item => item.id), ['risk']);
	assert.deepEqual(groups.byCategory.onboarding.map(item => item.id), ['friction']);
	assert.deepEqual(groups.productFindings.map(item => item.id), ['strength', 'friction', 'risk']);
});

test('Founder quick wins resolve only valid recommendation IDs in declared order', () => {
	const report = {
		recommendations: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
		quickWins: ['b', 'missing', 'a']
	};
	assert.deepEqual(resolveFounderQuickWins(report).map(item => item.id), ['b', 'a']);
});

test('Founder evidence summary counts unique browser activities and confidence', () => {
	const summary = founderEvidenceSummary({
		scope: { categories: ['visual_interface', 'onboarding'] },
		observations: [
			{ category: 'visual_interface', confidence: 'high', evidence: [{ activityId: 'a1' }, { activityId: 'a2' }] },
			{ category: 'onboarding', confidence: 'medium', evidence: [{ activityId: 'a2' }] },
			{ category: 'onboarding', confidence: 'low', evidence: [] }
		]
	});
	assert.deepEqual(summary.confidence, { high: 1, medium: 1, low: 1 });
	assert.equal(summary.observations, 3);
	assert.equal(summary.artifacts, 3);
	assert.equal(summary.activities, 2);
	assert.equal(summary.reviewed, 2);
	assert.equal(summary.total, 2);
});

test('Founder assumptions include monetization and metric hypotheses', () => {
	const assumptions = collectFounderAssumptions({
		icp: { assumptions: ['ICP hypothesis'] },
		monetization: { assumptions: ['Pricing hypothesis'] },
		metrics: {
			northStar: { assumptions: ['Metric hypothesis'] },
			candidates: [{ name: 'Activation', assumptions: ['Candidate hypothesis'] }],
			experiments: [{ assumptions: ['Experiment hypothesis'] }]
		}
	});
	assert.deepEqual(assumptions, [
		{ source: 'ICP', text: 'ICP hypothesis' },
		{ source: 'Monetization', text: 'Pricing hypothesis' },
		{ source: 'North-star metric', text: 'Metric hypothesis' },
		{ source: 'Experiment 1', text: 'Experiment hypothesis' },
		{ source: 'Activation', text: 'Candidate hypothesis' }
	]);
});
