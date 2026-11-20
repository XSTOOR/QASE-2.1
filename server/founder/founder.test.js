import test from 'node:test';
import assert from 'node:assert/strict';
import { createFounderRunState, normalizeBrief, briefQuestion, isFounderEngineSession } from './engine.js';
import { toSignals } from './signals.js';
import { recordBusinessTool, recordMarketTool, recordJourneyTool, scoreLensTool, recordRecommendationsTool, finishTool, knownEvidence } from './tools.js';
import { lensScores, readinessScore, orderedRecommendations, fallbackRecommendations, buildFounderReport, buildFounderMarkdown, founderFindings } from './report.js';
import { LENSES, LENS_IDS, SIGNAL_KINDS, verdictFor } from './catalog.js';
import { FIXTURE_FACTS, createFounderReviewFixture } from './fixtureReview.js';

const TARGET = 'https://taskly.test/';
function freshState(brief = {}) {
	const state = createFounderRunState({ targetUrl: TARGET, name: 'Taskly', brief });
	state.targetUrl = TARGET;
	state.signals = toSignals(FIXTURE_FACTS, { targetUrl: TARGET });
	state.sources = [{ url: 'https://asana.test/', via: 'web_search' }];
	return state;
}
const business = { name: 'Taskly', category: 'saas', one_liner: 'Tasks for agencies', target_customer: { inferred: 'Agencies' }, business_model: 'free_trial', primary_goal: 'sign_up', journeys: [{ name: 'Sign up', goal: 'Create an account' }], evidence: ['/: headline'] };

test('the brief keeps only known values and the launcher state is a version 2 engine run', () => {
	const brief = normalizeBrief({ goals: '  More   trials ', stage: 'unicorn', journeys: 'A\nB\n\nC\nD\nE', competitors: 'x.test', focus: ['trust', 'nope'] });
	assert.equal(brief.goals, 'More trials');
	assert.equal(brief.stage, undefined);
	assert.equal(brief.journeys.length, 4, 'at most four owner journeys');
	assert.deepEqual(brief.focus, ['trust']);
	const session = { mode: 'founder', founder: createFounderRunState({ targetUrl: TARGET, brief }) };
	assert.equal(isFounderEngineSession(session), true);
	assert.equal(session.founder.scope.target.name, 'taskly.test');
	assert.equal(isFounderEngineSession({ mode: 'founder', founder: { scope: {} } }), false);
	const question = briefQuestion('taskly.test');
	assert.equal(question.kind, 'founder_brief');
	assert.match(question.question, /taskly\.test/);
	assert.ok(question.options.some(option => /skip/i.test(option)), 'the owner can always skip');
});

test('measured signals cover every kind with stable ids and the planted gaps', () => {
	const signals = toSignals(FIXTURE_FACTS, { targetUrl: TARGET });
	assert.equal(signals.length, Object.keys(SIGNAL_KINDS).length);
	assert.deepEqual(signals.map(item => item.id), signals.map((_, index) => `S${index + 1}`));
	const status = kind => signals.find(item => item.kind === kind).status;
	assert.equal(status('value.headline'), 'weak', 'a 14-word headline is weak');
	assert.equal(status('conversion.pricing'), 'missing', 'a broken pricing link counts as missing');
	assert.equal(status('onboarding.signup_friction'), 'missing', 'nine fields is heavy friction');
	assert.equal(status('mobile.layout'), 'missing');
	assert.equal(status('trust.https'), 'good');
	const unmeasured = toSignals({}, { targetUrl: TARGET });
	assert.ok(unmeasured.every(item => item.status === 'unknown'), 'nothing is invented when the start page could not be measured');
});

test('the business tool puts the owner journeys first and caps the plan', async () => {
	const state = freshState({ journeys: 'Invite a teammate\nSign up' });
	const result = await recordBusinessTool(state).run({ ...business, journeys: [{ name: 'Sign up', goal: 'Account' }, ...Array.from({ length: 8 }, (_, i) => ({ name: `Extra ${i}`, goal: 'x' }))] });
	assert.equal(result.success, true);
	assert.deepEqual(state.journeyPlan.slice(0, 2).map(item => [item.id, item.name, item.requestedBy]), [['J1', 'Invite a teammate', 'owner'], ['J2', 'Sign up', 'owner']]);
	assert.equal(state.journeyPlan.length, 6);
	assert.equal((await recordBusinessTool(freshState()).run({ ...business, evidence: [] })).success, false, 'conclusions need evidence');
	assert.equal((await recordBusinessTool(freshState()).run({ ...business, category: 'spaceships' })).success, false);
});

test('competitors are accepted only from this run’s research and never the product itself', async () => {
	const state = freshState();
	const result = await recordMarketTool(state).run({
		competitors: [
			{ name: 'Asana', url: 'https://asana.test/', source_url: 'https://asana.test/pricing' },
			{ name: 'Invented', url: 'https://made-up.test/', source_url: 'https://made-up.test/' },
			{ name: 'Itself', url: 'https://taskly.test/', source_url: 'https://asana.test/' }
		],
		expectations: ['Free plan']
	});
	assert.deepEqual(state.market.competitors.map(item => item.id + ':' + item.name), ['C1:Asana']);
	assert.equal(result.rejected.length, 2);
	assert.equal((await recordMarketTool(freshState()).run({ competitors: [{ name: 'Invented', url: 'https://made-up.test/', source_url: 'https://made-up.test/' }], expectations: [] })).success, false);
	assert.equal((await recordMarketTool(freshState()).run({ competitors: [], expectations: [], none_found: 'A new category.' })).success, true);
});

test('journeys, lens scores and recommendations must cite known evidence', async () => {
	const state = freshState();
	await recordBusinessTool(state).run(business);
	assert.equal((await recordJourneyTool(state).run({ journey_id: 'J9', outcome: 'completed', steps: ['x'], summary: 'x' })).success, false);
	assert.equal((await recordJourneyTool(state).run({ journey_id: 'j1', outcome: 'blocked', steps: ['Opened sign-up', 'Gave up'], summary: 'Too long' })).success, true);
	assert.ok(knownEvidence(state).has('J1'));
	assert.equal((await scoreLensTool(state).run({ lens: 'trust', score: 11, verdict: 'x', evidence: ['S1'] })).success, false);
	assert.equal((await scoreLensTool(state).run({ lens: 'trust', score: 6, verdict: 'x', evidence: ['S999'] })).success, false);
	const scored = await scoreLensTool(state).run({ lens: 'trust', score: 6.25, verdict: 'Fine', evidence: ['s4', 'S999'] });
	assert.equal(scored.success, true);
	assert.deepEqual(state.lenses.trust.evidence, ['S4'], 'ids are normalised and unknown ones dropped');
	assert.equal(scored.remaining.length, LENS_IDS.length - 1);

	const base = { lens: 'conversion', kind: 'do', impact: 'high', effort: 'small', why: 'Buyers leave.', how: ['Add /pricing'] };
	const rejected = await recordRecommendationsTool(state).run({ recommendations: [{ ...base, title: 'A', priority: 'now', evidence: [] }, { ...base, title: 'B', priority: 'next', evidence: [] }] });
	assert.equal(rejected.success, false, 'fewer than three valid recommendations');
	assert.match(rejected.error, /"now" priority needs evidence/);
	const accepted = await recordRecommendationsTool(state).run({
		recommendations: [{ ...base, title: 'A', priority: 'now', evidence: ['S8'] }, { ...base, title: 'B', priority: 'later', evidence: [] }, { ...base, title: 'C', kind: 'avoid', priority: 'next', evidence: [] }, { ...base, title: 'D', how: [], priority: 'next', evidence: [] }],
		keep: [{ title: 'HTTPS', why: 'Trust', evidence: ['S7'] }]
	});
	assert.equal(accepted.accepted, 3);
	assert.equal(state.recommendations.find(item => item.title === 'C').kind, 'avoid');
	assert.equal(state.keep[0].title, 'HTTPS');
	assert.equal((await finishTool(state).run({ summary: '' })).success, false);
});

test('readiness is the lens-weighted score and the verdict bands are fixed', () => {
	assert.equal(LENSES.reduce((sum, lens) => sum + lens.weight, 0), 100);
	const state = freshState();
	state.lenses = Object.fromEntries(LENS_IDS.map(id => [id, { score: 8 }]));
	assert.equal(readinessScore(lensScores(state)), 80);
	assert.equal(verdictFor(80).id, 'ready');
	assert.equal(verdictFor(79).id, 'polish');
	assert.equal(verdictFor(45).id, 'not_ready');
	assert.equal(verdictFor(10).id, 'major_gaps');
	assert.equal(verdictFor(null).id, 'not_assessed');
	const measuredOnly = lensScores(freshState());
	assert.ok(measuredOnly.every(lens => lens.score === null || lens.scoredBy === 'measured'), 'without a model the scorecard comes from measurements');
	assert.equal(readinessScore(lensScores({ signals: [] })), null);
});

test('recommendations are ordered now → next → later, then by impact and effort, and fall back to measured gaps', () => {
	const state = freshState();
	state.recommendations = [
		{ title: 'later', lens: 'trust', kind: 'do', priority: 'later', impact: 'high', effort: 'small', why: 'x', how: ['x'], evidence: [] },
		{ title: 'now-medium', lens: 'trust', kind: 'do', priority: 'now', impact: 'medium', effort: 'small', why: 'x', how: ['x'], evidence: ['S1'] },
		{ title: 'now-high-large', lens: 'trust', kind: 'do', priority: 'now', impact: 'high', effort: 'large', why: 'x', how: ['x'], evidence: ['S1'] },
		{ title: 'now-high-small', lens: 'trust', kind: 'do', priority: 'now', impact: 'high', effort: 'small', why: 'x', how: ['x'], evidence: ['S1'] },
		{ title: 'next', lens: 'trust', kind: 'do', priority: 'next', impact: 'high', effort: 'small', why: 'x', how: ['x'], evidence: [] }
	];
	const ordered = orderedRecommendations(state);
	assert.deepEqual(ordered.map(item => item.title), ['now-high-small', 'now-high-large', 'now-medium', 'next', 'later']);
	assert.deepEqual(ordered.map(item => item.id), ['R1', 'R2', 'R3', 'R4', 'R5']);
	assert.equal(ordered[0].actions[0], 'x', 'handoff fields are present');
	const fallback = fallbackRecommendations(freshState());
	assert.ok(fallback.length >= 5);
	assert.ok(fallback.every(item => item.evidence.length === 1 && item.how.length));
	assert.ok(fallback.some(item => item.priority === 'now' && item.lens === 'conversion'), 'missing pricing is a do-now fix');
});

test('the finished report carries everything a founder and the Studio handoff need', async () => {
	const session = await createFounderReviewFixture();
	const report = buildFounderReport(session);
	assert.equal(report.engine, 'qase-founder');
	assert.equal(report.lenses.length, 10);
	assert.equal(report.counts.recommendations, report.recommendations.length);
	assert.equal(report.counts.blocked, 1);
	assert.equal(report.recommendationSet.setVersion, 1);
	assert.match(report.disclaimer, /\w/);
	const findings = founderFindings(session);
	assert.equal(findings.length, report.counts.now);
	assert.ok(findings.every(item => item.category === 'business'));
	const markdown = buildFounderMarkdown(session);
	assert.match(markdown, /Readiness/i);
	assert.match(markdown, /R1/);
	assert.doesNotMatch(markdown, /undefined/);
});
