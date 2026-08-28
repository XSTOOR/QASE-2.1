const FINAL_RESULTS = Object.freeze({
	pass: { label: 'Pass', mark: '✓' },
	fail: { label: 'Fail', mark: '×' },
	blocked: { label: 'Blocked', mark: '!' },
	not_assessed: { label: 'Not assessed', mark: '—' }
});

/**
 * Evidence types that the browser agent can defensibly produce or reference
 * during a run. Every other type represents an operator/reviewer artifact.
 * Keep this presentation boundary aligned with the server-side SQA evidence
 * contract; it changes labels only and never changes evaluator results.
 */
export const SQA_AGENT_CAPABLE_EVIDENCE_TYPES = Object.freeze([
	'assessment_record',
	'configuration_record',
	'security_report',
	'test_result',
	'wcag_report'
]);

const AGENT_CAPABLE_EVIDENCE = new Set(SQA_AGENT_CAPABLE_EVIDENCE_TYPES);

function missingEvidenceTypes(result) {
	return (result?.evidenceCoverage?.requirements ?? [])
		.filter(requirement => !requirement?.satisfied && typeof requirement?.type === 'string')
		.map(requirement => requirement.type);
}

/**
 * Split unresolved controls by who can supply the missing evidence. Failures
 * stay distinct so missing paperwork is never presented as a failed web test.
 */
export function groupSqaUnresolvedResults(results = []) {
	const groups = {
		failures: [],
		reviewer: [],
		mixed: [],
		automated: []
	};
	for (const result of Array.isArray(results) ? results : []) {
		if (!result || result.status === 'pass') continue;
		if (result.status === 'fail') {
			groups.failures.push(result);
			continue;
		}

		const missingTypes = missingEvidenceTypes(result);
		const hasAgentEvidence = missingTypes.some(type => AGENT_CAPABLE_EVIDENCE.has(type));
		const hasReviewerEvidence = missingTypes.some(type => !AGENT_CAPABLE_EVIDENCE.has(type));
		if (result.automationLevel === 'manual' || (hasReviewerEvidence && !hasAgentEvidence)) {
			groups.reviewer.push(result);
		} else if (result.automationLevel === 'hybrid' || (hasAgentEvidence && hasReviewerEvidence)) {
			groups.mixed.push(result);
		} else {
			groups.automated.push(result);
		}
	}
	return groups;
}

/**
 * Turn the persisted SQA lifecycle into user-facing state.
 *
 * A newly created assessment is pending and older sessions may still contain
 * a conservative, evidence-empty draft evaluation. Neither is a final
 * "blocked" verdict; only `finalizedAt` makes the result final.
 */
export function describeSqaLifecycle(sqa = {}, runStatus = 'idle', activityCount = 0) {
	const assessment = sqa?.assessment;
	if (sqa?.finalizedAt) {
		const status = assessment?.verdict ?? 'not_assessed';
		const result = FINAL_RESULTS[status] ?? {
			label: String(status).replaceAll('_', ' '),
			mark: '•'
		};
		const groups = groupSqaUnresolvedResults(assessment?.results);
		const hasFailure = groups.failures.length > 0 || Number(assessment?.summary?.fail) > 0;
		const evidenceGapCount = groups.reviewer.length + groups.mixed.length;
		const evidenceIncomplete = status === 'blocked'
			&& !hasFailure
			&& groups.automated.length === 0
			&& evidenceGapCount > 0;
		const presentation = evidenceIncomplete
			? { label: 'Evidence incomplete', mark: '!', badge: 'evidence incomplete' }
			: { ...result, badge: result.label.toLowerCase() };
		return {
			phase: 'finalized',
			finalized: true,
			status,
			rawVerdict: status,
			evidenceIncomplete,
			evidenceGapCount,
			eyebrow: 'Final deterministic verdict',
			...presentation
		};
	}

	if (runStatus === 'running') {
		return {
			phase: 'running', finalized: false, status: 'running', badge: 'running',
			label: 'Assessment running', mark: '…', eyebrow: 'Assessment lifecycle'
		};
	}
	if (runStatus === 'awaiting_input') {
		return {
			phase: 'waiting', finalized: false, status: 'waiting', badge: 'waiting',
			label: 'Waiting for input', mark: '?', eyebrow: 'Assessment lifecycle'
		};
	}

	const observationCount = Array.isArray(sqa?.observations) ? sqa.observations.length : 0;
	if (observationCount > 0 || activityCount > 0) {
		return {
			phase: 'in_progress', finalized: false, status: 'in_progress', badge: 'in progress',
			label: 'Assessment in progress', mark: '…', eyebrow: 'Assessment lifecycle'
		};
	}

	return {
		phase: 'ready', finalized: false, status: 'ready', badge: 'ready',
		label: 'Ready to test', mark: '>', eyebrow: 'Assessment lifecycle'
	};
}
