import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	buildFounderReportMarkdown,
	createFounderReviewTodos,
	createFounderState,
	finishFounderReview,
	FOUNDER_CATEGORY_IDS,
	FOUNDER_CAVEAT,
	founderCoverage,
	hasFounderPublicOnlyDecision,
	recordFounderPublicOnlyDecision,
	recordFounderObservation,
	recordFounderObservations
} from './founderService.js';
import { clearSecrets, storeSecrets } from './secrets.js';
import { createFounderTools } from './founderTools.js';

const fixedNow = () => Date.parse('2026-08-18T00:00:00.000Z');

function founderSession() {
	return {
		id: '123e4567-e89b-42d3-a456-426614174200',
		mode: 'founder',
		targetUrl: 'https://example.test/',
		messages: [],
		activities: [
			{ id: 'open-1', toolName: 'browser_open', status: 'done', ts: fixedNow(), summary: 'Opened landing page.' },
			{ id: 'snapshot-1', toolName: 'browser_snapshot', status: 'done', ts: fixedNow(), summary: 'Observed product landing page.' },
			{ id: 'diagnostics-1', toolName: 'browser_diagnostics', status: 'done', ts: fixedNow(), summary: 'No failed requests in sampled flow.' }
		],
		todos: [],
		founder: createFounderState({
			authorizationConfirmed: true,
			target: { name: 'Example', url: 'https://example.test/', release: '1', environment: 'test' },
			productContext: { stage: 'beta', businessModel: 'B2B SaaS', targetCustomer: 'Operations leaders', primaryGoal: 'Improve activation' }
		}, fixedNow)
	};
}

function runStore() {
	const commits = [];
	return { commits, async commit(_session, type, payload) { commits.push({ type, payload }); } };
}

function populateObservations(session) {
	session.founder.observations = FOUNDER_CATEGORY_IDS.map((category, index) => ({
		id: `observation-${index + 1}`,
		category,
		type: index % 2 ? 'opportunity' : 'strength',
		title: `${category} observation`,
		summary: `Browser-visible evidence for ${category}.`,
		confidence: 'high',
		evidence: [{ activityId: `activity-${index + 1}`, reference: `qase://activity-${index + 1}`, summary: 'Observed.', collectedAt: '2026-08-18T00:00:00.000Z' }],
		createdAt: '2026-08-18T00:00:00.000Z'
	}));
}

function reportInput(session) {
	const id = category => session.founder.observations.find(item => item.category === category).id;
	const evidence = category => [id(category)];
	return {
		executive_summary: 'The sampled product communicates a credible core promise, with activation and commercial clarity as the highest-leverage opportunities. This review covers browser-accessible surfaces only.',
		icp: { primary: 'Operations leaders at scaling SaaS companies', users: ['Operations teams'], buyers: ['Operations leaders'], jobs: ['Find and resolve quality risk'], pains: ['Slow manual review'], evidence_observation_ids: evidence('customer_discovery'), assumptions: [] },
		positioning: { category: 'Product quality platform', one_liner: 'Review product quality with an autonomous browser agent.', value_proposition: 'Reduce the time from release candidate to evidence-backed decision.', differentiators: ['Integrated browser evidence'], alternatives: ['Manual review'], evidence_observation_ids: evidence('positioning'), assumptions: [] },
		monetization: { model: 'Subscription SaaS', value_metric: 'Completed product reviews', packages: ['Team', 'Business'], pricing_presentation: 'Connect each tier to review volume and governance needs.', next_tests: ['Interview five target buyers about the value metric.'], evidence_observation_ids: evidence('monetization_pricing'), assumptions: [] },
		recommendations: FOUNDER_CATEGORY_IDS.slice(0, 6).map((category, index) => ({ id: `rec-${index + 1}`, category, title: `Improve ${category}`, rationale: 'The sampled flow exposes a focused opportunity.', actions: ['Prototype and test the change.'], impact: 'high', effort: index % 2 ? 'medium' : 'low', confidence: 'medium', evidence_observation_ids: evidence(category), assumptions: [] })),
		marketing: { channels: [{ channel: 'Founder-led content', rationale: 'The product has demonstrable workflows.', first_test: 'Publish three workflow teardown posts.', confidence: 'medium', evidence_observation_ids: evidence('marketing_growth'), assumptions: [] }], content_angles: ['Evidence-backed release confidence'], launch_motions: ['Design-partner launch'], growth_loops: ['Shareable review summaries'], assumptions: [] },
		sales: { motion: 'Founder-led discovery followed by a scoped pilot.', qualification_questions: ['How are releases approved today?'], objection_responses: [{ objection: 'We already test manually.', response: 'Use the product to standardize evidence and surface blind spots.' }], sales_assets: ['Annotated sample review'], evidence_observation_ids: evidence('go_to_market_sales'), assumptions: [] },
		risks: [{ title: 'Unvalidated willingness to pay', likelihood: 'medium', impact: 'high', mitigation: 'Run buyer interviews and paid pilots.', evidence_observation_ids: [], assumptions: ['No customer or revenue evidence was available in this browser review.'] }],
		quick_wins: ['rec-1'],
		plan: { days_30: ['Validate ICP and activation problem.'], days_60: ['Ship the highest-confidence activation change.'], days_90: ['Evaluate pilot and pricing evidence.'] },
		metrics: {
			north_star: { name: 'Reviews reaching a decision', definition: 'Completed reviews that produce an accepted next action.', why: 'It connects use to a product decision.', evidence_observation_ids: evidence('metrics_experiments'), assumptions: [] },
			candidates: [{ name: 'Time to first useful observation', definition: 'Elapsed time from review start to first accepted observation.', evidence_observation_ids: evidence('activation'), assumptions: [] }],
			experiments: [{ hypothesis: 'A guided setup will improve first-review completion.', change: 'Add a three-step setup.', success_metric: 'First-review completion rate', timebox: 'Two weeks after sufficient traffic', guardrail: 'No increase in setup abandonment', evidence_observation_ids: evidence('onboarding'), assumptions: ['No current conversion baseline was available.'] }]
		}
	};
}

test('Founder state requires authorization and exposes the complete bounded taxonomy', () => {
	assert.throws(() => createFounderState({ target: { name: 'Example' } }), /authorized/);
	const state = founderSession().founder;
	assert.equal(state.schemaVersion, '2026.08.1');
	assert.deepEqual(state.scope.categories, FOUNDER_CATEGORY_IDS);
	assert.equal(state.scope.productContext.businessModel, 'B2B SaaS');
	const todos = createFounderReviewTodos();
	assert.equal(todos.length, 8);
	assert.ok(todos.every(item => item.status === 'pending'));
	assert.match(todos[0].text, /evidence baseline/i);
	assert.match(todos.at(-1).text, /publish the Founder report/i);
});

test('Founder complete tool workflow records all lenses, finalizes strategy, and exports a traceable report', async () => {
	const candidate = founderSession();
	candidate.todos = createFounderReviewTodos().map(todo => ({ ...todo, status: 'completed' }));
	const persistence = runStore();
	const tools = createFounderTools(candidate, persistence);
	const record = tools.find(tool => tool.name === 'record_founder_observation');
	const finish = tools.find(tool => tool.name === 'finish_founder_review');
	const recorded = await record.run({ observations: FOUNDER_CATEGORY_IDS.map(category => ({
		category, type: 'opportunity', title: `Observed ${category} opportunity`,
		summary: `Deterministic fixture browser observations support a bounded review of ${category}.`,
		confidence: 'medium', evidence_activity_ids: candidate.activities.map(activity => activity.id)
	})) });
	assert.equal(recorded.success, true, recorded.error);
	assert.equal(recorded.recorded_count, FOUNDER_CATEGORY_IDS.length);
	const result = await finish.run(reportInput(candidate));
	assert.equal(result.success, true, result.error);
	assert.ok(candidate.founder.finalizedAt);
	assert.equal(candidate.founder.report.coverage.categoriesReviewed.length, FOUNDER_CATEGORY_IDS.length);
	const markdown = buildFounderReportMarkdown(candidate);
	assert.match(markdown, /30 \/ 60 \/ 90-day plan/);
	assert.match(markdown, /Metrics & experiments/);
	for (const recommendation of candidate.founder.report.recommendations) {
		for (const id of recommendation.evidenceObservationIds) {
			assert.ok(candidate.founder.observations.some(observation => observation.id === id));
			assert.ok(markdown.includes(id));
		}
	}
	const count = persistence.commits.length;
	assert.equal((await finish.run(reportInput(candidate))).already_finalized, true);
	assert.equal(persistence.commits.length, count);
	assert.equal((await record.run({ category: 'activation', type: 'opportunity', title: 'Late change', summary: 'Must stay immutable.', confidence: 'low' })).success, false);
});

test('Founder finalization storage failure preserves observations and permits a durable retry', async () => {
	const candidate = founderSession();
	populateObservations(candidate);
	const previous = structuredClone(candidate.founder);
	await assert.rejects(finishFounderReview(candidate, reportInput(candidate), {
		async commit() { throw new Error('persistence unavailable'); }
	}, fixedNow), /persistence unavailable/);
	assert.deepEqual(candidate.founder, previous);
	const persistence = runStore();
	await finishFounderReview(candidate, reportInput(candidate), persistence, fixedNow);
	assert.ok(candidate.founder.finalizedAt);
	assert.equal(persistence.commits.length, 1);
});

test('Founder public-only access decisions are durable, bounded, and idempotent', () => {
	const candidate = founderSession();
	assert.equal(hasFounderPublicOnlyDecision(candidate), false);
	const decision = recordFounderPublicOnlyDecision(candidate, fixedNow);
	assert.deepEqual(decision, {
		decision: 'public_only',
		authenticatedSurfaces: 'excluded',
		decidedAt: '2026-08-18T00:00:00.000Z',
		source: 'user'
	});
	assert.equal(hasFounderPublicOnlyDecision(candidate), true);
	assert.equal(recordFounderPublicOnlyDecision(candidate, () => fixedNow() + 60_000), decision);
});

test('Founder observations are vault-redacted and cryptographically bound to completed browser activities', async () => {
	const session = founderSession();
	const store = runStore();
	const secret = 'founder-sensitive-secret';
	storeSecrets(session.id, { QA_PASSWORD: secret });
	try {
		const observation = await recordFounderObservation(session, {
			category: 'product_clarity', type: 'friction', title: 'Primary promise is hard to scan',
			summary: `The hero mixes several outcomes ${secret}.`, confidence: 'high',
			evidence_activity_ids: ['snapshot-1']
		}, store, fixedNow);
		assert.equal(observation.evidence[0].activityId, 'snapshot-1');
		assert.match(observation.evidence[0].reference, /^qase:\/\/runs\//);
		assert.match(observation.evidence[0].digest, /^sha256:[0-9a-f]{64}$/);
		assert.doesNotMatch(JSON.stringify(observation), new RegExp(secret));
		assert.equal(store.commits[0].type, 'founder.observation');
		await assert.rejects(recordFounderObservation(session, {
			category: 'roadmap', type: 'risk', title: 'Unsupported', summary: 'No evidence.', confidence: 'low', evidence_activity_ids: ['missing']
		}, store, fixedNow), /not a completed browser activity/);
	} finally {
		clearSecrets(session.id);
	}
});

test('Founder observation batches validate and persist atomically with per-item evidence', async () => {
	const candidate = founderSession();
	const store = runStore();
	const productClarity = {
		category: 'product_clarity', type: 'strength', title: 'Clear promise',
		summary: 'The landing page states one primary outcome.', confidence: 'high',
		evidence_activity_ids: ['snapshot-1']
	};
	const positioning = {
		category: 'positioning', type: 'opportunity', title: 'Proof can be closer to the claim',
		summary: 'The positioning claim and proof are separated in the sampled page.', confidence: 'medium',
		evidence_activity_ids: ['open-1', 'snapshot-1']
	};

	await assert.rejects(recordFounderObservations(candidate, [productClarity, {
		...positioning, evidence_activity_ids: ['not-a-real-activity']
	}], store, fixedNow), /not a completed browser activity/);
	assert.equal(candidate.founder.observations.length, 0);
	assert.equal(store.commits.length, 0);

	const recorded = await recordFounderObservations(candidate, [productClarity, positioning], store, fixedNow);
	assert.equal(recorded.length, 2);
	assert.deepEqual(recorded.map(item => item.evidence.map(evidence => evidence.activityId)), [
		['snapshot-1'], ['open-1', 'snapshot-1']
	]);
	assert.equal(candidate.founder.observations.length, 2);
	assert.equal(store.commits.length, 1);
	assert.equal(store.commits[0].payload.observations.length, 2);

	const rollbackCandidate = founderSession();
	await assert.rejects(recordFounderObservations(rollbackCandidate, [productClarity], {
		async commit() { throw new Error('persistence unavailable'); }
	}, fixedNow), /persistence unavailable/);
	assert.equal(rollbackCandidate.founder.observations.length, 0);
});

test('Founder report validation enforces coverage, provenance, pricing, conservative evidence confidence, and immutability', async () => {
	const session = founderSession();
	const store = runStore();
	await assert.rejects(finishFounderReview(session, {}, store, fixedNow), /missing evidence-backed categories/);
	populateObservations(session);
	const report = await finishFounderReview(session, reportInput(session), store, fixedNow);
	assert.equal(founderCoverage(session.founder).missing.length, 0);
	assert.equal(report.monetization.valueMetric, 'Completed product reviews');
	assert.equal(report.evidenceConfidence.rating, 'medium');
	assert.equal(report.evidenceConfidence.uniqueBrowserActivities, FOUNDER_CATEGORY_IDS.length);
	assert.ok(report.evidenceConfidence.assumptionCount >= 2);
	assert.match(report.evidenceConfidence.limitation, /private analytics/);
	assert.equal(report.caveat, FOUNDER_CAVEAT);
	assert.equal(store.commits.at(-1).type, 'founder.finalized');
	await assert.rejects(recordFounderObservation(session, { category: 'roadmap', type: 'risk', title: 'Late edit', summary: 'No.', confidence: 'low' }, store, fixedNow), /finalized/);
	assert.equal(await finishFounderReview(session, reportInput(session), store, fixedNow), report);
	assert.match(buildFounderReportMarkdown(session), /## Monetization & pricing/);
});

test('Founder Markdown exports the complete decision artifact and its evidence and assumption trace', async () => {
	const session = founderSession();
	populateObservations(session);
	const report = await finishFounderReview(session, reportInput(session), runStore(), fixedNow);
	const markdown = buildFounderReportMarkdown(session);

	assert.match(markdown, /## Evidence confidence/);
	assert.match(markdown, /\*\*Rating:\*\* medium/);
	assert.match(markdown, new RegExp(report.evidenceConfidence.limitation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	assert.match(markdown, /\*\*Explicit assumptions:\*\* 2/);
	assert.match(markdown, /\*\*External evidence classes:\*\* none/);

	assert.match(markdown, /## Observation evidence registry/);
	for (const observation of session.founder.observations) {
		assert.match(markdown, new RegExp(observation.id));
		assert.match(markdown, new RegExp(observation.evidence[0].reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
	}

	assert.match(markdown, /## Ideal customer profile[\s\S]*\*\*Evidence observations\*\*[\s\S]*`observation-1`/);
	assert.match(markdown, /## Positioning[\s\S]*\*\*Market category:\*\* Product quality platform[\s\S]*\*\*Differentiators\*\*[\s\S]*Integrated browser evidence[\s\S]*\*\*Alternatives\*\*[\s\S]*Manual review/);
	assert.match(markdown, /## Monetization & pricing[\s\S]*\*\*Value metric:\*\* Completed product reviews[\s\S]*Interview five target buyers[\s\S]*`observation-8`/);

	assert.match(markdown, /## Prioritized recommendations[\s\S]*\*\*ID:\*\* `rec-1`[\s\S]*\*\*Impact:\*\* high[\s\S]*Prototype and test the change[\s\S]*`observation-1`/);
	assert.match(markdown, /## Marketing & growth[\s\S]*### Founder-led content[\s\S]*Publish three workflow teardown posts[\s\S]*Evidence-backed release confidence[\s\S]*Design-partner launch[\s\S]*Shareable review summaries/);
	assert.match(markdown, /## Sales & go-to-market[\s\S]*Founder-led discovery followed by a scoped pilot[\s\S]*How are releases approved today[\s\S]*We already test manually[\s\S]*Annotated sample review[\s\S]*`observation-11`/);
	assert.match(markdown, /## Key risks[\s\S]*Unvalidated willingness to pay[\s\S]*Run buyer interviews and paid pilots[\s\S]*No customer or revenue evidence was available/);
	assert.match(markdown, /## Quick wins[\s\S]*`rec-1` — Improve customer_discovery[\s\S]*Prototype and test the change/);

	assert.match(markdown, /### North-star metric[\s\S]*Reviews reaching a decision[\s\S]*It connects use to a product decision[\s\S]*`observation-16`/);
	assert.match(markdown, /### Metric candidates[\s\S]*Time to first useful observation[\s\S]*Elapsed time from review start[\s\S]*`observation-6`/);
	assert.match(markdown, /### Experiments[\s\S]*A guided setup will improve first-review completion[\s\S]*\*\*Change:\*\* Add a three-step setup[\s\S]*\*\*Success metric:\*\* First-review completion rate[\s\S]*\*\*Timebox:\*\* Two weeks after sufficient traffic[\s\S]*\*\*Guardrail:\*\* No increase in setup abandonment[\s\S]*No current conversion baseline was available/);
	assert.match(markdown, /## Important boundary[\s\S]*do not guarantee revenue/i);
});

test('Founder report rejects unsupported references, unlabeled strategic claims, complete-source claims, and oversized state before mutation', async () => {
	const unsupported = founderSession();
	populateObservations(unsupported);
	const invalid = reportInput(unsupported);
	invalid.icp.evidence_observation_ids = ['unknown-observation'];
	await assert.rejects(finishFounderReview(unsupported, invalid, runStore(), fixedNow), /unknown ID/);
	assert.equal(unsupported.founder.report, undefined);

	const untraceable = founderSession(); populateObservations(untraceable);
	const untraceableReport = reportInput(untraceable);
	untraceableReport.sales.evidence_observation_ids = [];
	await assert.rejects(finishFounderReview(untraceable, untraceableReport, runStore(), fixedNow), /must cite an observation or identify an assumption/);

	const sourceClaim = founderSession(); populateObservations(sourceClaim);
	const sourceReport = reportInput(sourceClaim);
	sourceReport.executive_summary = 'I reviewed the complete source code and found it excellent.';
	await assert.rejects(finishFounderReview(sourceClaim, sourceReport, runStore(), fixedNow), /browser-accessible product surfaces/);

	const oversized = founderSession(); populateObservations(oversized);
	const huge = reportInput(oversized);
	huge.recommendations = Array.from({ length: 50 }, (_, index) => ({
		id: `huge-${index}`, category: FOUNDER_CATEGORY_IDS[index % FOUNDER_CATEGORY_IDS.length], title: `Recommendation ${index}`,
		rationale: 'r'.repeat(4_000), actions: Array.from({ length: 15 }, () => 'a'.repeat(2_000)),
		impact: 'high', effort: 'high', confidence: 'low', evidence_observation_ids: [], assumptions: ['A'.repeat(1_000)]
	}));
	huge.quick_wins = ['huge-0'];
	await assert.rejects(finishFounderReview(oversized, huge, runStore(), fixedNow), /smaller than 1,000,000 serialized bytes/);
	assert.equal(oversized.founder.finalizedAt, undefined);
});
