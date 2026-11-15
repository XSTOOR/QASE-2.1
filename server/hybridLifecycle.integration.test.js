import './testWorkingDirectory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from './agent.js';
import { hybridProfile, profileIdentity, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION } from './hybridConfig.js';
import { JEV_ENDPOINT } from './jevClient.js';
import { withUserConfiguration } from './config.js';
import { createRuntimeApplicationServices } from './localServices.js';
import { modeReceiptHash } from './modeIntegrity.js';
import { hybridRecoveryProblem } from './hybridRecoveryGate.js';

test('eleven real browser scenarios survive final-looking SDK segment endings and rejected early publication', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-lifecycle-sdk-'));
  const env = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false', QASE_HYBRID_AUTONOMOUS_COMPLETION: 'true', JEV_API_KEY: 'lifecycle-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: env.JEV_API_KEY, headless: true, maxTurns: 3 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  let writes = 0;
  const server = http.createServer((request, response) => { if (request.method !== 'GET') writes++; response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Lifecycle fixture</title><h1>Scoped fixture</h1><p>No unsafe actions.</p>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'owner', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['responsive'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, store = { liveFor: () => live, listLive: () => [], publish() {},
    async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); return value; },
    async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
    async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; } };
  await withUserConfiguration(settings, async () => {}, async () => {
    const [record, concurrent] = await Promise.all([ensureRuntime(session, store), ensureRuntime(session, store)]);
    assert.equal(record, concurrent); assert.equal(record.initializingRuntime, undefined);
    t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    const originalRun = record.runtime.run;
    await record.hybrid.ledger.plan(Array.from({ length: 10 }, (_, index) => ({ category: 'responsive', objective: `Independent fixture assertion ${index}`, expected: { source: 'hypothesis', text: 'Fixed viewport geometry assertions' } })));
    record.hybrid.router.classifier = async (_state, questions) => Object.fromEntries(Object.keys(questions).map(key => [key, { choice: key.startsWith('c') ? 'rendering' : 'investigate' }]));
    let requests = 0, step = 0, endSegment = false; const dispatches = [];
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      requests++; record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 30, outputTokens: 10, estimated: false });
      if (!options.tools?.length) { yield { type: 'text', content: 'Continue the remaining host-ledger scenarios. Completed fixture assertions are durable; do not replay them.' }; return; }
      if (endSegment) { endSegment = false; yield { type: 'text', content: 'The tests are complete. Here is the final result.' }; return; }
      let toolName, input;
      if (step++ === 0) { toolName = 'browser_open'; input = { url: session.targetUrl }; }
      else if (step === 2) { toolName = 'finish_qa_report'; input = { verdict: 'blocked', summary: 'Premature fixture publication' }; }
      else {
        const next = session.hybrid.scenarios.find(item => item.status === 'planned');
        if (next) { toolName = 'browser_qa_scenario'; input = { scenario_id: next.id, action: 'responsive' }; }
        else { toolName = 'finish_qa_report'; input = { verdict: 'pass', summary: 'Host must validate every executed assertion.' }; }
      }
      dispatches.push({ toolName, advertised: options.tools?.map(tool => tool.name), closing: session.hybrid.budgetFinalizing });
      endSegment = true;
      yield { type: 'tool_call', call: { id: randomUUID(), toolName, input } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Execute the eleven validated fixture scenarios. SDK final text is not report authority.' }, store);
    assert.equal(record.runtime.run, originalRun); assert.equal(record.runtime.run, Object.getPrototypeOf(record.runtime).run);
    assert.equal(session.status, 'done', JSON.stringify({ detail: session.statusDetail, step, requests, dispatches, budgets: session.hybrid.budgets, states: session.hybrid.scenarios.map(s => s.status), failures: session.activities.filter(a => a.status === 'failed').map(a => ({ tool: a.toolName, error: a.error })), continuation: session.hybrid.sdkContinuation, closeout: session.hybrid.closeoutAuthorization }));
    assert.equal(session.hybrid.scenarios.length, 11);
    assert.ok(session.hybrid.scenarios.every(item => item.status === 'passed' && item.executedActionIds.length && item.assertions.length));
    assert.ok(session.hybrid.sdkContinuation.segments >= 11);
    assert.ok(session.activities.some(item => item.toolName === 'finish_qa_report' && item.status === 'failed'));
    assert.equal(session.activities.filter(item => item.toolName === 'finish_qa_report' && item.status === 'done').length, 1);
    assert.equal(session.hybrid.actions.filter(item => item.toolName === 'browser_qa_check').length, 11);
    assert.equal(session.hybrid.telemetry.reasoner.calls, requests);
    assert.equal(session.hybrid.telemetry.reasoner.reservedTokens, 0); assert.equal(writes, 0);
    const durable = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json')));
    assert.equal(durable.hybrid.scenarios.filter(item => item.status === 'passed').length, 11);
    assert.equal(durable.hybrid.evidence.length, session.hybrid.evidence.length);
  });
});

test('Stop fences a verified late SDK answer and Resume reopens and snapshots before remaining browser checks', { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-stop-sdk-'));
  const env = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false',
    QASE_HYBRID_AUTONOMOUS_COMPLETION: 'false', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: 'stop-fixture-key', headless: true, maxTurns: 12 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION,
    profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  const requests = [];
  const fixture = http.createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Workspace</title><h1>Workspace</h1><p>Safe stop and resume fixture.</p>');
  });
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  t.after(() => { fixture.closeAllConnections(); fixture.close(); });
  const session = { id: randomUUID(), ownerUserId: 'fixture-owner', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
    targetUrl: `http://127.0.0.1:${fixture.address().port}/`, selectedTests: ['responsive'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  let live = {};
  const checkpoint = path.join(root, 'checkpoint.json');
  const store = { liveFor: () => live, peekLive: () => live, listLive: () => [], publish() {},
    async commit(s) { fs.writeFileSync(checkpoint, JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; await this.commit(s); },
    async addActivity(s, item) { const activity = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(activity); return activity; },
    async updateActivity(s, id, patch) { const activity = s.activities.find(item => item.id === id); if (activity) Object.assign(activity, patch); },
    async addMessage(s, item) { s.messages.push({ id: randomUUID(), ts: Date.now(), ...item }); } };
  const { agent } = createRuntimeApplicationServices(store);
  t.after(async () => {
    await live.bridge?.service.dispose?.();
    live.dispose?.();
    deleteRunSnapshot(session.id);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lateReady = Promise.withResolvers();
  const releaseLate = Promise.withResolvers();
  t.after(() => releaseLate.resolve());
  const emitTool = (toolName, input) => ({ type: 'tool_call', call: { id: randomUUID(), toolName, input } });
  await withUserConfiguration(settings, async () => {}, async () => {
    const first = await ensureRuntime(session, store);
    const [completed] = session.hybrid.scenarios;
    const [_, remaining] = await first.hybrid.ledger.plan([{ category: 'responsive', objective: 'Check remaining fixture viewport',
      expected: { source: 'hypothesis', text: 'Viewport assertions from the browser' } }]);
    let turn = 0;
    first.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      first.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 30, outputTokens: 10 });
      if (turn++ === 0) yield emitTool('browser_open', { url: session.targetUrl });
      else if (turn === 2) yield emitTool('browser_qa_scenario', { scenario_id: completed.id, action: 'responsive' });
      else {
        lateReady.resolve();
        await releaseLate.promise;
        yield emitTool('browser_open', { url: session.targetUrl + 'late-response' });
      }
    })();
    first.hybrid.wrapChat(first.runtime.cleanSlateService);
    const running = runTurn(session, { task: 'Run two viewport checks on this read-only fixture.' }, store);
    await Promise.race([lateReady.promise, running.then(() => assert.fail(session.statusDetail || 'Run ended before the stop window.'))]);
    assert.equal(completed.status, 'passed');
    const preserved = structuredClone(completed.assertions);
    const beforeStop = session.hybrid.actions.length;
    await agent.stop(session.id);
    await agent.stop(session.id);
    releaseLate.resolve();
    await running;
    assert.equal(session.status, 'interrupted');
    assert.equal(session.hybrid.recovery.verificationRequired, true);
    assert.equal(hybridRecoveryProblem(session), null);
    assert.equal(session.hybrid.actions.length, beforeStop);
    assert.equal(remaining.status, 'planned');
    assert.deepEqual(completed.assertions, preserved);

    const durable = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    assert.deepEqual(durable.hybrid.scenarios[0].assertions, preserved);
    await first.bridge.service.dispose?.();
    first.dispose();
    live = {};
    Object.assign(session, durable);
    const resume = await ensureRuntime(session, store);
    let recoveredTurns = 0;
    resume.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      resume.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 30, outputTokens: 10 });
      assert.equal(session.hybrid.recovery.verificationRequired, false);
      if (recoveredTurns++ === 0) yield emitTool('browser_qa_scenario', { scenario_id: remaining.id, action: 'responsive' });
      else yield emitTool('finish_qa_report', { verdict: options.tools.find(tool => tool.name === 'finish_qa_report').parametersSchema.properties.verdict.enum[0], summary: 'Completed the remaining checks.' });
    })();
    resume.hybrid.wrapChat(resume.runtime.cleanSlateService);
    await runTurn(session, { task: 'Resume from the saved checks.' }, store);
    assert.equal(session.status, 'done', session.statusDetail);
    assert.deepEqual(session.hybrid.scenarios[0].assertions, preserved);
    assert.equal(session.hybrid.scenarios[1].status, 'passed');
    assert.deepEqual(session.hybrid.actions.slice(-3).map(action => action.toolName), ['browser_open', 'browser_snapshot', 'browser_qa_check']);
    for (const assertion of preserved) {
      const receipt = session.hybrid.evidence.find(item => item.id === assertion.evidenceRef);
      assert.equal(receipt.digest, modeReceiptHash(receipt));
    }
    assert.ok(requests.every(item => item.method === 'GET' && item.url !== '/late-response'));
    assert.equal(session.hybrid.telemetry.reasoner.reservedTokens, 0);
  });
});
