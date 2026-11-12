import test from 'node:test';
import assert from 'node:assert/strict';
import { createFounderActionController } from './founderActions.js';

const session = id => ({ id, ownerUserId: 'owner', mode: 'founder', founder: { finalizedAt: 'published', report: {} } });
const saved = id => ({ runId: id, reviewKey: `publication-${id}`, revision: 0, selections: [], recommendationSet: { recommendations: [{ id: 'rec-1' }] } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture(api, onExport = async () => {}) {
  let current = session('a'), changes = 0;
  const controller = createFounderActionController({ api, getSession: () => current, onChange() { changes++; }, onExport, schedule() {}, cancel() {} });
  return { controller, set session(next) { current = next; }, get changes() { return changes; } };
}

test('a late load or write from another run cannot replace the visible report selection', async () => {
  const firstRead = deferred(), write = deferred(); let aReads = 0;
  const f = fixture(async (path, options = {}) => {
    if (options.method === 'PATCH') return write.promise;
    if (path.includes('runId=a') && aReads++ === 0) return firstRead.promise;
    return { state: saved(path.includes('runId=b') ? 'b' : 'a') };
  });
  const loadA = f.controller.load(); f.session = session('b'); await f.controller.load();
  firstRead.resolve({ state: saved('a') }); await loadA;
  assert.equal(f.controller.snapshot().state.runId, 'b');
  f.session = session('a'); const selecting = f.controller.select(['rec-1']); f.session = session('b');
  const before = f.changes; write.resolve({ state: { ...saved('a'), revision: 1, selections: ['rec-1'] } }); await selecting;
  assert.equal(f.controller.snapshot().state.runId, 'b'); assert.equal(f.changes, before);
  f.session = session('a'); assert.deepEqual(f.controller.snapshot().state.selections, ['rec-1']);
});

test('a delivery update during the initial read refreshes the saved receipt without submitting anything', async () => {
  const pendingRead = deferred(), receiptRead = deferred(), requests = [];
  const f = fixture(async (path, options) => {
    requests.push({ path, method: options.method });
    return requests.length === 1 ? pendingRead.promise : receiptRead.promise;
  });
  const opening = f.controller.load();
  await f.controller.load({ force: true });
  pendingRead.resolve({ state: { ...saved('a'), automaticHandoff: true } });
  await opening;
  assert.equal(requests.length, 2);
  receiptRead.resolve({ state: { ...saved('a'), automaticHandoff: true, revision: 2, handoff: { status: 'succeeded', reference: 'studio-job' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.controller.snapshot().state.handoff.reference, 'studio-job');
  await f.controller.select(['rec-1']);
  assert.ok(requests.every(({ path, method }) => path === '/founder/state?runId=a' && method === undefined));
});

test('pending saves and sends are synchronous guards; selection changes never deliver', async () => {
  const saveGate = deferred(), sendGate = deferred(), calls = []; let state = saved('a');
  const f = fixture(async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'PATCH') { await saveGate.promise; state = { ...state, revision: 1, selections: ['rec-1'] }; return { state }; }
    if (options.method === 'POST') { await sendGate.promise; return { state: { ...state, revision: 3, handoff: { status: 'succeeded' } } }; }
    return { state };
  });
  await f.controller.load(); const selecting = f.controller.select(['rec-1']);
  await f.controller.select([]); await f.controller.send(); assert.equal(f.controller.snapshot().saving, true);
  assert.equal(calls.filter(call => call.options.method === 'PATCH').length, 1); assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
  saveGate.resolve(); await selecting;
  const sending = f.controller.send(); await f.controller.send(); await f.controller.select([]);
  assert.equal(f.controller.snapshot().state.handoff.status, 'pending'); assert.equal(f.controller.snapshot().sending, true);
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1); sendGate.resolve(); await sending;
  assert.equal(f.controller.snapshot().state.handoff.status, 'succeeded');
  const body = JSON.parse(calls.find(call => call.options.method === 'POST').options.body);
  assert.deepEqual(body, { runId: 'a', reviewKey: 'publication-a', expectedRevision: 1, selectedRecommendationIds: ['rec-1'] });
});

test('failed saves keep the acknowledged state and expose explicit retry; conflicts require reviewing the latest selection', async () => {
  let fail = true, conflict = false, writes = 0, state = saved('a');
  const f = fixture(async (_path, options = {}) => {
    if (options.method === 'PATCH') {
      writes++;
      if (fail) { const error = new Error('Unavailable'); error.status = conflict ? 409 : 503; if (conflict) state = { ...state, revision: 1, selections: ['other-tab'] }; throw error; }
      state = { ...state, revision: state.revision + 1, selections: JSON.parse(options.body).selectedRecommendationIds };
    }
    return { state };
  });
  await f.controller.load(); await f.controller.select(['rec-1']);
  assert.deepEqual(f.controller.snapshot().state.selections, []); assert.equal(f.controller.snapshot().canRetrySelection, true);
  fail = false; await f.controller.retrySelection(); assert.deepEqual(f.controller.snapshot().state.selections, ['rec-1']); assert.equal(writes, 2);
  fail = conflict = true; await f.controller.select([]);
  assert.equal(f.controller.snapshot().canRetrySelection, false); assert.deepEqual(f.controller.snapshot().state.selections, ['other-tab']);
});

test('export is explicit, never sends, ignores navigation and gives a download fallback after clipboard failure', async () => {
  const exportGate = deferred(), exported = []; let state = { ...saved('a'), selections: ['rec-1'] }, block = true;
  const f = fixture(async (_path, options = {}) => {
    if (options.method === 'POST') { assert.equal(JSON.parse(options.body).export, true); if (block) await exportGate.promise; return { payload: { sourceRunId: state.runId } }; }
    return { state };
  }, async (mode, payload) => { if (mode === 'copy') throw new Error('Clipboard permission denied'); exported.push(payload); });
  await f.controller.load(); const exporting = f.controller.export('download'); f.session = session('b'); exportGate.resolve(); await exporting; assert.deepEqual(exported, []);
  f.session = session('a'); block = false; await f.controller.export('copy'); assert.match(f.controller.snapshot().error, /Download requirements/);
  await f.controller.export('download'); assert.deepEqual(exported, [{ sourceRunId: 'a' }]); assert.match(f.controller.snapshot().notice, /No build was started/);
});

test('a lost send response reconciles a saved acceptance without redelivery or a contradictory error', async () => {
  let state={...saved('a'),selections:['rec-1']},posts=0;
  const f=fixture(async (_path,options={})=>{assert.ok(options.signal);if(options.method==='POST'){posts++;state={...state,revision:2,handoff:{status:'succeeded',reference:'accepted-before-disconnect'}};throw new Error('Connection closed');}return {state};});
  await f.controller.load();await f.controller.send();
  assert.equal(posts,1);assert.equal(f.controller.snapshot().error,undefined);assert.equal(f.controller.snapshot().state.handoff.reference,'accepted-before-disconnect');
});
