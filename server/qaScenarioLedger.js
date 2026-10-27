import { createHash, randomUUID } from 'node:crypto';
import { redact } from './secrets.js';
import { QA_STANDARD_TESTS } from './qaTestCatalog.js';
import { jevRequestedChecks } from './jevQaRunner.js';
import { jevDiagnosticCandidates } from './jevDiagnostics.js';

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
      preconditions: (input.preconditions || []).slice(0, 10).map(value => text(value)), authorization: 'public_read_only',
      plannedActions: (input.plannedActions || []).slice(0, 20).map(value => text(value, 300)), executedActionIds: [], assertions: [], evidenceRefs: [], reproductionAttempts: [],
      status: 'planned', coverage: 'not_executed', uncertainty: [], createdAt: now(), updatedAt: now() };
    state.scenarios.push(item); return item;
  }
  if (!state.scenarios.length) for (const category of state.scope) addScenario({ category, objective: `Exercise selected ${category} scope`, expected: { source: 'hypothesis', text: 'Define a supported behavior and execute assertions.' } }, true);
  return {
    state, evidence, scenario,
    async plan(inputs) {
      if (!Array.isArray(inputs) || inputs.length > 20) throw new Error('Provide at most 20 scenarios.');
      for (const input of inputs) {
        if (input.id) {
          const item = scenario(input.id);
          if (item.status !== 'planned') throw new Error('Only planned scenarios can be revised.');
          if (input.category !== item.category) throw new Error('Required scope cannot be changed.');
          item.objective = text(input.objective); item.expected = { text: text(input.expected?.text), source: ['request', 'specification'].includes(input.expected?.source) ? input.expected.source : 'hypothesis' };
          item.preconditions = (input.preconditions || []).slice(0, 10).map(value => text(value));
          item.plannedActions = (input.plannedActions || []).slice(0, 20).map(value => text(value, 300));
        } else addScenario(input);
      }
      await persist(); return state.scenarios;
    },
    async start(id) {
      const item = scenario(id);
      if (state.currentScenarioId && state.currentScenarioId !== id && scenario(state.currentScenarioId).status === 'running') throw new Error('Finish the active scenario before starting another.');
      if (!['planned', 'inconclusive', 'blocked'].includes(item.status)) throw new Error('Scenario is not available to start.');
      item.status = 'running'; item.updatedAt = now(); state.currentScenarioId = id; await persist(); return item;
    },
    // Host-only suite continuation, never exposed as a model tool. A new,
    // observed route is a distinct execution, not a replay of an old action.
    async startRoute(id, url) {
      const item = scenario(id);
      if (state.exploration?.version !== 2 || !state.exploration.routes.some(route => route.url === url && route.status === 'running') ||
          new URL(url).origin !== new URL(session.targetUrl).origin || state.budgetFinalizing || state.recovery?.verificationRequired ||
          state.currentScenarioId || state.actions.some(action => action.scenarioId === id && ['running', 'uncertain'].includes(action.status))) throw new Error('Suite continuation requires a fresh owned observed route and verified state.');
      item.routeRuns ??= [];
      if (item.routeRuns.some(run => run.url === url)) return null;
      item.routeRuns.push({ url, status: 'running', assertionOffset: item.assertions.length, actionOffset: item.executedActionIds.length, startedAt: now() });
      item.status = 'running'; item.updatedAt = now(); state.currentScenarioId = id; await persist(); return item;
    },
    async close(id, disposition, reason) {
      const item = scenario(id);
      if (!['complete', 'blocked', 'inconclusive', 'not_executed'].includes(disposition)) throw new Error('Unknown disposition.');
      if (disposition !== 'complete' && ['content', 'visual_consistency'].includes(item.category) && !['request', 'specification'].includes(item.expected.source)) {
        disposition = 'blocked';
        reason = `${item.category === 'content' ? 'Approved expected copy/content assertions' : 'An approved visual/design reference and comparison criteria'} are required; observed page content is not its own correctness oracle. ${reason || ''}`;
      }
      if (item.routeRuns?.length && !item.routeRuns.some(run => run.status === 'running') && ['passed', 'failed'].includes(item.status)) throw new Error('A completed category suite cannot be relabeled; a fresh observed route execution is required.');
      const supported = ['navigation', 'responsive', 'forms', 'search', 'media', 'accessibility', 'console_health', 'broken_links'];
      const sampled = state.exploration?.routes.filter(route => route.status === 'tested') || [];
      const absentOnSample = sampled.length && sampled.every(route => route.absentChecks?.some(check => {
        const observed = evidence(check.evidenceId);
        return check.category === item.category && observed?.success && observed.digest === digestEvidence(observed.result) && observed.result.inventory;
      }));
      if (disposition !== 'complete' && !state.budgetFinalizing && supported.includes(item.category) && state.exploration?.routes.some(route => route.status === 'tested') &&
          !absentOnSample && !state.scenarios.some(other => other.category === item.category && other.executedActionIds.length)) throw new Error('Selected supported checks require an actual attempt. Use qa_test_routes with the selected checks; a prose skip reason alone is not execution evidence.');
      if (disposition === 'complete') {
        const routeRun = item.routeRuns?.findLast(run => run.status === 'running');
        if (item.status !== 'running' || !item.assertions.length || (routeRun && item.assertions.length <= routeRun.assertionOffset)) throw new Error('Scenario has no new executed host assertions.');
        item.status = item.assertions.some(assertion => assertion.outcome === 'fail') ? 'failed' : !item.routeRuns?.length && item.executionGaps?.length ? 'inconclusive' : 'passed';
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
      const current = action.scenarioId && scenario(action.scenarioId);
      if (current) {
        current.evidenceRefs.push(item.id);
        // Tool/readiness failures are unresolved execution observations, not
        // target bugs. Persist them even when useful partial assertions exist.
        if (action.toolName === 'browser_qa_check') for (const gap of [...(Array.isArray(clean.gaps) ? clean.gaps : []), ...(clean.success === false ? [clean.error || 'The browser check did not complete.'] : [])].slice(0, 12)) {
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
