import test from 'node:test';
import assert from 'node:assert/strict';
import { createSqaState, recordAgentSqaObservation, recordAgentSqaObservations, finishSqaAssessment, recordReviewerSqaObservation } from './sqaService.js';
import { inspectSqaEvidence } from './sqaEvidence.js';
import { storeSecrets, clearSecrets } from './secrets.js';
import { buildSqaReportMarkdown } from './sqaAssessment.js';
import { buildReportHtml } from './reportPdf.js';
import { sqaReportModel } from '../public/sqaReportModel.js';

const store = { async commit() {} };
const input = { control_id: 'SQA-WEB-001', status: 'pass', evidence_type: 'test_result', evidence_summary: 'Page rendered correctly with heading and primary action.' };
async function fixture() {
	const session = { id: '123e4567-e89b-42d3-a456-426614174000', mode: 'sqa', status: 'done', activities: [{ id: 'observed-page', toolName: 'browser_snapshot', status: 'done', ts: Date.now(), summary: 'Heading and primary action rendered.' }], findings: [], todos: [], messages: [] };
	session.sqa = createSqaState({ authorizationConfirmed: true, target: { name: 'Evidence fixture', release: 'phase-9', environment: 'test' } });
	session.createdAt = Date.now(); session.updatedAt = session.createdAt;
	await recordAgentSqaObservation(session, input, store);
	return session;
}

test('retained browser bundles verify after JSON persistence and survive later activity changes', async () => {
	const session = await fixture();
	assert.equal(inspectSqaEvidence(session, 'SQA-WEB-001', 1).integrity, 'verified');
	session.activities[0].summary = 'Changed later';
	const restored = JSON.parse(JSON.stringify(session));
	const evidence = inspectSqaEvidence(restored, 'SQA-WEB-001', 1);
	assert.equal(evidence.integrity, 'verified');
	assert.equal(evidence.activities[0].summary, 'Heading and primary action rendered.');
	await finishSqaAssessment(restored, store);
	assert.equal(inspectSqaEvidence(restored, 'SQA-WEB-001', 1, 1).integrity, 'verified');
});

test('tampered bundles and metadata are never delivered as verified evidence', async () => {
	const session = await fixture();
	const digest = session.sqa.observations[0].evidence[0].digest;
	session.sqa.evidenceRecords[digest].summary = 'Tampered';
	const result = inspectSqaEvidence(session, 'SQA-WEB-001', 1);
	assert.equal(result.integrity, 'mismatch'); assert.equal(result.bundle, undefined); assert.deepEqual(result.activities, []);
});

test('legacy records and external reviewer references remain explicitly unverifiable', async () => {
	const session = await fixture(); delete session.sqa.evidenceRecords;
	assert.equal(inspectSqaEvidence(session, 'SQA-WEB-001', 1).integrity, 'unavailable');
	await recordReviewerSqaObservation(session, { controlId: 'SQA-GOV-001', status: 'pass', evidence: [{ type: 'risk_register', reference: 'https://documents.example.test/risk' }] }, { role: 'owner' }, store);
	assert.equal(inspectSqaEvidence(session, 'SQA-GOV-001', 1).integrity, 'external_unverified');
});

test('inspection cannot resolve a different run, invalid index or unattached control', async () => {
	const session = await fixture();
	assert.throws(() => inspectSqaEvidence(session, 'SQA-WEB-001', '../1'), /Invalid/);
	assert.throws(() => inspectSqaEvidence(session, 'SQA-GOV-001', 1), /No evidence/);
	session.sqa.assessment.results.find(item => item.controlId === 'SQA-WEB-001').evidence[0].reference = session.sqa.observations[0].evidence[0].reference.replace(session.id, 'foreign-run');
	assert.throws(() => inspectSqaEvidence(session, 'SQA-WEB-001', 1), /does not belong/);
});

test('failed single and batch evidence writes roll back both observations and retained bundles', async () => {
	const session = await fixture(); const before = structuredClone(session.sqa);
	const broken = { async commit() { throw new Error('Disk failed'); } };
	await assert.rejects(recordAgentSqaObservation(session, { ...input, evidence_summary: 'A different observed result.' }, broken), /Disk failed/);
	assert.deepEqual(session.sqa, before);
	await assert.rejects(recordAgentSqaObservations(session, [{ ...input, evidence_summary: 'Batch update.' }], broken), /Disk failed/);
	assert.deepEqual(session.sqa, before);
});

test('vault values are redacted before hashing and additional delivery redaction is explicitly labelled', async () => {
	const session = await fixture();
	storeSecrets(session.id, { PASSWORD: 'do-not-export-this' });
	try {
		await recordAgentSqaObservation(session, { ...input, evidence_summary: 'Observed do-not-export-this without retaining its value.' }, store);
		const result = inspectSqaEvidence(session, 'SQA-WEB-001', 1);
		assert.equal(result.integrity, 'verified'); assert.equal(JSON.stringify(result).includes('do-not-export-this'), false);
	} finally { clearSecrets(session.id); }
	storeSecrets(session.id, { PASSWORD: 'Heading and primary action rendered.' });
	try { assert.equal(inspectSqaEvidence(session, 'SQA-WEB-001', 1).integrity, 'redacted'); }
	finally { clearSecrets(session.id); }
});

test('Markdown and PDF contain the complete common register including passing-control provenance', async () => {
	const session = await fixture(); await finishSqaAssessment(session, store);
	const assessment = session.sqa.assessment;
	const markdown = buildSqaReportMarkdown(assessment);
	const html = buildReportHtml(session);
	for (const item of sqaReportModel(assessment).evidence) {
		for (const value of [item.controlId, item.type, item.reference, item.digest, item.collectedAt, item.summary, item.origin]) {
			assert.ok(markdown.includes(value), `Markdown missing ${value}`);
			assert.ok(html.includes(value), `PDF missing ${value}`);
		}
	}
	assert.ok(markdown.indexOf('## Bounded technical smoke sample') < markdown.indexOf('## Priority action plan'));
	assert.ok(html.indexOf('Bounded technical smoke sample') < html.indexOf('Unresolved controls'));
});
