import { createHash } from 'node:crypto';
import { evaluateSqaAssessment } from './sqaAssessment.js';
import { SQA_CATALOG, getSqaControl, resolveSqaScope } from './sqaCatalog.js';
import { redact } from './secrets.js';
import { PublicInputError, publicInput } from './publicErrors.js';
import { assertSqaSize, preserveSqaPublication } from './sqaHistory.js';
import { evidenceDigest } from './sqaEvidence.js';

const AGENT_EVIDENCE_TYPES = new Set([
	'assessment_record', 'configuration_record', 'security_report', 'test_result', 'wcag_report'
]);
const STATUS = new Set(['pass', 'fail', 'blocked', 'not_assessed']);
const MAX_RATIONALE = 2_000;
const MAX_EVIDENCE_SUMMARY = 1_000;
const MAX_AGENT_EVIDENCE_ITEMS = 10;
const MAX_AGENT_OBSERVATION_BATCH = 12;
const MAX_BLOCKER_BATCH = 50;

/** Every SQA run created by this service is a browser assessment of a URL. */
export const SQA_BROWSER_REVIEW_ATTRIBUTES = Object.freeze([
	'web_application',
	'user_interface'
]);

function text(value, label, maximum, required = false) {
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

function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object') {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

function target(input = {}) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('SQA target must be an object.');
	}
	return {
		name: text(input.name, 'SQA target name', 200, true),
		release: text(input.release, 'SQA target release', 200, true),
		environment: text(input.environment, 'SQA target environment', 100, true)
	};
}

function assessmentInput(sqa, assessedAt = new Date().toISOString()) {
	return {
		catalogVersion: sqa.scope.catalogVersion,
		target: sqa.scope.target,
		assessedAt,
		profiles: sqa.scope.profiles,
		attributes: sqa.scope.attributes,
		...(sqa.scope.scopeNotes ? { scopeNotes: sqa.scope.scopeNotes } : {}),
		observations: sqa.observations
	};
}

/**
 * Create the authorized scope for a new SQA run.
 *
 * A scope is not an assessment result. Publishing the deterministic evaluator's
 * evidence-empty output here made a brand-new, runnable session look BLOCKED
 * before the agent had received a target instruction or performed a check.
 * `assessment` is therefore added only after an observation is recorded or the
 * run is explicitly finalized.
 */
export function createSqaState(input = {}, now = () => Date.now()) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError('SQA scope must be an object.');
	}
	if (input.authorizationConfirmed !== true) {
		throw new TypeError('You must confirm that you are authorized to test this target.');
	}
	const attributes = Array.isArray(input.attributes)
		? [...new Set([...SQA_BROWSER_REVIEW_ATTRIBUTES, ...input.attributes])]
		: input.attributes === undefined ? [...SQA_BROWSER_REVIEW_ATTRIBUTES] : input.attributes;
	const resolved = resolveSqaScope({ profiles: input.profiles, attributes });
	const authorizedAt = new Date(now()).toISOString();
	const scope = {
		catalogVersion: resolved.catalogVersion,
		profiles: resolved.profiles,
		attributes: resolved.attributes,
		target: target(input.target),
		...(text(input.scopeNotes, 'SQA scope notes', 4_000) ? { scopeNotes: text(input.scopeNotes, 'SQA scope notes', 4_000) } : {}),
		authorization: {
			confirmed: true,
			confirmedAt: authorizedAt,
			policy: 'non_destructive_authorized_testing'
		},
		applicableControlIds: resolved.applicableControls.map(control => control.id)
	};
	return { scope, observations: [], updatedAt: authorizedAt };
}

/**
 * Seed a truthful, host-owned plan before the first model turn. This prevents a
 * newly created assessment from rendering as 0/0 while keeping detailed route
 * and workflow planning in the agent's control after it inspects the target.
 */
export function createSqaTodoPlan(sqa) {
	const applicableIds = sqa?.scope?.applicableControlIds;
	if (!Array.isArray(applicableIds) || applicableIds.length === 0) {
		throw new TypeError('SQA todo planning requires a resolved assessment scope.');
	}
	const controls = applicableIds.map(controlId => getSqaControl(controlId));
	if (controls.some(control => !control)) {
		throw new TypeError('SQA todo planning found an unknown scoped control.');
	}
	const browserEligible = controls.filter(control => (
		control.evidenceRequirements.some(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type))
	));
	const reviewerOnly = controls.length - browserEligible.length;
	return [
		{ text: 'Confirm the authorized target, assessment boundary, and representative workflows', status: 'pending' },
		{ text: 'Run bounded keyboard/semantic accessibility and responsive-layout smoke checks', status: 'pending' },
		{ text: 'Run bounded same-origin navigation and safe form-validation/recovery smoke checks', status: 'pending' },
		{ text: `Collect browser evidence for ${browserEligible.length} technically observable control${browserEligible.length === 1 ? '' : 's'}`, status: 'pending' },
		{ text: 'Verify positive, negative, boundary, diagnostics, security, privacy, and localization behavior where applicable', status: 'pending' },
		{ text: 'Record evidence-backed control decisions and file confirmed product findings', status: 'pending' },
		{ text: `Resolve or document reviewer-only evidence prerequisites for ${reviewerOnly} control${reviewerOnly === 1 ? '' : 's'}`, status: 'pending' },
		{ text: 'Validate control and evidence completeness, then publish the professional SQA report', status: 'pending' }
	];
}

/**
 * Remove the provisional evidence-empty result written by the first SQA
 * implementation. This keeps local and PostgreSQL runs created before the
 * lifecycle correction compatible while preserving every assessment that has
 * an observation or was explicitly finalized.
 */
export function normalizePendingSqaState(input) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
	if (input.finalizedAt) return input;
	let normalized = input;
	const existingAttributes = Array.isArray(input.scope?.attributes) ? input.scope.attributes : [];
	const missingBrowserReviewScope = SQA_BROWSER_REVIEW_ATTRIBUTES.some(attribute => !existingAttributes.includes(attribute));
	if (input.scope?.catalogVersion !== SQA_CATALOG.catalogVersion || missingBrowserReviewScope) {
		const resolved = resolveSqaScope({
			profiles: input.scope?.profiles,
			attributes: [...new Set([...SQA_BROWSER_REVIEW_ATTRIBUTES, ...existingAttributes])]
		});
		const applicableIds = new Set(resolved.applicableControls.map(control => control.id));
		normalized = {
			...input,
			scope: {
				...input.scope,
				catalogVersion: resolved.catalogVersion,
				profiles: resolved.profiles,
				attributes: resolved.attributes,
				applicableControlIds: [...applicableIds]
			},
			observations: (input.observations ?? []).filter(item => applicableIds.has(item?.controlId))
		};
		// An assessment calculated under an older or incomplete browser scope is
		// no longer a valid progress snapshot. Retained in-scope observations are
		// re-evaluated on the next record operation; new controls remain pending.
		delete normalized.assessment;
	}
	if (Array.isArray(normalized.observations) && normalized.observations.length > 0) return normalized;
	const results = normalized.assessment?.results;
	const isEvidenceEmpty = Array.isArray(results) && results.length > 0 && results.every(result => (
		result?.status === 'not_assessed'
		&& result?.claimedStatus === 'not_assessed'
		&& Array.isArray(result?.evidence)
		&& result.evidence.length === 0
	));
	if (!isEvidenceEmpty) return normalized;
	const pending = { ...normalized };
	delete pending.assessment;
	return pending;
}

function relevantBrowserActivities(session) {
	return (session.activities ?? [])
		.filter(activity => activity.status === 'done' && String(activity.toolName ?? '').startsWith('browser_'))
		.slice(-12)
		.map(activity => ({
			id: String(activity.id),
			toolName: activity.toolName,
			ts: activity.ts,
			detail: activity.detail,
			summary: activity.summary
		}));
}

function evidenceFromBrowser(session, type, summary, now, records) {
	if (!AGENT_EVIDENCE_TYPES.has(type)) {
		throw new TypeError('The SQA agent cannot attest documentary, regulatory, approval, or independent-review evidence.');
	}
	const activities = relevantBrowserActivities(session);
	if (activities.length === 0) {
		throw new TypeError('A pass or fail requires a completed browser observation in this run.');
	}
	const collectedAt = new Date(now()).toISOString();
	// Normalize to the exact JSON representation retained by both run stores.
	const payload = JSON.parse(JSON.stringify(redact(session.id, {
		runId: session.id,
		evidenceType: type,
		activityIds: activities.map(activity => activity.id),
		activities,
		collectedAt,
		summary
	})));
	const digest = evidenceDigest(payload).slice(7);
	records?.set(`sha256:${digest}`, payload);
	const primaryActivityId = encodeURIComponent(String(activities.at(-1).id).slice(0, 128));
	return {
		type,
		// The reference names the most recent bound activity as the primary audit
		// anchor while the digest covers the complete bounded activity bundle.
		reference: `qase://runs/${session.id}/activities/${primaryActivityId}/evidence/${digest.slice(0, 24)}`,
		// Use the vault-redacted copy that was included in the digest. Returning
		// the original model text here could otherwise persist a value that was
		// visible on the page but belongs in the credential vault.
		summary: payload.summary,
		digest: `sha256:${digest}`,
		collectedAt
	};
}

function normalizeAgentEvidenceInputs(input, status) {
	const hasList = input?.evidence !== undefined;
	const hasLegacy = input?.evidence_type !== undefined || input?.evidence_summary !== undefined;
	if (hasList && hasLegacy) {
		throw new TypeError('Use either evidence or evidence_type/evidence_summary, not both.');
	}
	let items;
	if (hasList) {
		if (!Array.isArray(input.evidence) || input.evidence.length > MAX_AGENT_EVIDENCE_ITEMS) {
			throw new TypeError(`SQA agent evidence must be an array with at most ${MAX_AGENT_EVIDENCE_ITEMS} items.`);
		}
		items = input.evidence.map((item, index) => {
			if (!item || typeof item !== 'object' || Array.isArray(item)) {
				throw new TypeError(`SQA agent evidence ${index} must be an object.`);
			}
			return {
				type: text(item.type, `SQA agent evidence ${index} type`, 80, true),
				summary: text(item.summary, `SQA agent evidence ${index} summary`, MAX_EVIDENCE_SUMMARY)
			};
		});
	} else if (hasLegacy) {
		items = [{
			type: text(input.evidence_type, 'SQA evidence type', 80, true),
			summary: text(input.evidence_summary, 'SQA evidence summary', MAX_EVIDENCE_SUMMARY)
		}];
	} else {
		items = [];
	}
	if (['pass', 'fail'].includes(status) && items.length === 0) {
		throw new TypeError(`A ${status} requires at least one browser evidence item.`);
	}
	if (status === 'not_assessed' && items.length > 0) {
		throw new TypeError('A not_assessed result cannot attach evidence.');
	}
	return items;
}

function normalizeAgentObservation(session, input, now, records) {
	const controlId = text(input?.control_id, 'SQA control ID', 32, true);
	const control = getSqaControl(controlId);
	if (!session.sqa.scope.applicableControlIds.includes(control.id)) {
		throw new TypeError(`SQA control ${control.id} is outside this assessment scope.`);
	}
	const status = input?.status;
	if (!STATUS.has(status)) throw new TypeError('SQA control status is invalid.');
	const rationale = text(input?.rationale, 'SQA rationale', MAX_RATIONALE, ['fail', 'blocked'].includes(status));
	const safeRationale = rationale ? redact(session.id, rationale) : undefined;
	const requestedEvidence = normalizeAgentEvidenceInputs(input, status).map(item => ({
		...item,
		summary: item.summary ? redact(session.id, item.summary) : undefined
	}));
	if (status === 'pass') {
		const required = new Map(control.evidenceRequirements.map(requirement => [requirement.type, requirement.minimum]));
		for (const item of requestedEvidence) {
			if (!required.has(item.type)) {
				throw new TypeError(`A pass for ${control.id} cannot use ${item.type}; expected: ${[...required.keys()].join(', ')}.`);
			}
		}
		const missing = [...required].filter(([type, minimum]) => (
			requestedEvidence.filter(item => item.type === type).length < minimum
		)).map(([type]) => type);
		if (missing.length > 0) {
			throw new TypeError(`A pass for ${control.id} is missing required browser evidence types: ${missing.join(', ')}.`);
		}
	}
	const evidence = requestedEvidence.map(item => evidenceFromBrowser(
		session,
		item.type,
		item.summary ?? `Browser evidence for ${control.id}.`,
		now,
		records
	));
	return {
		controlId: control.id,
		status,
		...(safeRationale ? { rationale: safeRationale } : {}),
		evidence
	};
}

function assertAgentRunMutable(session) {
	if (session?.mode !== 'sqa' || !session.sqa) {
		throw new TypeError('This run is not an SQA assessment.');
	}
	if (session.sqa.finalizedAt) {
		throw new TypeError('This SQA assessment is finalized. Reopen it through an authorized reviewer workflow before changing observations.');
	}
	if (session.sqa.review?.status === 'in_review') throw new TypeError('Human review is in progress. Only an authorized reviewer can change this draft.');
	const normalized = normalizePendingSqaState(session.sqa);
	if (normalized !== session.sqa) session.sqa = normalized;
}

/**
 * Record one model-proposed control result, then re-evaluate outside the model.
 * The model can reference browser evidence only. Manual and documentary proof
 * must arrive through a separately authorized reviewer workflow.
 */
export async function recordAgentSqaObservation(session, input, runStore, now = () => Date.now()) {
	assertAgentRunMutable(session);
	const previous = session.sqa;
	const records = new Map();
	const observation = normalizeAgentObservation(session, input, now, records);
	const next = structuredClone(previous);
	next.evidenceRecords = { ...previous.evidenceRecords, ...Object.fromEntries(records) };
	const index = next.observations.findIndex(item => item.controlId === observation.controlId);
	if (index >= 0) next.observations[index] = observation;
	else next.observations.push(observation);
	const assessedAt = new Date(now()).toISOString();
	next.updatedAt = assessedAt;
	next.assessment = evaluateSqaAssessment(assessmentInput(next, assessedAt));
	try {
		assertSqaSize(next);
		session.sqa = next;
		await runStore.commit(session, 'sqa', {
			assessment: next.assessment,
			controlId: observation.controlId,
			status: next.assessment.results.find(result => result.controlId === observation.controlId)?.status
		});
	} catch (error) { session.sqa = previous; throw error; }
	return session.sqa.assessment.results.find(result => result.controlId === observation.controlId);
}

/**
 * Record a small, atomic group of browser-backed results from one cohesive
 * workflow. The complete batch is validated before the session is mutated, so
 * one malformed or unsupported claim cannot leave a half-written assessment.
 * Each observation still receives its own evidence contract and digest.
 */
export async function recordAgentSqaObservations(session, inputs, runStore, now = () => Date.now()) {
	assertAgentRunMutable(session);
	if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_AGENT_OBSERVATION_BATCH) {
		throw new TypeError(`SQA observation batch must contain 1-${MAX_AGENT_OBSERVATION_BATCH} controls.`);
	}
	const previous = session.sqa;
	const records = new Map();
	const observations = inputs.map(input => normalizeAgentObservation(session, input, now, records));
	const ids = observations.map(item => item.controlId);
	if (new Set(ids).size !== ids.length) {
		throw new TypeError('SQA observation batch contains duplicate control IDs.');
	}
	const next = structuredClone(previous);
	next.evidenceRecords = { ...previous.evidenceRecords, ...Object.fromEntries(records) };
	for (const observation of observations) {
		const index = next.observations.findIndex(item => item.controlId === observation.controlId);
		if (index >= 0) next.observations[index] = observation;
		else next.observations.push(observation);
	}
	const assessedAt = new Date(now()).toISOString();
	next.updatedAt = assessedAt;
	next.assessment = evaluateSqaAssessment(assessmentInput(next, assessedAt));
	const statuses = Object.fromEntries(ids.map(controlId => [
		controlId,
		next.assessment.results.find(result => result.controlId === controlId)?.status
	]));
	try {
		assertSqaSize(next);
		session.sqa = next;
		await runStore.commit(session, 'sqa', {
			assessment: next.assessment,
			controlIds: ids,
			statuses,
			batch: true
		});
	} catch (error) { session.sqa = previous; throw error; }
	return session.sqa.assessment.results.filter(result => ids.includes(result.controlId));
}

/** Record reviewer-only prerequisites in one bounded host transaction. */
export async function recordAgentSqaBlockers(session, inputs, runStore, now = () => Date.now()) {
	assertAgentRunMutable(session);
	if (!Array.isArray(inputs) || inputs.length === 0 || inputs.length > MAX_BLOCKER_BATCH) {
		throw new TypeError(`SQA blocker batch must contain 1-${MAX_BLOCKER_BATCH} controls.`);
	}
	const observations = inputs.map(input => normalizeAgentObservation(session, {
		control_id: input?.control_id,
		status: 'blocked',
		rationale: input?.rationale
	}, now));
	const ids = observations.map(item => item.controlId);
	if (new Set(ids).size !== ids.length) {
		throw new TypeError('SQA blocker batch contains duplicate control IDs.');
	}
	const browserEligibleIds = observations
		.map(item => getSqaControl(item.controlId))
		.filter(control => control.evidenceRequirements.some(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type)))
		.map(control => control.id);
	if (browserEligibleIds.length > 0) {
		throw new TypeError(`SQA blocker batch is reviewer-only. Record browser-eligible controls with record_sqa_control: ${browserEligibleIds.join(', ')}.`);
	}
	for (const observation of observations) {
		const index = session.sqa.observations.findIndex(item => item.controlId === observation.controlId);
		if (index >= 0) session.sqa.observations[index] = observation;
		else session.sqa.observations.push(observation);
	}
	const assessedAt = new Date(now()).toISOString();
	session.sqa.updatedAt = assessedAt;
	session.sqa.assessment = evaluateSqaAssessment(assessmentInput(session.sqa, assessedAt));
	await runStore.commit(session, 'sqa', {
		assessment: session.sqa.assessment,
		controlIds: ids,
		status: 'blocked',
		batch: true
	});
	return session.sqa.assessment.results.filter(result => ids.includes(result.controlId));
}

/**
 * Host-owned safety closeout for an exhausted SQA run. Every still-pending
 * control becomes blocked in one durable transaction with the exact host
 * limit as its reason. Existing pass/fail/blocked evidence is preserved.
 */
export async function closePendingSqaControlsAsBlocked(session, reason, runStore, now = () => Date.now()) {
	assertAgentRunMutable(session);
	const safeReason = redact(session.id, text(reason, 'SQA safety closeout reason', MAX_RATIONALE, true));
	const previous = session.sqa;
	const normalized = normalizePendingSqaState(previous);
	const observations = [...normalized.observations];
	const closedControlIds = [];
	for (const controlId of normalized.scope.applicableControlIds) {
		const index = observations.findIndex(item => item.controlId === controlId);
		if (index >= 0 && observations[index].status !== 'not_assessed') continue;
		const blocked = { controlId, status: 'blocked', rationale: safeReason, evidence: [] };
		if (index >= 0) observations[index] = blocked;
		else observations.push(blocked);
		closedControlIds.push(controlId);
	}
	if (closedControlIds.length === 0) return [];
	const assessedAt = new Date(now()).toISOString();
	session.sqa = {
		...normalized,
		observations,
		updatedAt: assessedAt,
		assessment: evaluateSqaAssessment(assessmentInput({ ...normalized, observations }, assessedAt))
	};
	try {
		await runStore.commit(session, 'sqa', {
			assessment: session.sqa.assessment,
			controlIds: closedControlIds,
			status: 'blocked',
			safetyCloseout: true,
			batch: true
		});
	} catch (error) {
		session.sqa = previous;
		throw error;
	}
	return session.sqa.assessment.results.filter(result => closedControlIds.includes(result.controlId));
}

/** Recompute and persist the final deterministic assessment. */
export async function finishSqaAssessment(session, runStore, now = () => Date.now()) {
	if (session?.mode !== 'sqa' || !session.sqa) {
		throw new TypeError('This run is not an SQA assessment.');
	}
	if (session.sqa.finalizedAt) {
		if (session.sqa.assessment) return session.sqa.assessment;
		throw new TypeError('This SQA assessment is finalized and cannot be recalculated without an authorized reopen.');
	}
	const previous = session.sqa;
	const normalized = normalizePendingSqaState(previous);
	const assessedAt = new Date(now()).toISOString();
	session.sqa = {
		...normalized,
		updatedAt: assessedAt,
		finalizedAt: assessedAt,
		assessment: evaluateSqaAssessment(assessmentInput(normalized, assessedAt))
	};
	try {
		session.sqa.publishedVersions = preserveSqaPublication(session.sqa, undefined, true);
		assertSqaSize(session.sqa);
		await runStore.commit(session, 'sqa', { assessment: session.sqa.assessment, final: true });
	} catch (error) {
		session.sqa = previous;
		throw error;
	}
	return session.sqa.assessment;
}

/**
 * Attach an evidence reference supplied by a trusted human reviewer. Qase does
 * not fetch or reinterpret the artifact; the reviewer remains responsible for
 * its authority, licence, scope, and retention. The deterministic evaluator
 * still downgrades unsupported pass/fail claims.
 */
export async function recordReviewerSqaObservation(session, observation, reviewer, runStore, now = () => Date.now()) {
	if (session?.mode !== 'sqa' || !session.sqa) {
		throw new PublicInputError('This run is not an SQA assessment.');
	}
	if (!reviewer || !['owner', 'admin'].includes(reviewer.role)) throw new PublicInputError('An owner or administrator reviewer is required.', 403);
	const reviewedAt = new Date(now()).toISOString();
	const previous = session.sqa;
	let workingSqa = structuredClone(previous);
	workingSqa.publishedVersions = preserveSqaPublication(previous);
	if (workingSqa.scope?.catalogVersion !== SQA_CATALOG.catalogVersion) {
		// A trusted review is an explicit reopen boundary. Prepare the catalog
		// migration off-object so an invalid reviewer payload cannot accidentally
		// mutate the historical finalized assessment.
		const reopen = { ...workingSqa };
		delete reopen.finalizedAt;
		workingSqa = normalizePendingSqaState(reopen);
	}
	const candidate = [...workingSqa.observations];
	// Reviewer references and summaries can still accidentally contain a value
	// already held in the run vault. Scrub the complete structured observation
	// before validation, hashing, persistence, and publication.
	const safeObservation = redact(session.id, observation);
	const controlId = publicInput(() => text(safeObservation?.controlId, 'SQA control ID', 32, true));
	const index = candidate.findIndex(item => item.controlId === controlId);
	if (index >= 0) candidate[index] = safeObservation;
	else candidate.push(safeObservation);
	const assessment = publicInput(() => evaluateSqaAssessment({
		...assessmentInput(workingSqa, reviewedAt),
		observations: candidate
	}));
	const normalized = assessment.results.find(result => result.controlId === controlId);
	if (!normalized) throw new PublicInputError(`SQA control ${controlId} is outside this assessment scope.`);
	// Preserve the evaluator-normalized input representation, not arbitrary body fields.
	const accepted = {
		controlId,
		status: normalized.claimedStatus,
		...(normalized.rationale ? { rationale: normalized.rationale } : {}),
		evidence: normalized.evidence
	};
	if (index >= 0) workingSqa.observations[index] = accepted;
	else workingSqa.observations.push(accepted);
	session.sqa = workingSqa;
	const attestation = {
		controlId,
		reviewedAt,
		role: reviewer.role,
		...(reviewer.actorUserId ? { actorUserId: reviewer.actorUserId } : {}),
		observationSha256: createHash('sha256').update(canonical(accepted)).digest('hex')
	};
	session.sqa.reviewerAttestations ??= [];
	session.sqa.reviewerAttestations.push(attestation);
	if (session.sqa.reviewerAttestations.length > 1_000) {
		session.sqa.reviewerAttestations.splice(0, session.sqa.reviewerAttestations.length - 1_000);
	}
	session.sqa.updatedAt = reviewedAt;
	session.sqa.finalizedAt = undefined;
	session.sqa.assessment = assessment;
	session.sqa.reviewRevision = (previous.reviewRevision ?? 0) + 1;
	session.sqa.review = { ...workingSqa.review, status: 'in_review', updatedAt: reviewedAt };
	try {
		assertSqaSize(session.sqa);
		await runStore.commit(session, 'sqa', { assessment, controlId, reviewerAttestation: attestation, review: session.sqa.review, reviewRevision: session.sqa.reviewRevision });
	} catch (error) {
		session.sqa = previous;
		throw error;
	}
	return normalized;
}

export function publicSqaCatalog() {
	return SQA_CATALOG;
}

export { AGENT_EVIDENCE_TYPES };
