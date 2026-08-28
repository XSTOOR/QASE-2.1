import assert from 'node:assert/strict';
import test from 'node:test';
import { SQA_CATALOG, SQA_TECHNICAL_CONTROL_IDS, resolveSqaScope } from './sqaCatalog.js';
import {
	buildSqaReportMarkdown,
	evaluateSqaAssessment,
	validateSqaAssessmentInput
} from './sqaAssessment.js';

function request(overrides = {}) {
	return {
		target: { name: 'Example Product', release: '2026.08.15+abc123', environment: 'qualification' },
		assessedAt: '2026-08-15T12:00:00.000Z',
		profiles: ['core'],
		attributes: [],
		observations: [],
		...overrides
	};
}

function passingObservation(control) {
	return {
		controlId: control.id,
		status: 'pass',
		rationale: 'Reviewed and accepted against the declared release baseline.',
		evidence: control.evidenceRequirements.flatMap(requirement => (
			Array.from({ length: requirement.minimum }, (_, index) => ({
				type: requirement.type,
				reference: `${control.id}/${requirement.id}/${index + 1}`,
				summary: 'Integrity-protected evidence is retained in the qualification record.',
				digest: `sha256:${'a'.repeat(64)}`,
				collectedAt: '2026-08-15T11:45:00.000Z'
			}))
		))
	};
}

test('complete evidence produces a deterministic pass and transparent framework crosswalk', () => {
	const controls = resolveSqaScope().applicableControls;
	const observations = controls.map(passingObservation);
	const first = evaluateSqaAssessment(request({ observations }));
	const second = evaluateSqaAssessment(request({ observations: [...observations].reverse() }));

	assert.equal(first.verdict, 'pass');
	assert.equal(first.passed, true);
	assert.equal(first.coverage.conclusive, 100);
	assert.equal(first.coverage.evidence, 100);
	assert.ok(first.gates.every(gate => gate.passed));
	assert.equal(first.assessmentId, second.assessmentId);
	assert.equal(first.assessmentSha256, second.assessmentSha256);
	assert.match(first.assessmentSha256, /^[0-9a-f]{64}$/);
	assert.ok(first.frameworkCoverage.some(framework => framework.sourceId === 'ISO_29119'));
	assert.match(first.disclaimer, /not legal advice.*certification/i);
	assert.equal(first.summary.pass, controls.length);
	assert.equal(first.risk.level, 'none');
	const markdown = buildSqaReportMarkdown(first);
	assert.match(markdown, /## Executive summary/);
	assert.match(markdown, /## Priority action plan/);
	assert.match(markdown, /## Evidence traceability register/);
	assert.match(markdown, /SQA-GOV-001\/product-risk-baseline\/1/);
	assert.match(markdown, /sha256:a{64}/);
	assert.match(markdown, /2026-08-15T11:45:00\.000Z/);
	assert.match(markdown, /## Limitations and assurance notice/);
});

test('claimed pass without its evidence contract is blocked, never silently passed', () => {
	const control = resolveSqaScope().applicableControls[0];
	const assessment = evaluateSqaAssessment(request({ observations: [{
		controlId: control.id,
		status: 'pass',
		evidence: []
	}] }));
	const result = assessment.results.find(item => item.controlId === control.id);

	assert.equal(result.claimedStatus, 'pass');
	assert.equal(result.status, 'blocked');
	assert.deepEqual(result.evidenceCoverage.missing, control.evidenceRequirements.map(requirement => requirement.id));
	assert.equal(assessment.verdict, 'blocked');
	assert.equal(assessment.passed, false);
	assert.equal(assessment.gates.find(gate => gate.id === 'evidence_completeness').passed, false);
});

test('evidence-backed failure fails mandatory and critical decision gates', () => {
	const control = SQA_CATALOG.controls.find(item => item.id === 'SQA-GOV-001');
	const assessment = evaluateSqaAssessment(request({ observations: [{
		controlId: control.id,
		status: 'fail',
		rationale: 'No approved product risk baseline exists for the release.',
		evidence: [{ type: 'risk_register', reference: 'risk/gap-17', summary: 'The reviewed risk register has no approved release baseline.' }]
	}] }));

	assert.equal(assessment.verdict, 'fail');
	assert.equal(assessment.risk.level, 'critical');
	assert.equal(assessment.gates.find(gate => gate.id === 'mandatory_controls').status, 'fail');
	assert.equal(assessment.gates.find(gate => gate.id === 'critical_risk').status, 'fail');
	const markdown = buildSqaReportMarkdown(assessment);
	assert.match(markdown, /# SQA assessment — Example Product/);
	assert.match(markdown, /\*\*Verdict:\*\* FAIL/);
	assert.match(markdown, /not legal advice/);
	assert.match(markdown, /SQA-GOV-001/);
	assert.match(markdown, /Framework crosswalk/);
	assert.match(markdown, /Recommended disposition/);
	assert.match(markdown, /Reviewer evidence request register/);
	assert.match(markdown, /Assessment digest:.*sha256:/);
});

test('a failure backed only by an unrelated browser artifact remains blocked', () => {
	const control = SQA_CATALOG.controls.find(item => item.id === 'SQA-GOV-001');
	const assessment = evaluateSqaAssessment(request({ observations: [{
		controlId: control.id,
		status: 'fail',
		rationale: 'A browser flow cannot establish that the release risk baseline is absent.',
		evidence: [{ type: 'test_result', reference: 'qase://runs/example/evidence/browser-check' }]
	}] }));
	const result = assessment.results.find(item => item.controlId === control.id);

	assert.equal(result.claimedStatus, 'fail');
	assert.equal(result.status, 'blocked');
	assert.match(result.decisionNotes.join(' '), /evidence matching this control contract/i);
	assert.equal(assessment.verdict, 'blocked');
});

test('omitted controls are explicitly not assessed and keep the assessment blocked', () => {
	const assessment = evaluateSqaAssessment(request());
	assert.equal(assessment.verdict, 'blocked');
	assert.equal(assessment.summary.not_assessed, assessment.summary.applicableControls);
	assert.equal(assessment.coverage.observed, 0);
	assert.equal(assessment.coverage.conclusive, 0);
	assert.equal(assessment.results.every(result => result.status === 'not_assessed'), true);
	assert.ok(assessment.risk.score > 0);
});

test('conditional and sector controls are included only for declared scope', () => {
	const assessment = evaluateSqaAssessment(request({
		profiles: ['medical'],
		attributes: ['web_application', 'handles_personal_data', 'ai_enabled']
	}));
	assert.equal(assessment.profiles.includes('core'), true);
	assert.equal(assessment.profiles.includes('medical'), true);
	assert.equal(assessment.results.some(result => result.controlId === 'SQA-QUA-004'), true);
	assert.equal(assessment.results.some(result => result.controlId === 'SQA-PRI-001'), true);
	assert.equal(assessment.results.some(result => result.controlId === 'SQA-AI-001'), true);
	assert.equal(assessment.results.filter(result => result.controlId.startsWith('SQA-MED-')).length, 3);
	assert.equal(assessment.results.some(result => result.controlId.startsWith('SQA-PCI-')), false);
});

test('input validation rejects ambiguity, typos, weak evidence references, and stale catalog versions', () => {
	const controlId = resolveSqaScope().applicableControls[0].id;
	assert.throws(() => validateSqaAssessmentInput(request({ assessedAt: '2026-08-15' })), /canonical UTC/);
	assert.throws(() => validateSqaAssessmentInput(request({ catalogVersion: 'old' })), /does not match/);
	assert.throws(() => validateSqaAssessmentInput(request({ unexpected: true })), /unsupported fields/);
	assert.throws(() => validateSqaAssessmentInput(request({ observations: [
		{ controlId, status: 'blocked', rationale: 'Unavailable.', evidence: [] },
		{ controlId, status: 'blocked', rationale: 'Still unavailable.', evidence: [] }
	] })), /Duplicate SQA observation/);
	assert.throws(() => validateSqaAssessmentInput(request({ observations: [{
		controlId: 'SQA-MED-001', status: 'blocked', rationale: 'Wrong profile.', evidence: []
	}] })), /out-of-scope/);
	assert.throws(() => validateSqaAssessmentInput(request({ observations: [{
		controlId, status: 'fail', evidence: []
	}] })), /rationale is required/);
	assert.throws(() => validateSqaAssessmentInput(request({ observations: [{
		controlId, status: 'not_assessed', evidence: [{ type: 'artifact', reference: 'impossible' }]
	}] })), /cannot attach evidence/);
	assert.throws(() => validateSqaAssessmentInput(request({ observations: [{
		controlId, status: 'pass', evidence: [{ type: 'artifact', reference: 'x', digest: 'sha256:nope' }]
	}] })), /digest must use/);
});

test('technical smoke summary concludes independently from broad assurance controls', () => {
	const controls = resolveSqaScope({ attributes: ['web_application'] }).applicableControls;
	const technicalControls = controls.filter(control => SQA_TECHNICAL_CONTROL_IDS.includes(control.id));
	const assessment = evaluateSqaAssessment(request({
		attributes: ['web_application'],
		observations: technicalControls.map(passingObservation)
	}));

	assert.equal(assessment.verdict, 'blocked', 'documentary assurance is still unresolved');
	assert.deepEqual(assessment.technicalSummary, {
		applicableControls: 6,
		pass: 6,
		fail: 0,
		blocked: 0,
		not_assessed: 0,
		verdict: 'pass',
		passed: true
	});
	const markdown = buildSqaReportMarkdown(assessment);
	assert.match(markdown, /## Bounded technical smoke sample/);
	assert.match(markdown, /- Verdict: PASS/);
	assert.match(markdown, /does not establish whole-product compliance/i);
});

test('technical smoke summary reports failures, unresolved checks, and non-applicability', () => {
	const failure = evaluateSqaAssessment(request({
		attributes: ['web_application'],
		observations: [{
			controlId: 'SQA-WEB-005',
			status: 'fail',
			rationale: 'The representative route consistently produced an uncaught error.',
			evidence: [{ type: 'test_result', reference: 'qase://runs/example/evidence/console-error' }]
		}]
	}));
	assert.equal(failure.technicalSummary.verdict, 'fail');
	assert.equal(failure.technicalSummary.fail, 1);
	assert.equal(failure.technicalSummary.not_assessed, 5);

	const unresolved = evaluateSqaAssessment(request({ attributes: ['user_interface'] }));
	assert.equal(unresolved.technicalSummary.verdict, 'blocked');
	assert.equal(unresolved.technicalSummary.not_assessed, 6);

	const notApplicable = evaluateSqaAssessment(request());
	assert.deepEqual(notApplicable.technicalSummary, {
		applicableControls: 0,
		pass: 0,
		fail: 0,
		blocked: 0,
		not_assessed: 0,
		verdict: 'not_applicable',
		passed: false
	});
});
