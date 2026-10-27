import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const origin = 'http://127.0.0.1:5174';
const mode = process.argv[2] ?? 'qa';
let cookie = '';
let csrf = '';
async function api(path, body, retried = false) {
  const response = await fetch(origin + '/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) {
    cookie = cookies.map(value => value.split(';')[0]).join('; ');
    csrf = decodeURIComponent(cookies.find(value => value.startsWith('qase_csrf='))?.split(';')[0].slice('qase_csrf='.length) ?? '');
  }
  const result = await response.json();
  // A second verification login can rotate this account's session. Resume
  // read-only monitoring once; never retry a run-creating mutation implicitly.
  if (response.status === 401 && body === undefined && account && !retried) {
    await api('/auth/login', account);
    return api(path, undefined, true);
  }
  if (!response.ok) throw new Error(`${response.status}: ${result.error}`);
  return result;
}
let account;
try { account = JSON.parse(readFileSync('.qase/jev-smoke-account.json', 'utf8')); }
catch {
  account = { email: `jev-verification-${randomBytes(5).toString('hex')}@qase.local`, password: randomBytes(24).toString('base64url'), displayName: 'JEV local verification' };
  await api('/auth/register', account);
  writeFileSync('.qase/jev-smoke-account.json', JSON.stringify(account), { mode: 0o600 });
}
if (!cookie) await api('/auth/login', account);
const config = await api('/config');
assert.equal(config.provider, 'jev');
assert.equal(config.model, 'jev-1.13');
assert.equal(config.ready, true);
if (mode === 'lab') {
  const probe = await api('/config/test', {});
  assert.equal(probe.decisionVerified, true);
  const labOrigin = 'http://127.0.0.1:5175';
  assert.equal((await (await fetch(`${labOrigin}/healthz`)).json()).configured, true);
  const response = await fetch(`${labOrigin}/api/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: labOrigin }, body: JSON.stringify({ state: 'The browser logged an uncaught TypeError.', instructions: 'Choose the relevant failure area.', type: 'choice', criteria: { frontend: 'A browser JavaScript failure.', network: 'A failed HTTP connection.' } }) });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.answers.result.choice, 'frontend');
  console.log(JSON.stringify({ configProbe: 'verified', labDecision: result.answers.result.choice, model: result.model, inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens }));
  process.exit(0);
}
const target = process.argv[3] ?? `${origin}/demo/defects`;
if (!['http:', 'https:'].includes(new URL(target).protocol)) throw new Error('Expected an authorized HTTP(S) target URL.');
let scope;
if (mode === 'sqa') scope = { authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application', 'user_interface'], target: { name: 'Local QASE JEV verification', release: 'development', environment: 'local' } };
else if (mode === 'founder') scope = { authorizationConfirmed: true, target: { name: 'Local QASE JEV verification', url: target }, productContext: { stage: 'local development', businessModel: 'Internal QA tooling', targetCustomer: 'Developers testing local applications', primaryGoal: 'Verify the bounded JEV-only review' } };
else scope = process.argv[3] ? {} : { selectedTests: ['navigation', 'console_health'] };
const existingId = process.env.QASE_SMOKE_RUN_ID;
const session = existingId ? await api(`/sessions/${existingId}`) : await api(mode === 'qa' ? '/sessions' : `/${mode}/sessions`, scope);
console.log(JSON.stringify({ mode, id: session.id, status: existingId ? 'monitoring' : 'created' }));
if (!existingId) await api(`/sessions/${session.id}/message`, { text: `Review ${target} using only JEV, public-only and non-destructive, with explicit limitations for anything not observed. ${process.argv[4] || ''}` });
const deadline = Date.now() + 900000;
let previous;
let progressAt = 0;
while (Date.now() < deadline) {
  const current = await api(`/sessions/${session.id}`);
  if (current.status !== previous) { console.log(JSON.stringify({ mode, status: current.status, activities: current.activities?.length })); previous = current.status; }
  if (current.jev?.qa?.version === 2 && Date.now() - progressAt > 15000) {
    const qa = current.jev.qa;
    console.log(JSON.stringify({ status: current.status, routes: qa.visits.length, scenarios: qa.checks.length, assertions: qa.checks.reduce((sum, check) => sum + (check.assertions?.length ?? 0), 0), latest: current.activities?.at(-1)?.summary || current.activities?.at(-1)?.label }));
    progressAt = Date.now();
  }
  if (['done', 'error', 'awaiting_input', 'interrupted'].includes(current.status)) {
    const report = mode === 'qa' ? current.report : mode === 'sqa' ? current.sqa?.assessment : current.founder?.report;
    console.log(JSON.stringify({ mode, id: session.id, status: current.status, verdict: report?.verdict, published: Boolean(report), model: current.jev?.decisions?.at(-1)?.model, decisionCalls: current.jev?.decisions?.length, tokenUsage: current.tokenUsage, findings: current.findings?.length, lastMessage: current.status !== 'done' ? current.messages?.at(-1)?.text : undefined }));
    assert.equal(current.status, 'done');
    assert.ok(report, 'The mode-specific report must be published.');
    assert.ok(current.activities?.some(item => item.toolName === 'browser_snapshot' && item.status === 'done'), 'Must execute a real browser snapshot.');
    assert.ok(current.tokenUsage?.totalTokens > 0, 'Must record actual JEV token usage.');
    if (mode === 'qa') {
      assert.equal(current.report.executionEvidence?.controller, 'coverage-decisions-v2');
      assert.ok(current.jev.qa.checks.some(check => check.action === 'navigation' && check.assertions?.length >= 4), 'Must execute real click/back/forward assertions, not only open pages.');
      console.log(JSON.stringify({ execution: { routes: current.jev.qa.visits.length, scenarios: current.jev.qa.checks.length, assertions: current.jev.qa.checks.reduce((sum, check) => sum + (check.assertions?.length ?? 0), 0), failedAssertions: current.jev.qa.checks.flatMap(check => check.assertions ?? []).filter(assertion => assertion.outcome === 'fail').length, stopReason: current.jev.qa.stopReason, durationSeconds: Math.round((current.jev.qa.completedAt - current.jev.qa.startedAt) / 1000) } }));
    }
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
if (Date.now() >= deadline) { await api(`/sessions/${session.id}/stop`, {}); throw new Error('JEV smoke run timed out and was stopped.'); }
