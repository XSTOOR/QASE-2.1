/** Opt-in LIVE model execution against a disposable, read-only local fixture.
 * Does not create user history, change configuration, or browse a real target. */
import 'dotenv/config';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from '../server/agent.js';
import { getConfig, withUserConfiguration } from '../server/config.js';
import { hybridProfile, loadQualification } from '../server/hybridConfig.js';

assert.equal(process.env.QASE_LIVE_HYBRID_EXECUTION, 'true', 'Explicit opt-in required: this invokes the configured paid models.');
assert.notEqual(process.env.NODE_ENV, 'production', 'Local qualification only.');
assert.equal(process.env.QASE_HYBRID_QA_ENABLED, 'true');
const settings = getConfig(); loadQualification(hybridProfile(settings));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-live-hybrid-execution-'));
let writes = 0;
const server = http.createServer((request, response) => {
  if (request.method !== 'GET') { writes++; response.writeHead(405); response.end(); return; }
  response.setHeader('Content-Type', 'text/html');
  const docs = request.url === '/docs';
  response.end(`<!doctype html><html lang="en"><head><title>${docs ? 'Documentation' : 'QA fixture'}</title></head><body><header><a href="/">Home</a> <a id="docs" href="/docs">Documentation</a></header><main><h1>${docs ? 'Documentation' : 'Disposable QA fixture'}</h1><p>All pages are local read-only fixtures.</p><div style="width:1800px;height:40px">Intentional horizontal overflow fixture</div><img src="/pixel.svg" alt="Decorative fixture" width="10" height="10"></main></body></html>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['navigation', 'responsive', 'accessibility'], messages: [], activities: [], findings: [], todos: [], secretNames: [], ownerUserId: 'isolated-live-qualification' };
const live = {}, store = {
  liveFor: () => live, listLive: () => [], publish() {},
  async commit(s) { fs.writeFileSync(path.join(root, 'checkpoint.json'), JSON.stringify(s), { mode: 0o600 }); },
  async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
  async addActivity(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(value); return value; },
  async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id), patch); },
  async addMessage(s, item) { const value = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(value); return value; }
};
let record;
const began = Date.now();
try {
  await withUserConfiguration(settings, async () => { throw new Error('Configuration changes forbidden.'); }, async () => {
    record = await ensureRuntime(session, store);
    await runTurn(session, { task: `Test ONLY ${session.targetUrl} with the selected navigation, responsive and accessibility scenarios. It is an authorized disposable read-only fixture. Check the observed Documentation anchor with its exact href, fixed responsive checks, and fixed accessibility checks. File only reproduced host-verified defects. Work each existing scenario to an honest disposition, finish all todos, then publish the evidence-based report. Do not expand scope or submit anything. Prefer bounded host checks over redundant screenshots or repeated planning.` }, store);
  });
  const metric = session.hybrid.telemetry;
  const result = { status: session.status, detail: session.statusDetail, elapsedMs: Date.now() - began,
    reasoner: metric.reasoner, classifier: metric.classifier, browserActions: metric.browserActions,
    contextBytes: metric.events.filter(item => item.type === 'model_context_projected').map(({ originalBytes, projectedBytes }) => ({ originalBytes, projectedBytes })),
    scenarios: session.hybrid.scenarios.map(({ category, status, assertions }) => ({ category, status, assertions: assertions.length })),
    confirmedFindings: session.findings.filter(item => item.hybridEvidence).length, writes, reportVerdict: session.report?.verdict, root };
  fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
  assert.equal(writes, 0);
  assert.equal(session.status, 'done', session.statusDetail);
  assert.equal(metric.reasoner.reservedTokens, 0);
  assert.ok(metric.reasoner.inputTokens + metric.reasoner.outputTokens <= session.hybrid.budgets.reasonerTokens);
  assert.ok(session.hybrid.scenarios.every(item => !['running', 'planned'].includes(item.status)));
  assert.ok(session.findings.some(item => item.hybridEvidence?.scenarioId === session.hybrid.scenarios.find(scenario => scenario.category === 'responsive')?.id), 'Known overflow must be reproduced and evidence-linked.');
} finally {
  if (record) { await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); }
  server.closeAllConnections(); server.close();
}
