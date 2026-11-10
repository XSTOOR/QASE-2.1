import './testWorkingDirectory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFounderState, recordFounderObservations } from './founderService.js';
import { inspectFounderEvidence } from './founderEvidence.js';
import { storeSecrets, clearSecrets } from './secrets.js';

async function fixture() {
	const session = { id: randomUUID(), mode: 'founder', status: 'running', activities: [{ id: 'page/one', toolName: 'browser_snapshot', status: 'done', ts: 1794077934679, summary: 'Task entry is visible.' }] };
	session.founder = createFounderState({ authorizationConfirmed: true, target: { name: 'Evidence fixture', url: 'https://fixture.test/' } });
	await recordFounderObservations(session, [{ category: 'product_clarity', type: 'opportunity', title: 'Task entry', summary: 'The sampled page has a task entry.', confidence: 'medium' }], { async commit() {} });
	return session;
}

test('the original published Founder receipt encoding survives JSON persistence and key reordering', () => {
	const session = { id: '0063179f-85b4-4325-8fe6-ddbb1303444b', mode: 'founder', activities: [{ id: 'call_5b4cde0563cf4116baf395a9', ts: 1794077934679, status: 'done', toolName: 'browser_snapshot', summary: '10 elements on Team practice fixture' }], founder: { observations: [{ id: 'historical', title: 'Historical controlled fixture', evidence: [{ activityId: 'call_5b4cde0563cf4116baf395a9', reference: 'qase://runs/0063179f-85b4-4325-8fe6-ddbb1303444b/activities/call_5b4cde0563cf4116baf395a9/founder-evidence/1e886995dd1ff1a3cbf757ac', summary: '10 elements on Team practice fixture', collectedAt: '2026-11-07T19:07:02.841Z', digest: 'sha256:1e886995dd1ff1a3cbf757acb82f9d96c91e79d7828393719a4072eaf4af6b01' }] }] } };
	const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
	assert.equal(inspectFounderEvidence(JSON.parse(JSON.stringify(reorder(session))), 'historical', 1).integrity, 'verified');
});

test('fresh observation receipts verify without changing run data or implying screenshot verification', async () => {
	const session = await fixture(), before = structuredClone(session), id = session.founder.observations[0].id;
	const result = inspectFounderEvidence(session, id, 1);
	assert.equal(result.integrity, 'verified'); assert.equal(result.activities[0].activityId, 'page/one');
	assert.match(result.detail, /not page content, a screenshot/); assert.deepEqual(session, before);
});

test('changed activity, digest, summary or reference metadata is never marked verified', async () => {
	for (const change of [s => s.activities[0].summary = 'Changed', s => s.founder.observations[0].evidence[0].digest = `sha256:${'0'.repeat(64)}`, s => s.founder.observations[0].evidence[0].summary = 'Changed']) {
		const session = await fixture(); change(session); const result = inspectFounderEvidence(session, session.founder.observations[0].id, 1);
		assert.equal(result.integrity, 'mismatch'); assert.deepEqual(result.activities, []);
	}
});

test('pruned activities and legacy digests remain explicitly unavailable', async () => {
	const session = await fixture(), id = session.founder.observations[0].id;
	delete session.founder.observations[0].evidence[0].digest;
	let result = inspectFounderEvidence(session, id, 1); assert.equal(result.integrity, 'unavailable'); assert.equal(result.activities.length, 1);
	session.activities = []; result = inspectFounderEvidence(session, id, 1); assert.equal(result.integrity, 'unavailable'); assert.deepEqual(result.activities, []);
});

test('inspection rejects foreign runs, unattached observations, invalid indexes and other modes', async () => {
	const session = await fixture(), observation = session.founder.observations[0];
	for (const index of ['../1', '0', '-1', '1.5', '9007199254740992']) assert.throws(() => inspectFounderEvidence(session, observation.id, index), /Invalid/);
	assert.throws(() => inspectFounderEvidence(session, 'missing', 1), /No browser record/);
	assert.throws(() => inspectFounderEvidence({ mode: 'qa' }, observation.id, 1), /not a Founder/);
	observation.evidence[0].reference = observation.evidence[0].reference.replace(session.id, randomUUID());
	assert.throws(() => inspectFounderEvidence(session, observation.id, 1), /does not belong/);
});

test('external and executable references are text-only, never a verified browser record', async () => {
	const session = await fixture(), observation = session.founder.observations[0];
	for (const reference of ['https://unverified.example/document', 'javascript:alert(1)', 'file:///private.txt', 'data:text/html,untrusted']) {
		observation.evidence[0].reference = reference; const result = inspectFounderEvidence(session, observation.id, 1);
		assert.equal(result.integrity, 'external_unverified'); assert.deepEqual(result.activities, []); assert.match(result.detail, /not fetched/);
	}
});

test('additional credential redaction is visible and does not expose credential values', async () => {
	const session = await fixture(), observation = session.founder.observations[0];
	storeSecrets(session.id, { PASSWORD: 'Task entry is visible.' });
	try { const result = inspectFounderEvidence(session, observation.id, 1); assert.equal(result.integrity, 'redacted'); assert.equal(JSON.stringify(result).includes('Task entry is visible.'), false); }
	finally { clearSecrets(session.id); }
});
