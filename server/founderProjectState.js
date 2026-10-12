/**
 * Project-level Founder Mode persistence (Phase 3).
 *
 * Stores the latest Founder state per trusted tenant project: context used
 * for the assessment, optional goals/constraints, the last GOOD
 * recommendation set (with stable ids + set version), user selections, and
 * handoff status/reference. Runs entirely on top of the run stores'
 * well-known patterns; secrets never enter this state.
 */

const MAX_FOUNDER_PROJECT_STATE_BYTES = 1_000_000;
const STATE_SCHEMA_VERSION = 1;

function assertPlainObject(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object.`);
	}
	return value;
}

function bounded(value, label, max) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string.`);
	if (value.length > max) throw new TypeError(`${label} must be at most ${max} characters.`);
	return value;
}

/**
 * Validate and bound a project founder state record before storage. The
 * recommendation set is stored verbatim from a validated Founder report —
 * its internal structure was already enforced at finalize time.
 */
export function normalizeFounderProjectState(input = {}) {
	assertPlainObject(input, 'Founder project state');
	const state = {
		schemaVersion: STATE_SCHEMA_VERSION,
		updatedAt: bounded(input.updatedAt, 'Founder project state updatedAt', 100)
			?? new Date().toISOString(),
		ownerUserId: bounded(input.ownerUserId, 'Founder project state ownerUserId', 200),
		targetUrl: bounded(input.targetUrl, 'Founder project state targetUrl', 8_192),
		context: input.context === undefined ? undefined : assertPlainObject(input.context, 'Founder project state context'),
		goals: input.goals === undefined ? undefined : assertPlainObject(input.goals, 'Founder project state goals'),
		recommendationSet: input.recommendationSet === undefined
			? undefined
			: assertPlainObject(input.recommendationSet, 'Founder project state recommendation set'),
		selections: input.selections === undefined
			? undefined
			: (Array.isArray(input.selections)
				? input.selections.map((id, i) => bounded(id, `Founder selection ${i + 1}`, 128))
				: (() => { throw new TypeError('Founder project state selections must be an array.'); })()),
		handoff: input.handoff === undefined ? undefined : assertPlainObject(input.handoff, 'Founder project state handoff')
	};
	const serialized = JSON.stringify(state);
	if (serialized.length > MAX_FOUNDER_PROJECT_STATE_BYTES) {
		throw new TypeError(`Founder project state must be smaller than ${MAX_FOUNDER_PROJECT_STATE_BYTES} serialized bytes.`);
	}
	return state;
}

/**
 * Extract the persistent Founder project state from a finalized founder
 * session. Only trusted, validated report data crosses over.
 */
export function projectStateFromSession(session) {
	const founder = session?.founder;
	if (!founder?.report) return undefined;
	const report = founder.report;
	return normalizeFounderProjectState({
		updatedAt: founder.finalizedAt,
		ownerUserId: session.ownerUserId,
		targetUrl: founder.scope?.target?.url ?? session.targetUrl,
		context: founder.scope?.projectContext,
		goals: founder.scope?.productContext,
		recommendationSet: report.recommendationSet
			? {
				...report.recommendationSet,
				recommendations: report.recommendations
			}
			: undefined
	});
}

/** Keep only selections whose ids still exist in the recommendation set. */
export function reconcileSelections(state) {
	if (!state?.recommendationSet?.recommendations || !Array.isArray(state.selections)) return state;
	const known = new Set(state.recommendationSet.recommendations.map(item => item.id));
	const kept = state.selections.filter(id => known.has(id));
	if (kept.length === state.selections.length) return state;
	return { ...state, selections: kept };
}

/**
 * Create the founder project-state persistence service on top of a run-store-
 * style backend. The backend adapter (Postgres repository or local file
 * store) provides get/save keyed by the trusted tenant project.
 */
export function createFounderProjectStateService(backend) {
	const get = backend.get.bind(backend);
	const save = backend.save.bind(backend);
	return {
		async get() {
			const raw = await get();
			if (!raw) return undefined;
			return normalizeFounderProjectState(raw);
		},
		/** Persist; a persistence failure must NOT erase caller-held state. */
		async save(state) {
			const normalized = normalizeFounderProjectState(state);
			await save(normalized);
			return normalized;
		},
		supported: true
	};
}
