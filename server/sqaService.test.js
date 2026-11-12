import './testWorkingDirectory.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	closePendingSqaControlsAsBlocked,
	closePendingReviewerSqaControlsAsBlocked,
	createSqaState,
	createSqaTodoPlan,
	finishSqaAssessment,
	normalizePendingSqaState,
	pendingAgentSqaControlIds,
	recordAgentSqaBlockers,
	recordAgentSqaObservation,
	recordAgentSqaObservations,
	recordReviewerSqaObservation,
	SQA_BROWSER_REVIEW_ATTRIBUTES
} from './sqaService.js';
import { SQA_CATALOG_VERSION, SQA_TECHNICAL_CONTROL_IDS, getSqaControl } from './sqaCatalog.js';
import { clearSecrets, storeSecrets } from './secrets.js';
import { inspectSqaEvidence } from './sqaEvidence.js';

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

test('single and batch observations preserve the live qualified ledger without mutating prior observations', async () => {
	const candidate = session(), previous = candidate.sqa;
	const execution = { strategy: 'qualified-opus-jev-v1', segments: 0, actions: [], evidence: [] };
	previous.execution = execution;
	const blocked = control_id => ({ control_id, status: 'blocked', rationale: 'Control-specific fixture evidence is unavailable.' });
	await recordAgentSqaObservation(candidate, blocked('SQA-WEB-001'), store(), fixedNow);
	assert.equal(candidate.sqa.execution, execution);
	assert.equal(previous.observations.length, 0);
	execution.segments++;
	await recordAgentSqaObservations(candidate, [blocked('SQA-WEB-002'), blocked('SQA-WEB-003')], store(), fixedNow);
	assert.equal(candidate.sqa.execution, execution);
	execution.segments++;
	assert.equal(candidate.sqa.execution.segments, 2);
	const saved = candidate.sqa;
	await assert.rejects(recordAgentSqaObservation(candidate, blocked('SQA-WEB-004'), { async commit() { throw new Error('Fixture persistence failure'); } }, fixedNow), /persistence failure/);
	assert.equal(candidate.sqa, saved);
	assert.equal(candidate.sqa.execution, execution);
});

test('SQA metadata can remain unknown without inventing a release or environment', () => {
	const sqa = createSqaState({ authorizationConfirmed: true, target: { name: 'Public review' } });
	assert.deepEqual(sqa.scope.target, { name: 'Public review' });
	assert.throws(() => createSqaState({ authorizationConfirmed: true, target: { name: 'Public review', release: 2026 } }), /must be a string/);
});

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

test('URL-based SQA state always includes browser review attributes and all six web controls', () => {
	const state = createSqaState({
		authorizationConfirmed: true,
		profiles: ['core'],
		attributes: [],
		target: { name: 'Example', release: 'build-123', environment: 'staging' }
	}, fixedNow);
	assert.deepEqual(state.scope.attributes, SQA_BROWSER_REVIEW_ATTRIBUTES);
	assert.deepEqual(
		state.scope.applicableControlIds.filter(controlId => SQA_TECHNICAL_CONTROL_IDS.includes(controlId)),
		SQA_TECHNICAL_CONTROL_IDS
	);
});

test('URL-based SQA state preserves additional attributes without duplicating browser defaults', () => {
	const state = createSqaState({
		authorizationConfirmed: true,
		expandedScopeConfirmed: true,
		attributes: ['handles_personal_data', 'web_application'],
		scopeNotes: 'The reviewed release processes customer contact details.',
		target: { name: 'Example', release: 'build-123', environment: 'staging' }
	}, fixedNow);
	assert.deepEqual(state.scope.attributes, ['web_application', 'user_interface', 'handles_personal_data']);
	assert.equal(state.scope.selectionReview.expanded, true);
	assert.ok(state.scope.selectionReview.additionalControlCount > 0);
	assert.equal(state.scope.selectionReview.confirmedAt, '2026-08-15T00:00:00.000Z');
});

test('expanded SQA scopes require an explicit confirmation and written rationale', () => {
	const expanded = {
		authorizationConfirmed: true,
		profiles: ['core', 'medical'],
		target: { name: 'Example', release: 'build-123', environment: 'staging' }
	};
	assert.throws(() => createSqaState(expanded, fixedNow), /Confirm.*expanded SQA scope/);
	assert.throws(() => createSqaState({ ...expanded, expandedScopeConfirmed: true }, fixedNow), /scope notes are required/);
	const state = createSqaState({
		...expanded,
		expandedScopeConfirmed: true,
		scopeNotes: 'The product is regulated as software in a medical-device context.'
	}, fixedNow);
	assert.deepEqual(state.scope.profiles, ['core', 'medical']);
	assert.equal(state.scope.selectionReview.expanded, true);
	assert.equal(state.scope.selectionReview.additionalControlCount, 3);
});

test('SQA finalization storage failure preserves the pending assessment and permits a durable retry', async () => {
	const candidate = session();
	const previous = structuredClone(candidate.sqa);
	await assert.rejects(finishSqaAssessment(candidate, {
		async commit() { throw new Error('persistence unavailable'); }
	}, fixedNow), /persistence unavailable/);
	assert.deepEqual(candidate.sqa, previous);
	const persistence = store();
	await finishSqaAssessment(candidate, persistence, fixedNow);
	assert.ok(candidate.sqa.finalizedAt);
	assert.equal(persistence.commits.length, 1);
});

test('SQA sessions receive a canonical non-empty host plan before the model starts', () => {
	const plan = createSqaTodoPlan(session().sqa);
	assert.equal(plan.length, 8);
	assert.ok(plan.every(item => item.status === 'pending'));
	assert.match(plan[1].text, /accessibility and responsive-layout smoke checks/);
	assert.match(plan[2].text, /navigation and safe form-validation/);
	assert.match(plan[3].text, /browser evidence for \d+ technically observable controls/);
	assert.match(plan[6].text, /reviewer-only evidence prerequisites for \d+ controls/);
	assert.match(plan.at(-1).text, /publish the professional SQA report/);
});

test('host safety closeout blocks only pending controls in one durable batch', async () => {
	const candidate = session();
	candidate.sqa.observations = [{
		controlId: 'SQA-WEB-001', status: 'blocked', rationale: 'Existing truthful result.', evidence: []
	}];
	const runStore = store();
	const results = await closePendingSqaControlsAsBlocked(
		candidate,
		'The host input-token safety limit was exhausted before control-specific evidence was collected.',
		runStore,
		fixedNow
	);
	assert.equal(results.length, candidate.sqa.scope.applicableControlIds.length - 1);
	assert.equal(candidate.sqa.observations.find(item => item.controlId === 'SQA-WEB-001').rationale, 'Existing truthful result.');
	assert.equal(candidate.sqa.observations.every(item => item.status === 'blocked'), true);
	assert.match(candidate.sqa.observations.find(item => item.controlId !== 'SQA-WEB-001').rationale, /safety limit was exhausted/);
	assert.equal(runStore.commits.length, 1);
	assert.equal(runStore.commits[0].payload.safetyCloseout, true);
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

for (const id of ['SQA-QUA-002', 'SQA-QUA-003', 'SQA-QUA-004', 'SQA-QUA-006', 'SQA-QUA-008']) {
	test(`${id} retains a browser sample as partial evidence and needs a reviewed full release report`, async () => {
		const candidate = session(), runStore = store(), control = getSqaControl(id);
		const evidence = control.evidenceRequirements.map(requirement => ({ type: requirement.type, summary: 'Only a bounded browser sample was performed.' }));
		const before = structuredClone(candidate.sqa);
		await assert.rejects(recordAgentSqaObservation(candidate, { control_id: id, status: 'pass', evidence }, runStore, fixedNow), /requires a reviewed release report/);
		assert.deepEqual(candidate.sqa, before); assert.equal(runStore.commits.length, 0);
		const partial = await recordAgentSqaObservation(candidate, { control_id: id, status: 'blocked', rationale: 'Complete release verification report not supplied.', evidence }, runStore, fixedNow);
		assert.equal(partial.status, 'blocked');
		assert.equal(partial.evidence.length, evidence.length, 'useful sampled observations remain available');
		assert.ok(partial.evidenceCoverage.requirements.every(r => !r.satisfied && r.actual === 0 && r.owner === 'reviewer'));
		const reviewed = await recordReviewerSqaObservation(candidate, { controlId: id, status: 'pass', rationale: 'The complete release report was reviewed against its baseline.', evidence: evidence.map(e => ({ ...e, reference: `artifact://release-reports/${id}` })) }, { role: 'owner' }, runStore, fixedNow);
		assert.equal(reviewed.status, 'pass');
	});
}

test('a misleading broad-assurance pass rolls back a mixed observation batch before any write', async () => {
	const candidate = session(), runStore = store(), before = structuredClone(candidate.sqa);
	await assert.rejects(recordAgentSqaObservations(candidate, [
		{ control_id: 'SQA-QUA-001', status: 'pass', evidence: [{ type: 'test_result', summary: 'Declared local functional oracle matched.' }] },
		{ control_id: 'SQA-QUA-006', status: 'pass', evidence: [{ type: 'security_report', summary: 'The console had no errors.' }] }
	], runStore, fixedNow), /requires a reviewed release report/);
	assert.deepEqual(candidate.sqa, before); assert.equal(runStore.commits.length, 0);
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

test('full release reports close with reviewer prerequisites after the actual browser controls, preserving all scope', async () => {
	const candidate = session(), runStore = store(), scopeBefore = [...candidate.sqa.scope.applicableControlIds];
	const browser = pendingAgentSqaControlIds(candidate);
	assert.equal(browser.length, 13);
	const reportIds = ['SQA-QUA-002', 'SQA-QUA-003', 'SQA-QUA-004', 'SQA-QUA-006', 'SQA-QUA-008'];
	assert.ok(reportIds.every(id => !browser.includes(id) && scopeBefore.includes(id)));
	candidate.sqa.observations = browser.map(controlId => ({ controlId, status: 'blocked', rationale: 'Controlled sample only; missing complete release prerequisites.', evidence: [] }));
	const closed = await closePendingReviewerSqaControlsAsBlocked(candidate, runStore, fixedNow);
	assert.equal(closed.length, 17);
	for (const id of reportIds) {
		const item = closed.find(r => r.controlId === id);
		assert.equal(item.status, 'blocked');
		assert.match(item.rationale, new RegExp(getSqaControl(id).evidenceRequirements[0].id));
	}
	assert.deepEqual(candidate.sqa.scope.applicableControlIds, scopeBefore);
	assert.equal(candidate.sqa.assessment.results.length, 30);
	assert.equal(candidate.sqa.assessment.summary.not_assessed, 0);
	assert.equal(runStore.commits.length, 1);
});

test('host reviewer closeout derives precise catalog blockers and commits atomically', async () => {
	const candidate = session();
	candidate.sqa.scope.applicableControlIds = ['SQA-WEB-001', 'SQA-GOV-001', 'SQA-GOV-004'];
	assert.deepEqual(pendingAgentSqaControlIds(candidate), ['SQA-WEB-001']);
	await assert.rejects(
		closePendingReviewerSqaControlsAsBlocked(candidate, store(), fixedNow),
		/Finish browser-eligible SQA controls.*SQA-WEB-001/
	);
	candidate.sqa.observations.push({
		controlId: 'SQA-WEB-001', status: 'blocked', rationale: 'Controlled browser sample unavailable.', evidence: []
	});
	const runStore = store();
	const results = await closePendingReviewerSqaControlsAsBlocked(candidate, runStore, fixedNow);
	assert.deepEqual(results.map(item => item.controlId), ['SQA-GOV-001', 'SQA-GOV-004']);
	assert.match(candidate.sqa.observations.find(item => item.controlId === 'SQA-GOV-001').rationale,
		/risk_register \(product-risk-baseline\).*qualified human review/);
	assert.match(candidate.sqa.observations.find(item => item.controlId === 'SQA-GOV-004').rationale,
		/approval_record \(assurance-roles\).*no pass or fail is claimed/);
	assert.equal(runStore.commits.length, 1);
	assert.equal(runStore.commits[0].payload.reviewerCloseout, true);

	const beforeFailure = structuredClone(candidate.sqa);
	candidate.sqa.observations = candidate.sqa.observations.filter(item => item.controlId !== 'SQA-GOV-004');
	const beforeRetry = structuredClone(candidate.sqa);
	await assert.rejects(closePendingReviewerSqaControlsAsBlocked(candidate, {
		async commit() { throw new Error('reviewer closeout persistence failed'); }
	}, fixedNow), /persistence failed/);
	assert.deepEqual(candidate.sqa, beforeRetry);
	assert.notDeepEqual(candidate.sqa, beforeFailure);
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

test('unfinished legacy sessions on the current catalog gain the required browser scope', () => {
	const candidate = session().sqa;
	candidate.scope.attributes = [];
	candidate.scope.applicableControlIds = candidate.scope.applicableControlIds.filter(controlId => !controlId.startsWith('SQA-WEB-'));
	const migrated = normalizePendingSqaState(candidate);
	assert.deepEqual(migrated.scope.attributes, SQA_BROWSER_REVIEW_ATTRIBUTES);
	assert.deepEqual(
		migrated.scope.applicableControlIds.filter(controlId => SQA_TECHNICAL_CONTROL_IDS.includes(controlId)),
		SQA_TECHNICAL_CONTROL_IDS
	);
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

test('reviewer document saves preserve browser evidence and reject fabricated or duplicate references', async () => {
	const candidate = session();
	const runStore = store();
	const controlId = 'SQA-QUA-005';
	await recordAgentSqaObservation(candidate, {
		control_id: controlId, status: 'blocked', rationale: 'A restoration record remains required.',
		evidence_type: 'test_result', evidence_summary: 'Retained browser sample.'
	}, runStore, fixedNow);
	const original = candidate.sqa.observations.find(item => item.controlId === controlId).evidence[0];
	const document = { type: 'operational_record', reference: 'artifact://quality/restore-proof', summary: 'Reviewed restoration record.' };
	const observation = { controlId, status: 'pass', rationale: 'Restore evidence reviewed.', evidence: [document] };
	const write = (input, role = 'admin', now = fixedNow) => recordReviewerSqaObservation(candidate, input, { role }, runStore, now, { reviewerDocuments: true });
	await assert.rejects(write(observation), /open a review draft/i);
	candidate.sqa.review = { status: 'in_review' };
	await assert.rejects(write(observation, 'developer'), /owner or administrator/i);
	const before = candidate.sqa;
	await assert.rejects(write({ ...observation, evidence: [original, document] }), /saved run/i);
	await assert.rejects(write({ ...observation, evidence: [document, document] }), /only once/i);
	assert.equal(candidate.sqa, before);
	const saved = await write(observation);
	assert.equal(saved.status, 'pass');
	assert.deepEqual(saved.evidence[0], original);
	assert.equal(inspectSqaEvidence(candidate, controlId, 1).integrity, 'verified');
	const later = await write(observation, 'owner', () => fixedNow() + 1000);
	assert.deepEqual(later.evidence, saved.evidence);
	assert.equal(candidate.sqa.reviewerAttestations.at(-1).role, 'owner');
});
