import { createHash } from 'node:crypto';
import { HYBRID_ROUTE_CHECKS, hybridRoutePolicy } from './hybridRoutePolicy.js';
import { hasConfirmedAccess } from './hybridAuth.js';
import { observedCheckPresence } from './qaInventoryCoverage.js';
import {qaScenarioSchedule} from './qaScenarioScheduler.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actions = { navigation: ['navigation', 'navigation_control', 'open_test_form', 'tabs', 'disclosure', 'anchors'], broken_links: ['navigation', 'anchors'], responsive: ['responsive'], forms: ['forms', 'submit_test_form'], search: ['search'], media: ['media'], accessibility: ['accessibility'], console_health: [] };
export const fixedCheckCategory = action => Object.keys(actions).find(category => category !== 'broken_links' && actions[category].includes(action));

/** Only intact host receipts discharge an execution obligation. A model's
 * terminal disposition, prose explanation or JEV opinion never does. */
export function scenarioExecutionAccount(session, scenario, {intactRecord} = {}) {
  const state = session.hybrid;
  const access = hasConfirmedAccess(state) ? state.authentication.grantId : 'public';
  const intact = intactRecord || (record => record && record.runId === session.id && record.digest === digest(record.result) && (record.authenticationContext || 'public') === access);
  const attempted = (scenario.assertions || []).some(assertion => ['request_assertion', 'host_browser_check', 'host_diagnostic'].includes(assertion.authority) && intact(state.evidence.find(record => record.id === assertion.evidenceRef))) || (state.actions || []).some(action => {
    if (!(action.scenarioId === scenario.id || scenario.evidenceRefs?.includes(action.evidenceId)) || !['done', 'failed'].includes(action.status)) return false;
    const receipt = state.evidence.find(record => record.id === action.evidenceId && record.actionId === action.id);
    return intact(receipt) && receipt.result?.dispatched !== false && (receipt.success||receipt.result?.dispatched===true) && (scenario.category === 'console_health' ? action.toolName === 'browser_diagnostics' : action.toolName === 'browser_qa_check' && actions[scenario.category]?.includes(action.input?.action));
  });
  const sampled = (state.exploration?.routes || []).filter(route => route.status === 'tested' && (route.authenticationContext || 'public') === access);
  const absent = sampled.length > 0 && sampled.every(route => route.absentChecks?.some(check => {
    const record = state.evidence.find(record => record.id === check.evidenceId), inventory = record?.result?.inventory;
    if (check.category !== scenario.category || !intact(record) || !record.success || !inventory || inventory.readiness?.ready === false) return false;
    if (observedCheckPresence(inventory, scenario.category) !== false) return false;
    // Later same-page discovery invalidates stale absence even if it is a
    // sidebar/state with no separate URL. Require a check, not a model claim.
    const later = state.evidence.slice(state.evidence.indexOf(record) + 1);
    return !later.some(next => intact(next) && next.success && next.result?.inventory?.url === inventory.url && observedCheckPresence(next.result.inventory, scenario.category) === true);
  }));
  const latestInventory = state.evidence.findLast(record => intact(record) && record.result?.inventory);
  const readinessBlocked = latestInventory?.result?.inventory?.readiness?.ready === false && state.evidence.some(record =>
    intact(record) && record.scenarioId === scenario.id && record.result?.code === 'QA_PAGE_NOT_READY' && record.result?.dispatched === false && record.result?.inventory?.readiness?.ready === false);
  return { attempted, absent, readinessBlocked, supported: HYBRID_ROUTE_CHECKS.includes(scenario.category) };
}

export function remainingHybridWork(session) {
  const state = session.hybrid;
  if(state.scheduler){const schedule=qaScenarioSchedule(session,scenarioExecutionAccount);return {scenarios:schedule.unresolved.map(({id,category,status,needsInvestigation})=>({id,category,status,needsInvestigation})),routesPending:hybridRoutePolicy(state).canExplore};}
  const scenarios = (state.scenarios || []).filter(scenario => {
    const account = scenarioExecutionAccount(session, scenario);
    return ['planned', 'running'].includes(scenario.status) || account.supported && !account.attempted && !account.absent && !(scenario.status === 'blocked' && account.readinessBlocked);
  }).map(({ id, category, status }) => ({ id, category, status }));
  return { scenarios, routesPending: hybridRoutePolicy(state).canExplore };
}

// Deliberately excludes model text, tool errors, repeated dispositions and
// timestamps. Those must not buy an unlimited series of extra SDK segments.
export function executionProgress(state) {
  if(state.scheduler)return digest({assertions:state.scenarios.map(s=>[s.id,[...new Set(s.assertions.map(a=>digest([a.name,a.expected,a.actual,a.outcome])))],(s.investigations||[]).map(i=>[i.observationEvidenceId,i.completedAt?true:false])]),routes:(state.exploration?.routes||[]).map(r=>[r.id,r.status]),outcomes:state.scenarios.map(s=>[s.id,s.status])});
  return digest({ evidence: [...new Set(state.evidence.map(record => JSON.stringify([record.toolName, record.scenarioId, record.digest])))],
    outcomes: state.scenarios.map(scenario => [scenario.id, scenario.status, scenario.assertions.length]),
    routes: (state.exploration?.routes || []).map(route => [route.id, route.status]) });
}

export function recordHybridSegment(session, before) {
  const state = session.hybrid;
  const progress = executionProgress(state), changed = before !== progress;
  const previous = state.sdkContinuation || {};
  state.sdkContinuation = { segments: (previous.segments || 0) + 1, stagnantSegments: changed ? 0 : (previous.stagnantSegments || 0) + 1,
    progress, updatedAt: Date.now(), remaining: remainingHybridWork(session) };
  return { continue: state.sdkContinuation.stagnantSegments < 3, ...state.sdkContinuation };
}
