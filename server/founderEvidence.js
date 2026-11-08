import { createHash } from 'node:crypto';
import { PublicInputError } from './publicErrors.js';
import { redact } from './secrets.js';

// Preserve the exact original Founder evidence encoding, including undefined
// activity fields. Existing published digests must never be migrated on read.
export function canonicalFounderEvidence(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalFounderEvidence).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFounderEvidence(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

export function founderEvidenceDigest(payload) {
	return `sha256:${createHash('sha256').update(canonicalFounderEvidence(payload)).digest('hex')}`;
}

const activityRecord = activity => ({ activityId: String(activity.id), toolName: activity.toolName, ts: activity.ts, detail: activity.detail, summary: activity.summary });

/** Inspect only an observation/evidence pair attached to the authorized run.
 * A matching receipt does not attest to page bytes or strategic correctness. */
export function inspectFounderEvidence(session, observationId, index) {
	if (session.mode !== 'founder' || !session.founder) throw new PublicInputError('This run is not a Founder review.', 409);
	if (!/^\d+$/.test(String(index)) || !Number.isSafeInteger(Number(index)) || Number(index) < 1) throw new PublicInputError('Invalid evidence index.');
	const observation = session.founder.observations?.find(item => item.id === observationId);
	const evidence = observation?.evidence?.[Number(index) - 1];
	if (!evidence) throw new PublicInputError('No browser record is attached at this observation and index.', 404);
	const reference = String(evidence.reference ?? '');
	let integrity = 'external_unverified', activities = [];
	let detail = 'This reference was not fetched or independently verified. It is displayed as text only.';
	if (reference.startsWith('qase://')) {
		const match = reference.match(/^qase:\/\/runs\/([^/]+)\/activities\/([^/]+)\/founder-evidence\/([a-f0-9]{24})$/);
		if (!match || match[1] !== session.id || match[2] !== encodeURIComponent(String(evidence.activityId))) throw new PublicInputError('This internal reference does not belong to the current run and activity.', 409);
		const activity = session.activities?.find(item => String(item.id) === String(evidence.activityId));
		integrity = 'unavailable';
		detail = 'The original activity receipt is not available for verification in this saved run.';
		if (activity?.status === 'done' && activity.toolName?.startsWith('browser_')) {
			const original = activityRecord(activity), safe = redact(session.id, original);
			activities = [safe];
			if (/^sha256:[a-f0-9]{64}$/.test(evidence.digest ?? '') && evidence.collectedAt) {
				const matched = [original, safe].find(candidate => founderEvidenceDigest({ runId: session.id, collectedAt: evidence.collectedAt, activity: candidate }) === evidence.digest);
				const expectedSummary = matched && String(matched.summary ?? `${matched.toolName}: ${matched.detail ?? 'browser observation'}`).trim();
				const valid = matched && evidence.digest.slice(7, 31) === match[3] && expectedSummary === evidence.summary;
				integrity = valid ? 'verified' : 'mismatch';
				detail = valid
					? 'The retained activity receipt and its metadata match the recorded SHA-256 digest. This verifies the receipt binding, not page content, a screenshot, or the recommendation.'
					: 'The retained activity receipt or evidence metadata differs from the recorded digest. It is not verified evidence.';
				activities = valid ? [matched] : [];
			} else detail = 'This legacy record has no supported digest. The current activity is shown for context only.';
		}
	}
	const payload = { observation: { id: observation.id, category: observation.category, title: observation.title, summary: observation.summary, confidence: observation.confidence }, index: Number(index), evidence, integrity, detail, activities,
		limitation: 'Raw page content and a screenshot are not implied by this receipt. Strategic claims and commercial assumptions still require validation.',
		redaction: 'Values currently held in the run credential vault are redacted before delivery.' };
	const safe = redact(session.id, payload);
	if (integrity === 'verified' && canonicalFounderEvidence(safe) !== canonicalFounderEvidence(payload)) {
		safe.integrity = 'redacted';
		safe.detail = 'The stored receipt matched its digest, but additional vault redaction was required for delivery. The delivered copy cannot reproduce that original digest.';
	}
	return safe;
}
