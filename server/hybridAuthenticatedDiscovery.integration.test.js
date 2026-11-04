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

test('installed SDK continues into same-URL app features when the model omits navigation from its batch', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-auth-discovery-'));
  const env = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false', QASE_HYBRID_AUTONOMOUS_COMPLETION: 'true', JEV_API_KEY: 'auth-discovery-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: env.JEV_API_KEY, headless: true, maxTurns: 20 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') writes++;
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>Authorized workspace fixture</title><nav><button id="projects">Projects</button></nav><main><h1>Workspace</h1></main><script>
      projects.onclick=()=>{projects.setAttribute('aria-current','page');document.querySelector('main').innerHTML='Loading...';
        setTimeout(()=>{document.querySelector('main').innerHTML='<h1>Projects</h1><input id="query" type="search" aria-label="Search projects" aria-controls="results"><ul id="results"><li>Alpha</li><li>Beta</li></ul>';
          query.oninput=()=>{results.innerHTML=['Alpha','Beta'].filter(x=>x.toLowerCase().includes(query.value.toLowerCase())).map(x=>'<li>'+x+'</li>').join('');};
        },300);};
    </script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'fixture-owner', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['navigation', 'search', 'accessibility'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, store = { liveFor: () => live, listLive: () => [], publish() {},
    async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); return value; },
    async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
    async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; } };
  await withUserConfiguration(settings, async () => {}, async () => {
    const record = await ensureRuntime(session, store);
    t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    // Host fixture seeds the authorized access transition; no real credentials
    // or authentication claims are fabricated by the model transport.
    session.hybrid.authentication = { status: 'access_observed', grantId: 'fixture-grant', origin: new URL(session.targetUrl).origin };
    const search = session.hybrid.scenarios.find(s => s.category === 'search');
    search.status = 'inconclusive'; search.uncertainty = ['Anonymous page had no search.'];
    record.hybrid.router.classifier = async (_state, questions) => Object.fromEntries(Object.keys(questions).map(key => [key, { choice: 'investigate' }]));
    let step = 0, premature = false, endedSegment = false;
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 40, outputTokens: 10, estimated: false });
      if (!options.tools?.length) { yield { type: 'text', content: 'Preserve host-ledger progress and continue pending routes.' }; return; }
      let toolName, input;
      if (step++ === 0) { toolName = 'browser_open'; input = { url: session.targetUrl }; }
      else if (step === 2) { toolName = 'browser_qa_check'; input = { action: 'inspect' }; }
      else if (session.hybrid.exploration.routes.some(route => route.kind === 'feature') && !premature) {
        premature = true; toolName = 'finish_qa_report'; input = { verdict: 'partial', summary: 'Model incorrectly believes the single URL is finished.' };
      } else if (premature && !endedSegment) { endedSegment = true; yield { type: 'text', content: 'All tests finished.' }; return; }
      else {
        const next = session.hybrid.exploration.routes.find(route => route.status === 'pending');
        if (next) { toolName = 'qa_test_routes'; input = { route_ids: [next.id], checks: ['accessibility'] }; }
        else { toolName = 'finish_qa_report'; input = { verdict: 'partial', summary: 'Report only executed state-specific coverage.' }; }
      }
      yield { type: 'tool_call', call: { id: randomUUID(), toolName, input } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Exercise navigation, search and accessibility across the authorized fixture workspace.' }, store);
    assert.equal(session.status, 'done', session.statusDetail);
    assert.equal(record.runtime.run, Object.getPrototypeOf(record.runtime).run);
    assert.equal(session.hybrid.accessContext, 'fixture-grant'); assert.equal(search.priorDispositions[0].accessContext, 'public');
    assert.ok(session.activities.some(item => item.toolName === 'finish_qa_report' && item.status === 'failed'));
    assert.ok(session.hybrid.sdkContinuation.segments >= 1);
    assert.ok(session.hybrid.exploration.routes.some(route => route.kind === 'feature' && route.status === 'tested'));
    assert.ok(session.hybrid.exploration.batches.every(batch => batch.checks.includes('navigation') && batch.checks.includes('search')));
    assert.equal(search.status, 'passed'); assert.ok(search.assertions.length >= 2);
    assert.ok(session.hybrid.scenarios.every(s => s.executedActionIds.length && s.assertions.length));
    assert.equal(writes, 0);
    const durable = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json')));
    assert.equal(durable.hybrid.evidence.length, session.hybrid.evidence.length);
    assert.ok(durable.hybrid.exploration.routes.some(route => route.kind === 'feature' && route.status === 'tested'));
  });
});
