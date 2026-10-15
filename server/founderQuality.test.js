import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	createFounderState,
	finishFounderReview,
	FOUNDER_CATEGORY_IDS,
	buildFounderReportMarkdown
} from './founderService.js';

/**
 * Phase 5 quality gate: the founder pipeline must produce materially
 * DIFFERENT, product-specific outputs for two materially different
 * products — not the same generic advice re-skinned. Both fixtures model
 * the mocked-model output shape (snake_case tool input) exactly as the
 * finish_founder_review tool would supply it after observing each product.
 */

const fixedNow = () => Date.parse('2026-09-30T00:00:00.000Z');

function makeSession({ name, url, context, categories }) {
	return {
		id: `123e4567-e89b-42d3-a456-4266141742${categories.length % 10}${categories.length % 7}`,
		mode: 'founder',
		targetUrl: url,
		messages: [],
		activities: [
			{ id: 'open-1', toolName: 'browser_open', status: 'done', ts: fixedNow(), summary: 'Opened landing page.' },
			{ id: 'snapshot-1', toolName: 'browser_snapshot', status: 'done', ts: fixedNow(), summary: 'Observed product surfaces.' },
			{ id: 'diagnostics-1', toolName: 'browser_diagnostics', status: 'done', ts: fixedNow(), summary: 'Diagnostics captured.' }
		],
		todos: [],
		founder: createFounderState({
			authorizationConfirmed: true,
			target: { name, url, release: '1', environment: 'test' },
			productContext: context
		}, fixedNow)
	};
}

function populateObservations(session, spec) {
	session.founder.observations = FOUNDER_CATEGORY_IDS.map((category, index) => ({
		id: `observation-${index + 1}`,
		category,
		type: index % 2 ? 'opportunity' : 'strength',
		title: spec.observationTitles[category] ?? `${category} observation`,
		summary: spec.observationSummaries[category] ?? `Browser-visible evidence for ${category}.`,
		confidence: 'high',
		evidence: [{ activityId: `activity-${index + 1}`, reference: `qase://activity-${index + 1}`, summary: spec.evidenceSummary, collectedAt: '2026-09-30T00:00:00.000Z' }],
		createdAt: '2026-09-30T00:00:00.000Z'
	}));
}

function observationId(session, category) {
	return session.founder.observations.find(item => item.category === category).id;
}

function recommendationBlock(session, spec) {
	return spec.recommendations.map((rec, index) => ({
		id: `rec-${index + 1}`,
		category: rec.category,
		title: rec.title,
		opportunity: rec.opportunity,
		proposed_feature: rec.proposedFeature,
		why_it_matters: rec.whyItMatters,
		intended_outcome: rec.intendedOutcome,
		priority_reason: rec.priorityReason,
		actions: rec.actions,
		implementation_scope: rec.implementationScope,
		acceptance_criteria: rec.acceptanceCriteria,
		dependencies: rec.dependencies,
		impact: rec.impact,
		effort: rec.effort,
		confidence: rec.confidence,
		evidence_observation_ids: [observationId(session, rec.category)],
		assumptions: []
	}));
}

function reportInput(session, spec) {
	return {
		executive_summary: spec.executiveSummary,
		icp: { primary: spec.icp.primary, users: [spec.icp.usersString], buyers: [spec.icp.buyersString], jobs: spec.icp.jobs.map(String), pains: spec.icp.pains.map(String), evidence_observation_ids: [observationId(session, 'customer_discovery')], assumptions: [] },
		positioning: { category: spec.positioning.category, one_liner: spec.positioning.oneLiner, value_proposition: spec.positioning.value, differentiators: [spec.positioning.differentiator], alternatives: [spec.positioning.alternative], evidence_observation_ids: [observationId(session, 'positioning')], assumptions: [] },
		monetization: { model: spec.monetization.model, value_metric: spec.monetization.valueMetric, packages: [spec.monetization.package], pricing_presentation: spec.monetization.pricingPresentation, next_tests: [spec.monetization.nextTest], evidence_observation_ids: [observationId(session, 'monetization_pricing')], assumptions: [] },
		recommendations: recommendationBlock(session, spec),
		marketing: { channels: [{ channel: spec.marketing.channel, rationale: spec.marketing.rationale, first_test: spec.marketing.firstTest, confidence: 'medium', evidence_observation_ids: [observationId(session, 'marketing_growth')], assumptions: [] }], content_angles: [spec.marketing.angle], launch_motions: [spec.marketing.launch], growth_loops: [spec.marketing.loop], assumptions: [] },
		sales: { motion: spec.sales.motion, qualification_questions: [spec.sales.question], objection_responses: [{ objection: spec.sales.objection, response: spec.sales.response }], sales_assets: [spec.sales.asset], evidence_observation_ids: [observationId(session, 'go_to_market_sales')], assumptions: [] },
		risks: spec.risks.map(risk => ({ title: risk.title, likelihood: risk.likelihood, impact: risk.impact, mitigation: risk.mitigation, evidence_observation_ids: [], assumptions: [risk.assumption] })),
		quick_wins: ['rec-1'],
		plan: { days_30: [spec.plan.d30], days_60: [spec.plan.d60], days_90: [spec.plan.d90] },
		metrics: {
			north_star: { name: spec.metrics.northStar, definition: spec.metrics.definition, why: spec.metrics.why, evidence_observation_ids: [observationId(session, 'metrics_experiments')], assumptions: [] },
			candidates: [{ name: spec.metrics.candidate, definition: spec.metrics.candidateDefinition, evidence_observation_ids: [observationId(session, 'activation')], assumptions: [] }],
			experiments: [{ hypothesis: spec.metrics.hypothesis, change: spec.metrics.change, success_metric: spec.metrics.successMetric, timebox: 'Two weeks', guardrail: spec.metrics.guardrail, evidence_observation_ids: [observationId(session, 'onboarding')], assumptions: [] }]
		}
	};
}

/** Product A — B2B manufacturing-equipment marketplace with RFQ workflow. */
const MARKETPLACE_SPEC = {
	executiveSummary: 'A credible RFQ marketplace whose activation hinges on supplier onboarding friction; monetization clarity is the fastest commercial unlock.',
	icp: { primary: 'Procurement managers at mid-size manufacturers', usersString: 'Buyers and suppliers', buyersString: 'Plant operations leads', jobs: ['Source parts faster'], pains: ['Multi-day quote cycles'] },
	positioning: { category: 'Industrial RFQ marketplace', oneLiner: 'Source machined parts through transparent quotes.', value: 'Compress quote cycles from days to hours.', differentiator: 'Structured RFQ templates', alternative: 'Email + spreadsheets' },
	monetization: { model: 'Transaction fee + supplier subscription', valueMetric: 'Closed RFQs', package: 'Supplier Pro', pricingPresentation: 'Fee per closed RFQ with subscription for analytics.', nextTest: 'Interview ten suppliers on fee tolerance.' },
	marketing: { channel: 'Industry trade associations', rationale: 'Buyers cluster in associations.', firstTest: 'Co-publish an RFQ benchmark report.', angle: 'Quote-cycle benchmarks', launch: 'Association partnership pilot', loop: 'Shared supplier scorecards' },
	sales: { motion: 'Founder-led onboarding of anchor suppliers.', question: 'How do you source custom parts today?', objection: 'We already have supplier lists.', response: 'Structured RFQs make quote comparison auditable.', asset: 'Sample RFQ walkthrough video' },
	risks: [{ title: 'Unverified supplier liquidity', likelihood: 'high', impact: 'high', mitigation: 'Pre-sign five anchor suppliers per category before charging fees.', assumption: 'Supplier counts were not observable in this review.' }],
	plan: { d30: 'Sign five anchor suppliers.', d60: 'Run ten RFQs end-to-end.', d90: 'Decide fee model from closed RFQ data.' },
	metrics: { northStar: 'RFQs closed per week', definition: 'RFQs reaching an accepted quote.', why: 'It ties usage to the core transaction.', candidate: 'Time to first quote', candidateDefinition: 'Hours from RFQ post to first supplier quote.', hypothesis: 'Guided RFQ templates will increase quote completion.', change: 'Add RFQ template picker.', successMetric: 'Quote completion rate', guardrail: 'No drop in RFQ detail quality' },
	observationTitles: { onboarding: 'Supplier signup requires manual document upload', monetization_pricing: 'No visible pricing or fee structure' },
	observationSummaries: { onboarding: 'Supplier onboarding has a 7-step unguided form.', monetization_pricing: 'Fee model is not shown anywhere on the product.' },
	evidenceSummary: 'Marketplace RFQ flow observed end-to-end.',
	recommendations: [
		{
			category: 'onboarding', title: 'Add supplier onboarding document scan integration',
			opportunity: 'Suppliers upload business documents manually in a 7-step unguided flow; observed abandonment mid-flow.',
			proposedFeature: 'Integrate a document-scanning/OCR service (e.g. an existing KYB vendor) to prefill supplier registration from uploaded documents.',
			whyItMatters: 'Supplier liquidity is the marketplace core; every hour of onboarding friction delays RFQ supply.',
			intendedOutcome: 'Suppliers complete registration in fewer steps, increasing RFQ supply without manual back-office work.',
			priorityReason: 'Unblocks marketplace supply, the binding constraint observed in this product.', actions: ['Pilot OCR prefill on the business-details step.', 'Measure step-level completion before/after.'],
			implementationScope: 'Client: add document upload with vendor SDK on step 3. Server: one webhook receiver for extracted fields. No schema change.',
			acceptanceCriteria: ['A supplier can upload one document and see prefilled fields.', 'Step 3 completion rate is measurable in analytics.'],
			dependencies: ['KYB vendor contract'], impact: 'high', effort: 'medium', confidence: 'medium'
		},
		{
			category: 'monetization_pricing', title: 'Publish the transaction fee model',
			opportunity: 'No fee, package, or pricing surface exists anywhere on the marketplace.',
			proposedFeature: 'Add a pricing page stating the per-closed-RFQ fee and Supplier Pro subscription.',
			whyItMatters: 'Buyers and suppliers cannot evaluate commercial terms, blocking committed usage.',
			intendedOutcome: 'Users self-qualify on cost before engaging, improving RFQ quality.',
			priorityReason: 'Cheapest unlock with direct revenue-path impact.', actions: ['Draft fee table.', 'A/B the pricing page against a contact-sales variant.'],
			implementationScope: 'Static page + CMS entry. No backend change.',
			acceptanceCriteria: ['Pricing page is reachable from primary nav.', 'Fee terms render on mobile.'],
			dependencies: [], impact: 'high', effort: 'small', confidence: 'high'
		},
		{
			category: 'activation', title: 'RFQ template picker on first use',
			opportunity: 'First-time buyers face a blank RFQ form with no guidance.',
			proposedFeature: 'Offer three RFQ templates (machining, sheet metal, casting) as a starting point.',
			whyItMatters: 'Blank-form activation friction was observed for the core buyer action.',
			intendedOutcome: 'First RFQs are completed with complete part specifications.',
			priorityReason: 'Directly targets the observed blank-form drop-off.', actions: ['Define three templates.', 'Instrument template selection.'],
			implementationScope: 'Client form logic + one server enum. No schema change.',
			acceptanceCriteria: ['A new buyer can start from a template.', 'Template choice is recorded per RFQ.'],
			dependencies: [], impact: 'medium', effort: 'small', confidence: 'medium'
		}
	]
};

/** Product B — consumer language-learning app with streak mechanics. */
const LANGUAGE_APP_SPEC = {
	executiveSummary: 'An engaging consumer language app whose retention depends on streak recovery; social features are the highest-leverage growth unlock.',
	icp: { primary: 'Casual adult language learners', usersString: 'Learners', buyersString: 'The learner (self-serve)', jobs: ['Keep a daily habit'], pains: ['Guilt after missing a day'] },
	positioning: { category: 'Consumer habit app', oneLiner: 'Learn a language without breaking the chain.', value: 'Make daily practice emotionally self-reinforcing.', differentiator: 'Streak recovery mechanics', alternative: 'Flashcard apps' },
	monetization: { model: 'Freemium subscription', valueMetric: 'Daily active learners', package: 'Premium', pricingPresentation: 'Free core lessons; premium unlocks offline and advanced content.', nextTest: 'Test price sensitivity with a 7-day premium trial cohort.' },
	marketing: { channel: 'Short-form video', rationale: 'Habit content thrives on TikTok/Reels.', firstTest: 'Publish 20 streak-story videos.', angle: 'Streak comebacks', launch: 'Creator partnership burst', loop: 'Shareable streak milestones' },
	sales: { motion: 'Self-serve in-app upgrade.', question: 'What happens after you miss a day?', objection: 'Free apps are enough.', response: 'Streak recovery keeps the habit alive after slips.', asset: 'Streak-comeback story reel' },
	risks: [{ title: 'Retention mechanics may not convert to payment', likelihood: 'medium', impact: 'high', mitigation: 'Gate recovery behind premium only after measuring willingness in trials.', assumption: 'No revenue data was observable in this review.' }],
	plan: { d30: 'Ship streak recovery.', d60: 'Run the creator burst.', d90: 'Evaluate trial-to-paid conversion.' },
	metrics: { northStar: 'Daily active learners', definition: 'Learners completing one lesson per day.', why: 'The habit is the product.', candidate: 'Day-7 retention', candidateDefinition: 'Share of new learners active on day 7.', hypothesis: 'Streak recovery will lift day-7 retention.', change: 'Add one free recovery per week.', successMetric: 'Day-7 retention rate', guardrail: 'No drop in daily completions' },
	observationTitles: { onboarding: 'Cold start with no placement test', retention: 'Hard streak reset after one missed day' },
	observationSummaries: { onboarding: 'Lesson 1 starts with no skill assessment.', retention: 'A missed day resets the streak to zero with no recovery path.' },
	evidenceSummary: 'Learner flow observed across lessons and streak screens.',
	recommendations: [
		{
			category: 'retention', title: 'Streak recovery with one weekly free revive',
			opportunity: 'Missing one day resets the streak to zero; observed churn-recovery dead end.',
			proposedFeature: 'Offer one free streak revive per week plus a revive-with-friend social mechanic.',
			whyItMatters: 'Streak loss is the observed emotional cliff where casual learners quit.',
			intendedOutcome: 'Lapsed learners return after a missed day instead of abandoning the app.',
			priorityReason: 'Directly repairs the observed quit moment in this product.', actions: ['Define revive rules.', 'Instrument revive usage vs. return rate.'],
			implementationScope: 'Server: streak state gains a revive counter. Client: revive dialog on return. One migration.',
			acceptanceCriteria: ['A learner missing one day can revive.', 'Revive usage is tracked per learner.'],
			dependencies: ['Push notification provider'], impact: 'high', effort: 'medium', confidence: 'medium'
		},
		{
			category: 'activation', title: 'Placement micro-test on first launch',
			opportunity: 'New learners start at lesson 1 regardless of prior skill; observed boredom for advanced beginners.',
			proposedFeature: 'A 90-second adaptive placement test that skips known material.',
			whyItMatters: 'Easy early lessons make the habit feel valueless, weakening day-2 return.',
			intendedOutcome: 'Learners land in content at their level, improving early retention.',
			priorityReason: 'Fixes the first-session boredom signal before growth spend.', actions: ['Author 3 adaptive branches.', 'Measure lesson-skip rates.'],
			implementationScope: 'Client: placement flow before lesson 1. Server: learner level field. One migration.',
			acceptanceCriteria: ['A new learner can take the placement test.', 'Lesson difficulty reflects placement result.'],
			dependencies: [], impact: 'high', effort: 'medium', confidence: 'medium'
		},
		{
			category: 'marketing_growth', title: 'Shareable streak milestone cards',
			opportunity: 'No shareable moment exists at streak milestones despite an inherently social habit loop.',
			proposedFeature: 'Generate a styled milestone card (7/30/100 days) with one-tap share to social platforms.',
			whyItMatters: 'Organic sharing is the cheapest acquisition channel for a self-serve consumer app.',
			intendedOutcome: 'Learners broadcast milestones, driving organic installs.',
			priorityReason: 'Lowest-effort growth loop aligned with the observed habit mechanic.', actions: ['Design three card templates.', 'Add share tap tracking with attribution.'],
			implementationScope: 'Client: card renderer + Web Share API. Server: none.',
			acceptanceCriteria: ['A learner at day 7 sees the share card.', 'Share taps are attributed in analytics.'],
			dependencies: [], impact: 'medium', effort: 'small', confidence: 'medium'
		}
	]
};

async function runFounderPipeline(spec, product) {
	const session = makeSession({
		name: product.name,
		url: product.url,
		context: product.context,
		categories: FOUNDER_CATEGORY_IDS
	});
	populateObservations(session, spec);
	const runStore = { commits: [], async commit(_s, type, payload) { this.commits.push({ type, payload }); } };
	const report = await finishFounderReview(session, reportInput(session, spec), runStore, fixedNow);
	return { session, report, markdown: buildFounderReportMarkdown(session) };
}

test('quality gate: B2B marketplace product yields its own prioritized, product-specific recommendations', async () => {
	const { report, markdown } = await runFounderPipeline(MARKETPLACE_SPEC, {
		name: 'PartsHub',
		url: 'https://partshub.test/',
		context: { stage: 'beta', businessModel: 'B2B marketplace', targetCustomer: 'Procurement managers', primaryGoal: 'Grow RFQ volume' }
	});
	assert.equal(report.recommendations.length, 3);
	assert.equal(report.target.name, 'PartsHub');
	// Ranked by the product's own constraints: supply first, then revenue path.
	assert.match(report.recommendations[0].title, /supplier onboarding/i);
	assert.match(report.recommendations[1].title, /fee model|pricing/i);
	assert.match(report.recommendations[0].proposedFeature, /integration|vendor|OCR/i);
	assert.match(report.recommendations[0].whyItMatters, /marketplace|supply|liquidity/i);
	assert.match(markdown, /RFQ/);
	assert.doesNotMatch(markdown, /streak|language learner|lesson/i);
});

test('quality gate: consumer language app yields its own prioritized, product-specific recommendations', async () => {
	const { report, markdown } = await runFounderPipeline(LANGUAGE_APP_SPEC, {
		name: 'ChainLingo',
		url: 'https://chainlingo.test/',
		context: { stage: 'launched', businessModel: 'Consumer freemium', targetCustomer: 'Casual learners', primaryGoal: 'Improve day-7 retention' }
	});
	assert.equal(report.recommendations.length, 3);
	assert.equal(report.target.name, 'ChainLingo');
	// Ranked by this product's constraint: the quit moment first.
	assert.match(report.recommendations[0].title, /streak recovery/i);
	assert.match(report.recommendations[0].proposedFeature, /revive/i);
	assert.match(report.recommendations[2].title, /milestone|share/i);
	assert.match(markdown, /streak/);
	assert.doesNotMatch(markdown, /RFQ|supplier|marketplace/i);
});

test('quality gate: two materially different products produce materially different outputs', async () => {
	const a = await runFounderPipeline(MARKETPLACE_SPEC, {
		name: 'PartsHub', url: 'https://partshub.test/',
		context: { stage: 'beta', businessModel: 'B2B marketplace', targetCustomer: 'Procurement managers', primaryGoal: 'Grow RFQ volume' }
	});
	const b = await runFounderPipeline(LANGUAGE_APP_SPEC, {
		name: 'ChainLingo', url: 'https://chainlingo.test/',
		context: { stage: 'launched', businessModel: 'Consumer freemium', targetCustomer: 'Casual learners', primaryGoal: 'Improve day-7 retention' }
	});
	const aTitles = a.report.recommendations.map(item => item.title).join(' | ');
	const bTitles = b.report.recommendations.map(item => item.title).join(' | ');
	// Zero overlap — the outputs are not generic advice re-skinned.
	const overlap = a.report.recommendations.filter(itemA =>
		b.report.recommendations.some(itemB =>
			itemA.title.toLowerCase() === itemB.title.toLowerCase()
			|| itemA.proposedFeature === itemB.proposedFeature
			|| itemA.whyItMatters === itemB.whyItMatters));
	assert.equal(overlap.length, 0, `Expected no shared recommendations, found: ${overlap.map(item => item.title).join(', ')}`);
	// Different ICPs, positioning, north stars.
	assert.notEqual(a.report.icp.primary, b.report.icp.primary);
	assert.notEqual(a.report.metrics.northStar.name, b.report.metrics.northStar.name);
	assert.notEqual(a.report.positioning.category, b.report.positioning.category);
	// Both remain valid: ranked 1..3, evidence-linked, effort-bounded.
	for (const report of [a.report, b.report]) {
		assert.deepEqual(report.recommendations.map(item => item.priority), [1, 2, 3]);
		assert.ok(report.recommendations.every(item => ['small', 'medium', 'large'].includes(item.effort)));
		assert.ok(report.recommendations.every(item => item.evidenceObservationIds.length === 1));
	}
});

test('quality gate: recommendations prefer an existing integration when one fits', async () => {
	// Marketplace recommendation #1 proposes a KYB vendor integration rather
	// than building document parsing in-house — pinned by the pipeline.
	const { report } = await runFounderPipeline(MARKETPLACE_SPEC, {
		name: 'PartsHub', url: 'https://partshub.test/',
		context: { stage: 'beta', businessModel: 'B2B marketplace', targetCustomer: 'Procurement managers', primaryGoal: 'Grow RFQ volume' }
	});
	assert.match(report.recommendations[0].proposedFeature, /integrat|vendor|existing/i);
	assert.doesNotMatch(report.recommendations[0].proposedFeature, /build.*in-house|write.*parser/i);
});
