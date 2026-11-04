import { createHash } from 'node:crypto';
import { PublicInputError } from './publicErrors.js';
import { redact } from './secrets.js';
import { sqaVersion } from './sqaHistory.js';

export function canonicalEvidence(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`;
	if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalEvidence(value[key])}`).join(',')}}`;
	return JSON.stringify(value);
}

export function evidenceDigest(payload) {
	return `sha256:${createHash('sha256').update(canonicalEvidence(payload)).digest('hex')}`;
}

/** Resolve only evidence already attached to the authorized run/control/version. */
export function inspectSqaEvidence(session, controlId, index, version) {
	if (session.mode !== 'sqa' || !session.sqa) throw new PublicInputError('This run is not an SQA assessment.', 409);
	const assessment = version === undefined ? session.sqa.assessment : sqaVersion(session.sqa, version).assessment;
	if (!/^\d+$/.test(String(index)) || Number(index) < 1) throw new PublicInputError('Invalid evidence index.');
	const result = assessment?.results?.find(item => item.controlId === controlId);
	const evidence = result?.evidence?.[Number(index) - 1];
	if (!evidence) throw new PublicInputError('No evidence is attached at this control and index.', 404);
	const reference = String(evidence.reference);
	const match = reference.match(/^qase:\/\/runs\/([^/]+)\/activities\/([^/]+)\/evidence\/([a-f0-9]{24})$/);
	let integrity = 'external_unverified';
	let activities = [];
	let detail = 'Reviewer document reference. Qase has not fetched or verified the document bytes.';
	let payload;
	if (reference.startsWith('qase://')) {
		if (!match || match[1] !== session.id) throw new PublicInputError('This internal reference does not belong to the current run.', 409);
		const record = session.sqa.evidenceRecords?.[evidence.digest];
		if (record) {
			const valid = evidenceDigest(record) === evidence.digest
				&& evidence.digest?.slice(7, 31) === match[3]
				&& record.runId === session.id && record.evidenceType === evidence.type
				&& record.collectedAt === evidence.collectedAt && record.summary === evidence.summary
				&& encodeURIComponent(String(record.activityIds?.at(-1)).slice(0, 128)) === match[2];
			integrity = valid ? 'verified' : 'mismatch';
			detail = valid ? 'The retained, redacted browser bundle matches its SHA-256 digest. This checks record integrity, not the correctness of a control decision.' : 'The retained bundle or its metadata does not match this evidence reference.';
			if (valid) { payload = record; activities = record.activities ?? []; }
		} else {
			integrity = 'unavailable';
			detail = 'Legacy evidence: the original digest bundle was not retained. The current anchor activity is shown for context only; its original digest cannot be verified.';
			activities = (session.activities ?? []).filter(activity => encodeURIComponent(String(activity.id).slice(0, 128)) === match[2]).map(({ id, toolName, ts, status, detail, summary }) => ({ id, toolName, ts, status, detail, summary }));
		}
	}
	const resultPayload = { controlId, index: Number(index), evidence, integrity, detail, activities, ...(payload ? { bundle: payload } : {}), redaction: 'Values currently held in the run credential vault are redacted before delivery.' };
	const safe = redact(session.id, resultPayload);
	if (integrity === 'verified' && canonicalEvidence(safe) !== canonicalEvidence(resultPayload)) {
		safe.integrity = 'redacted';
		safe.detail = 'The stored bundle matched its digest, but additional vault redaction was required for delivery. The delivered copy cannot reproduce the original digest.';
	}
	return safe;
}
