/** Common traceability data used by the UI, Markdown and PDF renderers. */
export function sqaReportModel(assessment = {}) {
	const results = Array.isArray(assessment.results) ? assessment.results : [];
	return {
		technical: assessment.technicalSummary,
		failures: results.filter(item => item.status === 'fail'),
		evidence: results.flatMap(result => (result.evidence ?? []).map((item, index) => ({
			controlId: result.controlId, status: result.status, index: index + 1,
			type: item.type, collectedAt: item.collectedAt ?? 'not recorded', reference: item.reference,
			digest: item.digest ?? 'not supplied', summary: item.summary ?? '',
			origin: String(item.reference).startsWith('qase://') ? 'Internal browser record' : 'Reviewer document reference'
		})))
	};
}
