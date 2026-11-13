import { applicationDiscoveryStatus } from './qaApplicationDiscovery.js';
import { scenarioExecutionAccount } from './qaExecutionState.js';
import { modeReceiptHash } from './modeIntegrity.js';
import { redact } from './secrets.js';

const assertionTools = {
  host_browser_check: 'browser_qa_check',
  host_diagnostic: 'browser_diagnostics',
  request_assertion: 'browser_snapshot'
};
const inventoryLimit = 24;
const assertionsPerScenario = 12;

function excerpt(value, limit = 480) {
  if (value == null) return undefined;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function location(value) {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol)) return excerpt(url.origin + url.pathname, 300);
  } catch { /* Some receipts have no associated page. */ }
  return undefined;
}

/** A bounded reader for the existing, owner-scoped run ledger. Never
 * include raw browser snapshots, tool inputs, credentials or model prompts. */
export function projectQaEvidence(session) {
  const state = session.hybrid;
  const records = new Map((state?.evidence || []).map(record => [record.id, record]));
  const actions = new Map((state?.actions || []).map(action => [action.id, action]));
  const checked = new Map();
  const intact = record => {
    if (!record || record.runId !== session.id || record.result === undefined) return false;
    if (!checked.has(record.id)) checked.set(record.id, record.digest === modeReceiptHash(record));
    return checked.get(record.id);
  };
  const discovery = state?.discovery?.version === 1 && Array.isArray(state.evidence)
    ? applicationDiscoveryStatus(session) : null;
  const features = new Map((discovery?.features || []).map(feature => [feature.id, feature]));
  const linkedFindings = new Map((session.findings || []).filter(finding => finding.hybridEvidence?.assertionId)
    .map(finding => [finding.hybridEvidence.assertionId, { id: finding.id, scenarioId: finding.hybridEvidence.scenarioId }]));
  const scenarios = (state?.scenarios || []).map(scenario => {
    const executed = new Set(scenario.executedActionIds);
    const assertions = (scenario.assertions || []).filter(assertion => {
      const record = records.get(assertion.evidenceRef);
      return ['pass', 'fail'].includes(assertion.outcome) && record?.success && assertionTools[assertion.authority] === record.toolName
        && record.actionId === assertion.actionId && executed.has(record.actionId)
        && actions.get(record.actionId)?.status === 'done' && intact(record);
    });
    const failed = assertions.filter(assertion => assertion.outcome === 'fail').length;
    const unverified = (scenario.assertions?.length || 0) - assertions.length;
    // Prefer failures, then retain the actual recorded order for the sample.
    const selected = new Set([...assertions].sort((a, b) => Number(b.outcome === 'fail') - Number(a.outcome === 'fail'))
      .slice(0, assertionsPerScenario).map(assertion => assertion.id));
    const targets = (scenario.discoveryPlan?.featureIds || []).map(id => features.get(id)).filter(Boolean);
    const absence = !assertions.length && scenario.status === 'not_executed' && state.exploration?.routes?.length
      && scenarioExecutionAccount(session, scenario).absent;
    const gaps = [...new Set([
      ...(scenario.uncertainty || []),
      ...(scenario.executionGaps || []).filter(gap => !gap.resolvedBy).map(gap => gap.reason),
      ...(scenario.routeRuns || []).filter(run => run.reason && !['passed', 'failed'].includes(run.status)).map(run => run.reason),
      unverified ? `${unverified} saved ${unverified === 1 ? 'assertion has no verifiable receipt' : 'assertions have no verifiable receipts'}.` : null
    ].filter(Boolean))].slice(0, 6).map(reason => excerpt(reason));
    return {
      id: scenario.id, category: scenario.category, objective: excerpt(scenario.objective, 240), status: scenario.status,
      route: location(scenario.routeUrl), absent: Boolean(absence), gaps,
      incompleteRoutes: (scenario.routeRuns || []).filter(run => !['passed', 'failed'].includes(run.status)).length,
      targets: [...new Set(targets.map(feature => feature.name))].slice(0, 6),
      expectation: ['request', 'specification'].includes(scenario.expected?.source) ? excerpt(scenario.expected.text) : undefined,
      passed: assertions.length - failed, failed,
      assertions: assertions.filter(assertion => selected.has(assertion.id)).map(assertion => {
        const record = records.get(assertion.evidenceRef);
        const result = record.result || {};
        const finding = linkedFindings.get(assertion.id);
        const source = location(result.source || record.url);
        const destination = location(result.destination || result.inventory?.url);
        return {
          id: assertion.id, name: excerpt(assertion.name, 180), outcome: assertion.outcome,
          expected: excerpt(assertion.expected), actual: excerpt(assertion.actual),
          authority: assertion.authority, reference: record.id, capturedAt: record.ts,
          source, destination: destination !== source ? destination : undefined,
          control: excerpt(result.controlLabel || result.transition?.control?.label, 120),
          httpStatus: Number.isInteger(result.responseStatus) ? result.responseStatus : undefined,
          findingId: finding?.scenarioId === scenario.id ? finding.id : undefined
        };
      })
    };
  });
  const inventory = [...features.values()];
  return redact(session.id, {
    currentScenarioId: state?.currentScenarioId,
    discovery: discovery ? {
      status: discovery.blocked ? 'blocked' : discovery.ready ? 'ready' : 'pending',
      total: inventory.length,
      features: inventory.slice(0, inventoryLimit).map(feature => ({
        id: feature.id, name: excerpt(feature.name, 140), kind: feature.kind, location: location(feature.location)
      })),
      limitations: discovery.limitations.slice(0, 6).map(reason => excerpt(reason))
    } : undefined,
    scenarios
  });
}
