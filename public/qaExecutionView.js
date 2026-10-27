import { planPresentation } from './planPresentation.js';

/** Derive identity from the run, never the server's currently selected model. */
export function qaExecutionModeLabel(session) {
  if (session?.mode !== 'qa') return '';
  if (session.qaExecutionMode === 'hybrid') return 'Hybrid QA · Opus reasoning + JEV classification';
  if (session.jev || session.report?.executionEvidence?.controller === 'coverage-decisions-v2') return 'JEV-only QA · bounded checks · no Opus reasoning';
  return 'Configured-model QA · hybrid not selected';
}

export function qaPlanProgress(session) {
  if (session?.mode !== 'qa' || session.qaExecutionMode === 'hybrid') return null;
  const todos = session.todos || [];
  const done = todos.filter(todo => ['completed', 'tested', 'passed', 'failed'].includes(planPresentation(todo).key)).length;
  return { total: todos.length, done, percent: todos.length ? Math.round(done / todos.length * 100) : undefined };
}

export function qaLauncherModeLabel(mode, config) {
  if (!mode && config?.hybridQa?.enabled) return 'Choose Hybrid for Opus reasoning + JEV classification, or explicitly choose bounded single-model QA.';
  return mode === 'hybrid' ? 'Hybrid QA — Opus 4.7 + JEV 1.13' : config?.provider === 'jev' ? 'JEV-only QA — bounded checks, no Opus reasoning' : `Configured-model QA — ${config?.model || 'selected model'} (not hybrid)`;
}

export function qaLauncherSelectionProblem(mode, config) {
  return config?.hybridQa?.enabled && !mode ? 'Choose an agent: Hybrid QA uses Opus + JEV; single-model QA does not use the hybrid reasoner.' : null;
}
