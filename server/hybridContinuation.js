import { randomUUID } from 'node:crypto';
import { ALL_TOOLS } from '@cleanslate/sdk';
import { needsHybridAuthQuestion } from './hybridAuth.js';
import { hybridCompletion } from './qaCompletionGate.js';
import { hybridRoutePolicy } from './hybridRoutePolicy.js';

const increments = { reasonerTokens: 300000, classifierTokens: 50000, reasonerCalls: 40, classifierCalls: 20, browserActions: 180, durationMs: 900000 };
const ceilings = { reasonerTokens: 2000000, classifierTokens: 500000, reasonerCalls: 200, classifierCalls: 100, browserActions: 1000, durationMs: 3600000 };
const FINISH = 'Publish the report with explicit coverage gaps';
const CONFIRM = 'I confirm this is the signed-in test platform; continue read-only testing';
const PUBLIC = 'Continue public-only; do not attempt another sign-in';

export function continuationOffer(session) {
  const state = session.hybrid;
  const changes = Object.fromEntries(Object.entries(increments).map(([key, amount]) => [key, Math.max(0, Math.min(amount, ceilings[key] - state.budgets[key]))]));
  const pages = Math.max(0, Math.min(8, 80 - (state.exploration?.maxPages || 0)));
  const available = ['reasoner', 'classifier'].every(role => {
    const metric = state.telemetry?.[role] || {};
    return state.budgets[`${role}Calls`] + changes[`${role}Calls`] > (metric.calls || 0) && state.budgets[`${role}Tokens`] + changes[`${role}Tokens`] > (metric.inputTokens || 0) + (metric.outputTokens || 0);
  }) && state.budgets.durationMs + changes.durationMs > (state.telemetry?.elapsedMs || 0) && state.budgets.browserActions + changes.browserActions > (state.telemetry?.browserActions || 0);
  return { changes, pages, available,
    label: `Continue testing: approve +${changes.reasonerTokens.toLocaleString('en-US')} Opus tokens, +${changes.classifierTokens.toLocaleString('en-US')} JEV tokens, +${Math.round(changes.durationMs / 60000)} min, +${changes.browserActions} browser actions and up to ${pages} page attempts` };
}

/** Host-authored prerequisites enter the existing SDK question tool. They do
 * not spend model tokens or create another agent loop. */
export function prepareHostDecision(session, { closing = false, forcedBudget = false } = {}) {
  const state = session.hybrid;
  if (state.continuationPolicyVersion !== 1) return null;
  if (state.pendingDecision && (!forcedBudget || state.pendingDecision.kind === 'budget')) return state.pendingDecision;
  let kind, question, options, offer;
  if (!forcedBudget && needsHybridAuthQuestion(session)) {
    const auth = state.authentication;
    if (auth.status === 'verification_needed' && auth.verificationObservation?.noPassword && auth.verificationObservation.sameOrigin) {
      kind = 'access';
      question = 'The sign-in service responded, but automatic access verification is incomplete. Is the browser showing your signed-in test platform? This confirms access only, not a passed authentication test.';
      options = [CONFIRM, PUBLIC];
    } else {
      kind = 'credentials';
      question = `Authenticated testing needs test account credentials or an access recovery decision. Use the secure form, or continue public-only.${auth.blockedEndpoint ? ` The site attempted this authentication API; approve its exact URL only if trusted: ${auth.blockedEndpoint}` : ''}`;
      options = ['Provide an authorized test account securely', PUBLIC];
    }
  } else if (closing && !state.partialReportApproved) {
    kind = 'budget'; offer = continuationOffer(session);
    question = 'Testing is unfinished. Progress and exact usage are saved. Approve a bounded additional budget to continue the remaining tests, or explicitly choose a report with coverage gaps.';
    options = offer.available && offer.changes.reasonerTokens > 0 && offer.changes.durationMs > 0 ? [offer.label, FINISH] : [FINISH];
  } else if (!state.partialReportApproved && state.scenarios.length && state.scenarios.every(item => !['planned', 'running'].includes(item.status)) && hybridRoutePolicy(state).publicationAllowed && hybridCompletion(session).gaps.length) {
    kind = 'coverage';
    question = 'Some requested checks still lack requirements, access or execution evidence. Provide the missing context to continue, or explicitly publish the report with those coverage gaps.';
    options = ['I will provide the missing requirements or access context', FINISH];
  }
  if (!kind) return null;
  return state.pendingDecision = { id: `qase-host-${randomUUID()}`, kind, createdAt: Date.now(), ...(offer ? { offer } : {}),
    input: { summary: 'Progress is saved. A user decision is required before testing can continue or an incomplete report can be finalized.', question, options, allowCustom: kind === 'coverage' } };
}

/** Known exhausted budgets are a human handoff, not a fabricated finished run.
 * Use the supported SDK pending-question API, as the existing JEV controller
 * does. Unknown usage or action state is never reconciled by this approval. */
export async function pauseForBudgetApproval(session, runtime, error) {
  if (session.hybrid?.continuationPolicyVersion !== 1 || !['HYBRID_MODEL_BUDGET', 'HYBRID_TIME_BUDGET', 'HYBRID_BROWSER_BUDGET'].includes(error?.code) ||
      typeof runtime.agentSession?.pauseForQuestion !== 'function' || Object.values(session.hybrid.modelBudget?.roles || {}).some(role => role.legacyCalls > 0 || role.reservations?.some(item => ['uncertain', 'pending'].includes(item.status)))) return null;
  const decision = prepareHostDecision(session, { closing: true, forcedBudget: true });
  if (!decision) return null;
  const result = await ALL_TOOLS.find(tool => tool.name === 'ask_question').run(decision.input);
  runtime.agentSession.pauseForQuestion({ id: decision.id, toolName: 'ask_question', input: decision.input }, result);
  session.hybrid.budgetPauseReason = error.code;
  return decision;
}

export function applyHostDecision(session, answer) {
  const state = session.hybrid, decision = state?.pendingDecision;
  if (!decision || session.pendingQuestion?.toolCallId !== decision.id) return false;
  const selected = String(answer).trim();
  if (decision.kind === 'credentials') {
    if (!/public[- ]only|skip (?:the )?login|no credentials/i.test(selected)) throw new Error('Use the secure credential form or choose a public-only review.');
  } else if (decision.kind === 'access') {
    if (selected === CONFIRM) {
      if (state.authentication.status !== 'verification_needed' || !state.authentication.verificationObservation?.noPassword || !state.authentication.verificationObservation.sameOrigin) throw new Error('Fresh same-origin access evidence is required before this confirmation.');
      state.authentication.status = 'owner_confirmed'; state.authentication.verificationMethod = 'owner_confirmation'; state.authentication.confirmedAt = Date.now();
    } else if (selected !== PUBLIC) throw new Error('Choose the explicit platform-access or public-only decision.');
  } else if (selected === FINISH) {
    state.partialReportApproved = { by: session.ownerUserId, at: Date.now(), decisionId: decision.id };
    state.finishRequested = true; state.budgetFinalizing = true;
  } else if (decision.kind === 'budget') {
    if (!decision.offer.available || !decision.input.options.includes(selected) || selected !== decision.offer.label) throw new Error('Explicit approval of the displayed additional budget is required.');
    if (Object.values(state.modelBudget?.roles || {}).some(role => role.legacyCalls > 0 || role.reservations?.some(item => ['uncertain', 'pending'].includes(item.status)))) throw new Error('Usage receipts must be reconciled before approving further model work.');
    for (const [key, amount] of Object.entries(decision.offer.changes)) {
      if (!Number.isSafeInteger(amount) || amount < 0 || state.budgets[key] + amount > ceilings[key]) throw new Error('The budget offer is outside the host limits.');
    }
    state.budgetApprovals ??= [];
    state.budgetApprovals.push({ decisionId: decision.id, by: session.ownerUserId, at: Date.now(), changes: structuredClone(decision.offer.changes), pages: decision.offer.pages });
    for (const [key, amount] of Object.entries(decision.offer.changes)) state.budgets[key] += amount;
    if (state.exploration) state.exploration.maxPages += decision.offer.pages;
    state.budgetFinalizing = false; state.partialReportApproved = undefined; state.finishRequested = false;
  } else if (decision.kind === 'coverage') {
    if (selected === decision.input.options[0]) throw new Error('Enter the missing requirements in the custom answer so the agent has concrete new context.');
    // Keep all assertions/actions. Reopen only unfinished outcomes, never failed
    // or passed tests, so new requirements cannot erase existing evidence.
    for (const scenario of state.scenarios) if (['blocked', 'inconclusive', 'not_executed'].includes(scenario.status)) scenario.status = 'planned';
  }
  state.pendingDecision = undefined;
  return true;
}


/** Explicit owner closeout uses the existing SDK tools and completion gate.
 * No model/browser request or extra budget is permitted in this path. */
export function hostCloseoutCalls(session) {
  const state = session.hybrid;
  if (state?.continuationPolicyVersion !== 1 || !state.finishRequested || !state.partialReportApproved?.decisionId || state.partialReportApproved.by !== session.ownerUserId) return null;
  if (Object.values(state.modelBudget?.roles || {}).some(role => role.legacyCalls > 0 || role.reservations?.some(item => ['pending', 'uncertain'].includes(item.status)))) throw new Error('Usage receipts must be reconciled before host closeout.');
  const unfinished = state.scenarios.filter(item => ['planned', 'running'].includes(item.status));
  if (unfinished.length) return unfinished.map(item => ({ id: `qase-close-${randomUUID()}`, toolName: 'qa_close_scenario', input: {
    scenario_id: item.id, disposition: 'inconclusive', reason: 'The run owner explicitly requested a report with remaining coverage gaps. This scenario was not completed; saved assertions and observations remain available.'
  } }));
  const result = hybridCompletion(session);
  return [{ id: `qase-report-${randomUUID()}`, toolName: 'finish_qa_report', input: {
    verdict: result.verdict, summary: result.summary, covered: result.covered, not_covered: result.gaps,
    recommendations: ['Review the saved evidence and authorize a new run for remaining scope.'],
    security_outcomes: (session.selectedTests || []).filter(id => id.startsWith('security_')).map(check => ({ check, outcome: 'not_tested', reason: 'A complete authorized positive/negative security workflow was not established before owner-requested closeout. See the scenario evidence and coverage gaps.' }))
  } }];
}
