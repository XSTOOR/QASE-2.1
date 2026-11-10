// Recover a COPY of the controlled live qualification checkpoint. No model
// requests or target-site browsing are allowed in this recovery qualification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { parse } from 'dotenv';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, checkpoint: { type: 'string' },
  'session-id': { type: 'string' }, 'output-dir': { type: 'string' }
} });
assert.ok(values['env-file'] && values.checkpoint && values['output-dir']);
assert.notEqual(process.env.NODE_ENV, 'production');
const source = path.resolve(values.checkpoint), original = fs.readFileSync(source);
const parsed = JSON.parse(original);
const session = Array.isArray(parsed) ? parsed.find(s => s.id === values['session-id']) : parsed;
assert.equal(session?.mode, 'sqa');
assert.equal(session.sqa.scope.target.name, 'SQA release fixture');
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(session.targetUrl).hostname));
assert.ok(['error', 'interrupted'].includes(session.status));
assert.ok(!session.sqa.finalizedAt && !session.pendingQuestion);
assert.equal(session.secretNames?.length || 0, 0);
assert.ok(session.activities.every(a => a.status !== 'running'));
const baseline = structuredClone(session);
const directory = path.resolve(values['output-dir']);
assert.ok(!fs.existsSync(directory), 'Choose a fresh output directory; previous evidence is immutable.');
const environment = parse(fs.readFileSync(path.resolve(values['env-file']), 'utf8'));
const secrets = Object.entries(environment).filter(([key, value]) => /key|token|password|secret/i.test(key) && value.length >= 8).map(([, value]) => value);
fs.mkdirSync(path.join(directory, 'runtime'), { recursive: true });
// Application modules resolve stores at import time, so isolate before import.
process.chdir(path.join(directory, 'runtime'));
const { platformEnvironment } = await import('../server/platformEnvironment.js');
Object.assign(process.env, platformEnvironment(environment, {}), { NODE_ENV: 'development' });
const { ensureRuntime, runTurn } = await import('../server/agent.js');
const { getConfig, withUserConfiguration } = await import('../server/config.js');
const { buildSqaReportMarkdown } = await import('../server/sqaAssessment.js');
const { buildReportHtml } = await import('../server/reportPdf.js');
const { SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD } = await import('../server/sqaBrowserBudget.js');
assert.ok(session.tokenUsage.inputTokens >= SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD);
const events = [], live = {}, checkpoint = path.join(directory, 'checkpoint.json');
const save = () => {
  fs.writeFileSync(checkpoint + '.tmp', JSON.stringify(session), { mode: 0o600 });
  fs.renameSync(checkpoint + '.tmp', checkpoint);
};
const store = {
  liveFor: () => live, listLive: () => [], publish() {},
  async commit(_s, type) { events.push({ type, at: Date.now() }); save(); },
  async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; save(); },
  async addActivity(s, item) { const a = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(a); save(); return a; },
  async updateActivity(s, id, patch) { Object.assign(s.activities.find(a => a.id === id), patch); save(); },
  async addMessage(s, item) { const m = { id: randomUUID(), ts: Date.now(), ...item }; s.messages.push(m); save(); return m; }
};
const result = { status: 'running', startedAt: new Date().toISOString(), source: 'isolated copy of controlled live SQA checkpoint', sessionId: session.id };
let record, modelCalls = 0;
try {
  await withUserConfiguration(getConfig(), async () => { throw new Error('Settings changes forbidden.'); }, async () => {
    record = await ensureRuntime(session, store);
    record.runtime.run = async function* () { modelCalls++; throw new Error('Recovery must not contact the model.'); };
    record.runtime.resumePendingQuestion = () => { modelCalls++; throw new Error('Unexpected pending question.'); };
    await runTurn(session, { task: 'Continue the saved SQA assessment.' }, store);
  });
  assert.equal(session.status, 'done', session.statusDetail);
  assert.ok(session.sqa.finalizedAt && session.sqa.assessment);
  assert.equal(modelCalls, 0);
  assert.deepEqual(session.tokenUsage, baseline.tokenUsage);
  assert.deepEqual(session.findings, baseline.findings);
  for (const observation of baseline.sqa.observations) {
    assert.deepEqual(session.sqa.observations.find(o => o.controlId === observation.controlId), observation);
  }
  assert.deepEqual(session.activities.filter(a => a.toolName?.startsWith('browser_')), baseline.activities.filter(a => a.toolName?.startsWith('browser_')));
  const originalIds = new Set(baseline.sqa.observations.map(o => o.controlId));
  const added = session.sqa.observations.filter(o => !originalIds.has(o.controlId));
  assert.ok(added.every(o => o.status === 'blocked' && /budget reached/.test(o.rationale)));
  assert.equal(session.sqa.assessment.results.length, session.sqa.scope.applicableControlIds.length);
  const reloaded = JSON.parse(fs.readFileSync(checkpoint));
  assert.deepEqual(reloaded.sqa, session.sqa);
  assert.deepEqual(reloaded.tokenUsage, baseline.tokenUsage);
  fs.writeFileSync(path.join(directory, 'report.md'), buildSqaReportMarkdown(session.sqa.assessment));
  fs.writeFileSync(path.join(directory, 'report.html'), buildReportHtml(session));
  Object.assign(result, { status: 'passed', modelCalls, browserReplay: false, originalObservationsPreserved: baseline.sqa.observations.length,
    newlyBlocked: added.length, tokenUsage: session.tokenUsage, verdict: session.sqa.assessment.verdict,
    results: session.sqa.assessment.results.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {}),
    checkpointRestoration: 'passed', exports: ['markdown', 'html'] });
} catch (error) {
  result.status = 'failed'; result.error = error.message; process.exitCode = 1;
} finally {
  try { await record?.bridge?.service?.dispose?.(); } finally { record?.dispose?.(); }
  assert.deepEqual(fs.readFileSync(source), original, 'Original checkpoint changed.');
  const scan = folder => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) scan(file);
    else assert.ok(!secrets.some(secret => fs.readFileSync(file).includes(Buffer.from(secret))), `Configured credential found in ${path.relative(directory, file)}`);
  } };
  scan(directory);
  result.credentialScan = 'passed'; result.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(directory, 'events.json'), JSON.stringify(events, null, 2));
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
