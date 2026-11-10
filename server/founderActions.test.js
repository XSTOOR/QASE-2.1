import test from 'node:test';
import assert from 'node:assert/strict';
import { createFounderActions, founderActionSource } from './founderActions.js';

function report(id = 'run-a', owner = 'owner-a') {
  return { id, ownerUserId: owner, mode: 'founder', founder: { finalizedAt: '2026-11-08T00:00:00Z', scope: { target: { url: 'https://example.test/' }, productContext: { primaryGoal: id } }, report: { generatedAt: '2026-11-08T00:00:00Z', recommendationSet: { setVersion: 1, generatedAt: '2026-11-08T00:00:00Z' }, recommendations: [{ id: 'rec-1', title: `First ${id}`, acceptanceCriteria: ['Visible result'] }, { id: 'rec-2', title: `Second ${id}` }] } } };
}
function fixture(options = {}) {
  let state, failSave = false, clock = Date.parse('2026-11-08T01:00:00Z');
  const backend = { get: async () => structuredClone(state), save: async next => { if (failSave) throw new Error('Disk unavailable'); state = structuredClone(next); } };
  const service = createFounderActions({ backend, projectId: 'trusted-project', now: () => new Date(clock).toISOString(), ...options });
  return { service, backend, get state() { return state; }, set state(next) { state = structuredClone(next); }, set failSave(value) { failSave = value; }, advance: ms => { clock += ms; } };
}
const input = (state, ids = state.selections) => ({ runId: state.runId, reviewKey: state.reviewKey, expectedRevision: state.revision, selectedRecommendationIds: ids });
const conflict = error => error.status === 409;

test('selections bind to report content, run and owner even when IDs and schema versions repeat', async () => {
  const f = fixture(), a = report(), b = report('run-b'), other = report('run-c', 'other-owner');
  await f.service.publish(a);
  const saved = await f.service.select(a, input(await f.service.read(a), ['rec-2', 'rec-1', 'rec-1']));
  assert.deepEqual(saved.selections, ['rec-1', 'rec-2']);
  await f.service.publish(b); await f.service.publish(other); await f.service.publish(a);
  assert.deepEqual((await f.service.read(a)).selections, ['rec-1', 'rec-2']);
  assert.deepEqual((await f.service.read(b)).selections, []); assert.deepEqual((await f.service.read(other)).selections, []);
  const regenerated = structuredClone(a); regenerated.founder.report.recommendations[0].title = 'A different feature';
  assert.notEqual(founderActionSource(a).reviewKey, founderActionSource(regenerated).reviewKey);
  await assert.rejects(f.service.select(regenerated, input(saved, [])), conflict);
  assert.deepEqual((await f.service.read(regenerated)).selections, []);
});

test('concurrent edits have one winner; failed persistence preserves the saved selection', async () => {
  const f = fixture(), a = report(), start = await f.service.read(a);
  const results = await Promise.allSettled([f.service.select(a, input(start, ['rec-1'])), f.service.select(a, input(start, ['rec-2']))]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.find(item => item.status === 'rejected').reason.status, 409);
  const before = await f.service.read(a); f.failSave = true;
  await assert.rejects(f.service.select(a, input(before, [])), /Disk unavailable/);
  assert.deepEqual(await f.service.read(a), before);
});

test('legacy selection migration requires the exact publication and survives publishing another report first', async () => {
  const f = fixture(), a = report(), b = report('run-b');
  const { runId, reviewKey, ...legacy } = founderActionSource(a); f.state = { ...legacy, selections: ['rec-2'] };
  await f.service.publish(b);
  assert.deepEqual((await f.service.read(b)).selections, []);
  assert.deepEqual((await f.service.read(a)).selections, ['rec-2']);
  await f.service.publish(a); assert.deepEqual((await f.service.read(a)).selections, ['rec-2']);
});

test('handoff reserves atomically, blocks duplicate writes, and cannot overwrite another report published during delivery', async () => {
  let resolveDelivery, entered;
  const deliveryStarted = new Promise(resolve => { entered = resolve; });
  const deliveries = [];
  const f = fixture({ deliveryClient: { async deliver(target, payload, options) { deliveries.push({ target, payload, options }); entered(); return new Promise(resolve => { resolveDelivery = resolve; }); } }, target: '/fake' });
  const a = report(), b = report('run-b');
  const saved = await f.service.select(a, input(await f.service.read(a), ['rec-1']));
  const sending = f.service.send(a, input(saved)); await deliveryStarted;
  await assert.rejects(f.service.send(a, input(saved)), conflict);
  const pending = await f.service.read(a); assert.equal(pending.handoff.status, 'pending');
  await assert.rejects(f.service.select(a, input(pending, [])), conflict);
  await f.service.publish(b); await f.service.select(b, input(await f.service.read(b), ['rec-2']));
  resolveDelivery({ status: 202, reference: 'local-job-1' }); const result = await sending;
  assert.equal(result.state.handoff.status, 'succeeded'); assert.equal(result.state.handoff.reference, 'local-job-1');
  assert.deepEqual((await f.service.read(b)).selections, ['rec-2']);
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].payload.sourceRunId, a.id);
  assert.equal((await f.service.send(a, input(saved))).deduplicated, true); assert.equal(deliveries.length, 1);
});

test('delivery retries preserve the full payload and key; another report with repeated IDs has a different key', async () => {
  const calls = []; let fail = true;
  const f = fixture({ deliveryClient: { async deliver(target, payload, options) { calls.push({ payload, options }); if (fail) throw new Error('Timeout after possible acceptance'); return { status: 202 }; } } });
  const a = report(); const saved = await f.service.select(a, input(await f.service.read(a), ['rec-1']));
  await assert.rejects(f.service.send(a, input(saved)), error => error.code === 'handoff_failed');
  assert.deepEqual((await f.service.read(a)).selections, ['rec-1']);
  f.advance(30_000); fail = false; await f.service.send(a, input(await f.service.read(a)));
  assert.deepEqual(calls[0].payload, calls[1].payload); assert.equal(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
  assert.ok(calls[0].options.idempotencyKey.length <= 128);
  const b = report('run-b'); const next = await f.service.select(b, input(await f.service.read(b), ['rec-1'])); await f.service.send(b, input(next));
  assert.notEqual(calls[0].options.idempotencyKey, calls[2].options.idempotencyKey);
});

test('a confirmed upstream receipt followed by a failed local commit stays pending and retries idempotently after restart lease expiry', async () => {
  const calls = []; let f;
  f = fixture({ deliveryClient: { async deliver(_target, payload, options) { calls.push({ payload, options }); if (calls.length === 1) f.failSave = true; return { status: 202, reference: 'same-upstream-job' }; } } });
  const a = report(), saved = await f.service.select(a, input(await f.service.read(a), ['rec-1']));
  await assert.rejects(f.service.send(a, input(saved)), /Disk unavailable/);
  assert.equal((await f.service.read(a)).handoff.status, 'pending');
  f.failSave = false;
  await assert.rejects(f.service.send(a, input(await f.service.read(a))), error => error.code === 'handoff_pending');
  f.advance(600_001); assert.equal((await f.service.read(a)).leaseExpired, true);
  // Recreate the service over durable data to exercise process restart.
  const restarted = createFounderActions({ backend: f.backend, projectId: 'trusted-project', now: () => '2026-11-08T01:11:00Z', deliveryClient: { async deliver(_target, payload, options) { calls.push({ payload, options }); return { status: 202, reference: 'same-upstream-job' }; } } });
  const result = await restarted.send(a, input(await restarted.read(a)));
  assert.equal(result.state.handoff.status, 'succeeded'); assert.deepEqual(calls[0].payload, calls[1].payload);
  assert.equal(calls[0].options.idempotencyKey, calls[1].options.idempotencyKey);
});

test('export is read-only, preserves source identity and scrubs nested context arrays; unavailable delivery never claims a build', async () => {
  const f = fixture(), a = report(); a.founder.scope.projectContext = { items: [{ description: 'Visible', password: 'fixture-sensitive-value' }] };
  const saved = await f.service.select(a, input(await f.service.read(a), ['rec-1'])), before = structuredClone(f.state);
  const payload = await f.service.build(a, input(saved)); assert.equal(payload.sourceRunId, a.id); assert.equal(payload.recommendationSet.reviewKey, saved.reviewKey);
  assert.doesNotMatch(JSON.stringify(payload), /fixture-sensitive-value/); assert.deepEqual(f.state, before);
  const result = await f.service.send(a, input(saved)); assert.equal(result.unavailable, true); assert.equal(result.state.handoff.status, 'unavailable');
});

test('missing binding and unsaved selections cannot deliver, and unfinalized reports cannot be promoted', async () => {
  const f = fixture(), a = report(), saved = await f.service.read(a);
  await assert.rejects(f.service.select(a, { selectedRecommendationIds: ['rec-1'] }), conflict);
  await assert.rejects(f.service.send(a, input(saved, ['rec-1'])), error => error.code === 'selection_not_saved');
  await assert.rejects(f.service.select(a, input(saved, ['unknown'])), error => error.status === 400);
  delete a.founder.finalizedAt; await assert.rejects(f.service.read(a), error => error.code === 'report_unavailable');
});

test('changing selections retains earlier receipts and stable retry payloads for every intent', async () => {
  const calls=[];let fail=true;
  const f=fixture({deliveryClient:{async deliver(_target,payload,options){calls.push({payload,options});if(fail)throw new Error('Unconfirmed');return {status:202,body:{accepted:true,jobId:`job-${calls.length}`}};}}});
  const a=report();let current=await f.service.select(a,input(await f.service.read(a),['rec-1']));
  await assert.rejects(f.service.send(a,input(current)));fail=false;f.advance(20_000);
  current=await f.service.select(a,input(await f.service.read(a),['rec-2']));await f.service.send(a,input(current));
  current=await f.service.select(a,input(await f.service.read(a),['rec-1']));await f.service.send(a,input(current));
  assert.deepEqual(calls[0].payload,calls[2].payload);assert.equal(calls[0].options.idempotencyKey,calls[2].options.idempotencyKey);
  current=await f.service.select(a,input(await f.service.read(a),['rec-2']));
  assert.equal(current.handoff.reference,'job-2');assert.equal((await f.service.send(a,input(current))).deduplicated,true);assert.equal(calls.length,3);
});

test('an explicit upstream refusal cannot be presented as accepted even with HTTP 200', async () => {
  const f=fixture({deliveryClient:{async deliver(){return {status:200,body:{accepted:false}};}}}),a=report();
  const saved=await f.service.select(a,input(await f.service.read(a),['rec-1']));
  await assert.rejects(f.service.send(a,input(saved)),error=>error.code==='handoff_failed');
  assert.equal((await f.service.read(a)).handoff.status,'failed');
});

test('malformed saved action history fails without replacing or erasing it', async () => {
  const f=fixture(),a=report(); f.state={schemaVersion:2,actionRecords:{unexpected:'preserve'}};
  const before=structuredClone(f.state);
  await assert.rejects(f.service.read(a),/Invalid saved Founder/);
  await assert.rejects(f.service.publish(a),/Invalid saved Founder/);
  assert.deepEqual(f.state,before);
  const source=founderActionSource(a);f.state={schemaVersion:2,actionRecords:[{runId:source.runId,ownerUserId:source.ownerUserId,reviewKey:source.reviewKey,revision:0,selections:[],handoffs:[null]}]};
  const corrupt=structuredClone(f.state);await assert.rejects(f.service.select(a,{...source,expectedRevision:0,selectedRecommendationIds:['rec-1']}),/Invalid saved Founder/);assert.deepEqual(f.state,corrupt);
});
