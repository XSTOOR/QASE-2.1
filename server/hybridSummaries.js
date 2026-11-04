/** Model-facing summaries only. Full assertions remain in durable evidence. */
export function scenarioSummary(scenario) {
  const assertions = scenario.assertions || [];
  return { id: scenario.id, category: scenario.category, routeUrl: scenario.routeUrl, status: scenario.status,
    ...(scenario.routeRuns ? { routeCounts: { attempted: scenario.routeRuns.length, passed: scenario.routeRuns.filter(run => run.status === 'passed').length, failed: scenario.routeRuns.filter(run => run.status === 'failed').length, gaps: scenario.routeRuns.filter(run => !['passed', 'failed'].includes(run.status)).length } } : {}),
    assertionCounts: { passed: assertions.filter(item => item.outcome === 'pass').length, failed: assertions.filter(item => item.outcome === 'fail').length },
    failures: assertions.filter(item => item.outcome === 'fail').slice(0, 8).map(assertionSummary),
    omittedFailures: Math.max(0, assertions.filter(item => item.outcome === 'fail').length - 8),
    uncertainty: scenario.uncertainty, evidenceRefs: (scenario.evidenceRefs || []).slice(-3) };
}
export function assertionSummary({ id, name, outcome, expected, actual, reproduction, evidenceRef }) {
  return { id, name, outcome, expected: String(expected).slice(0, 300), actual: (typeof actual === 'string' ? actual : JSON.stringify(actual))?.slice(0, 400),
    reproduced: Boolean(reproduction?.confirmed), evidenceRef };
}
