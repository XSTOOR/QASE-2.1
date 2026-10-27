import { createQaScenarioLedger, digestEvidence, diagnosticFailures } from './qaScenarioLedger.js';
import { createHybridTelemetry } from './hybridTelemetry.js';
import { createHybridModelRouter, HybridPause } from './hybridModelRouter.js';
import { createJevClassificationTools } from './jevClassificationTools.js';
import { createHybridQaTools } from './hybridQaTools.js';
import { profileIdentity } from './hybridConfig.js';
import { hybridCompletion } from './qaCompletionGate.js';
import { redact } from './secrets.js';
import { hybridHostContext, projectHybridMessages, prepareHybridInference } from './hybridContext.js';
import { assertionSummary, scenarioSummary } from './hybridSummaries.js';
import { createHybridRouteExecution } from './hybridRouteExecution.js';
import { checkPrimaryViewport } from './qaViewport.js';
import { hybridRecoveryProblem } from './hybridRecoveryGate.js';
import { hybridRoutePolicy } from './hybridRoutePolicy.js';
import { observeHybridAuthentication, needsHybridAuthQuestion } from './hybridAuth.js';

const discovery = new Set(['browser_authenticate', 'browser_open', 'browser_snapshot', 'browser_get_url', 'browser_screenshot', 'browser_diagnostics', 'browser_tabs']);
const forbidden = new Set(['security_check', 'browser_dialog', 'browser_media', 'browser_test_meeting_link']);
const mutates = name => name.startsWith('browser_') && !['browser_snapshot', 'browser_get_url', 'browser_screenshot', 'browser_diagnostics', 'browser_tabs', 'browser_wait'].includes(name);

export async function hybridRegressionSuggestions(session, runStore) {
  if (!session.ownerUserId || !session.targetUrl || typeof runStore.list !== 'function' || typeof runStore.get !== 'function') return [];
  const suggestions = [];
  try {
    for (const summary of (await runStore.list()).filter(item => item.id !== session.id && item.mode === 'qa').slice(0, 20)) {
      const prior = await runStore.get(summary.id);
      if (!prior || prior.ownerUserId !== session.ownerUserId || !prior.targetUrl || new URL(prior.targetUrl).origin !== new URL(session.targetUrl).origin) continue;
      for (const finding of prior.findings || []) {
        suggestions.push(redact(session.id, { sourceRunId: prior.id, findingId: finding.id, category: finding.category === 'layout' ? 'responsive' : finding.category, title: String(finding.title || '').slice(0, 200), observedAt: finding.ts, authority: 'historical_hint_only' }));
        if (suggestions.length >= 10) return suggestions;
      }
    }
  } catch { /* Historical hints are optional, never a reason to fabricate coverage. */ }
  return suggestions;
}

export function initializeHybridState(session, profile) {
  if (session.mode !== 'qa' || session.qaExecutionMode !== 'hybrid') throw new Error('Hybrid is available only for explicitly selected QA runs.');
  const identity = profileIdentity(profile);
  if (session.hybrid && session.hybrid.profileIdentity !== identity) throw new Error('Hybrid model/key identity changed. Requalify and create a new run; an in-progress run cannot switch models.');
  session.hybrid ??= { version: 1, profileIdentity: identity, sdkVersion: profile.sdkVersion,
    reasoner: { model: profile.reasoner.model, endpoint: profile.reasoner.endpoint }, classifier: { model: profile.classifier.model, endpoint: profile.classifier.endpoint },
    budgets: structuredClone(profile.budgets), allowWithoutClassifier: profile.allowWithoutClassifier, status: 'ready', createdAt: Date.now() };
  // Budgets and degradation policy are pinned to the run, not changed by env on resume.
  profile.budgets = structuredClone(session.hybrid.budgets);
  profile.allowWithoutClassifier = session.hybrid.allowWithoutClassifier;
  return session.hybrid;
}

export function publicHybridState(session) {
  const state = session.hybrid;
  if (!state) return undefined;
  let completion;
  try { completion = hybridCompletion(session); } catch { /* report malformed states as pending verification */ }
  const inputTrials = (state.evidence || []).map(item => item.result?.formTesting).filter(item => item?.mode === 'live_non_submitting');
  const problem = hybridRecoveryProblem(session);
  const depth = hybridRoutePolicy(state);
  const recovery = { ...state.recovery, ...(problem ? { resumeBlockedReason: problem.reason } : {}) };
  return { version: state.version, status: state.status, reasoner: state.reasoner, classifier: state.classifier,
    authentication: state.authentication ? { status: state.authentication.status, required: state.authentication.required, origin: state.authentication.origin, attemptedAt: state.authentication.attemptedAt } : undefined,
    currentScenarioId: state.currentScenarioId, viewport: state.viewport, counts: completion?.counts, coverage: completion?.coverage || 0,
    confirmedDefects: completion?.confirmedDefects || 0, unresolved: completion?.unresolved || 0,
    unresolvedObservations: completion?.unresolvedObservations || [],
    inputTesting: { fieldsFilled: inputTrials.reduce((sum, item) => sum + item.fieldsFilled, 0), casesExecuted: inputTrials.reduce((sum, item) => sum + item.casesExecuted, 0), negativeCases: inputTrials.reduce((sum, item) => sum + item.negativeCases, 0), submissionExecuted: false },
    gaps: completion?.gaps || [], telemetry: state.telemetry, budgets: state.budgets, exploration: state.exploration ? { version: state.exploration.version, observed: depth.observed, tested: depth.tested, pending: depth.pending,
      attempted: depth.attempted, target: depth.target, remainingSlots: depth.remainingSlots, canExplore: depth.canExplore, stopReason: depth.stopReason, publicationAllowed: depth.publicationAllowed,
      interactions: { attempted: state.exploration.interactions?.length || 0, executed: state.exploration.interactions?.filter(item => item.status === 'executed').length || 0 } } : undefined, budgetFinalizing: Boolean(state.budgetFinalizing), pauseReason: state.pauseReason, recovery,
    scenarios: (state.scenarios || []).map(item => ({ id: item.id, objective: item.objective, category: item.category, routeUrl: item.routeUrl, status: item.status, uncertainty: item.uncertainty, assertions: item.assertions.length, routeCounts: scenarioSummary(item).routeCounts })) };
}

export function createHybridRuntime({ session, runStore, profile, record, onUsage, fetchImpl }) {
  const state = initializeHybridState(session, profile);
  const telemetry = createHybridTelemetry(state);
  let commits = Promise.resolve();
  const checkpoint = () => {
    telemetry.tick(); state.updatedAt = Date.now();
    const work = async () => {
      try { return await runStore.commit(session, 'hybrid.state', { hybrid: publicHybridState(session) }); }
      catch { record.hybridPause = new HybridPause('HYBRID_PERSISTENCE', 'Progress could not be persisted. Execution paused before further actions.'); state.status = 'paused'; state.pauseReason = record.hybridPause.message; throw record.hybridPause; }
    };
    const next = commits.then(work); commits = next.catch(() => {}); return next;
  };
  const ledger = createQaScenarioLedger(session, { persist: checkpoint });
  const router = createHybridModelRouter({ session, profile, telemetry, checkpoint, onUsage, fetchImpl });
  let browserTail = Promise.resolve();
  let browserOperationActive = false;
  let signal;
  let modelTimer;
  state.repeatActions ??= [];
  const tools = [...createHybridQaTools(ledger, checkpoint), ...createJevClassificationTools({ session, ledger, router, checkpoint, profile, telemetry })];
  const routes = createHybridRouteExecution({ session, ledger, checkpoint, router, telemetry, invoke: (...args) => record.invokeHybridTool(...args) });
  tools.push(...routes.tools);
  let catalog = [];
  let modelToolsReady = Promise.resolve(true);
  tools.push({ name: 'qa_load_tools', category: 'qa', description: 'Expose extra approved SDK tools for a specific investigation. This grants no new permissions. Empty names lists the available approved tools.',
    parametersSchema: { type: 'object', additionalProperties: false, properties: { names: { type: 'array', maxItems: 12, items: { type: 'string' } } } },
    async run(input = {}) {
      const names = input.names || [];
      if (!Array.isArray(names) || names.length > 12 || names.some(name => !catalog.includes(name))) throw new Error('Only existing approved tools can be loaded.');
      state.extraModelTools = [...new Set([...(state.extraModelTools || []), ...names])].slice(-20); await checkpoint();
      return { success: true, enabled: state.extraModelTools, available: catalog };
    } });

  return {
    ledger, router, telemetry, checkpoint, tools,
    registerToolCatalog(names) { catalog = names.filter(name => !forbidden.has(name)); },
    async awaitToolDispatch(abortSignal) {
      abortSignal?.throwIfAborted();
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(abortSignal.reason);
        abortSignal?.addEventListener('abort', abort, { once: true });
      });
      try {
        const allowed = await Promise.race([modelToolsReady, cancelled]);
        abortSignal?.throwIfAborted();
        if (!allowed) throw new Error('The complete verified model tool batch was not received; no tool may dispatch.');
      } finally { abortSignal?.removeEventListener('abort', abort); }
    },
    allows: name => !forbidden.has(name),
    context(liveUrl) { return hybridHostContext(session, liveUrl); },
    wrapChat(service) {
      const original = service.chat.bind(service);
      service.chat = async (messages, options) => {
        let release;
        modelToolsReady = new Promise(resolve => { release = resolve; });
        try {
        const clean = redact(session.id, messages);
        const page = record.bridge?.service?.activePage;
        const liveUrl = page && !page.isClosed() ? page.url() : record.bridge?.saved?.url;
        const projected = projectHybridMessages(clean, session, redact(session.id, hybridHostContext(session, liveUrl)));
        const prepared = prepareHybridInference(projected, options, session);
        if (prepared.closing && !state.budgetFinalizing) { state.budgetFinalizing = true; state.status = 'finalizing_budget'; telemetry.event('budget_closeout_started'); }
        telemetry.event('model_context_projected', { originalBytes: Buffer.byteLength(JSON.stringify(clean)), projectedBytes: Buffer.byteLength(JSON.stringify(prepared.messages)), messages: prepared.messages.length });
        const source = await router.reasoner(original, prepared.messages, prepared.options);
        return (async function* () {
          let complete = false;
          try { for await (const part of source) yield part; complete = true; }
          finally { release(complete); }
        })();
        } catch (error) { release(false); throw error; }
      };
    },
    wrapTool(tool) {
      if (!tool.name.startsWith('browser_')) return { ...tool, async run(input, context) {
        try {
          signal?.throwIfAborted(); router.check();
          if (!routes.access()) throw new Error('An approved route batch owns the browser/scenario lifecycle; wait for its result.');
          if (state.budgetFinalizing && !['qa_close_scenario', 'update_todo', 'report_finding', 'finish_qa_report'].includes(tool.name)) throw new Error('Budget closeout permits only scenario dispositions, evidenced findings, todo dispositions and final report publication.');
          if (browserOperationActive && ['qa_start_scenario', 'qa_close_scenario'].includes(tool.name)) throw new Error('Wait for the active browser operation before changing scenario ownership.');
          return await tool.run(input, context);
        }
        catch (error) { if (error instanceof HybridPause) { state.pauseReason = error.message; state.status = 'paused'; record.hybridPause = error; await checkpoint(); } throw error; }
      } };
      return { ...tool, async run(input, context = {}) {
        const atomicScenario = tool.name === 'browser_qa_scenario';
        const previous = browserTail; let unlock; browserTail = new Promise(resolve => { unlock = resolve; });
        await previous;
        browserOperationActive = true;
        let action;
        let ownsPreviewLock = false;
        try {
          const activeSignal = context.signal || signal;
          activeSignal?.throwIfAborted(); router.check();
          if (!routes.access()) throw new Error('An approved route batch owns the browser; wait for its result.');
          if (state.budgetFinalizing) throw new Error('Browser exploration has stopped for budget closeout. Record remaining coverage gaps and publish the host-validated report.');
          if (['browser_qa_check', 'browser_qa_scenario'].includes(tool.name)) {
            const categories = { navigation: ['navigation', 'broken_links'], anchors: ['navigation', 'broken_links'], disclosure: ['navigation'], tabs: ['navigation'], dismiss_overlay: ['navigation'], responsive: ['responsive'], forms: ['forms'], search: ['search'], media: ['media'], accessibility: ['accessibility'] };
            if (categories[input?.action] && !categories[input.action].some(category => state.scope.includes(category))) throw new Error('The fixed check is outside the selected test scope or selected scenario category.');
          }
          if (state.recovery?.verificationRequired && !['browser_open', 'browser_snapshot', 'browser_get_url'].includes(tool.name)) throw new HybridPause('HYBRID_VERIFY_STATE', 'Recovery requires a fresh browser open and snapshot before actions.');
          const viewportProblem = checkPrimaryViewport(session, record.bridge?.service?.activePage);
          if (viewportProblem) { state.recovery = { ...state.recovery, verificationRequired: true }; throw new HybridPause('HYBRID_VIEWPORT_DRIFT', viewportProblem); }
          if (atomicScenario) {
            const scenario = ledger.scenario(input.scenario_id);
            const compatible = { navigation: ['navigation', 'disclosure', 'anchors', 'tabs'], broken_links: ['navigation', 'anchors'], responsive: ['responsive'], forms: ['forms'], search: ['search'], media: ['media'], accessibility: ['accessibility'] };
            if (!compatible[scenario.category]?.includes(input.action)) throw new Error('This action cannot establish the selected scenario category; use its matching fixed check or record a concrete coverage gap.');
            if (state.actions.some(action => action.status === 'uncertain' && action.toolName === 'browser_qa_check' && action.scenarioId === scenario.id)) throw new HybridPause('HYBRID_UNCERTAIN_ACTION', 'The scenario has an uncertain prior browser-check receipt. It cannot be automatically replayed. Record the blocker or choose a separately verified investigation.');
            if (state.currentScenarioId && state.currentScenarioId !== scenario.id) throw new Error('Close the active scenario before executing another.');
            if (scenario.status === 'planned') await ledger.start(scenario.id);
            else if (scenario.status !== 'running') throw new Error('Only planned or currently running scenarios can execute; completed scenarios are not replayed automatically.');
          }
          if (!discovery.has(tool.name) && !state.currentScenarioId && !(tool.name === 'browser_qa_check' && ['inspect', 'scroll'].includes(input?.action))) throw new Error('Start a validated QA scenario before this browser action.');
          const actionCost = tool.name === 'browser_authenticate' ? 5 : 1;
          if (state.telemetry.browserActions + actionCost > profile.budgets.browserActions) throw new HybridPause('HYBRID_BROWSER_BUDGET', 'Browser action budget exhausted.');
          if (needsHybridAuthQuestion(session) && tool.name === 'browser_authenticate') throw new Error('Ask for secure test-account authorization before attempting sign-in.');
          if (forbidden.has(tool.name)) throw new Error('This tool requires a separate authorized workflow and is unavailable in hybrid public QA.');
          if (!['browser_qa_check', 'browser_qa_scenario'].includes(tool.name) && record.bridge) {
            await record.bridge.frameCapture;
            record.bridge.qaOperationActive = true; ownsPreviewLock = true;
          }
          if (['browser_open', 'browser_new_tab'].includes(tool.name)) {
            const destination = new URL(input.url);
            if (!session.targetUrl || destination.origin !== new URL(session.targetUrl).origin || destination.username || destination.password || !['http:', 'https:'].includes(destination.protocol)) throw new Error('Hybrid navigation must stay in the authorized target origin.');
          }
          await record.bridge?.authorizeHybridAction?.(tool.name, input);
          if (['browser_click', 'browser_fill', 'browser_type', 'browser_check', 'browser_select', 'browser_key'].includes(tool.name) && state.actions.some(action => action.status === 'uncertain' && action.toolName === tool.name && digestEvidence(action.input) === digestEvidence(redact(session.id, input)))) throw new HybridPause('HYBRID_UNCERTAIN_ACTION', 'This action has an uncertain prior receipt. Inspect state and choose a different verified step or record the blocker; it cannot be automatically replayed.');
          const key = digestEvidence([tool.name, redact(session.id, input), state.currentScenarioId, state.lastObservedState || 'unobserved']);
          if (mutates(tool.name)) {
            let repeated = state.repeatActions.find(item => item.key === key);
            if (!repeated) { repeated = { key, count: 0, toolName: tool.name }; state.repeatActions.push(repeated); if (state.repeatActions.length > 128) state.repeatActions.shift(); }
            if (++repeated.count >= 3) throw new HybridPause('HYBRID_REPLAN_REQUIRED', 'Repeated action produced no new observed state. Replan from a fresh snapshot.');
          }
          state.telemetry.browserActions += actionCost;
          action = await ledger.beginAction(atomicScenario ? 'browser_qa_check' : tool.name, input);
          const result = await tool.run(tool.name === 'browser_diagnostics' ? { ...input, clear: true } : input, context);
          if (result?.code === 'QA_INPUT_RESTORE_FAILED') { state.recovery = { ...state.recovery, verificationRequired: true }; throw new HybridPause('QA_INPUT_RESTORE_FAILED', 'Live input restoration could not be verified. Progress is saved; do not replay input actions.'); }
          const restoreProblem = checkPrimaryViewport(session, record.bridge?.service?.activePage);
          if (restoreProblem) { state.recovery = { ...state.recovery, verificationRequired: true }; throw new HybridPause('HYBRID_VIEWPORT_DRIFT', restoreProblem); }
          state.policyBlocks = (record.bridge?.securityBlocks || []).slice(-100).map(({ url, code, resourceType }) => ({ url, code, resourceType }));
          // Cancellation after dispatch leaves an uncertain receipt. Never
          // convert a late result into a passing assertion or replay it.
          if (activeSignal?.aborted) throw activeSignal.reason;
          const evidence = await ledger.record(action, result);
          evidence.authenticationContext = state.authentication?.status === 'authenticated' ? state.authentication.grantId : 'public';
          observeHybridAuthentication(session, result);
          if (result?.code === 'HYBRID_AUTH_UNCERTAIN') throw new HybridPause('HYBRID_AUTH_UNCERTAIN', 'Sign-in was dispatched but its outcome is uncertain. Progress is saved; verify the account state before any further sign-in attempt.');
          if (result?.inventory) routes.observe();
          if (tool.name === 'browser_snapshot' || result?.inventory) {
            const observed = evidence.result.inventory || evidence.result;
            state.lastObservedState = digestEvidence({ url: observed.url, title: observed.title, text: observed.bodyText || observed.text, elements: observed.elements, disclosures: observed.disclosures });
          }
          let classification;
          if ((['browser_qa_check', 'browser_qa_scenario'].includes(tool.name) && (result?.assertions?.some(item => item.outcome === 'fail') || result?.gaps?.length || result?.success === false)) || (tool.name === 'browser_diagnostics' && diagnosticFailures(result, result.url || session.targetUrl).length)) {
            classification = await tools.find(item => item.name === 'classify_qa_observations').run({ evidence_ids: [evidence.id] }, { signal: activeSignal });
          }
          if (atomicScenario && evidence.success) {
            const scenario = ledger.scenario(input.scenario_id);
            if (scenario.assertions.some(item => item.actionId === action.id)) await ledger.close(scenario.id, 'complete');
            else await ledger.close(scenario.id, 'inconclusive', result.skipped || result.limitations || 'The fixed check produced no category-specific host assertions.');
          }
          telemetry.browserTiming(input?.action || tool.name, action.completedAt - action.ts);
          if (result?.success === false || result?.executionComplete === false) { state.telemetry.toolFailures++; telemetry.event('tool_failed', { toolName: tool.name, actionId: action.id }); }
          if (state.recovery?.verificationRequired && evidence.success && tool.name === 'browser_snapshot') {
            const current = evidence.result.url;
            if (!current || new URL(current).origin !== new URL(session.targetUrl).origin) throw new HybridPause('HYBRID_VERIFY_STATE', 'Recovered browser is outside the authorized scope.');
            state.recovery.verificationRequired = false; state.recovery.verifiedAt = Date.now();
          }
          await checkpoint();
          const response = atomicScenario ? { success: result.success, action: result.action || input.action, url: evidence.url, limitations: result.limitations, skipped: result.skipped, error: result.error, gaps: result.gaps, executionComplete: result.executionComplete, formTesting: result.formTesting,
            scenarioStatus: ledger.scenario(input.scenario_id).status,
            assertionCounts: { passed: ledger.scenario(input.scenario_id).assertions.filter(item => item.actionId === action.id && item.outcome === 'pass').length,
              failed: ledger.scenario(input.scenario_id).assertions.filter(item => item.actionId === action.id && item.outcome === 'fail').length },
            hostAssertions: ledger.scenario(input.scenario_id).assertions.filter(item => item.actionId === action.id && item.outcome === 'fail').slice(0, 8).map(assertionSummary) } : result;
          return { ...response, hostEvidenceId: evidence.id, hostActionId: action.id, scenarioId: action.scenarioId, ...(classification ? { classification } : {}) };
        } catch (error) {
          if (action?.status === 'running') { action.status = 'uncertain'; action.completedAt = Date.now(); state.recovery = { verificationRequired: true, uncertainActionId: action.id }; }
          if (error instanceof HybridPause) { state.pauseReason = error.message; state.status = 'paused'; record.hybridPause = error; }
          await checkpoint(); throw error;
        } finally { if (ownsPreviewLock) record.bridge.qaOperationActive = false; browserOperationActive = false; unlock(); }
      } };
    },
    async beginTurn(abortSignal) {
      abortSignal.throwIfAborted();
      router.check();
      signal = abortSignal;
      delete state.pauseReason; record.hybridPause = undefined;
      // Recreate elapsed-time baseline at each human continuation, excluding
      // time spent waiting for credentials or paused between turns.
      telemetry.resume();
      state.status = 'running';
      for (const action of state.actions.filter(item => item.status === 'running')) { action.status = 'uncertain'; state.recovery = { verificationRequired: true, uncertainActionId: action.id }; }
      if (state.recovery?.verificationRequired) telemetry.event('recovery_requested');
      const remaining = profile.budgets.durationMs - state.telemetry.elapsedMs;
      modelTimer = setTimeout(() => { record.hybridPause = new HybridPause('HYBRID_TIME_BUDGET', 'Execution time budget exhausted.'); record.controller?.abort(record.hybridPause); }, Math.max(1, remaining));
      signal.addEventListener('abort', () => telemetry.event('cancelled'), { once: true });
      await checkpoint();
    },
    async endTurn(status) {
      clearTimeout(modelTimer); modelTimer = undefined;
      state.status = status; if (status === 'paused' || status === 'cancelled') state.recovery = { ...state.recovery, verificationRequired: true };
      telemetry.event(status === 'done' ? 'completed' : status === 'paused' ? 'recovery_checkpoint' : status);
      await checkpoint();
      telemetry.pause();
    },
    usage(usage) { router.reasonerUsage(usage); }
  };
}
