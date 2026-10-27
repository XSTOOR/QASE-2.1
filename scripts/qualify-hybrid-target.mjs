/** Explicit, read-only real-target verification using QASE's existing loop.
 * Temporary checkpoints only; no user-run creation or configuration changes. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from '../server/agent.js';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { hybridProfile, loadQualification } from '../server/hybridConfig.js';
import { validateHybridFinding } from '../server/qaCompletionGate.js';

assert.equal(process.env.QASE_LIVE_HYBRID_EXECUTION, 'true', 'Explicit live-model opt-in required.');
assert.notEqual(process.env.NODE_ENV, 'production');
assert.equal(process.env.QASE_HYBRID_QA_ENABLED, 'true');
const target = new URL(process.argv[2]);
assert.ok(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && !target.search, 'Supply an explicitly authorized HTTP(S) target without credentials or query data.');
assert.equal(process.env.QASE_AUTHORIZED_TARGET, target.origin, 'The operator must first obtain explicit target authorization, then name its exact origin in QASE_AUTHORIZED_TARGET.');
const settings = getConfig(); loadQualification(hybridProfile(settings));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-hybrid-target-'));
const session = { id: randomUUID(), ownerUserId: 'isolated-readonly-verification', mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle',
  targetUrl: target.href, selectedTests: ['navigation', 'broken_links', 'responsive', 'forms', 'search', 'authentication', 'media', 'accessibility', 'console_health', 'content', 'visual_consistency'],
  messages: [], activities: [], findings: [], todos: [], secretNames: [] };
const live = {}, store = {
  liveFor: () => live, listLive: () => [], publish() {},
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
    await runTurn(session, { task: `Read-only precision verification of ${target.href}. Use the existing approved route batches with default checks; include the entry page and prioritize distinct functional routes over repeated legal pages. Investigate observable failures, report only intact reproduced host assertions, and publish an honest report after every selected suite has an evidence-based disposition. No form submission, credentials, account changes, security payloads, external origins or other writes are authorized. Record missing expectations, authorization and unsupported workflows as gaps, not passes. Do not invent defects to meet a quota.` }, store);
  });
  const result = { status: session.status, detail: session.statusDetail, target: `${target.origin}${target.pathname}`, elapsedMs: Date.now() - began,
    sdkLoopUnchanged: record.runtime.run === Object.getPrototypeOf(record.runtime).run,
    reasoner: session.hybrid.telemetry.reasoner, classifier: session.hybrid.telemetry.classifier,
    browserActions: session.hybrid.telemetry.browserActions, browserTimings: session.hybrid.telemetry.browserTimings,
    routes: session.hybrid.exploration.routes.map(({ url, status, reason }) => ({ url, status, reason })),
    scenarios: session.hybrid.scenarios.map(({ category, status, assertions }) => ({ category, status, passedAssertions: assertions.filter(a => a.outcome === 'pass').length, failedAssertions: assertions.filter(a => a.outcome === 'fail').length })),
    confirmedFindings: session.findings.map(({ title, hybridEvidence }) => ({ title, scenarioId: hybridEvidence?.scenarioId, assertionId: hybridEvidence?.assertionId })),
    unresolvedObservations: session.hybrid.observations.filter(item => item.status !== 'confirmed').length,
    verdict: session.report?.verdict, viewport: session.hybrid.viewport, root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(session.status, 'done', session.statusDetail);
  assert.ok(result.sdkLoopUnchanged);
  assert.ok(session.hybrid.scenarios.every(s => !['planned', 'running'].includes(s.status)), 'Every suite needs a terminal evidence-based disposition.');
  for (const finding of session.findings) validateHybridFinding(session, { scenario_id: finding.hybridEvidence?.scenarioId, assertion_id: finding.hybridEvidence?.assertionId });
  assert.equal(result.viewport?.restored, true);
} finally { if (record) { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); } }
