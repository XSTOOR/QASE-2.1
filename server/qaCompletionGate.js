import { digestEvidence, diagnosticFailures } from './qaScenarioLedger.js';
import { hybridRoutePolicy } from './hybridRoutePolicy.js';

export function validateHybridFinding(session, input) {
  const state = session.hybrid;
  const scenario = state?.scenarios?.find(item => item.id === input.scenario_id);
  const assertion = scenario?.assertions.find(item => item.id === input.assertion_id);
  const evidence = state?.evidence.find(item => item.id === assertion?.evidenceRef);
  const action = state?.actions.find(item => item.id === assertion?.actionId);
  if (!scenario || !assertion || assertion.outcome !== 'fail' || !evidence?.success || evidence.runId !== session.id ||
      evidence.digest !== digestEvidence(evidence.result) || evidence.actionId !== action?.id || action.status !== 'done' ||
      !['host_browser_check', 'request_assertion', 'host_diagnostic'].includes(assertion.authority)) throw new Error('Confirmed findings require a failed host assertion and intact evidence from this run.');
  if (!assertion.reproduction?.confirmed || assertion.reproduction.observations < 2) throw new Error('The observed failure is unresolved until safe reproduction or repeated deterministic assertion evidence is available.');
  if ((state.policyBlocks || []).some(item => item.url && String(assertion.actual).includes(item.url)) ||
      (assertion.authority === 'host_diagnostic' && (state.policyBlocks || []).some(item => ['script', 'stylesheet', 'document'].includes(item.resourceType)))) throw new Error('Browser policy blocked a relevant dependency; the target defect is not established.');
  if (assertion.authority === 'host_browser_check') {
    if (evidence.toolName !== 'browser_qa_check' || !evidence.result.assertions?.some(item => item.name === assertion.name && digestEvidence(item.expected) === digestEvidence(assertion.expected) && digestEvidence(item.actual) === digestEvidence(assertion.actual) && item.outcome === 'fail' && item.reproduction?.confirmed === true)) throw new Error('Host assertion does not match the executed browser check.');
  } else {
    const first = state.evidence.find(item => item.id === assertion.reproduction.firstEvidenceRef);
    if (!first?.success || first.runId !== session.id || first.digest !== digestEvidence(first.result) || first.id === evidence.id || first.actionId === evidence.actionId) throw new Error('Distinct intact reproduction evidence is required.');
    if (assertion.authority === 'host_diagnostic' && (first.toolName !== 'browser_diagnostics' || evidence.toolName !== 'browser_diagnostics' || JSON.stringify(diagnosticFailures(first.result, first.url || session.targetUrl)) !== assertion.actual || JSON.stringify(diagnosticFailures(evidence.result, evidence.url || session.targetUrl)) !== assertion.actual)) throw new Error('Diagnostic reproduction does not match recorded exceptions.');
  }
  return { scenarioId: scenario.id, assertionId: assertion.id, failureKey: digestEvidence([scenario.id, assertion.name, assertion.expected, assertion.actual]), evidenceRefs: [...new Set([evidence.id, assertion.reproduction.firstEvidenceRef].filter(Boolean))],
    expected: assertion.expected, actual: String(assertion.actual), url: assertion.check === 'broken_links' && evidence.result.destination ? evidence.result.destination : evidence.url || session.targetUrl,
    evidence: `Host assertion ${assertion.id}; scenario ${scenario.id}; action ${action.id}; evidence ${evidence.id}; reproduction ${JSON.stringify(assertion.reproduction)}` };
}

export function hybridCompletion(session) {
  const state = session.hybrid;
  if (!state?.scenarios?.length) throw new Error('Hybrid QA requires a scenario ledger.');
  const counts = Object.fromEntries(['planned', 'running', 'passed', 'failed', 'blocked', 'inconclusive', 'not_executed'].map(status => [status, state.scenarios.filter(item => item.status === status).length]));
  const gaps = state.scenarios.filter(item => !['passed', 'failed'].includes(item.status)).map(item => `${item.category}: ${item.objective} — ${item.status}. ${item.uncertainty.join(' ')}`);
  if (state.viewport && (state.viewport.phase !== 'selected_device' || !state.viewport.restored)) gaps.push('The selected-device viewport has not been verified restored; responsive or recovery work remains incomplete.');
  for (const scenario of state.scenarios) {
    const routeGaps = scenario.routeRuns?.filter(run => !['passed', 'failed'].includes(run.status));
    if (routeGaps?.length) gaps.push(`${scenario.category}: ${routeGaps.length} route executions remain inconclusive/blocked/not executed: ${routeGaps.map(run => run.url).join(', ')}.`);
  }
  const evidenceById = new Map(state.evidence.map(item => [item.id, item]));
  const checkedEvidence = new Map();
  for (const category of state.scope || []) if (!state.scenarios.some(item => item.category === category && ['passed', 'failed'].includes(item.status))) gaps.push(`${category}: selected scope has no completed scenario with host assertions.`);
  for (const item of state.scenarios.filter(item => ['passed', 'failed'].includes(item.status))) {
    if (!item.executedActionIds.length || !item.assertions.length) throw new Error('Scenario completion has no executed action/assertion evidence.');
    for (const assertion of item.assertions) {
      const record = evidenceById.get(assertion.evidenceRef);
      if (record && !checkedEvidence.has(record.id)) checkedEvidence.set(record.id, record.success && record.runId === session.id && record.digest === digestEvidence(record.result));
      if (!record || !checkedEvidence.get(record.id)) throw new Error('Scenario evidence is missing or invalid.');
    }
    if (item.status === 'passed' && item.assertions.some(assertion => assertion.outcome !== 'pass')) throw new Error('A scenario with failed assertions cannot pass.');
  }
  const unresolved = state.observations.filter(item => item.status !== 'confirmed');
  if (unresolved.length) gaps.push(`${unresolved.length} observations remain unresolved.`);
  if (state.degradedClassification) gaps.push('Classification degraded: JEV could not classify all eligible observations.');
  const routes = state.exploration?.routes || [];
  const depth = hybridRoutePolicy(state);
  if (depth.stopReason === 'budget_closeout' && depth.depthPending) gaps.push(`Budget closeout ended route exploration at ${depth.attempted}/${depth.target} attempted pages; ${depth.pending} observed routes remain pending. The depth target is unmet, not a publication prerequisite during closeout.`);
  if (routes.some(item => item.status !== 'tested')) gaps.push(`Observed-route coverage: ${routes.filter(item => item.status === 'tested').length}/${routes.length} observed pages tested; unvisited/failed routes remain outside this review.`);
  const incompleteControls = state.exploration?.interactions?.filter(item => item.status !== 'executed') || [];
  if (incompleteControls.length) gaps.push(`${incompleteControls.length} observed interaction trials were inconclusive/interrupted; no pass was inferred.`);
  if (routes.some(route => route.remainingScroll)) gaps.push('The bounded scroll sample did not reach all document content on some pages; deeper/lazy content remains untested.');
  const absent = [...new Set(routes.flatMap(route => (route.absentChecks || []).map(item => item.category)))];
  if (absent.length) gaps.push(`Eligible controls were absent on some sampled pages for: ${absent.join(', ')}. Observed absence is not successful workflow coverage.`);
  for (const item of state.scenarios.filter(item => ['passed', 'failed'].includes(item.status))) {
    if (item.category === 'forms') gaps.push(state.evidence.some(evidence => item.evidenceRefs.includes(evidence.id) && evidence.result?.formTesting?.mode === 'live_non_submitting')
      ? 'Form checks filled real controls and exercised bounded local negative cases under egress quarantine. Successful submission, remote validation, authenticated/business workflows and unsampled fields remain unverified.'
      : 'Form assertions cover detached native constraints; application handlers, submissions and recovery remain unverified.');
    if (item.category === 'search') gaps.push('Local search assertions do not establish remote search relevance or submitted workflows.');
    if (item.category === 'accessibility') gaps.push('Accessible-name assertions do not establish full keyboard, focus, contrast or screen-reader behavior.');
    if (item.category === 'authentication' || item.category.startsWith('security_')) gaps.push(`${item.category}: an authorized positive/negative workflow is not established by public browser observations.`);
  }
  if (state.pauseReason) gaps.push(state.pauseReason);
  if (state.actions.some(item => item.status === 'running' || item.status === 'uncertain')) gaps.push('Interrupted action requires state verification and a new scenario decision.');
  const findings = (session.findings || []).filter(item => item.hybridEvidence);
  const executed = counts.passed + counts.failed;
  const completeCoverage = state.scenarios.filter(item => item.status === 'failed' || (item.status === 'passed' && !item.routeRuns?.some(run => !['passed', 'failed'].includes(run.status)))).length;
  const observedAssertions = state.scenarios.some(item => item.assertions.length && item.executedActionIds.length);
  const verdict = !executed && !observedAssertions ? 'blocked' : findings.some(item => ['critical', 'high'].includes(item.severity)) ? 'fail' : gaps.length ? 'partial' : findings.length ? 'pass_with_issues' : 'pass';
  const assertions = state.scenarios.flatMap(item => item.assertions);
  return { version: 1, counts, verdict, confirmedDefects: findings.length, unresolved: unresolved.length,
    unresolvedObservations: unresolved.slice(0, 20).map(({ id, kind, title, detail, evidenceRefs }) => ({ id, kind, title, detail, evidenceRefs })),
    passedAssertions: assertions.filter(item => item.outcome === 'pass').length, failedAssertions: assertions.filter(item => item.outcome === 'fail').length,
    covered: state.scenarios.filter(item => item.assertions.length && item.executedActionIds.length).map(item => `${item.category}: ${item.status}. Executed assertions: ${[...new Set(item.assertions.map(assertion => assertion.name))].join('; ')}`),
    gaps: [...new Set(gaps)], coverage: state.scenarios.length ? completeCoverage / state.scenarios.length : 0,
    summary: `Hybrid QA executed ${executed}/${state.scenarios.length} scenarios; ${counts.passed} passed, ${counts.failed} failed, ${counts.blocked} blocked, ${counts.inconclusive} inconclusive. ${findings.length} confirmed defects and ${unresolved.length} unresolved observations. Coverage is limited to the recorded scenarios.` };
}

export function validateHybridReport(session, input) {
  if (!session.hybrid.budgetFinalizing && needsHybridAuthQuestion(session)) throw Object.assign(new Error('Ask the user for secure test-account access or a public-only decision before finalizing requested authenticated scope.'), { code: 'HYBRID_AUTH_QUESTION_REQUIRED' });
  const result = hybridCompletion(session);
  if (['pass', 'pass_with_issues'].includes(input.verdict) && !['pass', 'pass_with_issues'].includes(result.verdict)) throw new Error('Unsupported pass: the host ledger contains gaps or unresolved evidence.');
  if (result.counts.running || result.counts.planned) throw new Error('Required scenarios still need executed assertions or explicit blocked/inconclusive/not-executed dispositions before publication.');
  const depth = hybridRoutePolicy(session.hybrid);
  if (!session.testCaseSnapshot && depth.target > 1 && !depth.publicationAllowed) throw Object.assign(new Error(`The observed-route depth contract requires ${depth.target} attempted pages before publication (${depth.attempted} attempted; ${depth.remainingSlots} slots remain). Use qa_test_routes with up to ${depth.nextBatchSize} pending route IDs. During host budget closeout the depth shortfall becomes a coverage gap, not a publication blocker.`), { code: 'HYBRID_DEPTH_PENDING', coverage: depth });
  if (session.hybrid.continuationPolicyVersion === 1 && result.gaps.length && !session.hybrid.partialReportApproved) throw Object.assign(new Error('Testing has coverage gaps. A host user decision is required before publishing an incomplete report.'), { code: 'HYBRID_COMPLETION_DECISION_REQUIRED' });
  return { ...input, verdict: result.verdict, summary: result.summary, covered: result.covered, not_covered: result.gaps,
    hybridEvidence: result };
}
import { needsHybridAuthQuestion } from './hybridAuth.js';
