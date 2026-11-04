import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { hybridProfile } from './hybridConfig.js';
import { createHybridTelemetry } from './hybridTelemetry.js';
import { createHybridModelRouter } from './hybridModelRouter.js';
import { createHybridBudgetLedger, reconcileLegacyBudget } from './hybridBudgetLedger.js';

function fixture() {
  const session = { id: randomUUID(), hybrid: {} }, profile = hybridProfile({ apiKey: 'fixture-key' }, {});
  const telemetry = createHybridTelemetry(session.hybrid);
  let durable;
  const checkpoint = async () => { durable = structuredClone(session); };
  const router = createHybridModelRouter({ session, profile, telemetry, checkpoint });
  return { session, profile, telemetry, router, checkpoint, saved: () => durable };
}
async function call(f, usage = { inputTokens: 24000, outputTokens: 100 }, messages = [{ content: 'x'.repeat(70000) }]) {
  const stream = await f.router.reasoner(async (_messages, options) => (async function* () {
    f.router.reasonerUsage({ ...usage, callId: randomUUID(), reservationId: options.qaseBudgetReservationId });
    yield { type: 'text', content: 'Observed.' };
  })(), messages);
  for await (const _part of stream) { /* consume SDK-facing stream */ }
}

test('completed calls settle conservative reservations rather than falsely exhausting the token budget', async () => {
  const f = fixture();
  // Old code paused on call four; exact cumulative use is well below 300k.
  for (let i = 0; i < 6; i++) await call(f);
  assert.equal(f.telemetry.metrics.reasoner.calls, 6);
  assert.equal(f.telemetry.metrics.reasoner.inputTokens + f.telemetry.metrics.reasoner.outputTokens, 144600);
  assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 0);
  assert.equal(f.saved().hybrid.modelBudget.roles.reasoner.reservations.filter(item => item.status === 'settled').length, 6);
});

test('real usage, pending exposure and call limits still prevent another dispatch', async () => {
  const f = fixture(); f.profile.budgets.reasonerTokens = 90000;
  await call(f); let dispatched = false;
  await assert.rejects(f.router.reasoner(async () => { dispatched = true; }, [{ content: 'x'.repeat(70000) }]), error => error.code === 'HYBRID_MODEL_BUDGET');
  assert.equal(dispatched, false); assert.equal(f.telemetry.metrics.reasoner.calls, 1);
  f.profile.budgets.reasonerTokens = 300000; f.profile.budgets.reasonerCalls = 1;
  await assert.rejects(call(f), error => error.code === 'HYBRID_MODEL_BUDGET');
});

test('actual provider overrun pauses before any tool is released and never estimates authoritative usage', async () => {
  const f = fixture(); f.profile.budgets.reasonerTokens = 10000;
  let released = false;
  const stream = await f.router.reasoner(async (_messages, options) => (async function* () {
    f.router.reasonerUsage({ reservationId: options.qaseBudgetReservationId, callId: 'overrun', inputTokens: 10001, outputTokens: 1 });
    yield { type: 'tool_call', call: { toolName: 'browser_click', input: {} } };
  })(), []);
  await assert.rejects(async () => { for await (const _part of stream) released = true; }, error => error.code === 'HYBRID_MODEL_BUDGET');
  assert.equal(released, false); assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 0);
  assert.equal(f.saved().hybrid.telemetry.reasoner.inputTokens, 10001);
});

test('duplicate receipts are idempotent; conflicting, estimated, orphan and reused receipts fail closed', () => {
  const f = fixture(); const ledger = createHybridBudgetLedger(f.session.hybrid, f.telemetry);
  const first = ledger.begin('reasoner', 1000), second = ledger.begin('reasoner', 1000);
  const receipt = { callId: 'one', inputTokens: 10, outputTokens: 2, totalTokens: 12 };
  assert.equal(ledger.settle('reasoner', first.id, receipt), true);
  assert.equal(ledger.settle('reasoner', first.id, receipt), false);
  for (const [id, usage] of [[first.id, { ...receipt, inputTokens: 11 }], [second.id, receipt], ['unknown', receipt], [second.id, { ...receipt, estimated: true }]]) assert.throws(() => ledger.settle('reasoner', id, usage));
  assert.equal(f.telemetry.metrics.reasoner.inputTokens, 10);
  assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 1000);
});

test('cancelled, timed-out and missing-usage calls retain exposure across recovery; no automatic replay', async () => {
  for (const kind of ['timeout', 'missing', 'cancelled']) {
    const f = fixture(); f.profile.budgets.reasonerTimeoutMs = 10;
    if (kind === 'timeout') await assert.rejects(f.router.reasoner(() => new Promise(() => {}), []), error => error.code === 'OPUS_TIMEOUT');
    else {
      const stream = await f.router.reasoner(async () => (async function* () { if (kind === 'cancelled') throw new Error('Cancelled'); })(), []);
      await assert.rejects(async () => { for await (const _part of stream) {} });
    }
    const saved = f.saved(), before = saved.hybrid.telemetry.reasoner.reservedTokens;
    assert.ok(before > 0); assert.equal(saved.hybrid.telemetry.reasoner.inputTokens, 0);
    const recovered = createHybridModelRouter({ session: saved, profile: f.profile, telemetry: createHybridTelemetry(saved.hybrid), checkpoint: async () => {} });
    await assert.rejects(recovered.reasoner(async () => { throw Error('Must not dispatch'); }, []), error => error.code === 'HYBRID_USAGE_UNRESOLVED');
    assert.equal(saved.hybrid.telemetry.reasoner.reservedTokens, before);
  }
});

test('settled usage survives runtime reconstruction and does not reset pinned budgets or calls', async () => {
  const f = fixture(); await call(f);
  const saved = f.saved(), telemetry = createHybridTelemetry(saved.hybrid);
  const recovered = createHybridModelRouter({ session: saved, profile: f.profile, telemetry, checkpoint: async () => {} });
  recovered.check(); assert.equal(telemetry.metrics.reasoner.calls, 1); assert.equal(telemetry.metrics.reasoner.inputTokens, 24000);
  assert.equal(telemetry.metrics.reasoner.reservedTokens, 0); assert.equal(f.profile.budgets.reasonerTokens, 300000);
});

test('parallel classifier responses settle their own reservations even out of order', async () => {
  const f = fixture(); const releases = [];
  const router = createHybridModelRouter({ ...f, checkpoint: f.checkpoint, fetchImpl: async () => {
    const index = releases.length;
    await new Promise(resolve => releases.push(resolve));
    return Response.json({ model: 'typesafe/jev-1.13-20260917', answers: { state: { type: 'noul', noul: 0.5 } }, usage: { input_tokens: index + 10, output_tokens: 2 } });
  } });
  const q = { state: { type: 'noul', instructions: 'Is this known?' } };
  const first = router.classifier({ text: 'a' }, q), second = router.classifier({ text: 'b'.repeat(200) }, q);
  await new Promise(resolve => setTimeout(resolve, 0));
  releases[1](); await second; assert.ok(f.telemetry.metrics.classifier.reservedTokens > 0);
  releases[0](); await first;
  assert.equal(f.telemetry.metrics.classifier.inputTokens, 21); assert.equal(f.telemetry.metrics.classifier.reservedTokens, 0);
});

test('legacy reconciliation requires every exact receipt; aggregate totals alone never release exposure', () => {
  const f = fixture(); delete f.session.hybrid.modelBudget;
  Object.assign(f.telemetry.metrics.reasoner, { calls: 3, inputTokens: 76666, outputTokens: 551, reservedTokens: 234321, usageReported: true });
  const ledger = createHybridBudgetLedger(f.session.hybrid, f.telemetry);
  assert.equal(ledger.unresolved('reasoner'), true);
  const receipts = [[23966, 104], [24249, 46], [28451, 401]].map(([inputTokens, outputTokens], i) => ({ callId: `exact-${i}`, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: false }));
  const digest = 'a'.repeat(64);
  assert.throws(() => reconcileLegacyBudget(f.session.hybrid, 'reasoner', receipts.slice(0, 2), digest));
  assert.throws(() => reconcileLegacyBudget(f.session.hybrid, 'reasoner', receipts.map(item => ({ ...item, inputTokens: 1 })), digest));
  assert.throws(() => reconcileLegacyBudget(f.session.hybrid, 'reasoner', receipts.map(item => ({ ...item, estimated: true })), digest));
  assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 234321);
  reconcileLegacyBudget(f.session.hybrid, 'reasoner', receipts, digest);
  assert.equal(ledger.unresolved('reasoner'), false); assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 0);
  assert.equal(f.telemetry.metrics.reasoner.calls, 3); assert.equal(f.telemetry.metrics.reasoner.inputTokens, 76666);
});

test('offline repair dry-run preserves history; explicit apply backs up history and changes no limits or evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-budget-repair-test-'));
  const f = fixture(); delete f.session.hybrid.modelBudget;
  Object.assign(f.telemetry.metrics.reasoner, { calls: 3, inputTokens: 76666, outputTokens: 551, reservedTokens: 234321, usageReported: true });
  Object.assign(f.session, { mode: 'qa', qaExecutionMode: 'hybrid', status: 'interrupted', findings: [{ id: 'preserved' }] });
  f.session.hybrid.budgets = structuredClone(f.profile.budgets);
  f.session.hybrid.evidence = [{ id: 'real-existing-evidence' }];
  const receipts = [[23966, 104], [24249, 46], [28451, 401]].map(([inputTokens, outputTokens], i) => ({ event: 'token_usage_commit', runId: f.session.id, callId: `exact-${i}`, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: false }));
  const log = path.join(root, 'host.log'), history = path.join(root, '.qase', 'sessions.json');
  fs.mkdirSync(path.dirname(history)); fs.writeFileSync(history, JSON.stringify([f.session]));
  fs.writeFileSync(log, receipts.map(item => JSON.stringify(item)).join('\n'));
  const before = fs.readFileSync(history, 'utf8'), script = new URL('../scripts/reconcile-hybrid-budget.mjs', import.meta.url);
  const server = net.createServer(socket => socket.end()); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = String(server.address().port);
  const run = args => spawnSync(process.execPath, [script.pathname, f.session.id, log, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'development', QASE_RUN_STORE: 'local', PORT: port } });
  const dry = run([]); assert.equal(dry.status, 0, dry.stderr); assert.equal(fs.readFileSync(history, 'utf8'), before);
  assert.equal(JSON.parse(dry.stdout).applied, false);
  const online = run(['--apply']); assert.notEqual(online.status, 0); assert.match(online.stderr, /Stop the local server/);
  assert.equal(fs.readFileSync(history, 'utf8'), before);
  await new Promise(resolve => server.close(resolve));
  const apply = run(['--apply']); assert.equal(apply.status, 0, apply.stderr);
  const result = JSON.parse(apply.stdout), saved = JSON.parse(fs.readFileSync(history, 'utf8'))[0];
  assert.equal(result.applied, true); assert.equal(result.runStarted, false); assert.equal(fs.readFileSync(result.backup, 'utf8'), before);
  assert.deepEqual(saved.hybrid.budgets, f.profile.budgets); assert.deepEqual(saved.hybrid.evidence, f.session.hybrid.evidence); assert.deepEqual(saved.findings, f.session.findings);
  assert.equal(saved.status, 'interrupted'); assert.equal(saved.hybrid.telemetry.reasoner.calls, 3); assert.equal(saved.hybrid.telemetry.reasoner.reservedTokens, 0);
  assert.equal(saved.hybrid.modelBudget.roles.reasoner.reconciliation.receipts.length, 3);
  const duplicate = run(['--apply']); assert.notEqual(duplicate.status, 0); assert.match(duplicate.stderr, /Complete exact host receipts/);
});

test('configured classifier degradation retains unresolved exposure but does not silently dispatch more requests', async () => {
  const f = fixture(); f.profile.allowWithoutClassifier = true; let requests = 0;
  const router = createHybridModelRouter({ ...f, fetchImpl: async () => { requests++; throw new Error('Unavailable'); } });
  const q = { state: { type: 'noul', instructions: 'Is this known?' } };
  assert.equal(await router.classifier({}, q), null);
  const reserved = f.telemetry.metrics.classifier.reservedTokens;
  assert.equal(await router.classifier({}, q), null); router.check();
  assert.equal(requests, 1); assert.ok(reserved > 0); assert.equal(f.telemetry.metrics.classifier.reservedTokens, reserved);
});

test('model response deadline ends at its verified receipt, not while the SDK executes a long browser batch', async () => {
  const f = fixture(); f.profile.budgets.reasonerTimeoutMs = 10;
  const stream = await f.router.reasoner(async (_messages, options) => (async function* () {
    f.router.reasonerUsage({ reservationId: options.qaseBudgetReservationId, callId: 'completed-stream', inputTokens: 30, outputTokens: 10 });
    yield { type: 'tool_call', call: { id: 'long-batch', toolName: 'qa_test_routes', input: {} } };
  })(), []);
  const iterator = stream[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'tool_call');
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal((await iterator.next()).done, true);
  assert.equal(f.telemetry.metrics.reasoner.reservedTokens, 0);
  assert.equal(f.telemetry.metrics.reasoner.inputTokens, 30);
});
