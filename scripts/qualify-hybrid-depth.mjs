/** Opt-in live SDK/model qualification on a disposable multi-page fixture. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { ensureRuntime, runTurn, deleteRunSnapshot } from '../server/agent.js';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { hybridProfile, loadQualification } from '../server/hybridConfig.js';
import { hybridDepthFixture } from '../server/hybridDepthFixture.js';

assert.equal(process.env.QASE_LIVE_HYBRID_EXECUTION, 'true', 'Explicit opt-in required: this invokes configured paid models.');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.equal(process.env.QASE_HYBRID_QA_ENABLED, 'true');
const settings = getConfig(); loadQualification(hybridProfile(settings));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-live-depth-'));
const fixture = hybridDepthFixture({ interactions: true }); fixture.server.listen(0, '127.0.0.1'); await once(fixture.server, 'listening');
const session = { id: randomUUID(), ownerUserId: 'isolated-live-depth', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
  targetUrl: `http://127.0.0.1:${fixture.server.address().port}/`, selectedTests: ['navigation', 'broken_links', 'responsive', 'forms', 'media', 'accessibility', 'console_health'], messages: [], activities: [], findings: [], todos: [], secretNames: [] };
const live = {}, preview = { frames: 0, urls: new Set(), clickTargets: 0 }, store = {
  liveFor: () => live, listLive: () => [], publish(_session, type, payload) {
    if (type === 'frame') { preview.frames++; preview.urls.add(payload.frame.url); }
    if (type === 'cursor' && payload.cursor.verb === 'click' && Number.isFinite(payload.cursor.x)) preview.clickTargets++;
  },
  async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s), { mode: 0o600 }); },
  async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
  async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); return value; },
  async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
  async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; }
};
let record; const began = Date.now();
try {
  await withUserConfiguration(settings, async () => { throw new Error('Configuration changes forbidden.'); }, async () => {
    record = await ensureRuntime(session, store);
    await runTurn(session, { task: `Deeply test the authorized read-only fixture at ${session.targetUrl}. Cover ALL observed routes up to the bounded frontier target and all supported selected checks. Use default qa_test_routes checks, investigate and report each distinct reproduced issue, then publish the host-validated report. Do not submit forms or expand outside this origin. Use evidence, not labels or model agreement.` }, store);
  });
  const actualGroups = [...new Set(session.findings.filter(item => item.hybridEvidence).map(item => {
    const scenario = session.hybrid.scenarios.find(s => s.id === item.hybridEvidence.scenarioId);
    return `${scenario.category}:${new URL(item.url || session.targetUrl).pathname}`;
  }))];
  const detected = fixture.expectedGroups.filter(group => actualGroups.includes(group)), unexpected = actualGroups.filter(group => !fixture.expectedGroups.includes(group));
  const result = { status: session.status, detail: session.statusDetail, elapsedMs: Date.now() - began,
    reasoner: session.hybrid.telemetry.reasoner, classifier: session.hybrid.telemetry.classifier,
    browserActions: session.hybrid.telemetry.browserActions, sdkBrowserCalls: record.runtime.getResult().toolCalls.filter(item => item.toolName.startsWith('browser_')).length,
    pagesTested: session.hybrid.exploration.routes.filter(route => route.status === 'tested').length,
    inputTrials: session.hybrid.evidence.map(item => item.result?.formTesting).filter(Boolean),
    viewport: session.hybrid.viewport,
    preview: { frames: preview.frames, routes: [...new Set([...preview.urls].map(url => new URL(url).pathname))], clickTargets: preview.clickTargets },
    scenarios: session.hybrid.scenarios.length, confirmedFindings: session.findings.length,
    expectedGroups: fixture.expectedGroups, detectedGroups: detected, unexpectedGroups: unexpected,
    fixtureGroupRecall: detected.length / fixture.expectedGroups.length,
    unexpectedGroupRate: actualGroups.length ? unexpected.length / actualGroups.length : 0,
    writes: fixture.writes(), reportVerdict: session.report?.verdict,
    costs: 'No overall price estimate: only any exact gateway-reported costs in role telemetry are authoritative.', root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(session.status, 'done', session.statusDetail);
  assert.equal(result.pagesTested, fixture.expectedPages); assert.ok(result.browserActions >= 25);
  assert.equal(result.scenarios, session.hybrid.scope.length);
  assert.equal(result.viewport.phase, 'selected_device'); assert.equal(result.viewport.restored, true);
  assert.deepEqual(result.viewport.current, result.viewport.primary);
  assert.equal(detected.length, fixture.expectedGroups.length); assert.equal(unexpected.length, 0);
  assert.equal(result.writes, 0);
  assert.ok(result.inputTrials.some(item => item.fieldsFilled > 0 && item.negativeCases > 0), 'Hybrid must fill actual eligible controls and execute negative inputs.');
  assert.ok(result.inputTrials.every(item => item.submissionExecuted === false && item.restored !== false));
  assert.ok(result.preview.frames >= fixture.expectedPages && result.preview.routes.length >= fixture.expectedPages, 'Preview must reflect the actual fixture pages.');
  assert.ok(result.preview.clickTargets >= 3, 'Actual click-target events must be visible.');
  assert.equal(session.hybrid.telemetry.reasoner.reservedTokens, 0);
} finally {
  if (record) { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); }
  fixture.server.closeAllConnections(); fixture.server.close();
}
