/**
 * Founder Mode → Drytis Studio handoff (Phase 4).
 *
 * Small adapter over the EXISTING signed Drytis delivery contract (same
 * deliveryClient the QA ticket push uses). Payloads are constructed
 * server-side from the trusted founder project state — the client only ever
 * supplies selected ids. No secrets, env contents, or API keys cross this
 * boundary; the payload is intentionally rendered from validated report
 * data only.
 */

const HANDOFF_SCHEMA_VERSION = 1;
const MAX_SELECTED = 50;
// A pending record older than this is treated as abandoned (process died
// mid-flight) so a crashed handoff cannot wedge the project forever.
const PENDING_MAX_AGE_MS = 10 * 60 * 1_000;

function isStalePending(handoff, atMs) {
	if (handoff?.status !== 'pending') return false;
	const requestedAt = Date.parse(handoff.requestedAt ?? '');
	if (!Number.isFinite(requestedAt)) return true; // unparseable → treat as stale
	return atMs - requestedAt > PENDING_MAX_AGE_MS;
}

export class FounderHandoffError extends Error {
	constructor(message, { code = 'founder_handoff_error', status = 400 } = {}) {
		super(message);
		this.name = 'FounderHandoffError';
		this.code = code;
		this.status = status;
	}
}

const SECRET_KEY_PATTERN = /pass(word)?|secret|token|credential|api[-_]?key|private[-_]?key/i;

/** Defense in depth: the validated report schema already whitelists context
 *  fields, but the handoff boundary scrubs any key that even looks like a
 *  secret so nothing sensitive can cross into the delivery payload. */
function scrubSecrets(value) {
	if (!plainObject(value)) return value;
	const cleaned = {};
	for (const [key, entry] of Object.entries(value)) {
		if (SECRET_KEY_PATTERN.test(key)) continue;
		cleaned[key] = plainObject(entry) ? scrubSecrets(entry) : entry;
	}
	return cleaned;
}

function plainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Text field for the handoff payload. Schema bounds the source fields
 * (title 500, labels 1,000–4,000 chars) — the cap here is a hard outer
 * safety bound, never a truncation of real content.
 */
function label(value, cap = 4_000) {
	if (typeof value !== 'string' || !value.trim()) return undefined;
	return value.trim().slice(0, cap);
}

/** Schema-validated string lists (actions, criteria, dependencies…). */
function strings(value, limit = 30) {
	if (!Array.isArray(value)) return undefined;
	const cleaned = value.filter(item => typeof item === 'string' && item.trim())
		.map(item => item.trim().slice(0, 2_000));
	return cleaned.length ? cleaned.slice(0, limit) : undefined;
}

/** implementationScope is a schema-bounded string; tolerate legacy arrays. */
function scopeText(value) {
	if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 4_000);
	return strings(value);
}

/**
 * Build the deliverable handoff payload from the trusted saved project
 * state. Server re-validates every selected id against the saved set and
 * orders requirements by the recommendation set's own priority order.
 */
export function buildFounderHandoffPayload(state, selectedIds, { now = new Date().toISOString(), projectId } = {}) {
	if (!state?.recommendationSet?.recommendations?.length) {
		throw new FounderHandoffError('No saved recommendation set exists. Finalize a Founder review first.', { code: 'no_recommendation_set', status: 409 });
	}
	if (!Array.isArray(selectedIds) || selectedIds.length === 0 || selectedIds.length > MAX_SELECTED) {
		throw new FounderHandoffError(`selectedRecommendationIds must contain between 1 and ${MAX_SELECTED} ids.`, { code: 'invalid_selection', status: 400 });
	}
	const byId = new Map(state.recommendationSet.recommendations.map(item => [item.id, item]));
	const unknown = selectedIds.filter(id => !byId.has(id));
	if (unknown.length > 0) {
		throw new FounderHandoffError(`Unknown recommendation ids: ${unknown.join(', ')}.`, { code: 'invalid_selection', status: 400 });
	}
	const selected = state.recommendationSet.recommendations
		.filter(item => selectedIds.includes(item.id));

	// Ordered implementation requirements: recommendation-set priority order,
	// each carrying its own scope, dependencies, and testable acceptance criteria.
	const implementationRequirements = selected.map((item, index) => ({
		order: index + 1,
		recommendationId: item.id,
		title: label(item.title, 500),
		priority: label(item.priority),
		priorityReason: label(item.priorityReason, 1_000) ?? label(item.priority_reason, 1_000),
		effort: label(item.effort),
		proposedFeature: label(item.proposedFeature, 2_000) ?? label(item.proposed_feature, 2_000),
		opportunity: label(item.opportunity),
		whyItMatters: label(item.whyItMatters, 2_000) ?? label(item.why_it_matters, 2_000),
		intendedOutcome: label(item.intendedOutcome, 2_000) ?? label(item.intended_outcome, 2_000),
		actions: strings(item.actions),
		implementationScope: scopeText(item.implementationScope) ?? scopeText(item.implementation_scope),
		dependencies: strings(item.dependencies),
		acceptanceCriteria: strings(item.acceptanceCriteria) ?? strings(item.acceptance_criteria),
		assumptions: strings(item.assumptions),
		// Schema stores evidence as observation-id references validated against
		// the recorded observations; keep both spellings for legacy sets.
		evidence: strings(item.evidenceObservationIds) ?? strings(item.evidenceObservation_ids) ?? strings(item.evidence)
	}));

	const payload = {
		schemaVersion: HANDOFF_SCHEMA_VERSION,
		source: 'founder',
		// Project identity comes from the trusted tenant context (or the saved
		// state's studio linkage) — never from the client request body.
		projectId: (typeof projectId === 'string' && projectId)
			|| (typeof state?.studio?.project?.id === 'string' && state.studio.project.id)
			|| (typeof state.projectId === 'string' && state.projectId)
			|| undefined,
		targetUrl: typeof state.targetUrl === 'string' && state.targetUrl ? state.targetUrl : undefined,
		recommendationSet: {
			setVersion: state.recommendationSet.setVersion ?? 1,
			generatedAt: state.recommendationSet.generatedAt,
			recommendationIds: selected.map(item => item.id)
		},
		productContext: state.context && Object.keys(state.context).length > 0 ? scrubSecrets(state.context) : undefined,
		goals: state.goals && Object.keys(state.goals).length > 0 ? scrubSecrets(state.goals) : undefined,
		implementationRequirements,
		dependencies: [...new Set(implementationRequirements.flatMap(item => item.dependencies ?? []))],
		acceptanceCriteria: implementationRequirements.flatMap(item => item.acceptanceCriteria ?? []),
		ordered: selected.map(item => item.id),
		sentAt: now
	};
	// Drop undefined top-level keys so the signed payload is stable.
	for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
	return { payload, selected: selected.map(item => item.id) };
}

/**
 * Adapter around the existing signed delivery client. Returns a pending
 * marker so callers can render an honest in-progress state before the
 * upstream confirmation arrives.
 */
export function createFounderHandoffService({ deliveryClient, target, save, get, tenantProjectId, now = () => new Date().toISOString() }) {
	if (deliveryClient !== undefined && typeof deliveryClient?.deliver !== 'function') {
		throw new TypeError('Founder handoff delivery client must provide deliver().');
	}
	if (typeof save !== 'function' || typeof get !== 'function') {
		throw new TypeError('Founder handoff requires state get/save.');
	}

	async function send(selectedIds) {
		const state = await get();
		const { payload, selected } = buildFounderHandoffPayload(state, selectedIds, {
			now: now(), projectId: tenantProjectId
		});
		// Duplicate-submit protection: one in-flight handoff per project. A
		// pending record left over from a crashed process expires so the
		// project is never wedged.
		const requestedAtNow = now();
		if (state?.handoff?.status === 'pending' && !isStalePending(state.handoff, Date.parse(requestedAtNow))) {
			throw new FounderHandoffError('A Founder handoff is already in progress. Wait for it to finish.', { code: 'handoff_pending', status: 409 });
		}
		// Record the pending intent WITHOUT dropping the caller's selections —
		// a failed handoff must preserve what the founder picked.
		await save({
			...state,
			handoff: {
				status: 'pending',
				requestedAt: requestedAtNow,
				selectedRecommendationIds: selected
			}
		});
		if (!deliveryClient) {
			// Integration not configured: fall back to a clearly labeled export —
			// never claim a build started.
			const handoff = {
				status: 'unavailable',
				requestedAt: requestedAtNow,
				selectedRecommendationIds: selected,
				message: 'Drytis Studio delivery is not configured on this instance. The handoff payload is ready to copy or export; no build was started.'
			};
			await save({ ...state, handoff });
			return { ok: false, unavailable: true, handoff, payload };
		}
		try {
			const receipt = await deliveryClient.deliver(target, payload, {
				idempotencyKey: `founder-handoff-${selected.slice().sort().join(',')}-${state.recommendationSet.setVersion ?? 1}`.slice(0, 128),
				correlationId: `founder-${requestedAtNow}`
			});
			const deliveredAt = now();
			const reference = receipt?.reference ?? receipt?.jobId ?? receipt?.threadId ?? receipt?.id;
			const handoff = {
				status: 'succeeded',
				requestedAt: requestedAtNow,
				deliveredAt,
				selectedRecommendationIds: selected,
				...(reference !== undefined ? { reference: String(reference).slice(0, 200) } : {}),
				...(Number.isInteger(receipt?.status) ? { upstreamStatus: receipt.status } : {})
			};
			await save({ ...state, handoff });
			return { ok: true, handoff, payload };
		} catch (error) {
			// Failure keeps selections intact; only the handoff record flips.
			const handoff = {
				status: 'failed',
				requestedAt: requestedAtNow,
				failedAt: now(),
				selectedRecommendationIds: selected,
				message: 'The Studio handoff did not complete. Your selections were kept — try sending again.',
				...(error?.retryable !== undefined ? { retryable: Boolean(error.retryable) } : {})
			};
			await save({ ...state, handoff });
			throw new FounderHandoffError(handoff.message, { code: 'handoff_failed', status: 502 });
		}
	}

	/** Export-only payload build for the copy/download fallback (no delivery). */
	async function buildOnly(selectedIds) {
		const state = await get();
		const { payload } = buildFounderHandoffPayload(state, selectedIds, {
			now: now(), projectId: tenantProjectId
		});
		return payload;
	}

	return Object.freeze({
		send,
		build: buildOnly,
		supported: true,
		configured: Boolean(deliveryClient)
	});
}
