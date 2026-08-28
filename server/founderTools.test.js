import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFounderState, FOUNDER_CATEGORY_IDS, recordFounderPublicOnlyDecision } from './founderService.js';
import { createFounderTools, founderFinishReadiness, founderReportToolSchema } from './founderTools.js';

const now = Date.parse('2026-08-18T00:00:00.000Z');

function session() {
	return {
		id: 'founder-tools', mode: 'founder', targetUrl: 'https://example.test/', secretNames: [], messages: [],
		founder: createFounderState({ authorizationConfirmed: true, target: { name: 'Example', url: 'https://example.test/' } }, () => now),
		activities: [
			{ id: 'open', toolName: 'browser_open', status: 'done', ts: now },
			{ id: 'snap', toolName: 'browser_snapshot', status: 'done', ts: now },
			{ id: 'diag', toolName: 'browser_diagnostics', status: 'done', ts: now }
		],
		todos: [
			{ text: 'Inventory public and authorized product surfaces', status: 'completed' },
			{ text: 'Exercise representative end-to-end workflow', status: 'completed' }
		]
	};
}

test('Founder tools expose bounded observation and complete strategy schemas', () => {
	const tools = createFounderTools(session(), { async commit() {} });
	assert.deepEqual(tools.map(tool => tool.name), ['record_founder_observation', 'finish_founder_review']);
	assert.deepEqual(tools[0].parametersSchema.properties.category.enum, FOUNDER_CATEGORY_IDS);
	assert.equal(tools[0].parametersSchema.properties.observations.maxItems, FOUNDER_CATEGORY_IDS.length);
	assert.deepEqual(tools[0].parametersSchema.properties.observations.items.properties.category.enum, FOUNDER_CATEGORY_IDS);
	assert.ok(founderReportToolSchema().required.includes('monetization'));
	assert.ok(founderReportToolSchema().properties.icp.required.includes('evidence_observation_ids'));
});

test('Founder finalization readiness requires category, workflow, diagnostics, context, and auth decisions', () => {
	const candidate = session();
	let readiness = founderFinishReadiness(candidate, now);
	assert.equal(readiness.missing.length, FOUNDER_CATEGORY_IDS.length);
	assert.equal(readiness.browserEvidenceComplete, false);
	assert.equal(readiness.contextDecisionRecorded, false);

	candidate.founder.scope.productContext.targetCustomer = 'Founders';
	candidate.founder.observations = FOUNDER_CATEGORY_IDS.map((category, index) => ({
		id: `ob-${index}`, category, title: category === 'onboarding' ? 'Authentication gate observed' : category,
		summary: category === 'onboarding' ? 'Sign-in credentials are required.' : 'Observed.', confidence: 'medium',
		evidence: [{ activityId: ['open', 'snap', 'diag'][index % 3] }]
	}));
	readiness = founderFinishReadiness(candidate, now);
	assert.equal(readiness.missing.length, 0);
	assert.equal(readiness.browserEvidenceComplete, true);
	assert.equal(readiness.contextDecisionRecorded, true);
	assert.equal(readiness.authenticationDecisionRequired, true);

	candidate.messages.push({ role: 'user', text: 'Continue with a public-only review, infer the remaining founder context, and label authenticated surfaces not observed.' });
	const decided = founderFinishReadiness(candidate, now);
	assert.equal(decided.authenticationDecisionRequired, false);
	assert.equal(decided.contextDecisionRecorded, true);

	const durableDecision = session();
	durableDecision.founder.observations = candidate.founder.observations;
	recordFounderPublicOnlyDecision(durableDecision, () => now);
	assert.equal(founderFinishReadiness(durableDecision, now).authenticationDecisionRequired, false);

	const externalBoundary = session();
	externalBoundary.founder.observations = FOUNDER_CATEGORY_IDS.map((category, index) => ({
		id: `external-${index}`, category,
		title: category === 'onboarding' ? 'Product application is on a different origin' : category,
		summary: category === 'onboarding'
			? 'Authentication is inaccessible because the linked application is outside the authorized target origin.'
			: 'Observed on the declared origin.',
		confidence: 'medium', evidence: [{ activityId: ['open', 'snap', 'diag'][index % 3] }]
	}));
	const bounded = founderFinishReadiness(externalBoundary, now);
	assert.equal(bounded.authenticationDecisionRequired, false);
	assert.equal(bounded.contextDecisionRecorded, true);
});

test('Founder observation tool records multiple lenses in one bounded call', async () => {
	const candidate = session();
	const commits = [];
	const record = createFounderTools(candidate, {
		async commit(_session, type, payload) { commits.push({ type, payload }); }
	}).find(tool => tool.name === 'record_founder_observation');
	const result = await record.run({ observations: [
		{ category: 'product_clarity', type: 'strength', title: 'Clear hero', summary: 'The hero states a concrete outcome.', confidence: 'high', evidence_activity_ids: ['snap'] },
		{ category: 'positioning', type: 'opportunity', title: 'Sharpen proof', summary: 'The sampled page could connect proof more directly to its promise.', confidence: 'medium', evidence_activity_ids: ['open', 'snap'] }
	] });

	assert.equal(result.success, true);
	assert.equal(result.recorded_count, 2);
	assert.equal(result.observations.length, 2);
	assert.equal(candidate.founder.observations.length, 2);
	assert.equal(commits.length, 1);
});

test('Founder finish tool returns actionable guards instead of publishing partial advice', async () => {
	const candidate = session();
	const finish = createFounderTools(candidate, { async commit() {} }).find(tool => tool.name === 'finish_founder_review');
	const result = await finish.run({});
	assert.equal(result.success, false);
	assert.match(result.error, /evidence from at least three browser activities/i);
	assert.equal(candidate.founder.finalizedAt, undefined);
});
