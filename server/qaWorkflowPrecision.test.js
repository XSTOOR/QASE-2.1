import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { runJevBrowserCheck, settleJevPage } from './jevBrowserChecks.js';
import { settleQaControl } from './qaRenderReadiness.js';
import { createQaScenarioLedger } from './qaScenarioLedger.js';
import { hybridCompletion, validateHybridFinding } from './qaCompletionGate.js';

test('a history timeout retains click/HTTP evidence and an unresolved gap without replay', { timeout: 15000 }, async t => {
  let requests = 0;
  const server = http.createServer((_req, res) => { requests++; res.setHeader('Content-Type', 'text/html'); res.end('<title>Navigation</title><p>Readable fixture</p><a id="next" href="/next">Next</a>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  const targetUrl = `http://127.0.0.1:${server.address().port}/`;
  await page.goto(targetUrl);
  const goBack = page.goBack.bind(page); let attempts = 0;
  page.goBack = async options => { attempts++; await goBack(options); throw new Error('Fixture history deadline after source navigation'); };
  const result = await runJevBrowserCheck(page, { action: 'navigation', selector: '#next', expected: `${targetUrl}next` });
  assert.equal(attempts, 1); assert.equal(result.success, true); assert.equal(result.executionComplete, false); assert.equal(result.destinationReady, false);
  assert.equal(result.assertions.length, 2); assert.ok(result.assertions.every(item => item.outcome === 'pass'));
  assert.match(result.gaps[0], /browser back.*Fixture history deadline/);
  const session = { id: 'partial-navigation', mode: 'qa', targetUrl, selectedTests: ['navigation'], hybrid: {} };
  let checkpoint;
  const ledger = createQaScenarioLedger(session, { persist: async () => { checkpoint = structuredClone(session); } }), scenario = session.hybrid.scenarios[0];
  await ledger.start(scenario.id); const action = await ledger.beginAction('browser_qa_check', { action: 'navigation' });
  const evidence = await ledger.record(action, result); await ledger.close(scenario.id, 'complete');
  assert.equal(checkpoint.hybrid.observations[0].kind, 'execution_gap');
  assert.equal(checkpoint.hybrid.observations[0].evidenceRefs[0], evidence.id);
  assert.equal(hybridCompletion(checkpoint).unresolved, 1);
  assert.equal(hybridCompletion(checkpoint).verdict, 'partial');
  assert.throws(() => validateHybridFinding(checkpoint, { scenario_id: scenario.id, assertion_id: scenario.assertions[0].id }), /failed host assertion/);
  assert.ok(requests >= 2);
});

test('control-local readiness ignores unrelated rotating content and a non-loading progress meter', { timeout: 10000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<title>Readiness fixture</title><div role="progressbar" aria-valuenow="50">Example completion meter</div><div id="ticker">Product 0</div><button id="faq" aria-controls="panel" aria-expanded="false">FAQ</button><section id="panel" hidden>Answer</section><script>let i=0;setInterval(()=>ticker.textContent="Product "+(++i),20)</script>');
  let began = performance.now(); await settleJevPage(page); const pageWideMs = performance.now() - began;
  began = performance.now(); const ready = await settleQaControl(page, '#faq'); const localMs = performance.now() - began;
  assert.equal(ready.ready, true);
  assert.ok(localMs < pageWideMs, 'An unrelated ticker must not impose its full-page readiness deadline on each control.');
  t.diagnostic(JSON.stringify({ pageWideMs: Math.round(pageWideMs), controlLocalMs: Math.round(localMs), scope: 'This disposable ticker fixture only; not whole-run latency.' }));
  await page.locator('#panel').evaluate(node => node.setAttribute('aria-busy', 'true'));
  assert.equal((await settleQaControl(page, '#faq')).ready, false, 'A declared busy panel must not be mistaken for stable content.');
});

test('delayed native disclosure transitions are awaited and their original state is restored', { timeout: 15000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<title>Delayed control</title><button id="faq" aria-controls="panel" aria-expanded="false" onclick="setTimeout(()=>{const open=this.getAttribute(\'aria-expanded\')!==\'true\';this.setAttribute(\'aria-expanded\',String(open));panel.hidden=!open},320)">FAQ</button><section id="panel" hidden>Answer</section>');
  const result = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#faq', restore: true });
  assert.equal(result.success, true, result.error); assert.ok(result.assertions.length >= 2);
  assert.ok(result.assertions.every(item => item.outcome === 'pass'), JSON.stringify(result.assertions));
  assert.equal(await page.locator('#faq').getAttribute('aria-expanded'), 'false');
});
