import { createHash } from 'node:crypto';
import { evaluateSqaAssessment } from './sqaAssessment.js';
import { SQA_CATALOG, getSqaControl, resolveSqaScope } from './sqaCatalog.js';
import { redact } from './secrets.js';

const AGENT_EVIDENCE_TYPES = new Set([
	'assessment_record', 'configuration_record', 'security_report', 'test_result', 'wcag_report'
]);
const STATUS = new Set(['pass', 'fail', 'blocked', 'not_assessed']);
const MAX_RATIONALE = 2_000;
const MAX_EVIDENCE_SUMMARY = 1_000;
const MAX_AGENT_EVIDENCE_ITEMS = 10;
const MAX_AGENT_OBSERVATION_BATCH = 12;
const MAX_BLOCKER_BATCH = 50;

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
	const resolved = resolveSqaScope({ profiles: input.profiles, attributes: input.attributes });
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
		{ text: `Collect browser evidence for ${browserEligible.length} technically observable control${browserEligible.length === 1 ? '' : 's'}`, status: 'pending' },
		{ text: 'Verify positive, negative, boundary, accessibility, responsive, diagnostics, security, privacy, and localization behavior where applicable', status: 'pending' },
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
	if (input.scope?.catalogVersion !== SQA_CATALOG.catalogVersion) {
		const resolved = resolveSqaScope({
			profiles: input.scope?.profiles,
			attributes: input.scope?.attributes
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
		// An assessment calculated under an older catalog is no longer a valid
		// progress snapshot. The retained observations are re-evaluated on the
		// next record operation; newly introduced controls remain pending.
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

function evidenceFromBrowser(session, type, summary, now) {
	if (!AGENT_EVIDENCE_TYPES.has(type)) {
		throw new TypeError('The SQA agent cannot attest documentary, regulatory, approval, or independent-review evidence.');
	}
	const activities = relevantBrowserActivities(session);
	if (activities.length === 0) {
		throw new TypeError('A pass or fail requires a completed browser observation in this run.');
	}
	const collectedAt = new Date(now()).toISOString();
	const payload = redact(session.id, {
		runId: session.id,
		evidenceType: type,
		activityIds: activities.map(activity => activity.id),
		activities,
		collectedAt,
		summary
	});
	const digest = createHash('sha256').update(canonical(payload)).digest('hex');
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

function normalizeAgentObservation(session, input, now) {
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
		now
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
	const observation = normalizeAgentObservation(session, input, now);
	const index = session.sqa.observations.findIndex(item => item.controlId === observation.controlId);
	if (index >= 0) session.sqa.observations[index] = observation;
	else session.sqa.observations.push(observation);
	const assessedAt = new Date(now()).toISOString();
	session.sqa.updatedAt = assessedAt;
	session.sqa.assessment = evaluateSqaAssessment(assessmentInput(session.sqa, assessedAt));
	await runStore.commit(session, 'sqa', {
		assessment: session.sqa.assessment,
		controlId: observation.controlId,
		status: session.sqa.assessment.results.find(result => result.controlId === observation.controlId)?.status
	});
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
	const observations = inputs.map(input => normalizeAgentObservation(session, input, now));
	const ids = observations.map(item => item.controlId);
	if (new Set(ids).size !== ids.length) {
		throw new TypeError('SQA observation batch contains duplicate control IDs.');
	}
	for (const observation of observations) {
		const index = session.sqa.observations.findIndex(item => item.controlId === observation.controlId);
		if (index >= 0) session.sqa.observations[index] = observation;
		else session.sqa.observations.push(observation);
	}
	const assessedAt = new Date(now()).toISOString();
	session.sqa.updatedAt = assessedAt;
	session.sqa.assessment = evaluateSqaAssessment(assessmentInput(session.sqa, assessedAt));
	const statuses = Object.fromEntries(ids.map(controlId => [
		controlId,
		session.sqa.assessment.results.find(result => result.controlId === controlId)?.status
	]));
	await runStore.commit(session, 'sqa', {
		assessment: session.sqa.assessment,
		controlIds: ids,
		statuses,
		batch: true
	});
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

/** Recompute and persist the final deterministic assessment. */
export async function finishSqaAssessment(session, runStore, now = () => Date.now()) {
	if (session?.mode !== 'sqa' || !session.sqa) {
		throw new TypeError('This run is not an SQA assessment.');
	}
	if (session.sqa.finalizedAt) {
		if (session.sqa.assessment) return session.sqa.assessment;
		throw new TypeError('This SQA assessment is finalized and cannot be recalculated without an authorized reopen.');
	}
	const normalized = normalizePendingSqaState(session.sqa);
	if (normalized !== session.sqa) session.sqa = normalized;
	const assessedAt = new Date(now()).toISOString();
	session.sqa.updatedAt = assessedAt;
	session.sqa.finalizedAt = assessedAt;
	session.sqa.assessment = evaluateSqaAssessment(assessmentInput(session.sqa, assessedAt));
	await runStore.commit(session, 'sqa', { assessment: session.sqa.assessment, final: true });
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
		throw new TypeError('This run is not an SQA assessment.');
	}
	if (!reviewer || typeof reviewer !== 'object') throw new TypeError('A trusted reviewer is required.');
	const reviewedAt = new Date(now()).toISOString();
	let workingSqa = session.sqa;
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
	const controlId = text(safeObservation?.controlId, 'SQA control ID', 32, true);
	const index = candidate.findIndex(item => item.controlId === controlId);
	if (index >= 0) candidate[index] = safeObservation;
	else candidate.push(safeObservation);
	const assessment = evaluateSqaAssessment({
		...assessmentInput(workingSqa, reviewedAt),
		observations: candidate
	});
	const normalized = assessment.results.find(result => result.controlId === controlId);
	if (!normalized) throw new TypeError(`SQA control ${controlId} is outside this assessment scope.`);
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
		role: ['owner', 'admin'].includes(reviewer.role) ? reviewer.role : 'owner',
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
	await runStore.commit(session, 'sqa', { assessment, controlId, reviewerAttestation: attestation });
	return normalized;
}

export function publicSqaCatalog() {
	return SQA_CATALOG;
}

export { AGENT_EVIDENCE_TYPES };
