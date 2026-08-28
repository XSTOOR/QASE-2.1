import {
	FOUNDER_CATEGORY_IDS,
	FOUNDER_LEVELS,
	FOUNDER_OBSERVATION_TYPES,
	finishFounderReview,
	founderCoverage,
	hasFounderPublicOnlyDecision,
	recordFounderObservations
} from './founderService.js';

const PUBLIC_ONLY_SCOPE = /\b(public[- ]only|anonymous[- ]only|unauthenticated[- ]only|login[- ]only|continue without (?:credentials|sign[- ]?in)|no credentials? available.{0,100}(?:skip|signed out)|skip.{0,80}behind (?:the )?login)\b/i;
const CONTEXT_INFERENCE_DECISION = /\b(infer|make (?:reasonable )?assumptions?|assumption-led|unknown|not sure|use what (?:is|you can see)|derive from the (?:site|product))\b/i;
const AUTH_GATE = /(?:\b(blocked|cannot|could not|unable|inaccessible|requires?|required|behind|gated?)\b.{0,80}\b(authentication|authenticated|credentials?|sign[- ]?in|log[- ]?in|login)\b|\b(authentication|authenticated|credentials?|sign[- ]?in|log[- ]?in|login)\b.{0,80}\b(blocked|cannot|unable|required|needed|unavailable|gated?)\b)/i;
const EXTERNAL_ORIGIN_BOUNDARY = /\b(?:different|external|separate|third[- ]party|cross[- ]origin|out[- ]of[- ]scope)\b.{0,80}\b(?:domain|host|origin|site|destination)\b|\b(?:outside|beyond)\b.{0,80}\b(?:declared|authorized|allowed|target)\b.{0,40}\b(?:origin|scope|site)\b|browser safety blocked top-level navigation/i;

function observationSchema() {
	return {
		type: 'object', properties: {
			category: { type: 'string', enum: FOUNDER_CATEGORY_IDS },
			type: { type: 'string', enum: FOUNDER_OBSERVATION_TYPES },
			title: { type: 'string' },
			summary: { type: 'string', description: 'Factual interpretation of browser evidence. Explicitly state not-observed boundaries.' },
			confidence: { type: 'string', enum: FOUNDER_LEVELS },
			evidence_activity_ids: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string' }, description: 'Optional exact completed browser activity IDs. Omit to bind the latest bounded browser evidence.' }
		}, required: ['category', 'type', 'title', 'summary', 'confidence']
	};
}

function reportSchema() {
	const strings = (description, maxItems = 20) => ({ type: 'array', maxItems, items: { type: 'string' }, description });
	const assumptions = strings('Explicit unknowns or inferences. Never put invented facts here as if observed.');
	const evidenceIds = strings('Exact record_founder_observation IDs supporting this item.', 30);
	return {
		type: 'object',
		properties: {
			executive_summary: { type: 'string' },
			icp: {
				type: 'object', properties: {
					primary: { type: 'string' }, users: strings('Likely product users.'), buyers: strings('Likely economic buyers.'),
					jobs: strings('Jobs to be done.'), pains: strings('Pain points.'), evidence_observation_ids: evidenceIds, assumptions
				}, required: ['primary', 'users', 'buyers', 'jobs', 'pains', 'evidence_observation_ids', 'assumptions']
			},
			positioning: {
				type: 'object', properties: {
					category: { type: 'string' }, one_liner: { type: 'string' }, value_proposition: { type: 'string' },
					differentiators: strings('Observed or hypothesized differentiators.'), alternatives: strings('Alternative approaches; do not invent competitor claims.'), evidence_observation_ids: evidenceIds, assumptions
				}, required: ['category', 'one_liner', 'value_proposition', 'differentiators', 'alternatives', 'evidence_observation_ids', 'assumptions']
			},
			monetization: {
				type: 'object', properties: {
					model: { type: 'string' }, value_metric: { type: 'string' }, packages: strings('Proposed packages or tiers.'),
					pricing_presentation: { type: 'string' }, next_tests: strings('Pricing and packaging hypotheses to validate.'),
					evidence_observation_ids: evidenceIds, assumptions
				}, required: ['model', 'value_metric', 'packages', 'pricing_presentation', 'next_tests', 'evidence_observation_ids', 'assumptions']
			},
			recommendations: {
				type: 'array', minItems: 6, maxItems: 50, items: {
					type: 'object', properties: {
						id: { type: 'string' }, category: { type: 'string', enum: FOUNDER_CATEGORY_IDS }, title: { type: 'string' },
						rationale: { type: 'string' }, actions: strings('Concrete next actions.', 15), impact: { type: 'string', enum: FOUNDER_LEVELS },
						effort: { type: 'string', enum: FOUNDER_LEVELS }, confidence: { type: 'string', enum: FOUNDER_LEVELS },
						evidence_observation_ids: evidenceIds, assumptions
					}, required: ['id', 'category', 'title', 'rationale', 'actions', 'impact', 'effort', 'confidence', 'evidence_observation_ids', 'assumptions']
				}
			},
			marketing: {
				type: 'object', properties: {
					channels: { type: 'array', minItems: 1, maxItems: 15, items: { type: 'object', properties: {
						channel: { type: 'string' }, rationale: { type: 'string' }, first_test: { type: 'string' },
						confidence: { type: 'string', enum: FOUNDER_LEVELS }, evidence_observation_ids: evidenceIds, assumptions
					}, required: ['channel', 'rationale', 'first_test', 'confidence', 'evidence_observation_ids', 'assumptions'] } },
					content_angles: strings('Content themes.'), launch_motions: strings('Launch/distribution motions.'), growth_loops: strings('Potential growth loops.'), assumptions
				}, required: ['channels', 'content_angles', 'launch_motions', 'growth_loops', 'assumptions']
			},
			sales: {
				type: 'object', properties: {
					motion: { type: 'string' }, qualification_questions: strings('Discovery questions.'),
					objection_responses: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { objection: { type: 'string' }, response: { type: 'string' } }, required: ['objection', 'response'] } },
					sales_assets: strings('Recommended sales enablement assets.'), evidence_observation_ids: evidenceIds, assumptions
				}, required: ['motion', 'qualification_questions', 'objection_responses', 'sales_assets', 'evidence_observation_ids', 'assumptions']
			},
			risks: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', properties: {
				title: { type: 'string' }, likelihood: { type: 'string', enum: FOUNDER_LEVELS }, impact: { type: 'string', enum: FOUNDER_LEVELS },
				mitigation: { type: 'string' }, evidence_observation_ids: evidenceIds, assumptions
			}, required: ['title', 'likelihood', 'impact', 'mitigation', 'evidence_observation_ids', 'assumptions'] } },
			quick_wins: strings('Recommendation IDs selected as quick wins.', 12),
			plan: { type: 'object', properties: { days_30: strings('First 30 days.'), days_60: strings('Days 31-60.'), days_90: strings('Days 61-90.') }, required: ['days_30', 'days_60', 'days_90'] },
			metrics: { type: 'object', properties: {
				north_star: { type: 'object', properties: { name: { type: 'string' }, definition: { type: 'string' }, why: { type: 'string' }, evidence_observation_ids: evidenceIds, assumptions }, required: ['name', 'definition', 'why', 'evidence_observation_ids', 'assumptions'] },
				candidates: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { name: { type: 'string' }, definition: { type: 'string' }, evidence_observation_ids: evidenceIds, assumptions }, required: ['name', 'definition', 'evidence_observation_ids', 'assumptions'] } },
				experiments: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
					hypothesis: { type: 'string' }, change: { type: 'string' }, success_metric: { type: 'string' }, timebox: { type: 'string' }, guardrail: { type: 'string' }, evidence_observation_ids: evidenceIds, assumptions
				}, required: ['hypothesis', 'change', 'success_metric', 'timebox', 'guardrail', 'evidence_observation_ids', 'assumptions'] } }
			}, required: ['north_star', 'candidates', 'experiments'] }
		},
		required: ['executive_summary', 'icp', 'positioning', 'monetization', 'recommendations', 'marketing', 'sales', 'risks', 'quick_wins', 'plan', 'metrics']
	};
}

export function founderFinishReadiness(session, now = Date.now()) {
	const coverage = founderCoverage(session.founder);
	const activeActivities = (session.activities ?? []).filter(activity => (
		activity.status === 'running'
		&& activity.toolName !== 'finish_founder_review'
		&& Number.isFinite(Number(activity.ts))
		&& now - Number(activity.ts) < 120_000
	));
	const incompleteTodos = (session.todos ?? []).filter(todo => (
		todo.status !== 'completed'
		&& !(todo.status === 'in_progress' && /\b(finish|publish)\b.*\b(founder|review|report)\b/i.test(todo.text ?? ''))
	));
	const completedTodoText = (session.todos ?? []).filter(todo => todo.status === 'completed').map(todo => todo.text ?? '').join(' ');
	const inventoryComplete = /\b(inventory|map)\b.{0,50}\b(route|surface|navigation|page)/i.test(completedTodoText)
		|| /\b(route|surface|navigation|page)\b.{0,50}\b(inventory|map)/i.test(completedTodoText);
	const representativeWorkflowComplete = /\b(representative|primary|core|end[- ]to[- ]end)\b.{0,50}\b(workflow|flow|journey|outcome)/i.test(completedTodoText);
	const browserActivities = (session.activities ?? []).filter(activity => activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_'));
	const evidenceActivityIds = new Set((session.founder?.observations ?? []).flatMap(item => item.evidence?.map(evidence => evidence.activityId) ?? []));
	const browserEvidenceComplete = evidenceActivityIds.size >= 3
		&& browserActivities.some(item => item.toolName === 'browser_snapshot')
		&& browserActivities.some(item => item.toolName === 'browser_diagnostics');
	const userText = (session.messages ?? []).filter(message => message.role === 'user').map(message => message.text ?? '').join(' ');
	const context = session.founder?.scope?.productContext ?? {};
	const suppliedContext = Boolean(context.stage && context.targetCustomer && context.businessModel && context.primaryGoal);
	const contextSignals = [
		/\b(customer|audience|user persona|buyer|ICP)\b/i.test(userText),
		/\b(business model|B2B|B2C|subscription|marketplace|usage[- ]based)\b/i.test(userText),
		/\b(stage|MVP|beta|pre[- ]launch|growth stage|enterprise)\b/i.test(userText),
		/\b(primary goal|current goal|objective|activation|retention|revenue|launch)\b/i.test(userText)
	].filter(Boolean).length;
	// Browser evidence plus the report's mandatory assumptions arrays provides a
	// safe assumption-led fallback. Missing optional founder context must not turn
	// an otherwise complete autonomous review into a late, avoidable pause.
	const contextDecisionRecorded = suppliedContext || contextSignals >= 3
		|| CONTEXT_INFERENCE_DECISION.test(userText) || coverage.evidenceBackedObservations > 0;
	const explicitlyPublicOnly = hasFounderPublicOnlyDecision(session) || PUBLIC_ONLY_SCOPE.test(userText);
	const observedAuthGate = (session.founder?.observations ?? []).some(item => {
		const text = `${item.title} ${item.summary}`;
		return AUTH_GATE.test(text) && !EXTERNAL_ORIGIN_BOUNDARY.test(text);
	});
	const authenticationDecisionRequired = observedAuthGate
		&& !(session.secretNames?.length > 0)
		&& !explicitlyPublicOnly;
	return {
		...coverage,
		activeActivities,
		incompleteTodos,
		inventoryComplete,
		representativeWorkflowComplete,
		browserEvidenceComplete,
		contextDecisionRecorded,
		authenticationDecisionRequired
	};
}

export function createFounderTools(session, runStore) {
	const record = {
		name: 'record_founder_observation',
		description: 'Records one or a bounded batch of evidence-backed Founder Mode product observations. Prefer observations:[...] to capture every lens supported by the same browser evidence in one call. The host validates and binds evidence per item atomically; do not use it for analytics, revenue, customer, or market claims that were not observed.',
		category: 'founder',
		parametersSchema: {
			type: 'object', properties: {
				...observationSchema().properties,
				observations: {
					type: 'array', minItems: 1, maxItems: FOUNDER_CATEGORY_IDS.length,
					items: observationSchema(),
					description: 'Preferred form: a bounded batch of independently evidence-bound observations. If supplied, top-level single-observation fields are ignored.'
				}
			}
		},
		async run(input) {
			try {
				const requested = Array.isArray(input?.observations) ? input.observations : [input];
				const observations = await recordFounderObservations(session, requested, runStore);
				return {
					success: true,
					recorded: observations.length === 1
						? `${observations[0].category}: ${observations[0].title}`
						: `${observations.length} Founder observations`,
					recorded_count: observations.length,
					observation_ids: observations.map(item => item.id),
					observations: observations.map(item => ({
						observation_id: item.id,
						category: item.category,
						evidence_count: item.evidence.length
					}))
				};
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	const finish = {
		name: 'finish_founder_review',
		description: 'Validates and publishes the complete evidence-informed Founder review. Call only after the route inventory, representative workflow, diagnostics, every category, and every plan item are complete.',
		category: 'founder',
		parametersSchema: reportSchema(),
		async run(input) {
			try {
				if (session.founder?.finalizedAt && session.founder?.report) {
					return { success: true, published: true, already_finalized: true, report: session.founder.report };
				}
				const readiness = founderFinishReadiness(session);
				if (readiness.activeActivities.length > 0) return { success: false, error: 'Browser work is still running.', active_activity_ids: readiness.activeActivities.map(item => item.id) };
				if (readiness.incompleteTodos.length > 0) return { success: false, error: 'The Founder review plan has unfinished work.', unfinished_todos: readiness.incompleteTodos.map(item => item.text) };
				if (!readiness.inventoryComplete || !readiness.representativeWorkflowComplete) return {
					success: false,
					error: 'Complete and mark both the route/surface inventory and representative end-to-end workflow plan items before publishing.',
					inventory_complete: readiness.inventoryComplete,
					representative_workflow_complete: readiness.representativeWorkflowComplete
				};
				if (!readiness.browserEvidenceComplete) return { success: false, error: 'Founder review needs evidence from at least three browser activities, including a snapshot and diagnostics.' };
				if (!readiness.contextDecisionRecorded) return { success: false, requires_user_input: true, error: 'Call ask_question for target customer, product stage/business model, and current goal. The user may explicitly authorize an assumption-led review.' };
				if (readiness.authenticationDecisionRequired) return { success: false, requires_user_input: true, error: 'Authentication blocks material product surfaces. Call ask_question for vaulted credentials or an explicit public-only scope boundary.' };
				if (readiness.missing.length > 0) return { success: false, error: 'Every Founder review area needs an evidence-backed observation.', missing_categories: readiness.missing };
				const report = await finishFounderReview(session, input, runStore);
				return { success: true, published: true, coverage: report.coverage, recommendation_count: report.recommendations.length, caveat: report.caveat };
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
	};

	return [record, finish];
}

export { reportSchema as founderReportToolSchema };
