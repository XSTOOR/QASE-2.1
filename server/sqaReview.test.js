import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqaState, finishSqaAssessment, recordReviewerSqaObservation, recordAgentSqaObservation } from './sqaService.js';
import { changeSqaReview, assertSqaReviewRevision } from './sqaReview.js';
import { sqaVersion } from './sqaHistory.js';
import { createSqaTools } from './sqaTools.js';
import { storeSecrets, clearSecrets } from './secrets.js';

const owner = { role: 'owner', actorUserId: 'reviewer-id' };
const now = () => Date.parse('2026-11-04T12:00:00.000Z');
const store = { async commit() {} };
async function fixture() {
	const sqa = createSqaState({ authorizationConfirmed: true, target: { name: 'Review fixture', release: 'v1', environment: 'test' } });
	sqa.observations = sqa.scope.applicableControlIds.map(controlId => ({ controlId, status: 'blocked', rationale: 'Document unavailable.', evidence: [] }));
	const session = { id: '123e4567-e89b-42d3-a456-426614174000', mode: 'sqa', status: 'done', sqa, todos: [], findings: [], activities: [] };
	await finishSqaAssessment(session, store, now);
	return session;
}
const input = (session, reason = 'Review current release evidence.') => ({ expectedRevision: session.sqa.reviewRevision ?? 0, reason });

test('review request, reopen, decision and human publication preserve immutable previous versions', async () => {
	const session = await fixture();
	const v1 = sqaVersion(session.sqa, 1);
	await changeSqaReview(session, 'request', input(session), { role: 'developer' }, store, now);
	assert.equal(session.sqa.review.status, 'requested');
	assert.ok(session.sqa.finalizedAt);
	await changeSqaReview(session, 'reopen', input(session), owner, store, now);
	assert.equal(session.sqa.finalizedAt, undefined);
	await recordReviewerSqaObservation(session, { controlId: 'SQA-GOV-001', status: 'pass', rationale: 'Approved risk register reviewed.', evidence: [{ type: 'risk_register', reference: 'artifact://risk/v1', summary: 'Release risk record.' }] }, owner, store, now);
	await changeSqaReview(session, 'publish', input(session, 'Risk evidence reviewed; remaining evidence unavailable.'), owner, store, now);
	assert.equal(session.sqa.publishedVersions.length, 2);
	assert.deepEqual(sqaVersion(session.sqa, 1), v1);
	assert.equal(sqaVersion(session.sqa, 2).assessment.results.find(item => item.controlId === 'SQA-GOV-001').status, 'pass');
	assert.equal(session.sqa.review.status, 'published');
	const reloaded = JSON.parse(JSON.stringify(session));
	assert.deepEqual(sqaVersion(reloaded.sqa, 1), v1);
	assert.equal(sqaVersion(reloaded.sqa, 2).publishedBy.actorUserId, 'reviewer-id');
});

test('legacy finalized assessments retain version one when first reviewer evidence reopens them', async () => {
	const session = await fixture(); delete session.sqa.publishedVersions;
	const original = session.sqa.assessment.assessmentSha256;
	await recordReviewerSqaObservation(session, { controlId: 'SQA-GOV-001', status: 'blocked', rationale: 'Review requested.', evidence: [] }, owner, store, now);
	assert.equal(sqaVersion(session.sqa, 1).assessment.assessmentSha256, original);
});

test('unauthorized reviewers, active runs, stale revisions and contradictory findings cannot publish', async () => {
	const session = await fixture();
	await assert.rejects(changeSqaReview(session, 'reopen', input(session), { role: 'developer' }, store), /owner or administrator/);
	await assert.rejects(recordReviewerSqaObservation(session, {}, {}, store), /owner or administrator/);
	session.status = 'running';
	await assert.rejects(changeSqaReview(session, 'request', input(session), owner, store), /running assessment/);
	session.status = 'done';
	await changeSqaReview(session, 'reopen', input(session), owner, store, now);
	assert.throws(() => assertSqaReviewRevision(session.sqa, 0), /changed/);
	session.findings.push({ id: 'finding', controlIds: ['SQA-GOV-001'] });
	await assert.rejects(changeSqaReview(session, 'publish', input(session), owner, store), /finding conflicts/);
	await assert.rejects(recordAgentSqaObservation(session, {}, store), /Human review/);
	assert.equal((await createSqaTools(session, store).find(tool => tool.name === 'finish_sqa_assessment').run()).success, false);
});

test('failed request, reviewer decision and publication commits restore the complete previous state', async () => {
	const broken = { async commit() { throw new Error('storage unavailable'); } };
	const session = await fixture();
	let before = structuredClone(session.sqa);
	await assert.rejects(changeSqaReview(session, 'request', input(session), owner, broken), /storage unavailable/);
	assert.deepEqual(session.sqa, before);
	await assert.rejects(recordReviewerSqaObservation(session, { controlId: 'SQA-GOV-001', status: 'blocked', rationale: 'Missing.', evidence: [] }, owner, broken), /storage unavailable/);
	assert.deepEqual(session.sqa, before);
	await changeSqaReview(session, 'reopen', input(session), owner, store, now);
	before = structuredClone(session.sqa);
	await assert.rejects(changeSqaReview(session, 'publish', input(session), owner, broken), /storage unavailable/);
	assert.deepEqual(session.sqa, before);
});

test('published versions remain separate even when unchanged evidence is republished at an identical timestamp', async () => {
	const session = await fixture();
	const original = sqaVersion(session.sqa, 1);
	await changeSqaReview(session, 'reopen', input(session), owner, store, now);
	await changeSqaReview(session, 'publish', input(session, 'Reviewed unchanged evidence.'), owner, store, now);
	assert.equal(session.sqa.publishedVersions.length, 2);
	assert.deepEqual(sqaVersion(session.sqa, 1), original);
	assert.throws(() => sqaVersion(session.sqa, 'invalid'), /Invalid/);
});

test('review reasons are redacted and bounded before saving', async () => {
	const session = await fixture(); storeSecrets(session.id, { PASSWORD: 'review-secret-value' });
	try {
		await changeSqaReview(session, 'request', input(session, 'Check review-secret-value'), owner, store);
		assert.equal(JSON.stringify(session.sqa.review).includes('review-secret-value'), false);
	} finally { clearSecrets(session.id); }
});

test('the history limit rejects publication without discarding a published version or changing the draft', async () => {
	const session = await fixture();
	const original = sqaVersion(session.sqa, 1);
	session.sqa.publishedVersions = Array.from({ length: 10 }, (_, index) => ({ ...structuredClone(original), version: index + 1 }));
	await changeSqaReview(session, 'reopen', input(session), owner, store, now);
	const draft = structuredClone(session.sqa);
	await assert.rejects(changeSqaReview(session, 'publish', input(session), owner, store, now), /10-version limit/);
	assert.deepEqual(session.sqa, draft);
	assert.equal(sqaVersion(session.sqa, 1).assessment.assessmentSha256, original.assessment.assessmentSha256);
});
