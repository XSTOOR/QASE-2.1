import { PublicInputError } from './publicErrors.js';
import { redact } from './secrets.js';
import { finishSqaAssessment } from './sqaService.js';
import { finishReadiness } from './sqaTools.js';
import { assertSqaSize, preserveSqaPublication } from './sqaHistory.js';

export function assertSqaReviewRevision(sqa, expected) {
	if (!Number.isSafeInteger(expected) || expected !== (sqa.reviewRevision ?? 0)) {
		throw new PublicInputError('This review changed. Reload it before saving your decision.', 409);
	}
}

export function assertSqaReviewIdle(session) {
	if (session.mode !== 'sqa' || !session.sqa) throw new PublicInputError('This run is not an SQA assessment.', 409);
	if (['running', 'queued', 'awaiting_input'].includes(session.status)) throw new PublicInputError('Stop or finish the running assessment before requesting human review.', 409);
}

function reviewerIdentity(actor) {
	if (!['owner', 'admin'].includes(actor?.role)) throw new PublicInputError('SQA evidence review requires an owner or administrator.', 403);
	return { role: actor.role, ...(actor.actorUserId ? { actorUserId: actor.actorUserId } : {}) };
}

export async function changeSqaReview(session, action, input, actor, store, now = () => Date.now()) {
	assertSqaReviewIdle(session);
	assertSqaReviewRevision(session.sqa, input?.expectedRevision);
	if (!['request', 'reopen', 'publish'].includes(action)) throw new PublicInputError('Unknown SQA review action.');
	const identity = action === 'request'
		? { role: actor?.role ?? 'developer', ...(actor?.actorUserId ? { actorUserId: actor.actorUserId } : {}) }
		: reviewerIdentity(actor);
	const previous = session.sqa;
	const timestamp = new Date(now()).toISOString();
	const reason = input?.reason;
	if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) throw new PublicInputError('Provide a review reason of 1–2000 characters.');
	const safeReason = redact(session.id, reason.trim());
	if (action !== 'publish' && !previous.finalizedAt) throw new PublicInputError('Publish the assessment before requesting or reopening a review.', 409);
	if (action === 'request' && previous.review?.status === 'requested') throw new PublicInputError('Review has already been requested.', 409);
	if (action === 'publish') {
		if (previous.review?.status !== 'in_review' || previous.finalizedAt) throw new PublicInputError('Open the assessment for review before publishing a version.', 409);
		const readiness = finishReadiness(session);
		if (Object.values(readiness).some(items => items.length > 0)) throw new PublicInputError('Review cannot be published: resolve pending controls, incomplete evidence, unfinished work, authentication scope, and finding conflicts first.', 409);
	}
	const events = [...(previous.review?.events ?? [])];
	if (events.length >= 100) throw new PublicInputError('Review activity limit reached. Create a new assessment.', 409);
	events.push({ action, reason: safeReason, at: timestamp, ...identity });
	const draft = structuredClone(previous);
	draft.publishedVersions = preserveSqaPublication(previous);
	draft.reviewRevision = (previous.reviewRevision ?? 0) + 1;
	draft.updatedAt = timestamp;
	draft.review = { ...previous.review, status: { request: 'requested', reopen: 'in_review', publish: 'published' }[action], reason: safeReason, updatedAt: timestamp, events };
	if (action === 'reopen') delete draft.finalizedAt;
	session.sqa = draft;
	try {
		assertSqaSize(draft);
		if (action === 'publish') {
			await finishSqaAssessment(session, {
				async commit(target, type, payload) {
					const latest = target.sqa.publishedVersions.at(-1);
					latest.publishedBy = identity;
					latest.reason = safeReason;
					assertSqaSize(target.sqa);
					await store.commit(target, type, { ...payload, review: target.sqa.review, reviewRevision: target.sqa.reviewRevision });
				}
			}, now);
		} else {
			await store.commit(session, 'sqa', { assessment: draft.assessment, final: Boolean(draft.finalizedAt), review: draft.review, reviewRevision: draft.reviewRevision });
		}
		return session.sqa;
	} catch (error) {
		session.sqa = previous;
		throw error;
	}
}
