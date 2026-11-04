export const HYBRID_BENCHMARK_MANIFEST = Object.freeze({
  version: 1,
  checks: ['navigation', 'responsive', 'media', 'search'],
  defects: [
    { id: 'horizontal-overflow', match: 'document-overflow|overflows horizontally' },
    { id: 'broken-image', match: 'missing-fixture.png|image-decode' },
    { id: 'stale-search', match: 'local-search|Unmatched search|search-no-match|qase-no-match' }
  ],
  negativeOpportunities: 4,
  negatives: [
    { id: 'healthy-back', assertionName: 'Browser back restores source route', findingMatch: 'Browser back|source route' },
    { id: 'healthy-forward', assertionName: 'Browser forward restores destination', findingMatch: 'Browser forward' },
    { id: 'healthy-image', actualMatch: 'healthy.svg', findingMatch: 'healthy.svg' },
    { id: 'healthy-disclosure', assertionName: 'Disclosure responds to actual click', findingMatch: 'Disclosure' }
  ],
  workflows: ['navigation', 'responsive', 'media', 'search'],
  definition: 'Workflow completion means the QA scenario executed assertions, including failed assertions. It does not mean the product workflow passed.'
});

export function benchmarkMetrics(session, manifest = HYBRID_BENCHMARK_MANIFEST) {
  const findings = session.findings || [];
  const predicted = new Set(); const falseRecords = [];
  for (const finding of findings) {
    const text = JSON.stringify(finding);
    const matched = manifest.defects.filter(defect => new RegExp(defect.match, 'i').test(text));
    if (!matched.length) falseRecords.push(finding); else for (const defect of matched) predicted.add(defect.id);
  }
  const checks = session.hybrid ? session.hybrid.evidence.filter(item => item.toolName === 'browser_qa_check').map(item => item.result) : session.jev?.qa?.checks || [];
  const complete = manifest.workflows.filter(action => checks.some(check => check.action === action && check.success && check.assertions?.length > 0));
  const assertions = checks.flatMap(check => check.assertions || []);
  const testedNegatives = (manifest.negatives || []).filter(negative => assertions.some(assertion => negative.assertionName ? assertion.name === negative.assertionName : String(assertion.actual).includes(negative.actualMatch)));
  const flaggedNegatives = testedNegatives.filter(negative => falseRecords.some(finding => new RegExp(negative.findingMatch, 'i').test(JSON.stringify(finding))));
  const mappedFalseRecords = falseRecords.filter(finding => testedNegatives.some(negative => new RegExp(negative.findingMatch, 'i').test(JSON.stringify(finding))));
  return { status: session.status, verdict: session.report?.verdict, confirmedDefectClasses: [...predicted],
    confirmedDefectRecall: predicted.size / manifest.defects.length, falseFindings: falseRecords.length,
    falsePositiveRate: testedNegatives.length && mappedFalseRecords.length === falseRecords.length ? flaggedNegatives.length / testedNegatives.length : null,
    evaluatedNegativeControls: testedNegatives.map(item => item.id),
    falseDiscoveryRate: findings.length ? falseRecords.length / findings.length : 0,
    falsePositiveNote: 'FPR covers only manifest negative controls that actually executed. Unmapped false findings or no executed negatives leave FPR unavailable.',
    workflowCompletionRate: complete.length / manifest.workflows.length, completedWorkflows: complete,
    scenarioCoverage: session.hybrid ? { total: session.hybrid.scenarios.length, completed: session.hybrid.scenarios.filter(item => ['passed', 'failed'].includes(item.status)).length } : { routes: session.jev?.qa?.visits.length || 0, assertions: checks.reduce((sum, check) => sum + (check.assertions?.length || 0), 0) },
    unresolvedCoverageGaps: session.report?.notCovered?.length || 0, tokenUsage: session.tokenUsage || null,
    perModelUsage: session.hybrid?.telemetry ? { reasoner: session.hybrid.telemetry.reasoner, classifier: session.hybrid.telemetry.classifier } : null,
    reportedModelCost: session.hybrid?.telemetry?.reasoner.reportedCost ?? null,
    costPerCompletedWorkflow: null,
    costNote: 'Unavailable unless complete comparable provider billing is reported. No static pricing or estimates are substituted.',
    recoverySuccess: null, recoveryNote: 'Not measured by the normal-run benchmark; use the interruption regression qualification.' };
}
