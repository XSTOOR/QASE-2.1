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
