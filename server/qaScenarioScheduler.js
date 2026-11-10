import {createHash} from 'node:crypto';
import {hasConfirmedAccess} from './hybridAuth.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = new Set(['passed', 'failed', 'blocked', 'inconclusive', 'not_executed']);
export const explicitQaCloseout = session => Boolean(session.hybrid.partialReportApproved?.decisionId && session.hybrid.partialReportApproved.by === session.ownerUserId);

export function intactQaReceipt(session, record) {
  const state = session.hybrid, access = hasConfirmedAccess(state) ? state.authentication.grantId : 'public';
  return Boolean(record && record.runId === session.id && record.digest === digest(record.result) && (record.authenticationContext || 'public') === access);
}

// One evaluation shares indexes and receipt verification. Checkpoint/public
// projections must not hash every observation again for every scenario.
function schedulerContext(session) {
  const state = session.hybrid, checked = new Map();
  return {
    evidence: new Map(state.evidence.map(e => [e.id, e])),
    indexes: new Map(state.evidence.map((e, i) => [e.id, i])),
    actions: new Map(state.actions.map(a => [a.id, a])),
    intact(record) {
      if (!record) return false;
      if (!checked.has(record.id)) checked.set(record.id, intactQaReceipt(session, record));
      return checked.get(record.id);
    }
  };
}

function isSafetyExclusion(record, action, gap, context, scenario) {
  // Typed host exclusions remain visible report gaps. Retrying protected or
  // excess fields cannot improve coverage within the same authorization.
  if(!context.intact(record)||!record.success||record.toolName!=='browser_qa_check')return false;
  return record.result?.coverageLimitations?.some(limit=>limit.message===gap.reason&&(
    action?.input?.action==='forms'&&limit.code==='QA_INPUT_SAMPLE_LIMIT'&&limit.excludedControls>0||
    action?.input?.action==='submit_test_form'&&limit.code==='QA_SUBMISSION_ORACLE_REQUIRED'&&record.result.writeTesting?.status==='responded'&&!['request','specification'].includes(scenario.expected?.source)));
}

function matchingRecheck(old, prior, next, category, context) {
  const action = context.actions.get(next.actionId);
  return old?.result?.dispatched === false && context.indexes.get(next.id) > context.indexes.get(old.id) && next.success && next.url === old.url &&
    !next.result?.gaps?.length && next.result?.assertions?.some(a => a.check === category) && action?.input?.action === prior?.input?.action && action?.input?.selector === prior?.input?.selector;
}

/** Accountable disposition is separate from passing coverage. An incomplete
 * tool invocation is not resolved merely because the model closed its item. */
export function scenarioObligation(session, scenario, account, context = schedulerContext(session)) {
  const state = session.hybrid;
  const dependencies = (scenario.dependsOn || []).map(id => state.scenarios.find(s => s.id === id));
  const waiting = dependencies.filter(s => !s || !terminal.has(s.status));
  const blocked = dependencies.filter(s => s && terminal.has(s.status) && s.status !== 'passed');
  const receipts = (scenario.evidenceRefs || []).map(id => context.evidence.get(id)).filter(context.intact);
  const unresolvedGaps = (scenario.executionGaps || []).filter(gap => {
    const old = context.evidence.get(gap.evidenceRef), prior = context.actions.get(old?.actionId);
    if (isSafetyExclusion(old, prior, gap, context, scenario)) return false;
    // Only a proved pre-dispatch refusal can be superseded by an exact matching
    // fresh check. Dispatched/uncertain mutations are never silently forgiven.
    return !receipts.some(next => matchingRecheck(old, prior, next, scenario.category, context));
  });
  const lastGapIndex = Math.max(-1, ...unresolvedGaps.map(g => context.indexes.get(g.evidenceRef) ?? -1));
  const investigations = scenario.investigations || [];
  const gapUrls = new Set(unresolvedGaps.map(g => context.evidence.get(g.evidenceRef)?.url || session.targetUrl));
  const fresh = state.evidence.filter((e, index) => index > lastGapIndex && context.intact(e) && e.success &&
    (state.discovery?.version === 1 && e.result?.inventory?.readiness?.ready === true || gapUrls.has(e.url || e.result?.url || e.result?.inventory?.url)) && e.result?.inventory?.readiness?.ready !== false &&
    ['browser_snapshot', 'browser_qa_check', 'browser_diagnostics'].includes(e.toolName) && !investigations.some(item => item.observationEvidenceId === e.id));
  const needsInvestigation = unresolvedGaps.length > 0;
  const prerequisite = (['content', 'visual_consistency', 'authentication'].includes(scenario.category) && !['request', 'specification'].includes(scenario.expected?.source)) || scenario.category.startsWith('security_');
  const verifiedBlocker = scenario.status === 'blocked' && (account.readinessBlocked || blocked.length > 0);
  const resolved = terminal.has(scenario.status) && (verifiedBlocker || !needsInvestigation && (account.attempted || account.absent || prerequisite && Boolean(scenario.uncertainty?.some(Boolean))));
  const base = state.scheduler?.maxInvestigations ?? 2;
  // New evidenced application states can justify a different bounded
  // strategy. Repeated snapshots of one state never extend the allowance.
  const firstIndex = investigations.length ? context.indexes.get(investigations[0].observationEvidenceId) ?? Infinity : Infinity;
  const firstState = context.evidence.get(investigations[0]?.observationEvidenceId)?.result?.inventory?.stateKey;
  const newStates = state.discovery?.version === 1 ? new Set(state.evidence.filter((e,i)=>i>firstIndex&&context.intact(e)&&e.success&&e.result?.inventory?.readiness?.ready===true).map(e=>e.result.inventory.stateKey).filter(key=>key&&key!==firstState)) : new Set();
  const max = base + Math.min(2, newStates.size);
  return {
    id: scenario.id, category: scenario.category, status: scenario.status,
    phase: resolved ? 'resolved' : waiting.length ? 'pending' : needsInvestigation && investigations.length >= max ? 'recovery_blocked' : scenario.status === 'running' ? 'running' : blocked.length ? 'blocked_dependency' : 'ready',
    resolved, attempted: account.attempted, absent: account.absent, prerequisite,
    waitingFor: waiting.map(s => s?.id || 'missing'), blockedBy: blocked.map(s => s.id),
    needsInvestigation, investigations: investigations.length, investigationLimit: max, canInvestigate: needsInvestigation && investigations.length < max,
    freshObservationIds: fresh.slice(-3).map(e => e.id), evidenceRefs: receipts.slice(-3).map(e => e.id)
  };
}

export function qaScenarioSchedule(session, accountFor) {
  const context = schedulerContext(session);
  const work = session.hybrid.scenarios.map(s => scenarioObligation(session, s, accountFor(session, s, {intactRecord: context.intact}), context));
  const ready = work.filter(s => !s.resolved && s.phase !== 'recovery_blocked' && !s.waitingFor.length && !s.blockedBy.length);
  ready.sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0) || Number(a.attempted) - Number(b.attempted) || a.investigations - b.investigations);
  return {
    version: 1, total: work.length, accounted: work.filter(s => s.resolved).length, attempted: work.filter(s => s.attempted).length,
    ready, waiting: work.filter(s => !s.resolved && s.waitingFor.length), recoveryBlocked: work.filter(s => s.phase === 'recovery_blocked'), dependencyBlocked: work.filter(s => !s.resolved && s.blockedBy.length),
    next: ready[0] || null, unresolved: work.filter(s => !s.resolved)
  };
}

export function validateScenarioDependencies(scenarios) {
  const byId = new Map(scenarios.map(s => [s.id, s])), visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('Scenario dependencies must not contain a cycle.');
    if (done.has(id)) return;
    const scenario = byId.get(id);
    if (!scenario) throw new Error('Scenario dependency does not exist.');
    visiting.add(id);
    for (const parent of scenario.dependsOn || []) visit(parent);
    visiting.delete(id); done.add(id);
  }
  for (const scenario of scenarios) visit(scenario.id);
}
