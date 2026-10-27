import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from './agent.js';
import { hybridProfile, profileIdentity, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION } from './hybridConfig.js';
import { JEV_ENDPOINT } from './jevClient.js';
import { withUserConfiguration } from './config.js';
import { hybridDepthFixture } from './hybridDepthFixture.js';
import { validateHybridFinding } from './qaCompletionGate.js';

test('one installed SDK loop discovers hidden/lazy routes and confirms nine defect groups with seven category suites', { timeout: 120000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-sdk-depth-'));
  const names = ['NODE_ENV', 'QASE_ALLOW_PRIVATE_NETWORK', 'QASE_HYBRID_QA_ENABLED', 'QASE_HYBRID_QUALIFICATION_FILE', 'JEV_API_KEY', 'QASE_LOCK_MODEL'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  Object.assign(process.env, { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_HYBRID_QA_ENABLED: 'true', QASE_LOCK_MODEL: 'false', JEV_API_KEY: 'isolated-depth-fixture', QASE_HYBRID_QUALIFICATION_FILE: path.join(root, 'qualification.json') });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: process.env.JEV_API_KEY, headless: true, maxTurns: 20 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(process.env.QASE_HYBRID_QUALIFICATION_FILE, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(name => [name, { passed: true }])) }));
  const fixture = hybridDepthFixture({ interactions: true }); fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
  t.after(() => { fixture.server.closeAllConnections(); fixture.server.close(); });
  const session = { id: randomUUID(), ownerUserId: 'depth-fixture', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${fixture.server.address().port}/`, selectedTests: ['navigation', 'broken_links', 'responsive', 'forms', 'media', 'accessibility', 'console_health'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
  const live = {}, frames = [], cursorEvents = [], store = {
    liveFor: () => live, listLive: () => [], publish(_session, type, payload) { if (type === 'frame') frames.push({ url: payload.frame.url, modelTurn: turnObserved }); if (type === 'cursor') cursorEvents.push(payload.cursor); },
    async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s)); },
    async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); return value; },
    async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
    async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; }
  };
  let turnObserved = 0;
  await withUserConfiguration(settings, async () => {}, async () => {
    const record = await ensureRuntime(session, store);
    t.after(async () => { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); });
    assert.equal(record.runtime.run, Object.getPrototypeOf(record.runtime).run);
    let ranks = 0, turn = 0;
    record.hybrid.router.classifier = async (_state, questions) => { ranks++; return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { choice: Object.keys(question.criteria)[0] }])); };
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 100, outputTokens: 30, estimated: false });
      assert.ok(options.tools.length <= 10);
      let calls;
      if (turn === 0) calls = [['browser_open', { url: session.targetUrl }]];
      else if (turn === 1) calls = [['browser_qa_check', { action: 'inspect' }]];
      else if (turn === 2) calls = [['qa_route_frontier', { rank: true }]];
      else if (turn === 3) calls = [['qa_test_routes', { route_ids: session.hybrid.exploration.routes.filter(route => ['/docs', '/contact', '/missing'].includes(new URL(route.url).pathname)).map(route => route.id) }]];
      else if (turn === 4) {
        for (const path of ['/docs', '/contact', '/missing']) assert.ok(frames.some(frame => new URL(frame.url).pathname === path), `Preview must update inside the route batch, before its result: ${path}`);
        calls = [['qa_test_routes', { route_ids: session.hybrid.exploration.routes.filter(route => new URL(route.url).pathname === '/').map(route => route.id) }]];
      }
      else if (turn === 5) calls = [['qa_test_routes', { route_ids: session.hybrid.exploration.routes.filter(route => route.status === 'pending').map(route => route.id) }]];
      else {
        const groups = new Set(), findings = [];
        for (const scenario of session.hybrid.scenarios) for (const assertion of scenario.assertions) {
          let validated;
          try { validated = validateHybridFinding(session, { scenario_id: scenario.id, assertion_id: assertion.id }); }
          catch (error) {
            if (assertion.outcome === 'fail' && assertion.reproduction?.confirmed) throw new Error(`Fixture ${scenario.category} unexpectedly failed evidence validation: ${error.message}`);
            continue;
          }
          const group = `${scenario.category}:${new URL(validated.url).pathname}`;
          if (groups.has(group)) continue; groups.add(group);
          findings.push(['report_finding', { scenario_id: scenario.id, assertion_id: assertion.id, title: `${group}: ${assertion.name}`, severity: 'medium', category: scenario.category }]);
        }
        calls = turn === 6 ? findings : [['finish_qa_report', { verdict: options.tools.find(tool => tool.name === 'finish_qa_report').parametersSchema.properties.verdict.enum[0], summary: 'Publish verified fixture evidence.' }]];
      }
      turn++; turnObserved = turn;
      for (const [toolName, input] of calls) yield { type: 'tool_call', call: { id: randomUUID(), toolName, input } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Deeply exercise only the authorized observed read-only fixture routes and publish evidence-linked results.' }, store);
    assert.equal(session.status, 'done', session.statusDetail);
    assert.equal(session.hybrid.exploration.routes.filter(route => route.status === 'tested').length, fixture.expectedPages);
    assert.ok(session.hybrid.exploration.routes.find(route => route.url.endsWith('/deep')).reveal, 'A restored disclosure must retain evidence-linked reveal instructions, not a hidden stale selector.');
    const confirmed = session.findings.map(finding => { const scenario = session.hybrid.scenarios.find(item => item.id === finding.hybridEvidence?.scenarioId); return `${scenario?.category}:${new URL(finding.url || session.targetUrl).pathname}`; });
    for (const group of fixture.expectedGroups) assert.ok(confirmed.includes(group), `Seeded defect not confirmed: ${group}; actual=${confirmed.join(',')}`);
    assert.equal(confirmed.filter(group => !fixture.expectedGroups.includes(group)).length, 0, 'No invented defect groups.');
    assert.ok(session.hybrid.telemetry.browserActions >= 25);
    assert.ok(record.runtime.getResult().toolCalls.filter(call => call.toolName.startsWith('browser_')).length >= 25, 'Batch children must execute through the installed SDK approval/execution harness.');
    assert.ok(ranks >= 2); assert.equal(fixture.writes(), 0); assert.equal(session.todos.length, 0);
    assert.equal(session.hybrid.scenarios.length, session.hybrid.scope.length, 'Only one suite per selected category, not one plan item per page/check.');
    assert.equal(session.hybrid.scenarios.length, 7);
    const inputs = session.hybrid.evidence.map(item => item.result?.formTesting).filter(Boolean);
    assert.ok(inputs.some(item => item.fieldsFilled > 0 && item.negativeCases > 0), 'The real SDK bridge must execute live input/negative trials, not detached-only validity checks.');
    assert.ok(inputs.every(item => item.submissionExecuted === false && item.restored !== false));
    assert.ok(session.hybrid.exploration.interactions.some(item => item.action === 'tabs' && item.status === 'executed'));
    assert.ok(cursorEvents.some(event => event.verb === 'click' && Number.isFinite(event.x)), 'Actual fixed-check targets must appear in the preview, not simulated progress.');
    assert.equal(session.activities.filter(item => item.status === 'running').length, 0);
    assert.equal(session.report.verdict, 'partial');
    const restored = JSON.parse(fs.readFileSync(path.join(root, 'checkpoint.json'), 'utf8'));
    for (const finding of restored.findings) assert.ok(validateHybridFinding(restored, { scenario_id: finding.hybridEvidence.scenarioId, assertion_id: finding.hybridEvidence.assertionId }));
  });
});
