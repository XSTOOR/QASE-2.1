import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { validateHybridReport } from './qaCompletionGate.js';
import { remainingHybridWork, scenarioExecutionAccount } from './qaExecutionState.js';
import { createHybridScenarioTool } from './hybridQaTools.js';
import { HybridPause } from './hybridModelRouter.js';

function fixture(checks = ['media']) {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', ownerUserId: 'owner', targetUrl: 'https://fixture.test/', selectedTests: checks, messages: [], findings: [], todos: [] };
  const record = {};
  const hybrid = createHybridRuntime({ session, record, profile: hybridProfile({ apiKey: 'fixture' }, { QASE_HYBRID_AUTONOMOUS_COMPLETION: 'true' }), runStore: { async commit() {} } });
  return { session, record, hybrid, state: session.hybrid, ledger: hybrid.ledger };
}

test('a later visible search invalidates an intact earlier absence on the same app URL', async () => {
  const f = fixture(['search']), scenario = f.state.scenarios[0];
  const observe = async search => {
    const action = await f.ledger.beginAction('browser_qa_check', { action: 'inspect' });
    return f.ledger.record(action, { success: true, inventory: { url: f.session.targetUrl, search, readiness: { ready: true } } });
  };
  const absent = await observe([]);
  f.state.exploration.routes.push({ status: 'tested', url: f.session.targetUrl, absentChecks: [{ category: 'search', evidenceId: absent.id }] });
  assert.equal(scenarioExecutionAccount(f.session, scenario).absent, true);
  scenario.status = 'not_executed';
  await observe([{ selector: '#projects-search', label: 'Search projects' }]);
  assert.equal(scenarioExecutionAccount(f.session, scenario).absent, false);
  assert.equal(remainingHybridWork(f.session).scenarios.length, 1);
  assert.throws(() => validateHybridReport(f.session, { verdict: 'partial' }), { code: 'HYBRID_EXECUTION_PENDING' });
});

test('unsupported terminal prose and discovery-only receipts cannot discharge a supported test obligation', async () => {
  const f = fixture(), scenario = f.state.scenarios[0];
  await f.ledger.start(scenario.id);
  const action = await f.ledger.beginAction('browser_qa_check', { action: 'inspect' });
  await f.ledger.record(action, { success: true, inventory: { url: f.session.targetUrl } });
  await assert.rejects(f.ledger.close(scenario.id, 'not_executed', 'Nothing to test'), /actual attempt/);
  scenario.status = 'not_executed'; // Corrupt/stale checkpoint cannot bypass the independent report gate.
  assert.throws(() => validateHybridReport(f.session, { verdict: 'partial' }), { code: 'HYBRID_EXECUTION_PENDING' });
  assert.equal(remainingHybridWork(f.session).scenarios.length, 1);
});

test('fixed checks restore a unique validated owner; arbitrary clicks remain denied', async () => {
  const f = fixture(), scenario = f.state.scenarios[0];
  let clicks = 0;
  await assert.rejects(f.hybrid.wrapTool({ name: 'browser_click', run() { clicks++; } }).run({ selector: '#arbitrary' }), /validated QA scenario/);
  assert.equal(clicks, 0);
  scenario.status = 'not_executed'; // Reopen an unexecuted disposition, never a completed action.
  const base = { name: 'browser_qa_check', parametersSchema: { properties: {} }, async run() { assert.equal(f.state.currentScenarioId, scenario.id); return { success: true, action: 'media', assertions: [] }; } };
  await f.hybrid.wrapTool(createHybridScenarioTool(base)).run({ scenario_id: scenario.id, action: 'media' });
  assert.equal(scenario.status, 'inconclusive');
  await assert.rejects(f.hybrid.wrapTool(createHybridScenarioTool(base)).run({ scenario_id: scenario.id, action: 'media' }), /completed scenarios/);
  assert.equal(f.state.actions.length, 1);
});

test('scenario mutations serialize behind browser work and cannot close it mid-dispatch', async () => {
  const f = fixture(); let unblock, began;
  const entered = new Promise(resolve => { began = resolve; });
  const tool = f.hybrid.wrapTool({ name: 'browser_qa_check', parametersSchema: { properties: {} }, async run() { began(); await new Promise(resolve => { unblock = resolve; }); return { success: true, action: 'media' }; } });
  const executing = tool.run({ action: 'media' }); await entered;
  const closing = f.hybrid.wrapTool(f.hybrid.tools.find(tool => tool.name === 'qa_close_scenario')).run({ scenario_id: f.state.scenarios[0].id, disposition: 'inconclusive', reason: 'Host media check has no eligible images.' });
  assert.equal(f.state.scenarios[0].status, 'running'); unblock(); await executing; await closing;
  assert.equal(f.state.scenarios[0].status, 'inconclusive'); assert.equal(f.state.currentScenarioId, undefined);
});

test('lost active pointer is restored from one running scenario at the next SDK segment', async () => {
  const f = fixture(); await f.ledger.start(f.state.scenarios[0].id); delete f.state.currentScenarioId;
  await f.hybrid.beginTurn(new AbortController().signal);
  assert.equal(f.state.currentScenarioId, f.state.scenarios[0].id); await f.hybrid.endTurn('awaiting_input');
});

test('new assertions permit eleven SDK segments; changing snapshot text cannot hide a stall', async () => {
  const f = fixture();
  for (let index = 0; index < 11; index++) {
    const before = f.hybrid.segmentProgress();
    await f.ledger.start(f.state.scenarios[0].id);
    const action = await f.ledger.beginAction('browser_qa_check', {action:'media'});
    await f.ledger.record(action, { success: true, url: f.session.targetUrl, assertions:[{check:'media',name:`Image ${index} decoded`,expected:true,actual:true,outcome:'pass'}] });
    assert.equal((await f.hybrid.continueSegment(before)).continue, true);
  }
  for (let index = 0; index < 3; index++) {
    const before=f.hybrid.segmentProgress();
    const action=await f.ledger.beginAction('browser_snapshot',{});
    await f.ledger.record(action,{success:true,url:f.session.targetUrl,text:`Clock ticker ${index}`});
    assert.equal((await f.hybrid.continueSegment(before)).continue,index<2);
  }
  assert.equal(f.session.report, undefined); assert.equal(f.state.budgetFinalizing, undefined);
});

test('classifier failure cannot discard completed browser evidence or own scenario lifecycle', async () => {
  const f = fixture(); f.hybrid.router.classifier = async () => { throw new HybridPause('JEV_CLASSIFICATION_SCHEMA', 'Malformed classifier fixture'); };
  const tool = f.hybrid.wrapTool(createHybridScenarioTool({ name: 'browser_qa_check', parametersSchema: { properties: {} }, async run() { return { success: true, action: 'media', gaps: ['Fixture image readiness unavailable'], assertions: [] }; } }));
  await assert.rejects(tool.run({ scenario_id: f.state.scenarios[0].id, action: 'media' }), /Malformed classifier/);
  assert.equal(f.state.actions[0].status, 'done'); assert.equal(f.state.scenarios[0].status, 'inconclusive');
  assert.equal(f.state.currentScenarioId, undefined); assert.equal(f.record.hybridPause.code, 'JEV_CLASSIFICATION_SCHEMA');
});

test('a single observed untested route blocks publication just like a multi-route frontier', async () => {
  const f = fixture(['content']); await f.ledger.close(f.state.scenarios[0].id, 'blocked', 'No copy specification.');
  f.state.scope.push('media');
  f.state.exploration.routes.push({ id: 'entry', status: 'pending', url: f.session.targetUrl });
  assert.throws(() => validateHybridReport(f.session, { verdict: 'partial' }), { code: 'HYBRID_DEPTH_PENDING' });
});

test('SDK conversation compaction keeps its summary contract and cannot trigger host execution decisions', async () => {
  const f = fixture(); f.state.budgetFinalizing = true;
  let seen;
  const service = { async chat() { throw new Error('Mock router owns fixture transport'); } };
  f.hybrid.router.reasoner = async (_original, messages, options) => {
    seen = { messages, options };
    return (async function* () { yield { type: 'text', content: 'Durable progress summary.' }; })();
  };
  f.hybrid.wrapChat(service);
  const messages = [{ role: 'system', content: 'Create a continuation summary.' }];
  const stream = await service.chat(messages, { maxOutputTokens: 2048 });
  const parts = []; for await (const part of stream) parts.push(part);
  assert.deepEqual(seen.messages, messages); assert.deepEqual(seen.options.tools, []);
  assert.equal(seen.options.maxOutputTokens, 2048);
  assert.deepEqual(parts, [{ type: 'text', content: 'Durable progress summary.' }]);
  assert.equal(f.session.pendingQuestion, undefined); assert.equal(f.session.report, undefined);
});

test('an executed no-media outcome is accounted and cannot be reopened into a repetition loop', async () => {
  const f = fixture(); const scenario = f.state.scenarios[0];
  await f.ledger.start(scenario.id);
  const action = await f.ledger.beginAction('browser_qa_check', { action: 'media' });
  await f.ledger.record(action, { success: true, action: 'media', assertions: [], limitations: 'No eligible media observed.' });
  await f.ledger.close(scenario.id, 'inconclusive', 'No eligible media observed.');
  assert.deepEqual(remainingHybridWork(f.session).scenarios, []);
  await assert.rejects(f.ledger.start(scenario.id), /already has an evidence-accounted outcome/);
  assert.equal(f.state.currentScenarioId, undefined);
  assert.equal(validateHybridReport(f.session, { verdict: 'blocked' }).verdict, 'blocked');
});

test('pre-dispatch readiness refusal and loading-shell absence cannot discharge a test', async () => {
  const f = fixture(); const scenario = f.state.scenarios[0]; await f.ledger.start(scenario.id);
  const action = await f.ledger.beginAction('browser_qa_check', { action: 'media' });
  const receipt = await f.ledger.record(action, { success: false, dispatched: false, code: 'QA_PAGE_NOT_READY', inventory: { url: f.session.targetUrl, readiness: { ready: false }, images: 0, players: 0 } });
  f.state.exploration.routes.push({ status: 'tested', url: f.session.targetUrl, absentChecks: [{ category: 'media', evidenceId: receipt.id }] });
  await assert.rejects(f.ledger.close(scenario.id, 'inconclusive', 'No media'), /actual attempt/);
  assert.equal(remainingHybridWork(f.session).scenarios.length, 1);
  assert.throws(() => validateHybridReport(f.session, { verdict: 'partial' }));
  await f.ledger.close(scenario.id, 'blocked', 'Host readiness check could not observe the rendered application.');
  assert.equal(validateHybridReport(f.session, { verdict: 'blocked' }).verdict, 'blocked');
  const refresh = await f.ledger.beginAction('browser_qa_check', { action: 'inspect' });
  await f.ledger.record(refresh, { success: true, inventory: { url: f.session.targetUrl, readiness: { ready: true } } });
  assert.equal(remainingHybridWork(f.session).scenarios.length, 1, 'A fresh rendered state invalidates the stale loading blocker.');
  await f.ledger.start(scenario.id); assert.equal(scenario.status, 'running');
});
