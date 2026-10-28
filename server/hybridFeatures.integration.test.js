import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hybridFeatureFixture } from './hybridFeatureFixture.js';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from './agent.js';
import { hybridProfile, profileIdentity, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION } from './hybridConfig.js';
import { JEV_ENDPOINT } from './jevClient.js';
import { withUserConfiguration } from './config.js';

for (const allowWrites of [false, true]) test(`one native SDK loop explores same-URL features with test writes ${allowWrites ? 'enabled' : 'disabled'}`, { timeout: 180000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-features-sdk-'));
  const env = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false', QASE_HYBRID_AUTONOMOUS_COMPLETION: 'true', JEV_API_KEY: 'features-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]])); Object.assign(process.env, env);
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: env.JEV_API_KEY, headless: true, maxTurns: 40 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  const fixture = hybridFeatureFixture(), server = fixture.server;
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'owner', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['navigation', 'forms', 'accessibility'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, questions = [], store = { liveFor: () => live, listLive: () => [], publish(_s, type) { if (type === 'question') questions.push(type); },
    async commit(s, type) { if (type === 'question') questions.push(type); fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const a = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(a); return a; },
    async updateActivity(s, id, patch) { Object.assign(s.activities.find(a => a.id === id), patch); }, async addMessage(s, item) { const m = { id: randomUUID(), ...item }; s.messages.push(m); return m; } };
  await withUserConfiguration(settings, async () => {}, async () => {
    const record = await ensureRuntime(session, store);
    if (allowWrites) session.hybrid.writeAuthorization = { enabled: true, runId: session.id, ownerUserId: session.ownerUserId, maximumSubmissions: 10, trials: [] };
    t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    t.signal.addEventListener('abort', () => record.controller?.abort(t.signal.reason), { once: true });
    record.hybrid.router.classifier = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { choice: Object.keys(question.criteria)[0] }]));
    let step = 0;
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 100, outputTokens: 20, estimated: false });
      let call;
      if (step === 0) call = ['browser_open', { url: session.targetUrl }];
      else if (step === 1) call = ['browser_qa_check', { action: 'inspect' }];
      else if (step === 2) call = ['qa_route_frontier', { rank: false }];
      else {
        const pending = session.hybrid.exploration.routes.find(route => route.status === 'pending');
        if (pending) call = ['qa_test_routes', { route_ids: [pending.id] }];
        else {
          const planned = session.hybrid.scenarios.find(s => ['planned', 'running'].includes(s.status));
          call = planned ? ['qa_close_scenario', { scenario_id: planned.id, disposition: 'not_executed', reason: 'No eligible controls observed on this fixture.' }]
            : ['finish_qa_report', { verdict: 'partial', summary: 'Fixture host evidence.' }];
        }
      }
      assert.ok(step++ < 25, 'Exploration must converge rather than repeat structural states.');
      yield { type: 'tool_call', call: { id: randomUUID(), toolName: call[0], input: call[1] } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Explore observed workspace features and subfeatures, including inputs and negative paths; do not ask for read-only confirmation.' }, store);
    assert.equal(session.status, 'done', session.statusDetail); assert.equal(questions.length, 0);
    const features = session.hybrid.exploration.routes.filter(route => route.kind === 'feature');
    assert.ok(features.some(route => route.label.includes('Projects') && route.status === 'tested'));
    assert.ok(features.some(route => route.label.includes('Details') && route.status === 'tested'), JSON.stringify(features.map(r => [r.label, r.status, r.reason])));
    assert.ok(features.some(route => route.label.includes('Reports') && route.status === 'tested'));
    assert.ok(session.hybrid.evidence.some(e => e.result.formTesting?.negativeCases > 0));
    assert.ok(session.hybrid.scenarios.find(s => s.category === 'forms').routeRuns.some(run => run.featureId));
    assert.ok(session.hybrid.scenarios.find(s => s.category === 'accessibility').assertions.some(a => a.outcome === 'fail'));
    assert.equal(session.hybrid.scenarios.length, 3, 'Subfeatures extend existing suites, not cosmetic planning items.');
    assert.ok(features.some(route => route.label.includes('Add record') && route.status === 'tested'));
    assert.ok(fixture.reads() > 0); assert.equal(fixture.writes(), allowWrites ? 2 : 0);
    if (allowWrites) assert.ok(session.hybrid.writeAuthorization.trials.some(trial => trial.status === 'responded'));
  });
});
