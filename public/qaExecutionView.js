import { planPresentation } from './planPresentation.js';

/** Derive identity from the run, never the server's currently selected model. */
export function qaExecutionModeLabel(session) {
  if (session?.mode !== 'qa') return '';
  if (session.hybrid?.version === 2) return 'QA engine · automated checks + reasoning model + JEV verification';
  if (session.qaExecutionMode === 'hybrid') return 'Hybrid QA (previous engine)';
  if (session.jev || session.report?.executionEvidence?.controller === 'coverage-decisions-v2') return 'JEV-only QA (previous engine)';
  return 'Single-model QA (previous engine)';
}

/** Plan progress for runs whose plan items are not QA-engine phases. */
export function qaPlanProgress(session) {
  if (session?.mode !== 'qa' || session.hybrid?.version === 2) return null;
  const todos = session.todos || [];
  const done = todos.filter(todo => ['completed', 'tested', 'passed', 'failed'].includes(planPresentation(todo).key)).length;
  return { total: todos.length, done, percent: todos.length ? Math.round(done / todos.length * 100) : undefined };
}

export function qaLauncherModeLabel(mode, config) {
  const qa = config?.hybridQa;
  return `QA engine — automated checks${qa?.reasonerConfigured ? ` + ${qa.reasoner}` : ''}${qa?.classifierConfigured ? ` + ${qa.classifier} verification` : ''}`;
}

export function qaLauncherSelectionProblem() {
  return null;
}
