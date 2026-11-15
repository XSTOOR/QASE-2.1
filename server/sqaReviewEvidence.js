import { createHash, randomUUID } from 'node:crypto';
import { sqaMissingEvidenceRequirements } from '../public/sqaPresentation.js';
import { PublicInputError } from './publicErrors.js';
import { redact } from './secrets.js';
import { assertSqaSize } from './sqaHistory.js';

const MAX_FILE_BYTES = 512 * 1024;
const TYPE = 'sqa_reviewer_document';
export const isSqaReviewerArtifact = artifact => artifact?.type === TYPE;
const referenceFor = id => `qase-review://${id}`;
export const isSubmittedSqaReference = reference => String(reference).startsWith('qase-review://');

function required(session, value, label, maximum) {
	if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
		throw new PublicInputError(`Enter ${label} using 1–${maximum} characters.`);
	}
	return redact(session.id, value.trim());
}

export function matchesSqaReviewTarget(document, target = {}) {
	return (!target.release || document.release === target.release)
		&& (!target.environment || document.environment === target.environment);
}

function digest(bytes) {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function readFileInput(input) {
	const name = input?.name;
	const encoded = input?.base64;
	if (typeof name !== 'string' || !/^[\w .-]{1,100}\.(pdf|txt|md)$/i.test(name)) {
		throw new PublicInputError('Choose a PDF, plain text, or Markdown document with a valid filename.');
	}
	if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) {
		throw new PublicInputError('Choose a nonempty document up to 512 KB.');
	}
	const bytes = Buffer.from(encoded, 'base64');
	if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== encoded) {
		throw new PublicInputError('The document upload is invalid or exceeds 512 KB.');
	}
	if (/\.pdf$/i.test(name)) {
		if (bytes.subarray(0, 5).toString() !== '%PDF-' || !bytes.subarray(-1024).includes('%%EOF')) {
			throw new PublicInputError('The uploaded file does not have a valid PDF header and trailer.');
		}
	} else {
		let text;
		try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
		catch { throw new PublicInputError('Text and Markdown files must be UTF-8.'); }
		if (!text.trim() || text.includes('\0')) throw new PublicInputError('The file must contain readable text.');
	}
	return { name, bytes };
}

function submittedFile(session, document, artifacts) {
	const found = artifacts?.get?.(session.id, document.artifactId);
	if (found?.meta?.type !== TYPE || found.meta.sessionId !== session.id
		|| found.bytes.length !== document.bytes || digest(found.bytes) !== document.digest) {
		throw new PublicInputError('The uploaded document is missing or its bytes changed. Submit a new copy.', 409);
	}
	return found.bytes;
}

export function readSqaReviewerFile(session, id, artifacts) {
	const document = session.sqa?.reviewSubmissions?.find(item => item.id === id && item.source === 'file');
	if (session.mode !== 'sqa' || !document) throw new PublicInputError('No uploaded reviewer document exists for this run.', 404);
	return { name: document.fileName, bytes: submittedFile(session, document, artifacts) };
}

function approvedEvidence(session, item, artifacts) {
	if (item.source === 'file') submittedFile(session, item, artifacts);
	return {
		type: item.type, reference: referenceFor(item.id), summary: item.summary,
		...(item.digest ? { digest: item.digest } : {}), collectedAt: item.reviewedAt
	};
}

export function acceptedSqaReviewEvidence(session, controlId, artifacts) {
	return (session.sqa.reviewSubmissions ?? [])
		.filter(item => item.controlId === controlId && item.status === 'accepted' && matchesSqaReviewTarget(item, session.sqa.scope.target))
		.flatMap(item => {
			try { return [approvedEvidence(session, item, artifacts)]; }
			catch (error) { if (error instanceof PublicInputError) return []; throw error; }
		});
}

export function assertAppliedSqaReviewEvidence(session, artifacts) {
	for (const observation of session.sqa.observations ?? []) {
		const applied = observation.evidence.filter(item => isSubmittedSqaReference(item.reference));
		if (!applied.length) continue;
		const retained = new Set(acceptedSqaReviewEvidence(session, observation.controlId, artifacts).map(item => item.reference));
		if (applied.some(item => !retained.has(item.reference))) {
			throw new PublicInputError('An applied reviewer document is unavailable or out of scope. Replace the document and save the control decision again before publishing.', 409);
		}
	}
}

export async function changeSqaReviewEvidence(session, input, actor, store, artifacts, { id, now = Date.now } = {}) {
	const previous = session.sqa;
	if (previous.finalizedAt || previous.review?.status !== 'in_review') {
		throw new PublicInputError('Open a review draft before updating submitted documents.', 409);
	}
	const documents = [...(previous.reviewSubmissions ?? [])];
	const timestamp = new Date(now()).toISOString();
	let document;
	let upload;
	if (id) {
		const index = documents.findIndex(item => item.id === id && item.status === 'submitted');
		if (index < 0) throw new PublicInputError('This submission is no longer awaiting review.', 409);
		const original = documents[index];
		if (input?.decision === 'accepted') {
			if (!matchesSqaReviewTarget(original, previous.scope.target)) {
				throw new PublicInputError('This document covers a different build or environment. Submit evidence for this assessment.', 409);
			}
			if (input.opened !== true) throw new PublicInputError('Open the document and confirm it is accessible before accepting it.');
			if (original.source === 'file') submittedFile(session, original, artifacts);
		} else if (input?.decision !== 'rejected') throw new PublicInputError('Choose Accept or Reject.');
		document = { ...original, status: input.decision, reviewedAt: timestamp, reviewedBy: actor.actorUserId,
			reviewNote: required(session, input.note, 'a review note', 1000) };
		documents[index] = document;
	} else {
		if (documents.length >= 60) throw new PublicInputError('This review has reached its 60-document limit.', 409);
		const result = previous.assessment?.results?.find(item => item.controlId === input?.controlId);
		const requirement = sqaMissingEvidenceRequirements(result).find(item => item.id === input?.requirementId && item.owner === 'reviewer');
		if (!requirement) throw new PublicInputError('Choose an outstanding reviewer evidence requirement.');
		document = {
			id: randomUUID(), controlId: result.controlId, requirementId: requirement.id, type: requirement.type,
			owner: required(session, input.owner, 'the document owner', 120),
			release: required(session, input.release, 'the document build or release', 200),
			environment: required(session, input.environment, 'the document environment', 100),
			summary: required(session, input.summary, 'what the document demonstrates', 1000),
			submittedAt: timestamp, submittedBy: actor.actorUserId, status: 'submitted'
		};
		if (input.source === 'link') {
			const link = URL.parse(required(session, input.link, 'a document link', 512));
			if (link?.protocol !== 'https:' || link.username || link.password) throw new PublicInputError('Use an HTTPS document link without embedded credentials.');
			Object.assign(document, { source: 'link', link: link.href });
		} else if (input.source === 'file') {
			if (!artifacts?.save) throw new PublicInputError('Document uploads are unavailable on this instance. Submit a link instead.', 503);
			upload = readFileInput(input.file);
			Object.assign(document, { source: 'file', fileName: redact(session.id, upload.name), bytes: upload.bytes.length, digest: digest(upload.bytes) });
		} else throw new PublicInputError('Choose a file or an HTTPS link.');
		const matchesOriginal = item => item.status !== 'rejected' && item.controlId === document.controlId
			&& item.requirementId === document.requirementId && item.release === document.release && item.environment === document.environment
			&& (document.source === 'link' ? item.link === document.link : item.digest === document.digest);
		const duplicate = documents.find(matchesOriginal);
		if (duplicate) {
			if (!upload) throw new PublicInputError('That document is already submitted for this requirement and scope.', 409);
			let available = true;
			try { submittedFile(session, duplicate, artifacts); }
			catch (error) { if (!(error instanceof PublicInputError)) throw error; available = false; }
			if (available) throw new PublicInputError('That document is already submitted for this requirement and scope.', 409);
		}
		documents.push(document);
	}
	const draft = { ...previous, reviewSubmissions: documents, reviewRevision: (previous.reviewRevision ?? 0) + 1, updatedAt: timestamp };
	if (upload) document.artifactId = artifacts.save(session, { type: TYPE, fileName: document.fileName, bytes: upload.bytes }).artifactId;
	session.sqa = draft;
	try {
		assertSqaSize(draft);
		await store.commit(session, 'sqa', { assessment: draft.assessment, review: draft.review, reviewRevision: draft.reviewRevision, reviewSubmissions: documents });
		return draft;
	} catch (error) {
		session.sqa = previous;
		if (upload) {
			try { artifacts.remove?.(session.id, document.artifactId); }
			catch { console.error('[Qase persistence] Could not clean up an uncommitted reviewer artifact.'); }
		}
		throw error;
	}
}
