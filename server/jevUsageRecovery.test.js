import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevClient } from './jevClient.js';
import { createHybridModelRouter } from './hybridModelRouter.js';
import { createHybridTelemetry } from './hybridTelemetry.js';
import { hybridProfile } from './hybridConfig.js';
import { hybridRecoveryProblem } from './hybridRecoveryGate.js';

const questions = { state: { type: 'noul', instructions: 'Classify immutable evidence.' } };
const reply = (answers = { state: { type: 'noul', noul: 0.7 } }, usage = { input_tokens: 17, output_tokens: 3 }) => Response.json({ id: 'fixture-receipt', model: 'jev-1.13', answers, usage });
function fixture(fetchImpl, options = {}) {
  const session = { id: 'receipt-fixture', hybrid: {} }, profile = hybridProfile({ apiKey: 'fixture-key' }, {});
  const telemetry = createHybridTelemetry(session.hybrid);
  let saved, dispatches = 0;
  const router = createHybridModelRouter({ session, profile, telemetry, checkpoint: async () => { saved = structuredClone(session); },
    fetchImpl: async (...args) => { dispatches++; return fetchImpl(...args); }, ...options });
  return { session, profile, telemetry, router, saved: () => saved, dispatches: () => dispatches };
}

test('a malformed answer cannot discard an exact provider usage receipt', async () => {
  const f = fixture(() => reply({}));
  await assert.rejects(f.router.classifier({}, questions), { code: 'JEV_RESPONSE_INVALID' });
  assert.equal(f.telemetry.metrics.classifier.inputTokens, 17);
  assert.equal(f.telemetry.metrics.classifier.outputTokens, 3);
  assert.equal(f.telemetry.metrics.classifier.reservedTokens, 0);
  assert.equal(f.saved().hybrid.modelBudget.roles.classifier.reservations[0].status, 'settled');
  f.router.check();
  const failure = f.saved().hybrid.telemetry.events.find(item => item.type === 'classification_failed');
  assert.equal(failure.stage, 'answers'); assert.equal(failure.usageVerified, true);
});

test('locally invalid classifier requests consume no call or usage reservation', async () => {
  const f = fixture(() => { throw Error('Must not dispatch'); });
  for (const [state, schema] of [[{}, {}], [{ text: 'x'.repeat(200001) }, questions]]) {
    await assert.rejects(f.router.classifier(state, schema));
    f.router.check();
  }
  assert.equal(f.dispatches(), 0);
  assert.equal(f.telemetry.metrics.classifier.calls, 0);
  assert.equal(f.telemetry.metrics.classifier.reservedTokens, 0);
});

test('cancellation after receipt parsing retains authoritative usage without releasing output', async () => {
  const controller = new AbortController(), receipts = [];
  const client = createJevClient({ apiKey: 'fixture' }, { fetchImpl: async () => reply() });
  await assert.rejects(client.decide({}, questions, { signal: controller.signal,
    onUsageReceipt: receipt => { receipts.push(receipt); controller.abort(new Error('Stopped by fixture')); }
  }), /Stopped by fixture/);
  assert.equal(receipts.length, 1); assert.equal(receipts[0].totalTokens, 20);
});

test('HTTP rejection records a safe diagnostic and retains unknown exposure across resume', async () => {
  const f = fixture(() => Response.json({ error: 'sensitive upstream body' }, { status: 429 }));
  await assert.rejects(f.router.classifier({}, questions), { code: 'JEV_HTTP_REJECTED' });
  assert.throws(() => f.router.check(), { code: 'HYBRID_USAGE_UNRESOLVED' });
  const failure = f.saved().hybrid.telemetry.events.find(item => item.type === 'classification_failed');
  assert.equal(failure.httpStatus, 429); assert.equal(failure.stage, 'transport'); assert.equal(failure.usageVerified, false);
  assert.equal(JSON.stringify(failure).includes('sensitive'), false);
  const saved = f.saved();
  const restored = createHybridModelRouter({ session: saved, profile: f.profile, telemetry: createHybridTelemetry(saved.hybrid), checkpoint: async () => {}, fetchImpl: () => { throw Error('No replay'); } });
  await assert.rejects(restored.classifier({}, questions), { code: 'HYBRID_USAGE_UNRESOLVED' });
  assert.equal(f.dispatches(), 1);
});

test('missing, fractional, unsafe, estimated and inconsistent usage cannot settle a reservation', async () => {
  for (const usage of [undefined, { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 2 },
    { input_tokens: 2, output_tokens: 1, estimated: true }, { input_tokens: 2, output_tokens: 1, total_tokens: 99 }]) {
    const f = fixture(() => usage === undefined ? Response.json({ model: 'jev-1.13', answers: {} }) : reply(undefined, usage));
    await assert.rejects(f.router.classifier({}, questions), { code: 'JEV_USAGE_UNVERIFIED' });
    assert.equal(f.telemetry.metrics.classifier.inputTokens, 0);
    assert.ok(f.telemetry.metrics.classifier.reservedTokens > 0);
  }
});

test('a checkpoint failure before dispatch releases only the provably undispatched reservation', async () => {
  const f = fixture(() => { throw Error('Must not dispatch'); });
  let checkpoints = 0;
  const router = createHybridModelRouter({ session: f.session, profile: f.profile, telemetry: f.telemetry,
    checkpoint: async () => { if (++checkpoints === 1) throw Error('Fixture disk unavailable'); }, fetchImpl: () => { throw Error('Must not dispatch'); } });
  await assert.rejects(router.classifier({}, questions));
  assert.equal(f.telemetry.metrics.classifier.calls, 0);
  assert.equal(f.telemetry.metrics.classifier.reservedTokens, 0);
  assert.equal(f.session.hybrid.modelBudget.roles.classifier.reservations[0].status, 'not_dispatched');
  router.check();
});

test('recovery preflight preserves explicit degradation policy, unresolved exposure and existing modes', () => {
  const f = fixture(() => reply()); Object.assign(f.session, { mode: 'qa', qaExecutionMode: 'hybrid', status: 'interrupted' });
  f.session.hybrid.modelBudget.roles.classifier.reservations.push({ id: 'unknown', status: 'pending', tokens: 100 });
  assert.equal(hybridRecoveryProblem(f.session).code, 'HYBRID_USAGE_UNRESOLVED');
  f.session.hybrid.allowWithoutClassifier = true;
  assert.equal(hybridRecoveryProblem(f.session), null);
  for (const mode of ['sqa', 'founder']) assert.equal(hybridRecoveryProblem({ ...f.session, mode }), null);
  assert.equal(hybridRecoveryProblem({ ...f.session, qaExecutionMode: 'legacy' }), null);
  f.session.hybrid.budgets = { durationMs: 10 }; f.session.hybrid.telemetry.elapsedMs = 11;
  assert.equal(hybridRecoveryProblem(f.session).code, 'HYBRID_TIME_BUDGET');
});
