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

// Real SDK loop, browser, tools and durable receipts; model responses are
// deterministic mocks. No model gateway or external website is contacted.
for (const closeout of [false, true]) test(`installed SDK publishes without depth deadlock: ${closeout ? 'budget closeout at six pages' : 'six plus three fills eight-page capacity'}`, { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-route-capacity-'));
  const overrides = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false',
    JEV_API_KEY: 'route-capacity-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json'), QASE_HYBRID_OPUS_CALLS: closeout ? '6' : '60' };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]])); Object.assign(process.env, overrides);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: overrides.JEV_API_KEY, headless: true, maxTurns: 12 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(overrides.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  let writes = 0;
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') { writes++; response.writeHead(405).end(); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html lang="en"><head><title>Area ${request.url}</title><meta name="viewport" content="width=device-width"></head><body><nav>${Array.from({ length: 8 }, (_, i) => `<a href="/area-${i}">Area ${i}</a>`).join(' ')}</nav><main><h1>Fixture area</h1><p>Bounded coverage fixture.</p></main></body></html>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'route-capacity-fixture', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
    targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['responsive'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, checkpoint = path.join(root, 'checkpoint.json');
  const store = { liveFor: () => live, listLive: () => [], publish() {},
    async commit(s) { fs.writeFileSync(checkpoint, JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const activity = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(activity); return activity; },
    async updateActivity(s, id, update) { Object.assign(s.activities.find(a => a.id === id), update); },
    async addMessage(s, item) { s.messages.push({ id: randomUUID(), ts: Date.now(), ...item }); }
  };
  await withUserConfiguration(settings, async () => { throw Error('Configuration changes forbidden'); }, async () => {
    const record = await ensureRuntime(session, store);
    t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    assert.equal(record.runtime.run, Object.getPrototypeOf(record.runtime).run);
    let turn = 0;
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 100, outputTokens: 30, estimated: false });
      let call;
      if (session.hybrid.budgetFinalizing || turn === 5) {
        const finish = options.tools.find(tool => tool.name === 'finish_qa_report'); assert.ok(finish);
        call = ['finish_qa_report', { verdict: finish.parametersSchema.properties.verdict.enum[0], summary: 'Publish only executed fixture coverage.' }];
      } else if (turn === 0) call = ['browser_open', { url: session.targetUrl }];
      else if (turn === 1) call = ['browser_qa_check', { action: 'inspect' }];
      else {
        assert.equal(options.tools.some(tool => tool.name === 'finish_qa_report'), false);
        if (turn === 4) assert.equal(options.tools.find(tool => tool.name === 'qa_test_routes').parametersSchema.properties.route_ids.maxItems, 2);
        // Intentionally exercise the defensive oversized-batch host path too.
        call = ['qa_test_routes', { route_ids: session.hybrid.exploration.routes.filter(route => route.status === 'pending').slice(0, 3).map(route => route.id) }];
      }
      turn++;
      yield { type: 'tool_call', call: { id: randomUUID(), toolName: call[0], input: call[1] } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Test only the observed local fixture routes and publish honest coverage.' }, store);
    assert.equal(session.status, 'done', session.statusDetail);
    assert.equal(session.report.verdict, 'partial');
    assert.equal(session.hybrid.exploration.routes.filter(route => route.status === 'tested').length, closeout ? 6 : 8);
    assert.equal(session.hybrid.exploration.routes.filter(route => route.status === 'pending').length, closeout ? 3 : 1);
    assert.equal(session.activities.filter(activity => ['qa_test_routes', 'finish_qa_report'].includes(activity.toolName) && activity.status === 'failed').length, 0);
    assert.equal(session.activities.filter(activity => activity.toolName === 'finish_qa_report').length, 1);
    assert.equal(writes, 0); assert.equal(session.hybrid.exploration.maxPages, 8);
    assert.ok(record.runtime.getResult().toolCalls.filter(call => call.toolName.startsWith('browser_')).length >= (closeout ? 18 : 24));
    const durable = JSON.parse(fs.readFileSync(checkpoint));
    assert.ok(durable.hybrid.evidence.length >= (closeout ? 18 : 24));
    if (closeout) {
      assert.equal(session.hybrid.budgetFinalizing, true);
      assert.ok(session.report.notCovered.some(gap => /Budget closeout.*6\/8/.test(gap)));
      assert.equal(session.hybrid.telemetry.reasoner.calls, 5);
    } else assert.equal(durable.hybrid.exploration.batches.at(-1).deferredRouteIds.length, 1);
  });
});
