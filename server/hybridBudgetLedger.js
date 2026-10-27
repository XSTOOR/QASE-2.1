import { randomUUID } from 'node:crypto';
import { HybridUsageError } from './hybridUsageTransport.js';

/** Reservations bound exposure; only verified provider receipts are usage.
 * Keep both durable so a restart never forgives an unaccounted request. */
export function createHybridBudgetLedger(state, telemetry) {
  const ledger = state.modelBudget ??= { version: 1, roles: Object.fromEntries(['reasoner', 'classifier'].map(role => [role, {
    reservations: [],
    // Older runs accumulated reservations without per-call receipts. Do not
    // guess which calls finished. An operator can reconcile exact host logs.
    legacyExposure: telemetry.metrics[role].reservedTokens || 0,
    legacyCalls: telemetry.metrics[role].calls || 0
  }])) };
  if (ledger.version !== 1) throw new HybridUsageError('HYBRID_BUDGET_VERSION');
  for (const role of Object.keys(ledger.roles)) {
    for (const item of ledger.roles[role].reservations) if (item.status === 'pending') item.status = 'uncertain';
  }
  const outstanding = role => ledger.roles[role].legacyExposure + ledger.roles[role].reservations.filter(item => !['settled', 'not_dispatched'].includes(item.status)).reduce((sum, item) => sum + item.tokens, 0);
  const sync = role => { telemetry.metrics[role].reservedTokens = outstanding(role); };
  for (const role of Object.keys(ledger.roles)) sync(role);
  return {
    unresolved(role) { return ledger.roles[role].legacyCalls > 0 || ledger.roles[role].reservations.some(item => item.status === 'uncertain'); },
    begin(role, tokens) {
      const item = { id: randomUUID(), tokens, status: 'pending', createdAt: Date.now() };
      ledger.roles[role].reservations.push(item); telemetry.metrics[role].calls++; sync(role); return item;
    },
    settle(role, id, usage) {
      const inputTokens = usage?.inputTokens ?? usage?.input_tokens, outputTokens = usage?.outputTokens ?? usage?.output_tokens;
      if (usage?.estimated === true || ![inputTokens, outputTokens, inputTokens + outputTokens].every(value => Number.isSafeInteger(value) && value >= 0) ||
          (usage.totalTokens !== undefined && usage.totalTokens !== inputTokens + outputTokens)) throw new HybridUsageError('HYBRID_USAGE_UNVERIFIED');
      const item = ledger.roles[role].reservations.find(item => item.id === id);
      if (!item || item.status === 'not_dispatched' || (usage.callId && ledger.roles[role].reservations.some(other => other.id !== id && other.receipt?.callId === usage.callId))) throw new HybridUsageError('HYBRID_USAGE_CONFLICT');
      const receipt = { inputTokens, outputTokens, ...(usage.callId ? { callId: usage.callId } : {}) };
      if (item.status === 'settled') {
        if (JSON.stringify(item.receipt) !== JSON.stringify(receipt)) throw new HybridUsageError('HYBRID_USAGE_CONFLICT');
        return false;
      }
      item.status = 'settled'; item.receipt = receipt; item.completedAt = Date.now();
      telemetry.usage(role, usage); sync(role); return true;
    },
    notDispatched(role, item) {
      if (item.status !== 'pending') throw new HybridUsageError('HYBRID_USAGE_CONFLICT');
      item.status = 'not_dispatched'; item.completedAt = Date.now();
      telemetry.metrics[role].calls--; sync(role);
    },
    uncertain(role, item) { if (!['settled', 'not_dispatched'].includes(item.status)) { item.status = 'uncertain'; sync(role); } }
  };
}

/** Offline operator repair only, never a model tool or HTTP parameter. Exact
 * per-call host receipts must account for EVERY old call and match saved totals.
 * The normal budget ledger still retains any newer uncertain reservations. */
export function reconcileLegacyBudget(state, role, receipts, sourceDigest) {
  const data = state.modelBudget?.roles?.[role], metric = state.telemetry?.[role];
  if (!data?.legacyCalls || receipts.length !== data.legacyCalls || !/^[a-f0-9]{64}$/.test(sourceDigest || '')) throw new Error('Complete exact host receipts are required for legacy budget reconciliation.');
  const ids = new Set(); let input = 0, output = 0;
  for (const receipt of receipts) {
    if (receipt.estimated !== false || typeof receipt.callId !== 'string' || !receipt.callId || ids.has(receipt.callId) ||
        ![receipt.inputTokens, receipt.outputTokens, receipt.totalTokens].every(value => Number.isSafeInteger(value) && value >= 0) || receipt.totalTokens !== receipt.inputTokens + receipt.outputTokens) throw new Error('Invalid or duplicate legacy usage receipt.');
    ids.add(receipt.callId); input += receipt.inputTokens; output += receipt.outputTokens;
  }
  const newer = data.reservations.filter(item => item.status === 'settled');
  if (input + newer.reduce((sum, item) => sum + item.receipt.inputTokens, 0) !== metric.inputTokens ||
      output + newer.reduce((sum, item) => sum + item.receipt.outputTokens, 0) !== metric.outputTokens) throw new Error('Legacy receipts do not match durable provider usage.');
  data.reconciliation = { sourceDigest, reconciledAt: Date.now(), receipts: receipts.map(({ callId, inputTokens, outputTokens }) => ({ callId, inputTokens, outputTokens })) };
  data.legacyExposure = 0; data.legacyCalls = 0;
  metric.reservedTokens = data.reservations.filter(item => !['settled', 'not_dispatched'].includes(item.status)).reduce((sum, item) => sum + item.tokens, 0);
}
