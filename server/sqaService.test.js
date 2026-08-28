import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	createSqaState,
	createSqaTodoPlan,
	finishSqaAssessment,
	normalizePendingSqaState,
	recordAgentSqaBlockers,
	recordAgentSqaObservation,
	recordAgentSqaObservations,
	recordReviewerSqaObservation
} from './sqaService.js';
import { SQA_CATALOG_VERSION } from './sqaCatalog.js';
import { clearSecrets, storeSecrets } from './secrets.js';

const fixedNow = () => Date.parse('2026-08-15T00:00:00.000Z');

function session() {
	return {
		id: '123e4567-e89b-42d3-a456-426614174000',
		mode: 'sqa',
		activities: [{
			id: 'browser-check-1',
			toolName: 'browser_snapshot',
			status: 'done',
			ts: fixedNow(),
			summary: 'Observed the authenticated primary flow.'
		}],
		sqa: createSqaState({
			authorizationConfirmed: true,
			profiles: ['core'],
			attributes: ['web_application', 'user_interface'],
			target: { name: 'Example', release: '2026.08', environment: 'staging' }
		}, fixedNow)
	};
}

function store() {
	const commits = [];
	return {
		commits,
		async commit(_session, type, payload) { commits.push({ type, payload }); }
	};
}

test('SQA state requires explicit authorization and resolves the universal core', () => {
	assert.throws(() => createSqaState({
		profiles: ['core'],
		target: { name: 'Example', release: '1', environment: 'test' }
	}), /authorized/);
	const state = session().sqa;
	assert.equal(state.scope.authorization.confirmed, true);
	assert.ok(state.scope.profiles.includes('core'));
	assert.equal(state.assessment, undefined);
});

test('SQA sessions receive a canonical non-empty host plan before the model starts', () => {
	const plan = createSqaTodoPlan(session().sqa);
	assert.equal(plan.length, 6);
	assert.ok(plan.every(item => item.status === 'pending'));
	assert.match(plan[1].text, /browser evidence for \d+ technically observable controls/);
	assert.match(plan[4].text, /reviewer-only evidence prerequisites for \d+ controls/);
	assert.match(plan.at(-1).text, /publish the professional SQA report/);
});

test('legacy evidence-empty provisional assessments migrate back to pending without changing real results', async () => {
	const candidate = session();
	await finishSqaAssessment(candidate, store(), fixedNow);
	const finalized = candidate.sqa;
	const legacy = structuredClone(finalized);
	delete legacy.finalizedAt;

	assert.equal(normalizePendingSqaState(legacy).assessment, undefined);
	assert.equal(normalizePendingSqaState(finalized).assessment.verdict, 'blocked');
});

test('agent observations bind browser activity to evidence and deterministic evaluation', async () => {
	const candidate = session();
	const runStore = store();
	const result = await recordAgentSqaObservation(candidate, {
		control_id: 'SQA-QUA-001',
		status: 'pass',
		evidence_type: 'test_result',
		evidence_summary: 'Critical positive and negative workflow outcomes matched the supplied oracle.'
	}, runStore, fixedNow);

	assert.equal(result.status, 'pass');
	assert.match(result.evidence[0].reference, /^qase:\/\/runs\//);
	assert.match(result.evidence[0].reference, /\/activities\/browser-check-1\/evidence\//);
	assert.match(result.evidence[0].digest, /^sha256:[0-9a-f]{64}$/);
	assert.equal(runStore.commits[0].type, 'sqa');
	assert.equal(candidate.sqa.assessment.verdict, 'blocked');
});

test('agent can use the evidence array for the consolidated reproducible-result contract', async () => {
	const candidate = session();
	const result = await recordAgentSqaObservation(candidate, {
		control_id: 'SQA-TRC-002',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'The bounded result contains steps, expected state, actual state, timestamps, browser, release, environment, and run identity.' }]
	}, store(), fixedNow);

	assert.equal(result.status, 'pass');
	assert.deepEqual(result.evidence.map(item => item.type), ['test_result']);
});

test('agent can atomically record a cohesive batch of control-specific browser results', async () => {
	const candidate = session();
	const runStore = store();
	const results = await recordAgentSqaObservations(candidate, [{
		control_id: 'SQA-QUA-001',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'Representative positive and negative workflow outcomes matched the supplied oracle.' }]
	}, {
		control_id: 'SQA-TRC-002',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'The same workflow record contains reproducible steps, expected and actual results, release, environment, and timestamps.' }]
	}], runStore, fixedNow);

	assert.deepEqual(results.map(item => item.controlId), ['SQA-TRC-002', 'SQA-QUA-001']);
	assert.equal(candidate.sqa.observations.length, 2);
	assert.equal(runStore.commits.length, 1);
	assert.equal(runStore.commits[0].payload.batch, true);
	assert.deepEqual(Object.keys(runStore.commits[0].payload.statuses).sort(), ['SQA-QUA-001', 'SQA-TRC-002']);
});

test('agent observation batches validate completely before mutating the assessment', async () => {
	const candidate = session();
	await assert.rejects(recordAgentSqaObservations(candidate, [{
		control_id: 'SQA-QUA-001',
		status: 'pass',
		evidence: [{ type: 'test_result', summary: 'Valid first result.' }]
	}, {
		control_id: 'SQA-TRC-002',
		status: 'pass',
		evidence: [{ type: 'configuration_record', summary: 'Wrong evidence contract.' }]
	}], store(), fixedNow), /cannot use configuration_record/);
	assert.equal(candidate.sqa.observations.length, 0);
	assert.equal(candidate.sqa.assessment, undefined);
});

test('incompatible pass evidence is rejected before it can become a misleading blocked observation', async () => {
	const candidate = session();
	await assert.rejects(recordAgentSqaObservation(candidate, {
		control_id: 'SQA-TRC-002',
		status: 'pass',
		evidence: [{ type: 'configuration_record', summary: 'A configuration snapshot alone is not the consolidated test result.' }]
	}, store(), fixedNow), /cannot use configuration_record; expected: test_result/);
	assert.equal(candidate.sqa.observations.length, 0);
});

test('reviewer-only blockers can be recorded in one bounded batch', async () => {
	const candidate = session();
	const runStore = store();
	const results = await recordAgentSqaBlockers(candidate, [
		{ control_id: 'SQA-GOV-001', rationale: 'No approved release risk register was supplied.' },
		{ control_id: 'SQA-GOV-004', rationale: 'No reviewed assurance-role approval was supplied.' }
	], runStore, fixedNow);

	assert.deepEqual(results.map(item => item.controlId), ['SQA-GOV-001', 'SQA-GOV-004']);
	assert.equal(runStore.commits.length, 1);
	assert.equal(runStore.commits[0].payload.batch, true);
});

test('blocker batches cannot skip browser-eligible checks', async () => {
	const candidate = session();
	await assert.rejects(recordAgentSqaBlockers(candidate, [{
		control_id: 'SQA-QUA-001',
		rationale: 'The browser check was skipped.'
	}], store(), fixedNow), /reviewer-only.*record_sqa_control.*SQA-QUA-001/i);
	assert.equal(candidate.sqa.observations.length, 0);
});

test('unfinished sessions migrate to the current catalog while finalized sessions remain immutable', async () => {
	const candidate = session();
	candidate.sqa.scope.catalogVersion = '2026.08.1';
	candidate.sqa.scope.applicableControlIds = ['SQA-GOV-001'];
	candidate.sqa.observations = [{ controlId: 'SQA-GOV-001', status: 'blocked', rationale: 'Missing.', evidence: [] }];
	const migrated = normalizePendingSqaState(candidate.sqa);
	assert.equal(migrated.scope.catalogVersion, SQA_CATALOG_VERSION);
	assert.ok(migrated.scope.applicableControlIds.includes('SQA-WEB-001'));
	assert.equal(migrated.observations.length, 1);

	candidate.sqa = migrated;
	await finishSqaAssessment(candidate, store(), fixedNow);
	const runStore = store();
	const same = await finishSqaAssessment(candidate, runStore, () => Date.parse('2026-08-16T00:00:00.000Z'));
	assert.equal(same, candidate.sqa.assessment);
	assert.equal(runStore.commits.length, 0);
	await assert.rejects(recordAgentSqaObservation(candidate, {
		control_id: 'SQA-WEB-001', status: 'blocked', rationale: 'Must not mutate.'
	}, runStore, fixedNow), /finalized/);
});

test('agent cannot manufacture documentary evidence and finalization remains conservative', async () => {
	const candidate = session();
	const runStore = store();
	await assert.rejects(recordAgentSqaObservation(candidate, {
		control_id: 'SQA-GOV-001',
		status: 'pass',
		evidence_type: 'risk_register',
		evidence_summary: 'Invented risk register.'
	}, runStore, fixedNow), /cannot attest documentary/);

	const assessment = await finishSqaAssessment(candidate, runStore, fixedNow);
	assert.equal(assessment.verdict, 'blocked');
	assert.equal(candidate.sqa.finalizedAt, '2026-08-15T00:00:00.000Z');
	assert.equal(runStore.commits.at(-1).payload.final, true);
});

test('trusted reviewer evidence is normalized, attributed, and reopens a finalized assessment', async () => {
	const candidate = session();
	const runStore = store();
	candidate.sqa.finalizedAt = '2026-08-14T00:00:00.000Z';
	const result = await recordReviewerSqaObservation(candidate, {
		controlId: 'SQA-GOV-001',
		status: 'pass',
		rationale: 'Approved risk baseline reviewed for this release.',
		evidence: [{
			type: 'risk_register',
			reference: 'artifact://quality/risk-register/2026.08',
			summary: 'Approved release risk baseline.',
			collectedAt: '2026-08-15T00:00:00.000Z'
		}]
	}, { role: 'admin', actorUserId: '123e4567-e89b-42d3-a456-426614174001' }, runStore, fixedNow);

	assert.equal(result.status, 'pass');
	assert.equal(candidate.sqa.finalizedAt, undefined);
	assert.equal(candidate.sqa.reviewerAttestations[0].role, 'admin');
	assert.match(candidate.sqa.reviewerAttestations[0].observationSha256, /^[0-9a-f]{64}$/);
});

test('agent and reviewer evidence never persist values held in the run credential vault', async () => {
	const candidate = session();
	const runStore = store();
	const secret = 'sqa-sensitive-value';
	storeSecrets(candidate.id, { QA_PASSWORD: secret });
	try {
		await recordAgentSqaObservation(candidate, {
			control_id: 'SQA-QUA-001',
			status: 'pass',
			evidence_type: 'test_result',
			evidence_summary: `Observed result accidentally echoed ${secret}.`
		}, runStore, fixedNow);
		await recordReviewerSqaObservation(candidate, {
			controlId: 'SQA-GOV-001',
			status: 'pass',
			rationale: `Reviewed without retaining ${secret}.`,
			evidence: [{
				type: 'risk_register',
				reference: `artifact://quality/${secret}`,
				summary: `Approved baseline ${secret}.`
			}]
		}, { role: 'owner' }, runStore, fixedNow);
		assert.doesNotMatch(JSON.stringify(candidate.sqa), new RegExp(secret));
		assert.match(JSON.stringify(candidate.sqa), /••••••••/);
	} finally {
		clearSecrets(candidate.id);
	}
});
