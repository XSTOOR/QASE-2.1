import { CancellationTokenSource } from '@cleanslate/sdk';
import { createJevClient, prepareJevRequest } from './jevClient.js';
import { redact } from './secrets.js';
import { HybridUsageError } from './hybridUsageTransport.js';
import { createHybridBudgetLedger } from './hybridBudgetLedger.js';

export class HybridPause extends Error {
  constructor(code, message) { super(message); this.name = 'HybridPause'; this.code = code; }
}

function boundedRace(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function createHybridModelRouter({ session, profile, telemetry, checkpoint, onUsage, fetchImpl }) {
  const budget = profile.budgets;
  const accounting = createHybridBudgetLedger(session.hybrid, telemetry);
  const deadlines = new Map();
  const modelFailure = error => {
    if (error instanceof HybridPause) return error;
    if (error instanceof HybridUsageError) {
      telemetry.metrics.reasoner.usageIncomplete = true;
      telemetry.event('model_usage_unverified', { role: 'reasoner', code: error.code });
      return new HybridPause(error.code, error.message);
    }
    return new HybridPause('OPUS_UNAVAILABLE', 'Opus request failed; progress checkpointed.');
  };
  let activeClassifier = 0;
  const waiters = [];
  const client = createJevClient({ apiKey: profile.classifier.apiKey, baseUrl: profile.classifier.endpoint, model: profile.classifier.model }, { fetchImpl, timeoutMs: budget.classifierTimeoutMs });
  const check = () => {
    if (telemetry.tick() >= budget.durationMs) throw new HybridPause('HYBRID_TIME_BUDGET', 'Execution time budget exhausted.');
    for (const role of ['reasoner', 'classifier']) {
      if (accounting.unresolved(role) && !(role === 'classifier' && profile.allowWithoutClassifier)) throw new HybridPause('HYBRID_USAGE_UNRESOLVED', `${role} has an unverified prior usage receipt. Progress is saved; usage must be reconciled before continuing.`);
      const metric = telemetry.metrics[role];
      if (metric.inputTokens + metric.outputTokens + metric.reservedTokens > budget[`${role}Tokens`]) throw new HybridPause('HYBRID_MODEL_BUDGET', `${role} provider usage plus pending reservations exceeded its token budget. Progress is saved; start a new run with an explicitly approved budget.`);
    }
  };
  function reserve(role, inputTokens) {
    check();
    if (accounting.unresolved(role)) throw new HybridPause('HYBRID_USAGE_UNRESOLVED', `${role} has unverified usage; another request cannot be dispatched.`);
    const metric = telemetry.metrics[role], maxCalls = role === 'reasoner' ? budget.reasonerCalls : budget.classifierCalls;
    const maxTokens = role === 'reasoner' ? budget.reasonerTokens : budget.classifierTokens;
    const reserve = inputTokens + budget.outputTokens;
    const used = metric.inputTokens + metric.outputTokens;
    if (metric.calls >= maxCalls || used + metric.reservedTokens + reserve > maxTokens) throw new HybridPause('HYBRID_MODEL_BUDGET', `${role} model budget exhausted (${used} provider-reported tokens, ${metric.reservedTokens} pending reservation tokens, ${metric.calls}/${maxCalls} calls). Progress is saved; a new run needs an explicitly approved budget.`);
    return accounting.begin(role, reserve);
  }
  return {
    check,
    reasonerUsage(usage) {
      try { accounting.settle('reasoner', usage.reservationId, usage); deadlines.get(usage.reservationId)?.(); }
      catch (error) { throw modelFailure(error); }
    },
    async classifier(observations, questions, signal) {
      signal?.throwIfAborted();
      if (accounting.unresolved('classifier') && profile.allowWithoutClassifier) {
        session.hybrid.degradedClassification = true;
        telemetry.event('classification_skipped', { code: 'HYBRID_USAGE_UNRESOLVED' });
        await checkpoint(); return null;
      }
      // Two immutable classification batches at most. Acquisition itself is
      // cancellable; a paused caller cannot later acquire and start a request.
      if (activeClassifier >= 2) await new Promise((resolve, reject) => {
        const entry = { resolve: () => { signal?.removeEventListener('abort', abort); resolve(); }, reject };
        const abort = () => { const index = waiters.indexOf(entry); if (index >= 0) waiters.splice(index, 1); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true }); waiters.push(entry);
      }); else activeClassifier++;
      const began = Date.now();
      let reservation, dispatched = false;
      try {
        signal?.throwIfAborted();
        const immutable = JSON.parse(JSON.stringify(redact(session.id, observations)));
        const boundedQuestions = JSON.parse(JSON.stringify(questions));
        prepareJevRequest(immutable, boundedQuestions, { model: profile.classifier.model, sessionId: session.id });
        reservation = reserve('classifier', Buffer.byteLength(JSON.stringify({ immutable, questions: boundedQuestions })) + 512);
        telemetry.event('model_request_started', { role: 'classifier', model: profile.classifier.model });
        await checkpoint();
        const response = await client.decide(immutable, boundedQuestions, { signal, sessionId: session.id,
          onDispatch: () => { dispatched = true; },
          onUsageReceipt: async receipt => {
            if (accounting.settle('classifier', reservation.id, { ...receipt, callId: reservation.id })) onUsage?.({ ...receipt, callId: reservation.id });
            await checkpoint();
          }
        });
        telemetry.event('classification_completed', { count: Object.keys(boundedQuestions).length });
        await checkpoint(); check(); return response.answers;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        session.hybrid.degradedClassification = true;
        telemetry.event('classification_failed', { code: error.code || 'JEV_UNAVAILABLE', stage: error.stage || (dispatched ? 'transport' : 'pre_dispatch'),
          ...(Number.isInteger(error.httpStatus) ? { httpStatus: error.httpStatus } : {}), usageVerified: reservation?.status === 'settled' });
        await checkpoint();
        if (error instanceof HybridPause) throw error;
        if (!profile.allowWithoutClassifier) throw new HybridPause(error.code || 'JEV_UNAVAILABLE', reservation?.status === 'settled'
          ? 'JEV returned an unusable classification. Exact usage and progress are saved; resume to continue safely.'
          : dispatched ? 'JEV classification did not return a verified usage receipt. Progress is saved; provider usage must be reconciled before resuming.'
          : 'JEV request could not be prepared. No classifier request was dispatched; progress is saved.');
        return null;
      } finally {
        if (reservation) { if (!dispatched) accounting.notDispatched('classifier', reservation); else accounting.uncertain('classifier', reservation); }
        telemetry.metrics.classifier.latencyMs += Date.now() - began;
        try { await checkpoint(); }
        finally { const waiter = waiters.shift(); if (waiter) waiter.resolve(); else activeClassifier--; }
      }
    },
    async reasoner(chat, messages, options = {}) {
      const reservation = reserve('reasoner', Buffer.byteLength(JSON.stringify(messages)) + Buffer.byteLength(JSON.stringify(options.tools || [])) + 2048);
      telemetry.event('model_request_started', { role: 'reasoner', model: profile.reasoner.model });
      const cts = new CancellationTokenSource(options.cancellationToken);
      const stop = new AbortController();
      const timeout = setTimeout(() => { stop.abort(new HybridPause('OPUS_TIMEOUT', 'Opus response timed out; progress checkpointed.')); cts.cancel(); }, Math.min(budget.reasonerTimeoutMs, Math.max(1, budget.durationMs - telemetry.tick())));
      deadlines.set(reservation.id, () => clearTimeout(timeout));
      const subscription = cts.token.onCancellationRequested(() => { if (!stop.signal.aborted) stop.abort(new HybridPause('HYBRID_CANCELLED', 'Model request cancelled.')); });
      const began = Date.now();
      try {
        await checkpoint();
        const stream = await boundedRace(chat(messages, { ...options, qaseBudgetReservationId: reservation.id, maxOutputTokens: Math.min(options.maxOutputTokens || budget.outputTokens, budget.outputTokens), cancellationToken: cts.token }), stop.signal);
        return (async function* () {
          const iterator = stream[Symbol.asyncIterator]();
          let outputBytes = 0;
          try {
            while (true) {
              const part = await boundedRace(iterator.next(), stop.signal);
              check();
              if (part.done) {
                if (reservation.status !== 'settled') throw new HybridUsageError();
                break;
              }
              outputBytes += Buffer.byteLength(JSON.stringify(part.value) || '');
              if (outputBytes > budget.outputTokens * 32 + 65536) throw new HybridPause('OPUS_RESPONSE_LIMIT', 'Opus response exceeded the host output limit; progress checkpointed.');
              // Private model reasoning never reaches QASE events or reports.
              if (part.value?.type !== 'reasoning' && part.value?.type !== 'reasoning_reset') yield part.value;
            }
          } catch (error) { throw modelFailure(error); }
          finally { clearTimeout(timeout); deadlines.delete(reservation.id); subscription.dispose(); cts.dispose(true); accounting.uncertain('reasoner', reservation); telemetry.metrics.reasoner.latencyMs += Math.max(0, (reservation.completedAt || Date.now()) - began); void iterator.return?.().catch?.(() => {}); await checkpoint(); }
        })();
      } catch (error) {
        clearTimeout(timeout); deadlines.delete(reservation.id); subscription.dispose(); cts.dispose(true);
        telemetry.metrics.reasoner.latencyMs += Date.now() - began;
        accounting.uncertain('reasoner', reservation); await checkpoint();
        throw modelFailure(error);
      }
    }
  };
}
