/** These objectives need release-wide verification reports. A Qase browser
 * activity bundle remains useful partial evidence, not the complete report. */
export const SQA_RELEASE_REPORT_CONTROL_IDS = Object.freeze([
	'SQA-QUA-002', 'SQA-QUA-003', 'SQA-QUA-004', 'SQA-QUA-006', 'SQA-QUA-008'
]);

export function isSqaPartialReleaseEvidence(controlId, evidence) {
	return SQA_RELEASE_REPORT_CONTROL_IDS.includes(controlId)
		&& /^qase:\/\/runs\/[^/]+\/activities\//i.test(evidence?.reference ?? '');
}

export function isSqaInternalEvidence(evidence) {
	return typeof evidence?.reference === 'string' && /^qase:/i.test(evidence.reference.trim());
}
