import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createQaTestWrites } from './qaTestWrites.js';
import { safeBrowserRoute } from './browserRouteSafety.js';

async function fixture(t, { enabled = true, uncertain = false } = {}) {
  let writes = 0, intentSaved = false;
  const controller = new AbortController();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      writes++; assert.equal(intentSaved, true, 'Durable intent must precede dispatch.');
      if (uncertain) { controller.abort(new Error('Fixture cancellation')); return; }
      res.end('<h1>Test record received</h1>'); return;
    }
    res.setHeader('Content-Type', 'text/html'); res.end('<form id="record" method="post" action="/records"><label>Record name<input name="name" required></label><button type="submit">Save test record</button></form>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { id: randomUUID(), ownerUserId: 'owner', qaExecutionMode: 'hybrid', targetUrl: origin, hybrid: {} };
  session.hybrid.writeAuthorization = { enabled, ownerUserId: session.ownerUserId, runId: session.id, maximumSubmissions: 10, trials: [] };
  const policy = createQaTestWrites(session, async () => { intentSaved = session.hybrid.writeAuthorization.trials.some(item => item.status === 'dispatched'); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.route('**/*', safeBrowserRoute(async route => {
    const decision = await policy.requestDecision(route.request());
    if (decision?.allowed || route.request().method() === 'GET') await route.continue(); else await route.abort();
  }));
  await page.goto(origin);
  return { session, policy, page, origin, controller, writes: () => writes };
}

test('owner-enabled namespaced test form writes persist intent and never replay an attempted form', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const result = await f.policy.run(f.page, '#record');
  assert.equal(result.writeTesting.submitted, true); assert.equal(result.writeTesting.httpStatus, 200);
  assert.equal(result.assertions.length, 0, 'HTTP acknowledgment must not become a business success assertion.');
  assert.equal(f.writes(), 1);
  await f.page.goto(f.origin);
  const repeat = await f.policy.run(f.page, '#record');
  assert.equal(repeat.success, false); assert.equal(f.writes(), 1);
});

test('read-only and wrong-owner runs never acquire test-write permission', { timeout: 30000 }, async t => {
  const f = await fixture(t, { enabled: false });
  assert.equal((await f.policy.run(f.page, '#record')).code, 'QA_TEST_WRITES_NOT_AUTHORIZED');
  f.session.hybrid.writeAuthorization.enabled = true; f.session.hybrid.writeAuthorization.ownerUserId = 'different-owner';
  assert.equal((await f.policy.run(f.page, '#record')).code, 'QA_TEST_WRITES_NOT_AUTHORIZED');
  assert.equal(f.writes(), 0);
});

test('cancellation after dispatch preserves uncertain write state and cannot authorize a replay', { timeout: 30000 }, async t => {
  const f = await fixture(t, { uncertain: true }), began = Date.now();
  await assert.rejects(f.policy.run(f.page, '#record', f.controller.signal), /Fixture cancellation/);
  assert.ok(Date.now() - began < 5000); assert.equal(f.writes(), 1);
  assert.equal(f.session.hybrid.writeAuthorization.trials[0].status, 'uncertain');
  await f.page.goto(f.origin);
  assert.equal((await f.policy.run(f.page, '#record')).success, false); assert.equal(f.writes(), 1);
});

test('account, communication and prefilled forms are not submitted as test records', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const content of ['<form id="record"><label>Message<input name="message"></label><button>Send message</button></form>', '<form id="record"><input name="name" value="Existing customer record"><button>Save</button></form>', '<form id="record" method="post"><input type="hidden" name="_method" value="DELETE"><input name="name"><button>Save</button></form>']) {
    await f.page.setContent(content);
    assert.equal((await f.policy.run(f.page, '#record')).success, false);
  }
  assert.equal(f.writes(), 0);
});

test('a plain form grant cannot dispatch extra JSON operations or nested API payloads', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  await f.page.evaluate(() => { document.querySelector('form').onsubmit = event => {
    event.preventDefault();
    fetch('/unapproved', { method: 'POST', body: new URLSearchParams({ name: document.querySelector('input').value }) }).catch(() => {});
    fetch('/records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.querySelector('input').value, operation: { deleteAll: true } }) }).catch(() => {});
  }; });
  const result = await f.policy.run(f.page, '#record');
  assert.equal(f.writes(), 0); assert.equal(result.success, false);
  assert.equal(f.session.hybrid.writeAuthorization.trials[0].status, 'not_dispatched');
});
