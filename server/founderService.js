import { createHash, randomUUID } from 'node:crypto';
import {
	assertPlainObject,
	boundedStrings,
	boundedText,
	FOUNDER_CATEGORIES,
	FOUNDER_CATEGORY_IDS,
	FOUNDER_CAVEAT,
	FOUNDER_LEVELS,
	FOUNDER_OBSERVATION_TYPES,
	FOUNDER_SCHEMA_VERSION,
	founderCategory,
	founderLevel,
	normalizeFounderReport
} from './founderSchema.js';
import { redact } from './secrets.js';

const observationTypes = new Set(FOUNDER_OBSERVATION_TYPES);
export const MAX_FOUNDER_STATE_BYTES = 1_000_000;
export const FOUNDER_PUBLIC_ONLY_ANSWER = 'Continue with a public-only review. No credentials are available. Treat authenticated surfaces as not observed, do not attempt login, and do not ask for credentials again during this review.';

const FOUNDER_REVIEW_PLAN = Object.freeze([
	'Open the target and establish the evidence baseline',
	'Map authorized routes, navigation, and product surfaces',
	'Exercise a representative end-to-end workflow',
	'Review usability, visual interface, and accessibility',
	'Review trust, security signals, and technical product quality',
	'Review product, positioning, growth, monetization, and sales signals',
	'Capture evidence across every Founder review lens',
	'Synthesize recommendations and publish the Founder report'
]);

/** A durable, host-owned plan keeps progress visible before the first model turn. */
export function createFounderReviewTodos() {
	return FOUNDER_REVIEW_PLAN.map(text => ({ text, status: 'pending' }));
}

function assertFounderStateSize(founder) {
	if (Buffer.byteLength(JSON.stringify(founder), 'utf8') >= MAX_FOUNDER_STATE_BYTES) {
		throw new TypeError('Founder state must be smaller than 1,000,000 serialized bytes. Reduce observations or report detail.');
	}
}

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function normalizeTarget(input) {
	assertPlainObject(input, 'Founder target');
	const rawUrl = boundedText(input.url, 'Founder target URL', 8_192);
	if (rawUrl) {
		let parsed;
		try { parsed = new URL(rawUrl); } catch { throw new TypeError('Founder target URL must be a valid URL.'); }
		if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Founder target URL must use HTTP or HTTPS.');
	}
	const founder = {
		name: boundedText(input.name, 'Founder target name', 200, { required: true }),
		...(rawUrl ? { url: rawUrl } : {}),
		...(boundedText(input.release, 'Founder target release', 200) ? { release: boundedText(input.release, 'Founder target release', 200) } : {}),
		...(boundedText(input.environment, 'Founder target environment', 100) ? { environment: boundedText(input.environment, 'Founder target environment', 100) } : {})
	};
	assertFounderStateSize(founder);
	return founder;
}

function normalizeProductContext(input = {}) {
	if (input === undefined) input = {};
	assertPlainObject(input, 'Founder product context');
	const output = {};
	for (const [source, destination, maximum] of [
		['stage', 'stage', 200],
		['businessModel', 'businessModel', 500],
		['business_model', 'businessModel', 500],
		['targetCustomer', 'targetCustomer', 1_000],
		['target_customer', 'targetCustomer', 1_000],
		['primaryGoal', 'primaryGoal', 1_000],
		['primary_goal', 'primaryGoal', 1_000],
		['constraints', 'constraints', 2_000]
	]) {
		if (output[destination] !== undefined || input[source] === undefined) continue;
		const value = boundedText(input[source], `Founder product context ${destination}`, maximum);
		if (value) output[destination] = value;
	}
	if (input.competitors !== undefined) {
		output.competitors = boundedStrings(input.competitors, 'Founder competitors', { maximum: 20, itemMaximum: 500 });
	}
	return output;
}

export function createFounderState(input = {}, now = () => Date.now()) {
	assertPlainObject(input, 'Founder review scope');
	if (input.authorizationConfirmed !== true) {
		throw new TypeError('You must confirm that you are authorized to review this target.');
	}
	const createdAt = new Date(now()).toISOString();
	return {
		schemaVersion: FOUNDER_SCHEMA_VERSION,
		scope: {
			target: normalizeTarget(input.target),
			authorization: {
				confirmed: true,
				confirmedAt: createdAt,
				policy: 'non_destructive_product_review'
			},
			productContext: normalizeProductContext(input.productContext),
			categories: [...FOUNDER_CATEGORY_IDS]
		},
		observations: [],
		updatedAt: createdAt
	};
}

/** Pending state may gain new categories; finalized reports remain immutable. */
export function normalizeFounderState(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input) || input.finalizedAt) return input;
	if (input.schemaVersion === FOUNDER_SCHEMA_VERSION
		&& FOUNDER_CATEGORY_IDS.every(id => input.scope?.categories?.includes(id))) return input;
	return {
		...input,
		schemaVersion: FOUNDER_SCHEMA_VERSION,
		scope: { ...input.scope, categories: [...FOUNDER_CATEGORY_IDS] },
		observations: (input.observations ?? []).filter(item => FOUNDER_CATEGORY_IDS.includes(item?.category))
	};
}

function assertMutable(session) {
	if (session?.mode !== 'founder' || !session.founder) throw new TypeError('This run is not a Founder review.');
	if (session.founder.finalizedAt) throw new TypeError('This Founder review is finalized and cannot be changed.');
	const normalized = normalizeFounderState(session.founder);
	if (normalized !== session.founder) session.founder = normalized;
}

export function hasFounderPublicOnlyDecision(session) {
	return session?.mode === 'founder'
		&& session.founder?.scope?.access?.decision === 'public_only';
}

/** Bind a credential refusal to the review instead of inferring it repeatedly from chat prose. */
export function recordFounderPublicOnlyDecision(session, now = () => Date.now()) {
	assertMutable(session);
	if (hasFounderPublicOnlyDecision(session)) return session.founder.scope.access;
	const decidedAt = new Date(now()).toISOString();
	const nextFounder = {
		...session.founder,
		scope: {
			...session.founder.scope,
			access: {
				decision: 'public_only',
				authenticatedSurfaces: 'excluded',
				decidedAt,
				source: 'user'
			}
		},
		updatedAt: decidedAt
	};
	assertFounderStateSize(nextFounder);
	session.founder = nextFounder;
	return nextFounder.scope.access;
}

function completedBrowserActivities(session) {
	return (session.activities ?? []).filter(activity => (
		activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_')
	));
}

function evidenceBundle(session, requestedIds, now) {
	const activities = completedBrowserActivities(session);
	if (activities.length === 0) throw new TypeError('A Founder observation requires a completed browser activity in this run.');
	let selected;
	if (requestedIds === undefined) {
		selected = activities.slice(-8);
	} else {
		const ids = boundedStrings(requestedIds, 'Founder evidence activity IDs', { minimum: 1, maximum: 12, itemMaximum: 128 });
		if (new Set(ids).size !== ids.length) throw new TypeError('Founder evidence activity IDs cannot contain duplicates.');
		const byId = new Map(activities.map(activity => [String(activity.id), activity]));
		selected = ids.map(id => {
			const activity = byId.get(id);
			if (!activity) throw new TypeError(`Founder evidence activity ${id} is not a completed browser activity in this run.`);
			return activity;
		});
	}
	const collectedAt = new Date(now).toISOString();
	const safe = redact(session.id, selected.map(activity => ({
		activityId: String(activity.id),
		toolName: activity.toolName,
		ts: activity.ts,
		detail: activity.detail,
		summary: activity.summary
	})));
	return safe.map(activity => {
		const digest = createHash('sha256').update(canonical({ runId: session.id, collectedAt, activity })).digest('hex');
		return {
			activityId: activity.activityId,
			reference: `qase://runs/${session.id}/activities/${encodeURIComponent(activity.activityId)}/founder-evidence/${digest.slice(0, 24)}`,
			summary: boundedText(activity.summary ?? `${activity.toolName}: ${activity.detail ?? 'browser observation'}`, 'Founder evidence summary', 1_000, { required: true }),
			collectedAt,
			digest: `sha256:${digest}`
		};
	});
}

function normalizeFounderObservation(session, input, timestamp) {
	assertMutable(session);
	assertPlainObject(input, 'Founder observation');
	const type = boundedText(input.type, 'Founder observation type', 30, { required: true });
	if (!observationTypes.has(type)) throw new TypeError('Founder observation type is invalid.');
	const observedAt = new Date(timestamp).toISOString();
	return redact(session.id, {
		id: randomUUID(),
		category: founderCategory(input.category),
		type,
		title: boundedText(input.title, 'Founder observation title', 500, { required: true }),
		summary: boundedText(input.summary, 'Founder observation summary', 4_000, { required: true }),
		confidence: founderLevel(input.confidence, 'Founder observation confidence'),
		evidence: evidenceBundle(session, input.evidence_activity_ids ?? input.evidenceActivityIds, timestamp),
		createdAt: observedAt
	});
}

/**
 * Validate and persist a bounded observation batch as one state transition.
 * Each item still carries its own browser-evidence bundle; a bad item prevents
 * every item from being committed, and a persistence failure restores memory.
 */
export async function recordFounderObservations(session, inputs, runStore, now = () => Date.now()) {
	assertMutable(session);
	if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > FOUNDER_CATEGORY_IDS.length) {
		throw new TypeError(`Founder observation batches must contain 1-${FOUNDER_CATEGORY_IDS.length} items.`);
	}
	const timestamp = now();
	const observedAt = new Date(timestamp).toISOString();
	const candidates = inputs.map(input => normalizeFounderObservation(session, input, timestamp));
	const existingByKey = new Map(session.founder.observations.map(item => (
		[`${item.category}\u0000${item.title.toLowerCase()}`, item]
	)));
	const resolved = [];
	const additions = [];
	for (const candidate of candidates) {
		const key = `${candidate.category}\u0000${candidate.title.toLowerCase()}`;
		const duplicate = existingByKey.get(key);
		if (duplicate) {
			resolved.push(duplicate);
			continue;
		}
		existingByKey.set(key, candidate);
		resolved.push(candidate);
		additions.push(candidate);
	}
	if (session.founder.observations.length + additions.length > 250) {
		throw new TypeError('Founder review cannot exceed 250 observations.');
	}
	if (additions.length === 0) return resolved;
	const previousFounder = session.founder;
	const nextFounder = {
		...previousFounder,
		observations: [...previousFounder.observations, ...additions],
		updatedAt: observedAt
	};
	assertFounderStateSize(nextFounder);
	session.founder = nextFounder;
	try {
		await runStore.commit(session, 'founder.observation', {
			observation: additions[0],
			observations: additions
		});
	} catch (error) {
		session.founder = previousFounder;
		throw error;
	}
	return resolved;
}

export async function recordFounderObservation(session, input, runStore, now = () => Date.now()) {
	const [observation] = await recordFounderObservations(session, [input], runStore, now);
	return observation;
}

export function founderCoverage(founder) {
	const reviewed = new Set((founder?.observations ?? []).map(item => item.category));
	return {
		reviewed: FOUNDER_CATEGORY_IDS.filter(id => reviewed.has(id)),
		missing: FOUNDER_CATEGORY_IDS.filter(id => !reviewed.has(id)),
		total: FOUNDER_CATEGORY_IDS.length,
		evidenceBackedObservations: founder?.observations?.length ?? 0
	};
}

export async function finishFounderReview(session, input, runStore, now = () => Date.now()) {
	if (session?.mode !== 'founder' || !session.founder) throw new TypeError('This run is not a Founder review.');
	if (session.founder.finalizedAt) {
		if (session.founder.report) return session.founder.report;
		throw new TypeError('This Founder review is finalized without a report and cannot be recalculated.');
	}
	assertMutable(session);
	const coverage = founderCoverage(session.founder);
	if (coverage.missing.length > 0) {
		throw new TypeError(`Founder review is missing evidence-backed categories: ${coverage.missing.join(', ')}.`);
	}
	const generatedAt = new Date(now()).toISOString();
	const safeInput = redact(session.id, input);
	const serialized = JSON.stringify(safeInput);
	if (/\b(reviewed|read|audited|analyzed)\b.{0,40}\b(?:the )?(?:complete|entire|full)\b.{0,20}\b(?:source|source code|codebase|repository|project files)\b/i.test(serialized)) {
		throw new TypeError('Founder Mode reviewed browser-accessible product surfaces, not the complete source code or repository. State that boundary explicitly.');
	}
	const report = normalizeFounderReport(safeInput, {
		observations: session.founder.observations,
		target: session.founder.scope.target,
		generatedAt
	});
	assertFounderStateSize({ ...session.founder, report, updatedAt: generatedAt, finalizedAt: generatedAt });
	session.founder.report = report;
	session.founder.updatedAt = generatedAt;
	session.founder.finalizedAt = generatedAt;
	await runStore.commit(session, 'founder.finalized', { report });
	return report;
}

function list(lines, items) {
	for (const item of items ?? []) lines.push(`- ${item}`);
}

function completeList(lines, items, empty = 'None declared.') {
	const values = Array.isArray(items) ? items : [];
	if (values.length === 0) lines.push(`- ${empty}`);
	else list(lines, values);
}

function code(value) {
	return `\`${String(value ?? '').replaceAll('`', '\\`')}\``;
}

function trace(lines, item = {}) {
	lines.push('', '**Evidence observations**', '');
	completeList(lines, (item.evidenceObservationIds ?? []).map(code));
	lines.push('', '**Assumptions**', '');
	completeList(lines, item.assumptions);
}

export function buildFounderReportMarkdown(founderOrSession) {
	const founder = founderOrSession?.founder ?? founderOrSession;
	const report = founder?.report;
	if (!report) throw new TypeError('Founder review has not been finalized.');
	const confidence = report.evidenceConfidence ?? {};
	const lines = [
		`# Founder review — ${report.target.name}`,
		'',
		`- **Schema:** ${report.schemaVersion ?? founder.schemaVersion ?? 'not recorded'}`,
		`- **Generated:** ${report.generatedAt}`,
		...(report.target.url ? [`- **Target URL:** ${report.target.url}`] : []),
		...(report.target.release ? [`- **Release:** ${report.target.release}`] : []),
		...(report.target.environment ? [`- **Environment:** ${report.target.environment}`] : []),
		`- **Coverage:** ${report.coverage.categoriesReviewed.length}/${report.coverage.totalCategories} areas`,
		`- **Evidence-backed observations:** ${report.coverage.evidenceBackedObservations}`,
		'',
		'## Evidence confidence', '',
		`- **Rating:** ${confidence.rating ?? 'not recorded'}`,
		`- **Category coverage ratio:** ${confidence.categoryCoverageRatio ?? 'not recorded'}`,
		`- **Unique browser activities:** ${confidence.uniqueBrowserActivities ?? 'not recorded'}`,
		`- **Explicit assumptions:** ${confidence.assumptionCount ?? 'not recorded'}`,
		`- **Observation confidence:** high ${confidence.observationConfidence?.high ?? 0}; medium ${confidence.observationConfidence?.medium ?? 0}; low ${confidence.observationConfidence?.low ?? 0}`,
		`- **External evidence classes:** ${(confidence.externalEvidenceClasses ?? []).join(', ') || 'none'}`,
		'',
		confidence.limitation ?? 'Evidence-confidence limitations were not recorded.',
		'',
		'**Reviewed categories**', ''
	];
	completeList(lines, report.coverage.categoriesReviewed.map(code));
	lines.push('', '## Executive summary', '', report.executiveSummary, '', '## Ideal customer profile', '', `**Primary:** ${report.icp.primary}`, '', '**Users**', '');
	list(lines, report.icp.users);
	lines.push('', '**Buyers**', ''); list(lines, report.icp.buyers);
	lines.push('', '**Jobs to be done**', ''); list(lines, report.icp.jobs);
	lines.push('', '**Pains**', ''); list(lines, report.icp.pains);
	trace(lines, report.icp);
	lines.push('', '## Positioning', '', `- **Market category:** ${report.positioning.category}`, `- **One-liner:** ${report.positioning.oneLiner}`, `- **Value proposition:** ${report.positioning.valueProposition}`, '', '**Differentiators**', '');
	completeList(lines, report.positioning.differentiators);
	lines.push('', '**Alternatives**', ''); completeList(lines, report.positioning.alternatives);
	trace(lines, report.positioning);
	lines.push('', '## Observation evidence registry', '');
	for (const observation of founder.observations ?? []) {
		lines.push(`### ${code(observation.id)} — ${observation.title}`, '', `- **Area:** ${observation.category}`, `- **Type:** ${observation.type}`, `- **Confidence:** ${observation.confidence}`, `- **Recorded:** ${observation.createdAt}`, '', observation.summary, '', '**Bound browser evidence**', '');
		for (const evidence of observation.evidence ?? []) {
			lines.push(`- Activity ${code(evidence.activityId)} · collected ${evidence.collectedAt} · reference ${code(evidence.reference)}${evidence.digest ? ` · digest ${code(evidence.digest)}` : ''}`);
			lines.push(`  - ${evidence.summary}`);
		}
		if (!observation.evidence?.length) lines.push('- No bound browser evidence recorded.');
		lines.push('');
	}
	if (!founder.observations?.length) lines.push('No observation registry was retained.', '');
	if (report.monetization) {
		lines.push('## Monetization & pricing', '', `**Model:** ${report.monetization.model}`, '', `**Value metric:** ${report.monetization.valueMetric}`, '', `**Pricing presentation:** ${report.monetization.pricingPresentation}`, '', '**Packages**', '');
		completeList(lines, report.monetization.packages);
		lines.push('', '**Tests to run**', ''); completeList(lines, report.monetization.nextTests);
		trace(lines, report.monetization); lines.push('');
	}
	lines.push('## Prioritized recommendations', '');
	for (const [index, item] of report.recommendations.entries()) {
		lines.push(`### ${index + 1}. ${item.title}`, '', `- **ID:** ${code(item.id)}`, `- **Area:** ${item.category}`, `- **Impact:** ${item.impact}`, `- **Effort:** ${item.effort}`, `- **Confidence:** ${item.confidence}`, '', item.rationale, '', '**Actions**', '');
		completeList(lines, item.actions); trace(lines, item); lines.push('');
	}
	lines.push('## Marketing & growth', '');
	for (const item of report.marketing.channels) {
		lines.push(`### ${item.channel}`, '', `- **Confidence:** ${item.confidence}`, `- **Rationale:** ${item.rationale}`, `- **First test:** ${item.firstTest}`);
		trace(lines, item); lines.push('');
	}
	lines.push('**Content angles**', ''); completeList(lines, report.marketing.contentAngles);
	lines.push('', '**Launch motions**', ''); completeList(lines, report.marketing.launchMotions);
	lines.push('', '**Growth loops**', ''); completeList(lines, report.marketing.growthLoops);
	lines.push('', '**Marketing assumptions**', ''); completeList(lines, report.marketing.assumptions);
	lines.push('', '## Sales & go-to-market', '', `**Motion:** ${report.sales.motion}`, '', '**Qualification questions**', '');
	completeList(lines, report.sales.qualificationQuestions);
	lines.push('', '**Objection responses**', '');
	for (const item of report.sales.objectionResponses ?? []) lines.push(`- **${item.objection}:** ${item.response}`);
	if (!report.sales.objectionResponses?.length) lines.push('- None declared.');
	lines.push('', '**Sales assets**', ''); completeList(lines, report.sales.salesAssets);
	trace(lines, report.sales);
	lines.push('', '## Key risks', '');
	for (const item of report.risks) {
		lines.push(`### ${item.title}`, '', `- **Likelihood:** ${item.likelihood}`, `- **Impact:** ${item.impact}`, `- **Mitigation:** ${item.mitigation}`);
		trace(lines, item); lines.push('');
	}
	lines.push('## Quick wins', '');
	const recommendations = new Map(report.recommendations.map(item => [item.id, item]));
	for (const id of report.quickWins ?? []) {
		const item = recommendations.get(id);
		lines.push(`### ${code(id)}${item ? ` — ${item.title}` : ''}`, '');
		if (item) {
			lines.push(`- **Impact / effort / confidence:** ${item.impact} / ${item.effort} / ${item.confidence}`, '', '**Actions**', '');
			completeList(lines, item.actions);
		}
		lines.push('');
	}
	if (!report.quickWins?.length) lines.push('No quick wins selected.', '');
	lines.push('', '## 30 / 60 / 90-day plan', '', '### First 30 days', ''); list(lines, report.plan.days30);
	lines.push('', '### Days 31–60', ''); list(lines, report.plan.days60);
	lines.push('', '### Days 61–90', ''); list(lines, report.plan.days90);
	lines.push('', '## Metrics & experiments', '', '### North-star metric', '', `- **Name:** ${report.metrics.northStar.name}`, `- **Definition:** ${report.metrics.northStar.definition}`, `- **Why:** ${report.metrics.northStar.why}`);
	trace(lines, report.metrics.northStar);
	lines.push('', '### Metric candidates', '');
	for (const item of report.metrics.candidates ?? []) {
		lines.push(`#### ${item.name}`, '', item.definition);
		trace(lines, item); lines.push('');
	}
	if (!report.metrics.candidates?.length) lines.push('No metric candidates declared.', '');
	lines.push('### Experiments', '');
	for (const [index, experiment] of (report.metrics.experiments ?? []).entries()) {
		lines.push(`#### Experiment ${index + 1}`, '', `- **Hypothesis:** ${experiment.hypothesis}`, `- **Change:** ${experiment.change}`, `- **Success metric:** ${experiment.successMetric}`, `- **Timebox:** ${experiment.timebox}`, `- **Guardrail:** ${experiment.guardrail}`);
		trace(lines, experiment); lines.push('');
	}
	if (!report.metrics.experiments?.length) lines.push('No experiments declared.', '');
	lines.push('', '## Important boundary', '', report.caveat, '');
	return lines.join('\n');
}

export { FOUNDER_CATEGORIES, FOUNDER_CATEGORY_IDS, FOUNDER_CAVEAT, FOUNDER_LEVELS, FOUNDER_OBSERVATION_TYPES, FOUNDER_SCHEMA_VERSION };
