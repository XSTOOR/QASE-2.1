import test from 'node:test';
import assert from 'node:assert/strict';
import { runJevQa } from './jevQaRunner.js';
import { jevDiagnosticCandidates } from './jevRuntime.js';

// Deliberately imperfect model confidence is part of this fixture. Verified
// browser failures must not disappear just because a probability is < 0.9.
function fixture({ errorCount = 1, transient = true, noiseOnly = false } = {}) {
  const url = 'https://accuracy.test/';
  const session = { id: 'accuracy-fixture', targetUrl: url, mode: 'qa', selectedTests: ['console_health'], findings: [], messages: [], jev: { pages: [] } };
  const calls = [];
  let opens = 0;
  let report;
  const inventory = { url, title: 'Controlled accuracy fixture', text: 'A page with deliberate failures and normal anonymous session checks.', viewport: { width: 1440, height: 900 }, forms: [], search: [], disclosures: [], images: 0, links: [] };
  const noise = () => ({
    console: [
      { level: 'error', message: 'Failed to load resource: the server responded with a status of 401 ()', sourceId: url + 'api/auth/me', timestamp: Date.now() },
      { level: 'error', message: 'Failed to load resource: the server responded with a status of 404 ()', sourceId: url + 'document.pdf/__next._tree.txt?_rsc=fixture', timestamp: Date.now() },
      { level: 'error', message: 'net::ERR_BLOCKED_BY_CLIENT', sourceId: url + 'blocked', timestamp: Date.now() }
    ],
    network: [
      { url: url + 'api/auth/me', method: 'GET', statusCode: 401, resourceType: 'fetch' },
      { url: url + 'document.pdf/__next._tree.txt?_rsc=fixture', method: 'GET', statusCode: 404, resourceType: 'fetch' },
      { url: url + 'blocked', method: 'GET', statusCode: 403, resourceType: 'document' },
      { url: 'https://unrelated.test/widget', method: 'GET', statusCode: 500, resourceType: 'fetch' }
    ],
    securityBlocks: [{ url: url + 'blocked', reason: 'Fixture policy denial' }]
  });
  const diagnostics = () => {
    const result = noise();
    if (!noiseOnly) {
      for (let index = 0; index < errorCount; index++) result.console.push({ level: 'error', message: `Uncaught TypeError: fixture failure ${index}`, sourceId: url + 'app.js', lineNumber: index + 1, timestamp: Date.now() });
      result.network.push({ url: url + 'required.js', method: 'GET', statusCode: 500, resourceType: 'script' });
      if (transient && opens === 1) result.console.push({ level: 'error', message: 'Uncaught TypeError: transient startup failure', sourceId: url + 'boot.js', timestamp: Date.now() });
    }
    return { success: true, ...result };
  };
  async function* invoke(name, input = {}) {
    calls.push({ name, input });
    let result = { success: true };
    if (name === 'browser_open') { opens++; result.url = url; }
    if (name === 'browser_qa_check') result = { success: true, action: input.action, url, inventory, assertions: [] };
    if (name === 'browser_snapshot') result = { success: true, ...inventory, bodyText: inventory.text, elements: [] };
    if (name === 'browser_diagnostics') result = diagnostics();
    if (name === 'report_finding') session.findings.push({ id: `finding-${session.findings.length}`, ...input });
    if (name === 'finish_qa_report') report = input;
    yield { type: 'tool_result', toolName: name, result };
    return result;
  }
  const reviewCalls = [];
  async function decide(state, questions) {
    if (questions.verdict) return { verdict: { choice: 'pass' } };
    reviewCalls.push(state);
    return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'noul' ? { noul: 0.55 } : { choice: Object.keys(question.criteria)[0] }]));
  }
  return { session, calls, reviewCalls, report: () => report, async run() { for await (const _ of runJevQa({ session, runStore: { async commit() {} }, invoke, decide, diagnosticCandidates: jevDiagnosticCandidates, signal: new AbortController().signal, maxPages: 1 })) {} } };
}

test('reproduced JavaScript and required-resource failures are retained despite an uncertain model', async () => {
  const f = fixture();
  await f.run();
  assert.ok(f.calls.filter(call => call.name === 'browser_open').length >= 2, 'Diagnostic evidence needs a fresh browser load, not two reads of a cumulative buffer.');
  assert.ok(f.session.findings.some(finding => finding.actual.includes('fixture failure 0')), 'The reproducible uncaught exception must be reported.');
  assert.ok(f.session.findings.some(finding => finding.actual.includes('required.js')), 'The reproducible failed required script must be reported.');
  assert.ok(!f.session.findings.some(finding => /auth\/me|_rsc=|\/blocked|unrelated\.test|transient startup/.test(finding.actual)), 'Expected authentication, speculative fetches, policy blocks and unconfirmed observations are not confirmed defects.');
  assert.ok(JSON.stringify(f.session.jev.qa.issueReview).includes('transient startup failure'), 'An unreproduced diagnostic remains visible for review.');
  assert.notEqual(f.report().verdict, 'pass');
});

test('normal anonymous authentication, blocked resources and speculative prefetches do not become defects', async () => {
  const f = fixture({ noiseOnly: true });
  await f.run();
  assert.equal(f.session.findings.length, 0);
});

test('candidate batching does not silently discard reproducible failures after candidate 24', async () => {
  const f = fixture({ errorCount: 27, transient: false });
  await f.run();
  const review = JSON.stringify(f.session.jev.qa.issueReview);
  for (let index = 0; index < 27; index++) {
    assert.ok(f.session.findings.some(finding => finding.actual.includes(`fixture failure ${index}`)) || review.includes(`fixture failure ${index}`), `Failure ${index} needs a finding or an explicit review disposition.`);
  }
  assert.notEqual(f.report().verdict, 'pass');
});
