import { createHash, randomUUID } from 'node:crypto';
import { redact } from './secrets.js';
import { QA_STANDARD_TESTS } from './qaTestCatalog.js';
import { jevRequestedChecks } from './jevQaRunner.js';
import { jevDiagnosticCandidates } from './jevDiagnostics.js';
import { scenarioExecutionAccount } from './qaExecutionState.js';
import {scenarioObligation,validateScenarioDependencies,intactQaReceipt} from './qaScenarioScheduler.js';
import { requireApplicationDiscovery, observeApplication } from './qaApplicationDiscovery.js';

const text = (value, max = 1500) => String(value ?? '').slice(0, max);
export const digestEvidence = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const TERMINAL_SCENARIO_STATES = ['passed', 'failed', 'blocked', 'inconclusive', 'not_executed'];
export const diagnosticFailures = (result, url) => jevDiagnosticCandidates({ url }, result).filter(item => item.kind === 'console_exception' && !item.excludedReason).map(item => ({ key: item.key, actual: item.actual }));
const sourceText = session => [session.messages?.filter(item => item.role === 'user').map(item => item.text).join('\n'), JSON.stringify(session.testCaseSnapshot || {})].join('\n');

export function createQaScenarioLedger(session, { persist = async () => {}, now = Date.now } = {}) {
  const state = session.hybrid;
  if (!state || session.mode !== 'qa') throw new Error('A hybrid QA run is required.');
  state.scenarios ??= [];
  state.evidence ??= [];
  state.observations ??= [];
  state.actions ??= [];
  state.scope ??= jevRequestedChecks(session);
  const evidence = id => state.evidence.find(item => item.id === id && item.runId === session.id);
  const scenario = id => { const item = state.scenarios.find(item => item.id === id); if (!item) throw new Error('Unknown scenario ID.'); return item; };
  function observation(current, assertion, evidenceRef) {
    const key = digestEvidence([current.id, assertion.name, assertion.expected, assertion.actual]);
    const old = state.observations.find(item => item.key === key);
    if (old) { old.assertionId = assertion.id; if (!old.evidenceRefs.includes(evidenceRef)) old.evidenceRefs.push(evidenceRef); return old; }
    const item = { id: randomUUID(), key, scenarioId: current.id, assertionId: assertion.id, evidenceRefs: [evidenceRef], title: text(assertion.name), status: 'unresolved', ts: now() };
    state.observations.push(item); return item;
  }
  function addScenario(input, required = false) {
    if (!input.objective?.trim() || !state.scope.includes(input.category)) throw new Error('Scenario requires an objective and selected scope category.');
    const existing = state.scenarios.find(item => item.category === input.category && item.objective === text(input.objective) &&
      item.expected.text === text(input.expected?.text) && item.expected.source === (['request', 'specification'].includes(input.expected?.source) ? input.expected.source : 'hypothesis'));
    if (existing) return existing;
    if (state.scenarios.length >= 80) throw new Error('Scenario limit reached.');
    const item = { id: randomUUID(), category: input.category, required, objective: text(input.objective), expected: { text: text(input.expected?.text), source: ['request', 'specification', 'hypothesis'].includes(input.expected?.source) ? input.expected.source : 'hypothesis' },
      preconditions: (input.preconditions || []).slice(0, 10).map(value => text(value)), dependsOn:(input.depends_on||[]).slice(0,10), authorization: 'public_read_only',
      plannedActions: (input.plannedActions || []).slice(0, 20).map(value => text(value, 300)), executedActionIds: [], assertions: [], evidenceRefs: [], reproductionAttempts: [],
      status: 'planned', coverage: 'not_executed', uncertainty: [], createdAt: now(), updatedAt: now() };
    state.scenarios.push(item); return item;
  }
  if (!state.scenarios.length) for (const category of state.scope) addScenario({ category, objective: `Exercise selected ${category} scope`, expected: { source: 'hypothesis', text: 'Define a supported behavior and execute assertions.' } }, true);
  return {
    state, session, evidence, scenario,
    async plan(inputs) {
      const discovery = requireApplicationDiscovery(session);
      if (!Array.isArray(inputs) || inputs.length > 20) throw new Error('Provide at most 20 scenarios.');
      const previous=structuredClone(state.scenarios);
      try{
      for (const input of inputs) {
        const featureIds = input.feature_ids || (input.id && scenario(input.id).discoveryPlan?.featureIds);
        if (discovery.required && (!Array.isArray(featureIds) || !featureIds.length || featureIds.some(id => !discovery.features.some(f => f.id === id)))) throw new Error('Discovery-first planning requires actual observed feature_ids; unrelated generic or invented features cannot enter the execution plan. Keep missing explicitly selected scope as its original obligation.');
        if (input.id) {
          const item = scenario(input.id);
          if (item.status !== 'planned') throw new Error('Only planned scenarios can be revised.');
          if (input.category !== item.category) throw new Error('Required scope cannot be changed.');
          item.objective = text(input.objective); item.expected = { text: text(input.expected?.text), source: ['request', 'specification'].includes(input.expected?.source) ? input.expected.source : 'hypothesis' };
          item.preconditions = (input.preconditions || []).slice(0, 10).map(value => text(value));
          item.plannedActions = (input.plannedActions || []).slice(0, 20).map(value => text(value, 300));
          if(input.depends_on!==undefined)item.dependsOn=input.depends_on.slice(0,10);
        } else addScenario(input);
        if (discovery.required) {
          const item = input.id ? scenario(input.id) : state.scenarios.find(s => s.category === input.category && s.objective === text(input.objective));
          item.discoveryPlan = { ...item.discoveryPlan, authenticationContext: discovery.authenticationContext, featureIds: [...featureIds], featureTargets: discovery.features.filter(f=>featureIds.includes(f.id)).map(({id,name,kind,location,stateKey,controls})=>({id,name,kind,location,stateKey,controls})), evidenceRefs: [...new Set(discovery.features.filter(f => featureIds.includes(f.id)).flatMap(f => f.evidenceRefs))], applicability: 'observed', updatedAt: now() };
        }
      }
      validateScenarioDependencies(state.scenarios);
      }catch(error){state.scenarios=previous;throw error;}
      await persist(); return state.scenarios;
    },
    async start(id) {
      requireApplicationDiscovery(session);
      const item = scenario(id);
      if((item.dependsOn||[]).some(parent=>scenario(parent).status!=='passed'))throw new Error('Scenario dependencies must pass before execution. Resolve the parent outcome or record its evidenced blocker.');
      if (state.currentScenarioId && state.currentScenarioId !== id && scenario(state.currentScenarioId).status === 'running') throw new Error('Finish the active scenario before starting another.');
      if (item.status === 'running' && state.currentScenarioId === id) return item;
      if (!['planned', 'inconclusive', 'blocked', 'not_executed'].includes(item.status)) throw new Error('Scenario is not available to start.');
      if (state.actions.some(action => action.scenarioId === id && ['running', 'uncertain'].includes(action.status))) throw new Error('Scenario has an uncertain action; verify state before choosing a new investigation.');
      const account = scenarioExecutionAccount(session, item);
      if (item.status !== 'planned' && (account.attempted || account.absent)) throw new Error('This scenario already has an evidence-accounted outcome. Do not repeat the same check to turn a coverage gap into a pass. Continue remaining scenarios or publish; a distinct investigation needs its own validated scenario or fresh observed route.');
      item.status = 'running'; item.updatedAt = now(); state.currentScenarioId = id; await persist(); return item;
    },
    async investigate(id,observationId,strategyFeatureId){
      const item=scenario(id),account=scenarioExecutionAccount(session,item),obligation=scenarioObligation(session,item,account),receipt=evidence(observationId);
      if(!obligation.canInvestigate||!obligation.freshObservationIds.includes(observationId)||!intactQaReceipt(session,receipt))throw new Error('Investigation requires a fresh intact browser observation after the gap, and remaining bounded investigation attempts.');
      let strategyKey;
      if (state.discovery?.version === 1) {
        const status = requireApplicationDiscovery(session), feature = status.features.find(f => f.id === strategyFeatureId && f.stateKey === receipt.result?.inventory?.stateKey && f.location === receipt.url);
        if (!feature) throw new Error('Choose an evidenced strategy_feature_id on the fresh observed state; repeated inspection is not a different investigation strategy.');
        strategyKey = digestEvidence([feature.id, feature.stateKey]);
        if (item.investigations?.some(i => i.strategyKey === strategyKey)) throw new Error('This feature strategy was already investigated. Choose a materially different evidenced control or record the genuine blocker.');
      }
      if(state.currentScenarioId&&state.currentScenarioId!==id||state.recovery?.verificationRequired||state.actions.some(a=>['running','uncertain'].includes(a.status)))throw new Error('Verify action state and release browser ownership before investigating. Uncertain mutations cannot be replayed.');
      item.investigations??=[];item.investigations.push({observationEvidenceId:observationId,...(strategyKey?{strategyKey,strategyFeatureId}:{}),assertionOffset:item.assertions.length,actionOffset:item.executedActionIds.length,startedAt:now()});
      item.status='running';state.currentScenarioId=id;item.updatedAt=now();await persist();return item;
    },
    // Host-only suite continuation, never exposed as a model tool. A new,
    // observed route is a distinct execution, not a replay of an old action.
    async startRoute(id, url) {
      requireApplicationDiscovery(session);
      const item = scenario(id);
      if (state.exploration?.version !== 2 || !state.exploration.routes.some(route => route.url === url && route.status === 'running') ||
          new URL(url).origin !== new URL(session.targetUrl).origin || state.budgetFinalizing || state.recovery?.verificationRequired ||
          state.currentScenarioId || state.actions.some(action => action.scenarioId === id && ['running', 'uncertain'].includes(action.status))) throw new Error('Suite continuation requires a fresh owned observed route and verified state.');
      item.routeRuns ??= [];
      const route = state.exploration.routes.find(route => route.url === url && route.status === 'running');
      const authenticationContext = route.authenticationContext || 'public', featureId = route.kind === 'feature' ? route.id : undefined;
      if (item.routeRuns.some(run => run.url === url && run.featureId === featureId && (run.authenticationContext || 'public') === authenticationContext)) return null;
      item.routeRuns.push({ url, authenticationContext, ...(featureId ? { featureId, feature: route.label } : {}), status: 'running', assertionOffset: item.assertions.length, actionOffset: item.executedActionIds.length, startedAt: now() });
      item.status = 'running'; item.updatedAt = now(); state.currentScenarioId = id; await persist(); return item;
    },
    async close(id, disposition, reason) {
      const item = scenario(id);
      if (!['complete', 'blocked', 'inconclusive', 'not_executed'].includes(disposition)) throw new Error('Unknown disposition.');
      const investigation=item.investigations?.at(-1);
      if(investigation&&!investigation.completedAt&&!state.budgetFinalizing&&!item.assertions.slice(investigation.assertionOffset).length&&!item.executedActionIds.slice(investigation.actionOffset).some(id=>{const a=state.actions.find(a=>a.id===id);return a?.toolName==='browser_diagnostics'||a?.toolName==='browser_qa_check'&&!['inspect','scroll','dismiss_overlay'].includes(a.input?.action);}))throw new Error('Investigation requires an actual new check; a fresh snapshot alone is not a completed investigation.');
      if (disposition !== 'complete' && ['content', 'visual_consistency'].includes(item.category) && !['request', 'specification'].includes(item.expected.source)) {
        disposition = 'blocked';
        reason = `${item.category === 'content' ? 'Approved expected copy/content assertions' : 'An approved visual/design reference and comparison criteria'} are required; observed page content is not its own correctness oracle. ${reason || ''}`;
      }
      if (!item.routeRuns?.some(run => run.status === 'running') && ['passed', 'failed'].includes(item.status)) throw new Error('A completed category suite cannot be relabeled; a fresh observed route execution is required.');
      const account = scenarioExecutionAccount(session, item);
      const dependencyBlocked=(item.dependsOn||[]).some(id=>TERMINAL_SCENARIO_STATES.includes(scenario(id).status)&&scenario(id).status!=='passed');
      if (disposition !== 'complete' && state.exploration?.version === 2 && !state.budgetFinalizing && account.supported && !account.attempted && !account.absent && !(disposition === 'blocked' && (account.readinessBlocked||dependencyBlocked))) throw new Error('Selected supported checks require an actual attempt or intact host absence evidence. Start this scenario and execute its matching fixed check; a prose disposition cannot complete it. A host-verified loading failure can only be closed as blocked.');
      const supported = ['navigation', 'responsive', 'forms', 'search', 'media', 'accessibility', 'console_health', 'broken_links'];
      const sampled = state.exploration?.routes.filter(route => route.status === 'tested') || [];
      const absentOnSample = sampled.length && sampled.every(route => route.absentChecks?.some(check => {
        const observed = evidence(check.evidenceId);
        return check.category === item.category && observed?.success && observed.digest === digestEvidence(observed.result) && observed.result.inventory;
      }));
      if (disposition !== 'complete' && !state.budgetFinalizing && supported.includes(item.category) && state.exploration?.routes.some(route => route.status === 'tested') &&
          !(disposition==='blocked'&&dependencyBlocked) && !absentOnSample && !state.scenarios.some(other => other.category === item.category && other.executedActionIds.length)) throw new Error('Selected supported checks require an actual attempt. Use qa_test_routes with the selected checks; a prose skip reason alone is not execution evidence.');
      if (disposition === 'complete') {
        const routeRun = item.routeRuns?.findLast(run => run.status === 'running');
        if (item.status !== 'running' || !item.assertions.length || (routeRun && item.assertions.length <= routeRun.assertionOffset)) throw new Error('Scenario has no new executed host assertions.');
        item.status = item.assertions.some(assertion => assertion.outcome === 'fail') ? 'failed' : !item.routeRuns?.length && item.executionGaps?.some(gap=>!gap.resolvedBy) ? 'inconclusive' : 'passed';
      } else { if (!reason?.trim()) throw new Error('A concrete gap reason is required.'); item.status = disposition; item.uncertainty.push(text(reason)); }
      const run = item.routeRuns?.findLast(run => run.status === 'running');
      if (run) {
        const assertions = item.assertions.slice(run.assertionOffset);
        if (disposition === 'complete' && !assertions.length) throw new Error('This route has no new executed host assertions.');
        const actionIds = item.executedActionIds.slice(run.actionOffset);
        const gaps = (item.executionGaps || []).filter(gap => actionIds.includes(gap.actionId));
        run.status = disposition === 'complete' ? assertions.some(a => a.outcome === 'fail') ? 'failed' : gaps.length ? 'inconclusive' : 'passed' : disposition;
        if (gaps.length) run.gaps = gaps.map(gap => gap.reason);
        run.assertionCounts = { passed: assertions.filter(a => a.outcome === 'pass').length, failed: assertions.filter(a => a.outcome === 'fail').length };
        run.evidenceRefs = [...new Set(assertions.map(a => a.evidenceRef))]; run.reason = ['passed', 'failed'].includes(run.status) ? undefined : gaps.length ? gaps.map(gap => gap.reason).join(' ') : reason; run.completedAt = now();
        // A later successful page cannot erase an earlier failure or gap.
        item.status = item.assertions.some(a => a.outcome === 'fail') ? 'failed' : item.routeRuns.some(r => r.status === 'passed') ? 'passed' : run.status;
      }
      item.coverage = item.status === 'passed' || item.status === 'failed' ? 'executed' : item.status;
      if(investigation&&!investigation.completedAt){
        investigation.completedAt=now();investigation.outcome=item.status;
      }
      item.updatedAt = now(); if (state.currentScenarioId === id) state.currentScenarioId = undefined;
      await persist(); return item;
    },
    async beginAction(toolName, input) {
      if (state.actions.length >= 1200) throw new Error('Action ledger limit reached.');
      const action = redact(session.id, { id: randomUUID(), toolName, input, scenarioId: state.currentScenarioId, status: 'running', ts: now() });
      state.actions.push(action);
      if (action.scenarioId) scenario(action.scenarioId).executedActionIds.push(action.id);
      await persist(); return action;
    },
    async record(action, result) {
      const clean = redact(session.id, result);
      const item = { id: randomUUID(), runId: session.id, actionId: action.id, toolName: action.toolName, scenarioId: action.scenarioId, ts: now(),
        digest: digestEvidence(clean), success: clean?.success !== false, url: clean?.url || clean?.inventory?.url, result: clean };
      if (state.evidence.length >= 1200) throw new Error('Evidence ledger limit reached.');
      state.evidence.push(item); action.status = item.success ? 'done' : 'failed'; action.evidenceId = item.id; action.completedAt = now();
      observeApplication(session, item);
      const current = action.scenarioId && scenario(action.scenarioId);
      if (current) {
        current.evidenceRefs.push(item.id);
        if(item.success&&action.toolName==='browser_qa_check'&&!clean.gaps?.length&&clean.assertions?.some(a=>a.check===current.category))for(const gap of current.executionGaps||[]){
          const old=evidence(gap.evidenceRef),prior=state.actions.find(a=>a.id===old?.actionId);
          if(old?.result?.dispatched===false&&prior?.input?.action===action.input?.action&&prior?.input?.selector===action.input?.selector)gap.resolvedBy=item.id;
        }
        // Tool/readiness failures are unresolved execution observations, not
        // target bugs. Persist them even when useful partial assertions exist.
        // A typed stale-control refusal happened before any target action.
        // Keep its failed tool receipt, but it is not an executed test gap or
        // an uncertain mutation. A later real check is still mandatory.
        const staleBeforeDispatch = clean.code === 'QA_CONTROL_STALE' && clean.dispatched === false;
        if (action.toolName === 'browser_qa_check' && !staleBeforeDispatch) for (const gap of [...(Array.isArray(clean.gaps) ? clean.gaps : []), ...(clean.success === false ? [clean.error || 'The browser check did not complete.'] : [])].slice(0, 12)) {
          current.executionGaps ??= [];
          current.executionGaps.push({ actionId: action.id, evidenceRef: item.id, reason: text(gap) });
          const key = digestEvidence([current.id, action.input.action, item.url, String(gap)]);
          if (!state.observations.some(value => value.key === key)) state.observations.push({ id: randomUUID(), key, kind: 'execution_gap', scenarioId: current.id, evidenceRefs: [item.id],
            title: text(`${action.input.action}: incomplete execution`), detail: text(gap), status: 'unresolved', ts: now() });
        }
        // Only fixed browser checks supply trusted assertion/reproduction data.
        if (action.toolName === 'browser_qa_check' && item.success) for (const assertion of clean.assertions || []) {
          if (!['pass', 'fail'].includes(assertion.outcome)) continue;
          if (assertion.check !== current.category) continue;
          const saved = { id: randomUUID(), ...assertion, authority: 'host_browser_check', evidenceRef: item.id, actionId: action.id, ts: now() };
          current.assertions.push(saved);
          if (assertion.reproduction) current.reproductionAttempts.push({ assertionId: saved.id, ...assertion.reproduction });
          if (assertion.outcome === 'fail') observation(current, saved, item.id);
        }
      }
      await persist(); return item;
    },
    async adoptHostAssertions(scenarioId, evidenceId) {
      const current = scenario(scenarioId), record = evidence(evidenceId), action = state.actions.find(item => item.id === record?.actionId);
      if (current.status !== 'running' || !state.scope.includes(current.category) || !record?.success || record.toolName !== 'browser_qa_check' || record.digest !== digestEvidence(record.result) || action?.status !== 'done') throw new Error('Shared assertions require an active scoped scenario and intact executed fixed browser evidence.');
      if (!current.executedActionIds.includes(action.id)) current.executedActionIds.push(action.id);
      if (!current.evidenceRefs.includes(record.id)) current.evidenceRefs.push(record.id);
      for (const assertion of record.result.assertions || []) {
        if (assertion.check !== current.category || !['pass', 'fail'].includes(assertion.outcome)) continue;
        const saved = { ...assertion, id: randomUUID(), authority: 'host_browser_check', evidenceRef: record.id, actionId: action.id, ts: now(), sharedEvidence: true };
        current.assertions.push(saved);
        if (assertion.reproduction) current.reproductionAttempts.push({ assertionId: saved.id, ...assertion.reproduction });
        if (assertion.outcome === 'fail') observation(current, saved, record.id);
      }
      await persist(); return current;
    },
    async assertSnapshot({ scenarioId, evidenceId, predicate, expected }) {
      const current = scenario(scenarioId), observed = evidence(evidenceId);
      if (!['navigation', 'content'].includes(current.category)) throw new Error('Snapshot text/title/URL predicates cannot establish this selected workflow.');
      if (current.status !== 'running' || !observed?.success || observed.scenarioId !== current.id || observed.toolName !== 'browser_snapshot') throw new Error('An executed snapshot from this running scenario is required.');
      if (!['request', 'specification'].includes(current.expected.source) || !current.expected.text || !sourceText(session).includes(current.expected.text) || !String(expected).trim() || !current.expected.text.includes(String(expected))) throw new Error('Snapshot expectations must be quoted from the authorized request or test specification.');
      const facts = observed.result;
      let pass;
      if (predicate === 'text_contains') pass = String(facts.bodyText || '').includes(expected);
      else if (predicate === 'url_equals') pass = facts.url === expected;
      else if (predicate === 'title_equals') pass = facts.title === expected;
      else throw new Error('Unknown snapshot predicate.');
      const assertion = { id: randomUUID(), name: `Snapshot ${predicate}`, expected, actual: text(predicate === 'text_contains' ? facts.bodyText : predicate === 'url_equals' ? facts.url : facts.title), outcome: pass ? 'pass' : 'fail', authority: 'request_assertion', evidenceRef: observed.id, actionId: observed.actionId, ts: now() };
      const repeated = current.assertions.find(item => item.name === assertion.name && item.expected === expected && item.outcome === assertion.outcome && item.evidenceRef !== observed.id && evidence(item.evidenceRef)?.actionId !== observed.actionId);
      if (repeated) assertion.reproduction = { confirmed: true, observations: 2, kind: 'request_assertion', firstEvidenceRef: repeated.evidenceRef, secondEvidenceRef: observed.id };
      current.assertions.push(assertion);
      if (!pass) observation(current, assertion, observed.id);
      await persist(); return assertion;
    },
    async assertDiagnostics({ scenarioId, evidenceId }) {
      const current = scenario(scenarioId), observed = evidence(evidenceId);
      if (current.status !== 'running' || current.category !== 'console_health' || !observed?.success || observed.scenarioId !== current.id || observed.toolName !== 'browser_diagnostics' || !Array.isArray(observed.result.console)) throw new Error('Console-health assertions require diagnostics from this active scoped scenario.');
      const failures = diagnosticFailures(observed.result, observed.url || session.targetUrl);
      const actual = JSON.stringify(failures);
      const assertion = { id: randomUUID(), check: 'console_health', name: 'No uncaught exceptions in the recorded diagnostic window', expected: 'No uncaught browser exceptions', actual, outcome: failures.length ? 'fail' : 'pass', authority: 'host_diagnostic', evidenceRef: observed.id, actionId: observed.actionId, ts: now() };
      const repeated = current.assertions.find(item => item.authority === 'host_diagnostic' && item.actual === actual && item.outcome === 'fail' && item.evidenceRef !== observed.id && state.actions.some((action, index) => action.toolName === 'browser_open' && action.status === 'done' && index > state.actions.findIndex(old => old.id === item.actionId) && index < state.actions.findIndex(latest => latest.id === observed.actionId)));
      if (repeated) assertion.reproduction = { confirmed: true, observations: 2, kind: 'host_diagnostic', firstEvidenceRef: repeated.evidenceRef, secondEvidenceRef: observed.id };
      current.assertions.push(assertion); if (failures.length) observation(current, assertion, observed.id);
      await persist(); return assertion;
    }
  };
}
