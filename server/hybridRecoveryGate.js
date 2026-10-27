/** Read-only preflight: do not reopen a browser or spend model budget merely
 * to rediscover a durable condition that prevents safe continuation. */
export function hybridRecoveryProblem(session) {
  if (session?.mode !== 'qa' || session.qaExecutionMode !== 'hybrid' || !session.hybrid) return null;
  const state = session.hybrid;
  for (const [role, data] of Object.entries(state.modelBudget?.roles || {})) {
    if (role === 'classifier' && state.allowWithoutClassifier === true) continue;
    if (data.legacyCalls > 0 || data.reservations?.some(item => item.status === 'uncertain' || (session.status !== 'running' && item.status === 'pending'))) {
      return { code: 'HYBRID_USAGE_UNRESOLVED', reason: 'usage_unverified', message: 'A model usage receipt is missing. Your progress is preserved; provider usage reconciliation is required before this run can resume.' };
    }
  }
  if (state.budgets && state.telemetry?.elapsedMs >= state.budgets.durationMs) return { code: 'HYBRID_TIME_BUDGET', reason: 'budget_reached', message: 'This run reached its approved time budget. Review saved progress before starting a new test with an approved budget.' };
  if (state.budgetFinalizing && session.status === 'done' && session.report) return { code: 'HYBRID_COVERAGE_CLOSED', reason: 'coverage_closed', message: 'This run has published its budget closeout report. Start a new test for the remaining scope; its saved report and evidence are preserved. Continuing here cannot reopen exploration or increase the approved budget.' };
  return null;
}
