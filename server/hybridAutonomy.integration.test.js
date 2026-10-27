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
import { validateHybridFinding } from './qaCompletionGate.js';

for (const late of [false, true]) test(`autonomous SDK ${late ? 'late' : 'initial'} onboarding: discovers button routes, fills negatives and publishes without questions`, { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-autonomous-sdk-'));
  const env = { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false', QASE_HYBRID_AUTONOMOUS_COMPLETION: 'true', JEV_API_KEY: 'autonomous-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') };
  const saved = Object.fromEntries(Object.keys(env).map(name => [name, process.env[name]])); Object.assign(process.env, env);
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: env.JEV_API_KEY, headless: true, maxTurns: 20 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  let writes = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') { writes++; res.writeHead(405).end(); return; }
    res.setHeader('Content-Type', 'text/html');
    const projects = req.url === '/projects';
    res.end(`<title>Owned autonomous fixture</title><nav><button id="projects" ${projects ? 'aria-current="page"' : ''} onclick="location.href='/projects'">Projects</button></nav>
      <main><h1>${projects ? 'Projects workspace' : 'Welcome workspace'}</h1>${projects ? `<div style="width:1800px;height:20px;background:red">Seeded overflow</div><label>Project name<input id="name" required minlength="3"></label><label>Search projects<input id="search" type="search"></label><ul id="results"><li>Alpha project</li><li>Beta project</li></ul><script>document.querySelector('#search').oninput=e=>{for(const row of document.querySelectorAll('#results li'))row.hidden=!row.textContent.toLowerCase().includes(e.target.value.toLowerCase())}</script>` : ''}</main>
      <script>setTimeout(()=>{if(!sessionStorage.getItem('tour-dismissed')){const layer=document.createElement('div');layer.style='position:fixed;inset:0;z-index:100;background:#0008;display:grid;place-items:center';layer.innerHTML='<div id="welcome" style="background:white;width:320px;padding:24px"><div>Welcome to the test platform</div><p>Take a quick tour.</p><button id="skip-tour">Skip</button></div>';document.body.append(layer);document.querySelector('#skip-tour').onclick=()=>{sessionStorage.setItem('tour-dismissed','1');layer.remove()}}},${late ? 650 : 0})</script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'owner', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['navigation', 'responsive', 'forms', 'search', 'accessibility', 'content'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, events = [], store = { liveFor: () => live, listLive: () => [], publish(_s, type) { if (type === 'question') events.push(type); },
    async commit(s, type) { if (type === 'question') events.push(type); fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const a = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(a); return a; },
    async updateActivity(s, id, patch) { Object.assign(s.activities.find(a => a.id === id), patch); }, async addMessage(s, item) { const m = { id: randomUUID(), ...item }; s.messages.push(m); return m; } };
  await withUserConfiguration(settings, async () => {}, async () => {
    const record = await ensureRuntime(session, store); t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    t.signal.addEventListener('abort', () => record.controller?.abort(t.signal.reason), { once: true });
    record.hybrid.router.classifier = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { choice: Object.keys(question.criteria)[0] }]));
    let step = 0;
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      // Synthetic exact fixture receipts; this is not a live-model benchmark.
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: step === 0 ? 295000 : 100, outputTokens: 20, estimated: false });
      const pending = pathname => session.hybrid.exploration.routes.find(route => new URL(route.url).pathname === pathname && route.status === 'pending');
      const content = session.hybrid.scenarios.find(s => s.category === 'content');
      let call;
      if (step === 0) call = ['browser_open', { url: session.targetUrl }];
      else if (step === 1) call = ['browser_qa_check', { action: 'inspect' }];
      else if (step === 2 || step === 4) call = ['qa_route_frontier', { rank: false }];
      else if (step === 3) call = ['qa_test_routes', { route_ids: [pending('/')?.id] }];
      else if (step === 5) { assert.ok(pending('/projects'), 'Button activation must discover a route without a supplied/invented href.'); call = ['qa_test_routes', { route_ids: [pending('/projects').id] }]; }
      else if (step === 6) call = ['qa_close_scenario', { scenario_id: content.id, disposition: 'blocked', reason: 'Exact expected copy was not supplied; report the limitation without asking a generic question.' }];
      else if (step === 7) {
        const scenario = session.hybrid.scenarios.find(s => s.category === 'responsive');
        const failure = scenario.assertions.find(a => a.outcome === 'fail' && a.reproduction?.confirmed);
        assert.ok(failure, 'A real seeded overflow must be reproduced.'); validateHybridFinding(session, { scenario_id: scenario.id, assertion_id: failure.id });
        call = ['report_finding', { scenario_id: scenario.id, assertion_id: failure.id, title: 'Projects page overflows the viewport', severity: 'medium' }];
      } else call = ['finish_qa_report', { verdict: options.tools.find(tool => tool.name === 'finish_qa_report').parametersSchema.properties.verdict.enum[0], summary: 'Host evidence is authoritative.' }];
      step++; yield { type: 'tool_call', call: { id: randomUUID(), toolName: call[0], input: call[1] } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Explore the authorized workspace, including observed navigation buttons, inputs and negative paths. Finish with evidence and honest scope.' }, store);
    assert.equal(session.status, 'done', session.statusDetail); assert.equal(events.length, 0);
    assert.equal(session.pendingQuestion, undefined); assert.equal(writes, 0);
    assert.ok(session.hybrid.evidence.some(e => e.result.action === 'dismiss_overlay' && e.result.assertions?.length));
    assert.ok(session.hybrid.exploration.interactions.some(i => i.action === 'navigation_control' && i.status === 'executed'));
    assert.ok(session.hybrid.evidence.some(e => e.result.formTesting?.fieldsFilled > 0 && e.result.formTesting.negativeCases > 0));
    assert.ok(session.hybrid.exploration.routes.some(route => route.url.endsWith('/projects') && route.status === 'tested'));
    assert.equal(session.findings.length, 1); assert.ok(session.findings[0].hybridEvidence);
    assert.equal(session.report.verdict, 'partial'); assert.ok(session.report.notCovered.some(text => /content/.test(text)));
    assert.equal(session.hybrid.scenarios.length, session.hybrid.scope.length);
    assert.ok(session.hybrid.budgets.reasonerTokens > 300000); assert.ok(session.hybrid.telemetry.reasoner.inputTokens >= 295000);
  });
});
