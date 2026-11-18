import { createHash, randomUUID } from 'node:crypto';
import { PublicInputError } from './publicErrors.js';
import { canonicalModeHash } from './modeIntegrity.js';
import { modeDiscoveryStatus } from './modeDiscovery.js';
import { assertSqaSize } from './sqaHistory.js';
import { publisherBackgroundSection } from './sqaSourceAuthority.js';
import { standaloneSqa } from './sqaStandaloneStrategy.js';

const digest = text => createHash('sha256').update(text).digest('hex');

// Called only through the account-scoped, idle-session review route. The
// document and excerpt stay out of checkpoints, SDK context and event payloads.
export async function recordSqaDocumentReview(session, input, actor, store, now = Date.now) {
	if (!standaloneSqa(session) || session.sqa.finalizedAt) throw new PublicInputError('An open standalone assessment is required.', 409);
	if (!['owner', 'admin'].includes(actor?.role) || !actor.actorUserId) throw new PublicInputError('An identified owner or administrator must review the document.', 403);
	const research = session.sqa.execution.research;
	const requirement = research?.requirements.find(row => row.id === input.requirementId);
	const feature = modeDiscoveryStatus(session).features.find(row => row.id === input.featureId);
	if (!requirement || !feature) throw new PublicInputError('Select a requirement and an observed feature in this assessment.');
	if (typeof input.documentText !== 'string' || Buffer.byteLength(input.documentText) > 128000 ||
		typeof input.excerpt !== 'string' || input.excerpt.trim().length < 20 || input.excerpt.length > 4000 ||
		!input.documentText.includes(input.excerpt)) throw new PublicInputError('Provide a bounded text document and an exact excerpt.');
	if (!['CONFIRMED_APPLICABLE', 'NOT_APPLICABLE', 'INSUFFICIENT'].includes(input.determination) ||
		!['legal', 'contractual', 'certification', 'recommended_practice'].includes(input.obligation) ||
		typeof input.jurisdiction !== 'string' || !input.jurisdiction.trim() || input.jurisdiction.length > 120)
		throw new PublicInputError('A scoped reviewer determination, obligation type and jurisdiction are required.');
	const receipt = {
		runId: session.id, requirementId: requirement.id, sourceHash: requirement.contentHash,
		featureId: feature.id, determination: input.determination, obligation: input.obligation,
		jurisdiction: input.jurisdiction.trim(), documentHash: digest(input.documentText),
		excerptHash: digest(input.excerpt), role: actor.role, reviewerId: actor.actorUserId
	};
	const previous = research.documentReviews ?? [];
	const existing = previous.findLast(row => row.requirementId === receipt.requirementId && row.featureId === receipt.featureId &&
		row.obligation === receipt.obligation && row.jurisdiction === receipt.jurisdiction);
	if (existing && Object.keys(receipt).every(key => existing[key] === receipt[key])) return { id: existing.id, reviewedAt: existing.reviewedAt };
	if (previous.length >= 100) throw new PublicInputError('Document review limit reached.', 409);
	Object.assign(receipt, { id: randomUUID(), reviewedAt: now() });
	receipt.integrityHash = canonicalModeHash(receipt);
	const priorRevision = session.sqa.reviewRevision;
	research.documentReviews = [...previous, receipt];
	session.sqa.reviewRevision = (priorRevision ?? 0) + 1;
	try {
		assertSqaSize(session.sqa);
		await store.commit(session, 'sqa', { documentReviewId: receipt.id, reviewRevision: session.sqa.reviewRevision });
	} catch (error) {
		research.documentReviews = previous;
		session.sqa.reviewRevision = priorRevision;
		throw error;
	}
	return { id: receipt.id, reviewedAt: receipt.reviewedAt };
}

export function applicabilityReviewIds(session, input, requirements) {
	if (!['CONFIRMED_APPLICABLE', 'NOT_APPLICABLE'].includes(input.classification)) return [];
	const research = session.sqa.execution.research;
	const ids = new Set();
	for (const requirement of requirements) {
		const source = research.sources.find(row => row.id === requirement.sourceId);
		// A technical specification cannot establish the applicable law.
		if (source?.authority !== 'verified_official' || source.superseded !== false || publisherBackgroundSection(source,requirement.controlId) ||
			(input.obligation === 'legal' && source.authorityType !== 'legislation')) return null;
		for (const featureId of input.feature_ids) {
			const row = research.documentReviews?.findLast(review =>
				review.requirementId === requirement.id && review.featureId === featureId &&
				review.obligation === input.obligation && review.jurisdiction === input.jurisdiction);
			if (!row) return null;
			const { integrityHash, ...payload } = row;
			if (row.runId !== session.id || row.sourceHash !== source.contentHash ||
				row.determination !== input.classification || canonicalModeHash(payload) !== integrityHash) return null;
			ids.add(row.id);
		}
	}
	return [...ids];
}
