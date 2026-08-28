export const FOUNDER_SCHEMA_VERSION = '2026.08.1';

/**
 * A bounded product review taxonomy. Founder Mode is deliberately broader than
 * a defect hunt, but it is not an unbounded "business guru" prompt: every
 * visible observation and every recommendation belongs to one of these areas.
 */
export const FOUNDER_CATEGORIES = Object.freeze([
	{ id: 'customer_discovery', label: 'Customer discovery & ICP', description: 'Intended users, buyers, jobs, pains, and evidence of demand.' },
	{ id: 'product_clarity', label: 'Product clarity', description: 'Problem, promise, value, scope, and comprehension.' },
	{ id: 'user_experience', label: 'User experience', description: 'Task flow, information architecture, feedback, recovery, and friction.' },
	{ id: 'visual_interface', label: 'UI & visual design', description: 'Hierarchy, consistency, readability, responsiveness, and polish.' },
	{ id: 'onboarding', label: 'Onboarding', description: 'First-run guidance, setup, empty states, and time to understanding.' },
	{ id: 'activation', label: 'Activation', description: 'Path to the first meaningful outcome and activation barriers.' },
	{ id: 'retention', label: 'Retention', description: 'Recurring value, habit loops, lifecycle messaging, and re-engagement.' },
	{ id: 'monetization_pricing', label: 'Monetization & pricing', description: 'Packaging, price communication, upgrade paths, and value metric.' },
	{ id: 'positioning', label: 'Positioning', description: 'Market frame, promise, audience relevance, and message coherence.' },
	{ id: 'differentiation', label: 'Differentiation', description: 'Defensible advantages, alternatives, and reasons to choose.' },
	{ id: 'go_to_market_sales', label: 'Go-to-market & sales', description: 'Sales motion, qualification, proof, objections, and enablement.' },
	{ id: 'marketing_growth', label: 'Marketing & growth', description: 'Acquisition channels, content, launches, loops, and distribution.' },
	{ id: 'trust_security', label: 'Trust, privacy & security', description: 'Trust signals, permissions, privacy communication, and buyer assurance.' },
	{ id: 'accessibility', label: 'Accessibility', description: 'Keyboard, semantics, contrast, labels, and inclusive interaction.' },
	{ id: 'technical_product_quality', label: 'Technical & product quality', description: 'Reliability, performance signals, errors, and product completeness.' },
	{ id: 'metrics_experiments', label: 'Metrics & experiments', description: 'Decision metrics, hypotheses, guardrails, and learning cadence.' },
	{ id: 'roadmap', label: 'Roadmap & prioritization', description: 'Sequencing, dependencies, trade-offs, and near-term focus.' }
]);

export const FOUNDER_CATEGORY_IDS = Object.freeze(FOUNDER_CATEGORIES.map(category => category.id));
export const FOUNDER_OBSERVATION_TYPES = Object.freeze(['strength', 'friction', 'opportunity', 'risk']);
export const FOUNDER_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const FOUNDER_CAVEAT = 'Founder Mode provides evidence-informed product and go-to-market guidance, not legal, financial, investment, security, or regulatory advice. Recommendations are hypotheses to validate with customers and market data; they do not guarantee revenue, growth, funding, product-market fit, or any other business outcome.';

const categoryIds = new Set(FOUNDER_CATEGORY_IDS);
const levels = new Set(FOUNDER_LEVELS);

export function boundedText(value, label, maximum, { required = false } = {}) {
	if (value === undefined || value === null) {
		if (required) throw new TypeError(`${label} is required.`);
		return undefined;
	}
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
	const normalized = value.trim();
	if (required && !normalized) throw new TypeError(`${label} is required.`);
	if (normalized.length > maximum) throw new TypeError(`${label} cannot exceed ${maximum} characters.`);
	return normalized || undefined;
}

export function boundedStrings(value, label, { minimum = 0, maximum = 20, itemMaximum = 2_000 } = {}) {
	if (!Array.isArray(value)) throw new TypeError(`${label} must be an array.`);
	if (value.length < minimum || value.length > maximum) {
		throw new TypeError(`${label} must contain ${minimum}-${maximum} items.`);
	}
	return value.map((item, index) => boundedText(item, `${label} ${index + 1}`, itemMaximum, { required: true }));
}

export function founderCategory(value, label = 'Founder category') {
	const category = boundedText(value, label, 80, { required: true });
	if (!categoryIds.has(category)) throw new TypeError(`${label} is invalid.`);
	return category;
}

export function founderLevel(value, label, fallback) {
	const level = value === undefined ? fallback : boundedText(value, label, 20, { required: true });
	if (!levels.has(level)) throw new TypeError(`${label} must be low, medium, or high.`);
	return level;
}

export function assertPlainObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	return value;
}

function normalizeAssumptions(value, label) {
	return boundedStrings(value ?? [], label, { maximum: 20, itemMaximum: 1_000 });
}

function normalizeReferenceIds(value, label, allowedIds, { minimum = 0, maximum = 30 } = {}) {
	const ids = boundedStrings(value ?? [], label, { minimum, maximum, itemMaximum: 128 });
	if (new Set(ids).size !== ids.length) throw new TypeError(`${label} cannot contain duplicates.`);
	for (const id of ids) {
		if (!allowedIds.has(id)) throw new TypeError(`${label} references unknown ID ${id}.`);
	}
	return ids;
}

function validateEvidenceOrAssumptions(evidenceIds, assumptions, label) {
	if (evidenceIds.length === 0 && assumptions.length === 0) {
		throw new TypeError(`${label} must cite an observation or identify an assumption.`);
	}
}

function countAssumptions(value) {
	if (Array.isArray(value)) return value.reduce((total, item) => total + countAssumptions(item), 0);
	if (!value || typeof value !== 'object') return 0;
	return Object.entries(value).reduce((total, [key, item]) => (
		total + (key === 'assumptions' && Array.isArray(item) ? item.length : countAssumptions(item))
	), 0);
}

/**
 * Normalize the model's final payload into the single persisted Founder report
 * shape. Computed fields and the caveat never come from the model.
 */
export function normalizeFounderReport(input, { observations, target, generatedAt }) {
	assertPlainObject(input, 'Founder report');
	const observationIds = new Set(observations.map(item => item.id));

	const rawIcp = assertPlainObject(input.icp, 'Founder ICP');
	const icpEvidenceObservationIds = normalizeReferenceIds(rawIcp.evidence_observation_ids ?? rawIcp.evidenceObservationIds, 'Founder ICP evidence', observationIds);
	const icpAssumptions = normalizeAssumptions(rawIcp.assumptions, 'Founder ICP assumptions');
	validateEvidenceOrAssumptions(icpEvidenceObservationIds, icpAssumptions, 'Founder ICP');
	const icp = {
		primary: boundedText(rawIcp.primary, 'Founder ICP primary customer', 1_000, { required: true }),
		users: boundedStrings(rawIcp.users, 'Founder ICP users', { minimum: 1 }),
		buyers: boundedStrings(rawIcp.buyers, 'Founder ICP buyers', { minimum: 1 }),
		jobs: boundedStrings(rawIcp.jobs, 'Founder ICP jobs', { minimum: 1 }),
		pains: boundedStrings(rawIcp.pains, 'Founder ICP pains', { minimum: 1 }),
		evidenceObservationIds: icpEvidenceObservationIds,
		assumptions: icpAssumptions
	};

	const rawPositioning = assertPlainObject(input.positioning, 'Founder positioning');
	const positioningEvidenceObservationIds = normalizeReferenceIds(rawPositioning.evidence_observation_ids ?? rawPositioning.evidenceObservationIds, 'Founder positioning evidence', observationIds);
	const positioningAssumptions = normalizeAssumptions(rawPositioning.assumptions, 'Founder positioning assumptions');
	validateEvidenceOrAssumptions(positioningEvidenceObservationIds, positioningAssumptions, 'Founder positioning');
	const positioning = {
		category: boundedText(rawPositioning.category, 'Founder positioning category', 500, { required: true }),
		oneLiner: boundedText(rawPositioning.one_liner ?? rawPositioning.oneLiner, 'Founder positioning one-liner', 1_000, { required: true }),
		valueProposition: boundedText(rawPositioning.value_proposition ?? rawPositioning.valueProposition, 'Founder value proposition', 2_000, { required: true }),
		differentiators: boundedStrings(rawPositioning.differentiators, 'Founder differentiators', { minimum: 1 }),
		alternatives: boundedStrings(rawPositioning.alternatives, 'Founder alternatives', { minimum: 1 }),
		evidenceObservationIds: positioningEvidenceObservationIds,
		assumptions: positioningAssumptions
	};

	const rawMonetization = assertPlainObject(input.monetization, 'Founder monetization plan');
	const monetizationEvidenceObservationIds = normalizeReferenceIds(rawMonetization.evidence_observation_ids ?? rawMonetization.evidenceObservationIds, 'Founder monetization evidence', observationIds);
	const monetizationAssumptions = normalizeAssumptions(rawMonetization.assumptions, 'Founder monetization assumptions');
	validateEvidenceOrAssumptions(monetizationEvidenceObservationIds, monetizationAssumptions, 'Founder monetization plan');
	const monetization = {
		model: boundedText(rawMonetization.model, 'Founder monetization model', 2_000, { required: true }),
		valueMetric: boundedText(rawMonetization.value_metric ?? rawMonetization.valueMetric, 'Founder monetization value metric', 1_000, { required: true }),
		packages: boundedStrings(rawMonetization.packages, 'Founder monetization packages', { minimum: 1 }),
		pricingPresentation: boundedText(rawMonetization.pricing_presentation ?? rawMonetization.pricingPresentation, 'Founder pricing presentation', 2_000, { required: true }),
		nextTests: boundedStrings(rawMonetization.next_tests ?? rawMonetization.nextTests, 'Founder monetization tests', { minimum: 1 }),
		evidenceObservationIds: monetizationEvidenceObservationIds,
		assumptions: monetizationAssumptions
	};

	if (!Array.isArray(input.recommendations) || input.recommendations.length < 6 || input.recommendations.length > 50) {
		throw new TypeError('Founder recommendations must contain 6-50 items.');
	}
	const recommendationIds = new Set();
	const recommendations = input.recommendations.map((item, index) => {
		assertPlainObject(item, `Founder recommendation ${index + 1}`);
		const id = boundedText(item.id ?? `recommendation-${index + 1}`, `Founder recommendation ${index + 1} ID`, 128, { required: true });
		if (recommendationIds.has(id)) throw new TypeError(`Founder recommendation ID ${id} is duplicated.`);
		recommendationIds.add(id);
		const evidenceObservationIds = normalizeReferenceIds(
			item.evidence_observation_ids ?? item.evidenceObservationIds,
			`Founder recommendation ${id} evidence`, observationIds
		);
		const assumptions = normalizeAssumptions(item.assumptions, `Founder recommendation ${id} assumptions`);
		validateEvidenceOrAssumptions(evidenceObservationIds, assumptions, `Founder recommendation ${id}`);
		return {
			id,
			category: founderCategory(item.category, `Founder recommendation ${id} category`),
			title: boundedText(item.title, `Founder recommendation ${id} title`, 500, { required: true }),
			rationale: boundedText(item.rationale, `Founder recommendation ${id} rationale`, 4_000, { required: true }),
			actions: boundedStrings(item.actions, `Founder recommendation ${id} actions`, { minimum: 1, maximum: 15 }),
			impact: founderLevel(item.impact, `Founder recommendation ${id} impact`),
			effort: founderLevel(item.effort, `Founder recommendation ${id} effort`),
			confidence: founderLevel(item.confidence, `Founder recommendation ${id} confidence`),
			evidenceObservationIds,
			assumptions
		};
	});

	const rawMarketing = assertPlainObject(input.marketing, 'Founder marketing plan');
	const channels = (rawMarketing.channels ?? []).map((item, index) => {
		assertPlainObject(item, `Founder marketing channel ${index + 1}`);
		const evidenceObservationIds = normalizeReferenceIds(
			item.evidence_observation_ids ?? item.evidenceObservationIds,
			`Founder marketing channel ${index + 1} evidence`, observationIds
		);
		const assumptions = normalizeAssumptions(item.assumptions, `Founder marketing channel ${index + 1} assumptions`);
		validateEvidenceOrAssumptions(evidenceObservationIds, assumptions, `Founder marketing channel ${index + 1}`);
		return {
			channel: boundedText(item.channel, `Founder marketing channel ${index + 1}`, 300, { required: true }),
			rationale: boundedText(item.rationale, `Founder marketing channel ${index + 1} rationale`, 2_000, { required: true }),
			firstTest: boundedText(item.first_test ?? item.firstTest, `Founder marketing channel ${index + 1} first test`, 2_000, { required: true }),
			confidence: founderLevel(item.confidence, `Founder marketing channel ${index + 1} confidence`),
			evidenceObservationIds,
			assumptions
		};
	});
	if (channels.length < 1 || channels.length > 15) throw new TypeError('Founder marketing channels must contain 1-15 items.');
	const marketing = {
		channels,
		contentAngles: boundedStrings(rawMarketing.content_angles ?? rawMarketing.contentAngles, 'Founder content angles', { minimum: 1 }),
		launchMotions: boundedStrings(rawMarketing.launch_motions ?? rawMarketing.launchMotions, 'Founder launch motions', { minimum: 1 }),
		growthLoops: boundedStrings(rawMarketing.growth_loops ?? rawMarketing.growthLoops, 'Founder growth loops', { minimum: 1 }),
		assumptions: normalizeAssumptions(rawMarketing.assumptions, 'Founder marketing assumptions')
	};

	const rawSales = assertPlainObject(input.sales, 'Founder sales plan');
	const salesEvidenceObservationIds = normalizeReferenceIds(rawSales.evidence_observation_ids ?? rawSales.evidenceObservationIds, 'Founder sales evidence', observationIds);
	const salesAssumptions = normalizeAssumptions(rawSales.assumptions, 'Founder sales assumptions');
	validateEvidenceOrAssumptions(salesEvidenceObservationIds, salesAssumptions, 'Founder sales plan');
	const rawObjections = rawSales.objection_responses ?? rawSales.objectionResponses;
	if (!Array.isArray(rawObjections) || rawObjections.length < 1 || rawObjections.length > 20) {
		throw new TypeError('Founder objection responses must contain 1-20 items.');
	}
	const sales = {
		motion: boundedText(rawSales.motion, 'Founder sales motion', 2_000, { required: true }),
		qualificationQuestions: boundedStrings(rawSales.qualification_questions ?? rawSales.qualificationQuestions, 'Founder qualification questions', { minimum: 1 }),
		objectionResponses: rawObjections.map((item, index) => {
			assertPlainObject(item, `Founder objection response ${index + 1}`);
			return {
				objection: boundedText(item.objection, `Founder objection ${index + 1}`, 1_000, { required: true }),
				response: boundedText(item.response, `Founder objection response ${index + 1}`, 2_000, { required: true })
			};
		}),
		salesAssets: boundedStrings(rawSales.sales_assets ?? rawSales.salesAssets, 'Founder sales assets', { minimum: 1 }),
		evidenceObservationIds: salesEvidenceObservationIds,
		assumptions: salesAssumptions
	};

	if (!Array.isArray(input.risks) || input.risks.length < 1 || input.risks.length > 30) {
		throw new TypeError('Founder risks must contain 1-30 items.');
	}
	const risks = input.risks.map((item, index) => {
		assertPlainObject(item, `Founder risk ${index + 1}`);
		const evidenceObservationIds = normalizeReferenceIds(
			item.evidence_observation_ids ?? item.evidenceObservationIds,
			`Founder risk ${index + 1} evidence`, observationIds
		);
		const assumptions = normalizeAssumptions(item.assumptions, `Founder risk ${index + 1} assumptions`);
		validateEvidenceOrAssumptions(evidenceObservationIds, assumptions, `Founder risk ${index + 1}`);
		return {
			title: boundedText(item.title, `Founder risk ${index + 1} title`, 500, { required: true }),
			likelihood: founderLevel(item.likelihood, `Founder risk ${index + 1} likelihood`),
			impact: founderLevel(item.impact, `Founder risk ${index + 1} impact`),
			mitigation: boundedText(item.mitigation, `Founder risk ${index + 1} mitigation`, 2_000, { required: true }),
			evidenceObservationIds,
			assumptions
		};
	});

	const quickWins = normalizeReferenceIds(input.quick_wins ?? input.quickWins, 'Founder quick wins', recommendationIds, { minimum: 1, maximum: 12 });
	const rawPlan = assertPlainObject(input.plan, 'Founder 30/60/90 plan');
	const plan = {
		days30: boundedStrings(rawPlan.days_30 ?? rawPlan.days30, 'Founder 30-day plan', { minimum: 1 }),
		days60: boundedStrings(rawPlan.days_60 ?? rawPlan.days60, 'Founder 60-day plan', { minimum: 1 }),
		days90: boundedStrings(rawPlan.days_90 ?? rawPlan.days90, 'Founder 90-day plan', { minimum: 1 })
	};

	const rawMetrics = assertPlainObject(input.metrics, 'Founder metrics');
	const rawNorthStar = assertPlainObject(rawMetrics.north_star ?? rawMetrics.northStar, 'Founder north-star metric');
	const northStarEvidenceObservationIds = normalizeReferenceIds(rawNorthStar.evidence_observation_ids ?? rawNorthStar.evidenceObservationIds, 'Founder north-star evidence', observationIds);
	const northStarAssumptions = normalizeAssumptions(rawNorthStar.assumptions, 'Founder north-star assumptions');
	validateEvidenceOrAssumptions(northStarEvidenceObservationIds, northStarAssumptions, 'Founder north-star metric');
	const candidates = rawMetrics.candidates;
	if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 20) {
		throw new TypeError('Founder metric candidates must contain 1-20 items.');
	}
	const experiments = rawMetrics.experiments;
	if (!Array.isArray(experiments) || experiments.length < 1 || experiments.length > 20) {
		throw new TypeError('Founder experiments must contain 1-20 items.');
	}
	const metrics = {
		northStar: {
			name: boundedText(rawNorthStar.name, 'Founder north-star metric name', 500, { required: true }),
			definition: boundedText(rawNorthStar.definition, 'Founder north-star metric definition', 2_000, { required: true }),
			why: boundedText(rawNorthStar.why, 'Founder north-star metric rationale', 2_000, { required: true }),
			evidenceObservationIds: northStarEvidenceObservationIds,
			assumptions: northStarAssumptions
		},
		candidates: candidates.map((item, index) => {
			assertPlainObject(item, `Founder metric candidate ${index + 1}`);
			const evidenceObservationIds = normalizeReferenceIds(item.evidence_observation_ids ?? item.evidenceObservationIds, `Founder metric candidate ${index + 1} evidence`, observationIds);
			const assumptions = normalizeAssumptions(item.assumptions, `Founder metric candidate ${index + 1} assumptions`);
			validateEvidenceOrAssumptions(evidenceObservationIds, assumptions, `Founder metric candidate ${index + 1}`);
			return {
				name: boundedText(item.name, `Founder metric candidate ${index + 1} name`, 500, { required: true }),
				definition: boundedText(item.definition, `Founder metric candidate ${index + 1} definition`, 2_000, { required: true }),
				evidenceObservationIds,
				assumptions
			};
		}),
		experiments: experiments.map((item, index) => {
			assertPlainObject(item, `Founder experiment ${index + 1}`);
			const evidenceObservationIds = normalizeReferenceIds(item.evidence_observation_ids ?? item.evidenceObservationIds, `Founder experiment ${index + 1} evidence`, observationIds);
			const assumptions = normalizeAssumptions(item.assumptions, `Founder experiment ${index + 1} assumptions`);
			validateEvidenceOrAssumptions(evidenceObservationIds, assumptions, `Founder experiment ${index + 1}`);
			return {
				hypothesis: boundedText(item.hypothesis, `Founder experiment ${index + 1} hypothesis`, 2_000, { required: true }),
				change: boundedText(item.change, `Founder experiment ${index + 1} change`, 2_000, { required: true }),
				successMetric: boundedText(item.success_metric ?? item.successMetric, `Founder experiment ${index + 1} success metric`, 1_000, { required: true }),
				timebox: boundedText(item.timebox, `Founder experiment ${index + 1} timebox`, 500, { required: true }),
				guardrail: boundedText(item.guardrail, `Founder experiment ${index + 1} guardrail`, 1_000, { required: true }),
				evidenceObservationIds,
				assumptions
			};
		})
	};

	const reviewed = new Set(observations.map(item => item.category));
	const confidenceCounts = { high: 0, medium: 0, low: 0 };
	const evidenceActivities = new Set();
	for (const observation of observations) {
		confidenceCounts[observation.confidence] += 1;
		for (const evidence of observation.evidence ?? []) evidenceActivities.add(evidence.activityId);
	}
	const coverageRatio = reviewed.size / FOUNDER_CATEGORY_IDS.length;
	const assumptionCount = countAssumptions({ icp, positioning, monetization, recommendations, marketing, sales, risks, metrics });
	const enoughIndependentBrowserEvidence = evidenceActivities.size >= Math.ceil(FOUNDER_CATEGORY_IDS.length / 2);
	const evidenceConfidence = {
		// Browser evidence alone cannot validate demand, market size, customer
		// sentiment, analytics, or commercial performance, so this rating is
		// intentionally capped at medium until an external evidence class exists.
		rating: coverageRatio === 1 && enoughIndependentBrowserEvidence && assumptionCount <= observations.length ? 'medium' : 'low',
		observationConfidence: confidenceCounts,
		uniqueBrowserActivities: evidenceActivities.size,
		categoryCoverageRatio: Number(coverageRatio.toFixed(4)),
		assumptionCount,
		externalEvidenceClasses: [],
		limitation: 'This rating reflects browser-accessible product evidence only. Customer research, market validation, private analytics, revenue data, and experiment outcomes were not independently verified.'
	};
	return {
		schemaVersion: FOUNDER_SCHEMA_VERSION,
		generatedAt,
		target,
		coverage: {
			categoriesReviewed: FOUNDER_CATEGORY_IDS.filter(id => reviewed.has(id)),
			totalCategories: FOUNDER_CATEGORY_IDS.length,
			evidenceBackedObservations: observations.length
		},
		evidenceConfidence,
		executiveSummary: boundedText(input.executive_summary ?? input.executiveSummary, 'Founder executive summary', 6_000, { required: true }),
		icp,
		positioning,
		monetization,
		recommendations,
		marketing,
		sales,
		risks,
		quickWins,
		plan,
		metrics,
		caveat: FOUNDER_CAVEAT
	};
}
