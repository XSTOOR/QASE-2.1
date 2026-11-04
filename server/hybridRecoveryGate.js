/** Read-only preflight: do not reopen a browser or spend model budget merely
 * to rediscover a durable condition that prevents safe continuation. */
export function hybridRecoveryProblem(session) {
  if (session?.mode !== 'qa' || session.qaExecutionMode !== 'hybrid' || !session.hybrid) return null;
  const state = session.hybrid;
  for (const [role, data] of Object.entries(state.modelBudget?.roles || {})) {
    if (role === 'classifier' && state.allowWithoutClassifier === true) continue;
    if (data.legacyCalls > 0 || data.reservations?.some(item => item.status === 'uncertain' || (session.status !== 'running' && item.status === 'pending'))) {
      return { code: 'HYBRID_USAGE_UNRESOLVED', reason: 'usage_unverified', message: 'A model usage receipt is missing for this run. Your progress is preserved. Ask the operator to reconcile the provider usage (exact host receipts) for this run, or start a new test run; usage must be reconciled before this run can resume.' };
    }
  }
  if (state.budgets && state.telemetry?.elapsedMs >= state.budgets.durationMs) return { code: 'HYBRID_TIME_BUDGET', reason: 'budget_reached', message: 'This run reached its approved time budget. Review saved progress before starting a new test with an approved budget.' };
  if (state.budgetFinalizing && session.status === 'done' && session.report) return { code: 'HYBRID_COVERAGE_CLOSED', reason: 'coverage_closed', message: 'This run has published its budget closeout report. Start a new test for the remaining scope; its saved report and evidence are preserved. Continuing here cannot reopen exploration or increase the approved budget.' };
  return null;
}

/** #18637 — heal-before-gate on a resume attempt. The stop race persisted
 * reservations stale (uncertain/pending) while their VERIFIED receipts were
 * durably logged in modelBudget.receiptLog (written atomically with the
 * settle). Replay exactly those logged receipts; a heal survives because the
 * caller's next save/checkpoint persists it. Never fabricates: without a log
 * entry the reservation stays blocked and the gate explains the resolution.
 * Returns the number of reservations healed (0 when nothing to do). */
export async function reconcileHybridUsageBeforeResume(session) {
  const state = session?.hybrid;
  if (session?.mode !== 'qa' || session.qaExecutionMode !== 'hybrid' || !state?.modelBudget) return 0;
  const blocked = Object.values(state.modelBudget.roles || {})
    .some(data => data.legacyCalls <= 0 && data.reservations?.some(item => ['uncertain', 'pending'].includes(item.status)));
  if (!blocked) return 0;
  return healFromReceiptLog(state);
}

/** Pure structural heal over the persisted budget state. Mirrors
 * createHybridBudgetLedger.reconcileFromReceiptLog() without needing a live
 * ledger/telemetry instance, because on the resume preflight the runtime has
 * not been constructed yet. Mutates session.hybrid in place. */
function healFromReceiptLog(state) {
  const budget = state.modelBudget;
  const log = budget.receiptLog ?? [];
  let healed = 0;
  for (const entry of log) {
    const role = budget.roles?.[entry.role];
    if (!role || ![entry.inputTokens, entry.outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) continue;
    const item = role.reservations?.find(item => item.id === entry.reservationId);
    if (!item || ['settled', 'not_dispatched'].includes(item.status)) continue;
    item.status = 'settled';
    item.receipt = { inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, ...(entry.callId ? { callId: entry.callId } : {}) };
    item.completedAt = entry.settledAt ?? Date.now();
    item.reconciledFromLog = true;
    // Exposure math: outstanding excludes settled/not_dispatched; recompute
    // reservedTokens per role from the reservations (legacy exposure kept).
    healed++;
  }
  if (healed > 0 && state.telemetry) {
    for (const [name, data] of Object.entries(budget.roles || {})) {
      if (state.telemetry[name]) state.telemetry[name].reservedTokens =
        (data.legacyExposure || 0) + (data.reservations || [])
          .filter(item => !['settled', 'not_dispatched'].includes(item.status))
          .reduce((sum, item) => sum + item.tokens, 0);
    }
  }
  return healed;
}
