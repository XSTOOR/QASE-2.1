import { SQA_AGENT_CAPABLE_EVIDENCE_TYPES } from './sqaPresentation.js';

/** Common traceability data used by the UI, Markdown and PDF renderers. */
export function sqaReportModel(assessment = {}) {
	const results = Array.isArray(assessment.results) ? assessment.results : [];
	return {
		technical: assessment.technicalSummary,
		failures: results.filter(item => item.status === 'fail'),
		evidenceRequests: results.flatMap(result => (result.evidenceCoverage?.requirements ?? [])
			.filter(requirement => !requirement.satisfied)
			.map(requirement => ({
				controlId: result.controlId, title: result.title, severity: result.severity,
				mandatory: result.mandatory, status: result.status,
				id: requirement.id, type: requirement.type, minimum: requirement.minimum,
				description: requirement.description,
				owner: SQA_AGENT_CAPABLE_EVIDENCE_TYPES.includes(requirement.type) ? 'browser' : 'reviewer'
			}))),
		evidence: results.flatMap(result => (result.evidence ?? []).map((item, index) => ({
			controlId: result.controlId, status: result.status, index: index + 1,
			type: item.type, collectedAt: item.collectedAt ?? 'not recorded', reference: item.reference,
			digest: item.digest ?? 'not supplied', summary: item.summary ?? '',
			origin: String(item.reference).startsWith('qase://') ? 'Internal browser record' : 'Reviewer document reference'
		})))
	};
}
