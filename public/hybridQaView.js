import { browserExecutionEngine } from './qaBrowserStatus.js';

export function hybridAvailabilityMessage(config) {
  return config?.hybridQa?.available ? 'Hybrid QA is ready. Model compatibility checks passed.' : config?.hybridQa?.reason || 'Hybrid QA is unavailable. Gateway qualification must be current.';
}

export function holdPrimaryPreview(frame, session) {
  const viewport = frame?.viewportTesting;
  return session?.qaExecutionMode === 'hybrid' && viewport?.phase === 'responsive_sample' &&
    (frame.viewport?.width !== viewport.primary?.width || frame.viewport?.height !== viewport.primary?.height);
}

export function viewportStatusText(viewport) {
  if (viewport?.phase === 'restore_failed') return 'Viewport restoration failed — execution must pause.';
  if (viewport?.phase !== 'responsive_sample') return '';
  return `Responsive ${viewport.current?.width}px · selected preview kept (${viewport.primary?.width}×${viewport.primary?.height})`;
}

export function hybridScenarioProgress(session) {
  if (session?.mode !== 'qa' || session.qaExecutionMode !== 'hybrid' || !session.hybrid) return null;
  const scenarios = session.hybrid.scenarios || [], counts = session.hybrid.counts;
  const total = scenarios.length || (counts ? Object.values(counts).reduce((sum, value) => sum + value, 0) : 0);
  const completed = item => item.status === 'failed' || (item.status === 'passed' && !(item.routeCounts?.gaps || item.routeRuns?.some(run => !['passed', 'failed'].includes(run.status))));
  const done = scenarios.length ? scenarios.filter(completed).length : counts ? (counts.passed || 0) + (counts.failed || 0) : 0;
  return { total, done, percent: total ? Math.round(done / total * 100) : 0 };
}
export function hybridScenarioPlan(session) {
  if (!hybridScenarioProgress(session)) return null;
  return (session.hybrid.scenarios || []).map(item => {
    const pages = item.routeCounts || (item.routeRuns ? { attempted: item.routeRuns.length, gaps: item.routeRuns.filter(run => !['passed', 'failed'].includes(run.status)).length } : null);
    const status = item.status === 'passed' && pages?.gaps ? 'partial' : item.status;
    return { text: `${item.category}${item.routeUrl ? ` · ${item.routeUrl}` : ''} — ${status}${pages ? ` · ${pages.attempted} page trials, ${pages.gaps} gaps` : ''}${item.uncertainty?.length ? ': ' + item.uncertainty.join(' ') : ''}`,
      status: ({ planned: 'pending', running: 'in_progress', not_executed: 'not_tested' })[status] || status };
  });
}

export function hybridQaModel(session) {
  if (session?.mode !== 'qa' || session.qaExecutionMode !== 'hybrid') return null;
  const state = session.hybrid || session.report?.hybridQa || {};
  const scenarios = state.scenarios || [];
  const counts = state.counts || Object.fromEntries(['planned', 'running', 'passed', 'failed', 'blocked', 'inconclusive', 'not_executed'].map(key => [key, scenarios.filter(item => item.status === key).length]));
  return { ...state, status: state.status || (session.status === 'error' ? 'startup failed' : 'initializing runtime'), counts, current: scenarios.find(item => item.id === state.currentScenarioId)?.objective,
    coverage: scenarios.length && session.hybrid ? hybridScenarioProgress(session).percent / 100 : Number.isFinite(state.coverage) ? state.coverage : 0,
    unresolved: state.unresolved ?? state.observations?.filter(item => item.status !== 'confirmed').length ?? 0,
    confirmedDefects: state.confirmedDefects ?? state.confirmedFindings?.length ?? 0 };
}

export function renderHybridQa(session, document) {
  const model = hybridQaModel(session); if (!model) return null;
  const root = document.createElement('section'); root.className = 'report-section hybrid-qa-status'; root.setAttribute('aria-label', 'Hybrid QA progress');
  const title = document.createElement('h3'); title.textContent = 'Hybrid QA'; root.append(title);
  const rows = [
    `Reasoner: ${model.reasoner?.model || 'Opus 4.7'} · Classifier: ${model.classifier?.model || 'JEV 1.13'}`,
    `Status: ${model.status === 'finalizing_budget' ? 'Finishing within the approved budget' : model.status || 'pending qualification'}${model.current ? ` · Current scenario: ${model.current}` : ''}`,
    `${model.counts.passed || 0} passed · ${model.counts.failed || 0} failed · ${model.counts.blocked || 0} blocked · ${model.counts.inconclusive || 0} inconclusive · ${(model.counts.planned || 0) + (model.counts.not_executed || 0)} unexecuted`,
    `Recorded scenario coverage: ${Math.round(Math.max(0, Math.min(1, model.coverage)) * 100)}% · ${model.confirmedDefects} confirmed defects · ${model.unresolved} unresolved observations`
  ];
  if (model.telemetry) {
    rows.push(`${model.telemetry.browserActions || 0} browser actions · ${Math.round((model.telemetry.elapsedMs || 0) / 1000)} seconds active execution`);
    const timings = Object.entries(model.telemetry.browserTimings || {}).sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, 3);
    if (timings.length) rows.push(`Largest measured browser costs: ${timings.map(([name, value]) => `${name}: ${(value.totalMs / 1000).toFixed(1)}s across ${value.calls} calls`).join(' · ')}. These include host checks and receipt overhead, not model inference.`);
    for (const [role, label] of [['reasoner', 'Opus'], ['classifier', 'JEV']]) {
      const usage = model.telemetry[role] || {};
      rows.push(`${label}: ${usage.calls || 0} calls · ${usage.inputTokens || 0} input / ${usage.outputTokens || 0} output tokens${usage.usageReported ? '' : ' (provider usage not reported)'}`);
      if (model.budgets?.[`${role}Tokens`]) rows.push(`${label} budget: ${(usage.inputTokens || 0) + (usage.outputTokens || 0)} / ${model.budgets[`${role}Tokens`]} provider-reported tokens · ${usage.reservedTokens || 0} pending reservation tokens`);
    }
  }
  if (model.exploration) rows.push(`Route depth: ${model.exploration.tested || 0}/${model.exploration.observed || 0} observed pages tested · ${model.exploration.pending || 0} pending. This is not whole-site coverage.`);
  if (Number.isInteger(model.exploration?.target)) rows.push(`Page target: ${model.exploration.attempted || 0}/${model.exploration.target} attempted. ${model.exploration.stopReason === 'budget_closeout'
    ? 'Exploration stopped to reserve the report budget. Unmet depth remains a coverage gap; it does not prevent publication.'
    : model.exploration.canExplore ? `${model.exploration.remainingSlots} page slots remain in this run.` : 'Remaining observed routes are recorded as untested scope.'} Attempts include failed/interrupted pages and are not passing results.`);
  if (model.exploration?.version === 2) {
    rows.push('Plan items are category suites. Per-page executions and coverage gaps remain recorded within each suite, not duplicated as planning items.');
    rows.push(`Observed interaction trials: ${model.exploration.interactions?.executed || 0}/${model.exploration.interactions?.attempted || 0} executed. Blocked or unavailable interactions are not passed.`);
  }
  if (model.pauseReason) rows.push(`Checkpoint: ${model.pauseReason}`);
  if (model.inputTesting?.casesExecuted) rows.push(`Live inputs: ${model.inputTesting.fieldsFilled} field trials · ${model.inputTesting.casesExecuted} input cases · ${model.inputTesting.negativeCases} declared-constraint negative cases. Fields restored; no form submission was executed. Remote validation and business workflows are separate coverage.`);
  if (model.budgetFinalizing) rows.push('Browser exploration stopped to reserve budget for the report. Remaining scope is recorded as coverage gaps, not passed tests.');
  if (model.recovery?.verificationRequired) rows.push('Recovery requires a fresh authorized browser snapshot.');
  if (model.gaps?.length) rows.push(`Coverage gaps: ${model.gaps.slice(0, 8).join(' ')}`);
  for (const item of (model.unresolvedObservations || []).slice(0, 4)) rows.push(`Unresolved observation (not a confirmed defect): ${item.title}${item.detail ? ` — ${item.detail}` : ''}. Evidence: ${(item.evidenceRefs || []).join(', ')}`);
  for (const value of rows) { const line = document.createElement('p'); line.textContent = value; root.append(line); }
  return root;
}
/** Explicit launcher selection; never silently convert a matrix/legacy run. */
export function hybridLaunchOptions({ config, mode, envIds, configurations }) {
  if (!mode || mode === 'legacy') return null;
  if (mode !== 'hybrid') throw new Error('Unknown QA execution mode.');
  if (!config?.hybridQa?.available) throw new Error(hybridAvailabilityMessage(config));
  if (envIds?.length !== 1) throw new Error('For hybrid testing, choose Focused check with one browser configuration. Multi-browser hybrid dispatch is not enabled.');
  const environment = configurations.find(item => item.envId === envIds[0]);
  if (!environment || environment.availability !== 'AVAILABLE') throw new Error('The selected browser is no longer available. Use the recommended browser or refresh the browser list.');
  const engine = browserExecutionEngine(environment);
  if (!engine) throw new Error('Refresh browser details to load the verified execution engine. Your test setup is kept.');
  return { qaExecutionMode: 'hybrid', environmentId: environment.envId, engine };
}
