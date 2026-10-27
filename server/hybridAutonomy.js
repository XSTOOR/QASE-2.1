/** Run policy is pinned at creation. Allocation may grow only inside its fixed
 * operator-defined ceiling; exact receipts and lifetime counters never reset. */
export const autonomous = state => state?.continuationPolicyVersion === 2 && state.executionPolicy?.mode === 'autonomous';
const steps = { reasonerTokens: 300000, classifierTokens: 50000, reasonerCalls: 40, classifierCalls: 20, browserActions: 180, durationMs: 900000 };
export function ensureAutonomousCapacity(state, requested) {
  if (!autonomous(state) || state.finishRequested || state.budgetFinalizing) return false;
  let changed = false;
  for (const [key, needed] of Object.entries(requested)) {
    const current = state.budgets[key], ceiling = state.executionPolicy.limits[key];
    if (!steps[key] || !Number.isSafeInteger(needed) || !Number.isSafeInteger(ceiling) || needed <= current || current >= ceiling) continue;
    const next = Math.min(ceiling, Math.max(needed, current + steps[key]));
    state.budgets[key] = next; changed = true;
    state.telemetry.events.push({ type: 'automatic_capacity_allocated', key, previous: current, current: next, ceiling, ts: Date.now() });
    state.telemetry.events = state.telemetry.events.slice(-100);
  }
  return changed;
}
export function hasUnknownUsage(state) {
  return Object.values(state.modelBudget?.roles || {}).some(role => role.legacyCalls > 0 || role.reservations?.some(item => ['uncertain', 'pending'].includes(item.status)));
}
export function requestAutomaticCloseout(session, reason) {
  const state = session.hybrid;
  if (!autonomous(state) || hasUnknownUsage(state) || state.finishRequested) return false;
  state.finishRequested = true; state.budgetFinalizing = true;
  state.closeoutAuthorization = { source: 'pinned_run_policy', reason, at: Date.now() };
  return true;
}

/** A prior anonymous limitation is historical context, never current evidence
 * that an already-authorized signed-in platform remains inaccessible. */
export function synchronizeAccessPhase(state) {
  const auth = state.authentication;
  const context = ['authenticated', 'owner_confirmed'].includes(auth?.status) ? auth.grantId : 'public';
  state.accessContext ??= 'public';
  if (state.accessContext === context) return false;
  const previous = state.accessContext;
  state.accessContext = context;
  if (context === 'public') return true;
  for (const scenario of state.scenarios) {
    if (scenario.uncertainty.length) {
      scenario.priorDispositions ??= [];
      scenario.priorDispositions.push({ accessContext: previous, status: scenario.status, uncertainty: [...scenario.uncertainty], at: Date.now() });
      scenario.priorDispositions = scenario.priorDispositions.slice(-4);
      scenario.uncertainty = [];
    }
    if (['not_executed', 'blocked', 'inconclusive'].includes(scenario.status) && !['content', 'visual_consistency'].includes(scenario.category)) {
      scenario.status = 'planned'; scenario.coverage = 'not_executed';
    }
  }
  return true;
}
