import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { runLiveFormChecks, liveInputCases } from './qaLiveForms.js';
import { createQaInputIsolation } from './qaInputIsolation.js';
import { createQaScenarioLedger } from './qaScenarioLedger.js';
import { validateHybridFinding } from './qaCompletionGate.js';
import { runJevBrowserCheck } from './jevBrowserChecks.js';
import {inspectJevPage} from './jevBrowserChecks.js';
import {runJevAccessibility} from './jevAccessibility.js';

async function fixture(t, content) {
  const requests = [];
  const server = http.createServer((req, res) => { requests.push({ url: req.url, method: req.method }); res.setHeader('Content-Type', 'text/html'); res.end(`<title>Input fixture</title>${content}`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' }), isolation = createQaInputIsolation();
  isolation.attach(context);
  await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', route => isolation.decision(route.request()) ? route.abort('blockedbyclient') : route.fallback());
  const page = await context.newPage(), origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin);
  return { page, context, isolation, origin, requests, options: { protectInputs: page => isolation.protect(page) } };
}

test('fixed input matrix is bounded, synthetic and includes negative type, whitespace, Unicode and length/range cases', () => {
  const text = liveInputCases({ type: 'text', minLength: 3, maxLength: 8 });
  for (const kind of ['empty', 'whitespace', 'unicode', 'below_minlength', 'maxlength_boundary', 'above_maxlength']) assert.ok(text.some(item => item.kind === kind));
  assert.ok(liveInputCases({ type: 'email' }).some(item => item.value === 'qase@example.invalid'));
  assert.ok(liveInputCases({ type: 'url' }).some(item => item.kind === 'malformed_url'));
  assert.ok(liveInputCases({ type: 'number', min: '2', max: '10' }).some(item => item.kind === 'below_minimum'));
  assert.ok(liveInputCases({ type: 'number', min: '2', max: '10', step: '2' }).some(item => item.kind === 'step_mismatch'));
  assert.ok(!liveInputCases({ type: 'number', min: '2', max: '10', step: 'any' }).some(item => item.kind === 'step_mismatch'));
  assert.ok(text.length <= 8 && text.every(item => item.value.length <= 129));
});

test('real inputs and negative paths run without submission, preserve private fields and block delayed autosaves after return', { timeout: 30000 }, async t => {
  const f = await fixture(t, `<form onsubmit="window.submits++;event.preventDefault()"><input id="text" name="message" required minlength="2" maxlength="12" oninput="fetch('/save',{method:'POST',body:this.value}).catch(()=>{});setTimeout(()=>fetch('/late?value='+encodeURIComponent(this.value)).catch(()=>{}),900)"><input id="email" type="email" required><input id="private" value="private-original-value"><input id="token" name="api_token"><button>Send</button></form><script>window.submits=0;window.inputs=0;document.addEventListener('input',()=>window.inputs++)</script>`);
  const result = await runLiveFormChecks(f.page, f.options);
  assert.equal(result.formTesting.mode, 'live_non_submitting'); assert.equal(result.formTesting.fieldsFilled, 2);
  assert.ok(result.formTesting.casesExecuted >= 8); assert.ok(result.formTesting.negativeCases >= 3);
  assert.equal(result.formTesting.submissionExecuted, false); assert.equal(result.formTesting.restored, true);
  assert.ok(await f.page.evaluate(() => window.inputs) >= 8); assert.equal(await f.page.evaluate(() => window.submits), 0);
  assert.equal(await f.page.locator('#text').inputValue(), ''); assert.equal(await f.page.locator('#email').inputValue(), '');
  assert.equal(await f.page.locator('#private').inputValue(), 'private-original-value'); assert.equal(await f.page.locator('#token').inputValue(), '');
  assert.ok(!JSON.stringify(result).includes('private-original-value'));
  assert.deepEqual(result.coverageLimitations.map(({code,excludedControls})=>({code,excludedControls})),[{code:'QA_INPUT_SAMPLE_LIMIT',excludedControls:2}]);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.ok(!f.requests.some(request => /save|late/.test(request.url)));
  assert.ok(result.blockedRequests.length); assert.ok(result.gaps.some(gap => /network dependencies/.test(gap)));
  await f.isolation.navigation(f.page, [`${f.origin}/next`], () => f.page.goto(`${f.origin}/next`));
  await f.page.evaluate(() => fetch('/read-after-fresh-document'));
  assert.ok(f.requests.some(request => request.url === '/read-after-fresh-document'), 'A proved fresh approved document releases the old input quarantine.');
  f.isolation.protect(f.page);
  await assert.rejects(f.page.goto(`${f.origin}/unauthorized-navigation`));
  assert.ok(!f.requests.some(request => request.url === '/unauthorized-navigation'));
});

test('a live validation function accepting unchanged declared-invalid input needs repeated evidence, not model agreement', { timeout: 20000 }, async t => {
  const f = await fixture(t, '<input id="email" type="email" required><script>email.checkValidity=()=>true</script>');
  const session = { id: 'live-input-evidence', mode: 'qa', selectedTests: ['forms'], targetUrl: f.origin, hybrid: {} };
  const ledger = createQaScenarioLedger(session), scenario = session.hybrid.scenarios[0]; await ledger.start(scenario.id);
  const action = await ledger.beginAction('browser_qa_check', { action: 'forms' });
  const result = await runLiveFormChecks(f.page, f.options);
  const failures = result.assertions.filter(item => item.outcome === 'fail');
  assert.ok(failures.length >= 2); assert.ok(failures.every(item => item.reproduction?.confirmed && item.reproduction.observations === 2));
  assert.equal(await f.page.locator('#email').inputValue(), '');
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
  const evidence = await ledger.record(action, { ...result, success: true, action: 'forms', url: f.origin });
  await ledger.close(scenario.id, 'complete');
  assert.equal(scenario.status, 'failed');
  const confirmed = validateHybridFinding(session, { scenario_id: scenario.id, assertion_id: scenario.assertions.find(item => item.outcome === 'fail').id });
  assert.ok(confirmed.evidenceRefs.includes(evidence.id));
});

test('number boundaries, textareas and observed select options are exercised and restored', { timeout: 15000 }, async t => {
  const f = await fixture(t, '<input id="quantity" type="number" min="2" max="5" required><textarea id="notes" minlength="2"></textarea><select id="choice" required><option value="">Choose</option><option value="observed">Observed option</option></select>');
  const result = await runLiveFormChecks(f.page, f.options);
  assert.equal(result.formTesting.fieldsFilled, 3); assert.ok(result.formTesting.negativeCases >= 3);
  assert.ok(result.fields.find(field => field.field === 'quantity').trials.some(trial => trial.kind === 'above_maximum'));
  assert.ok(result.fields.find(field => field.field === 'choice').trials.some(trial => trial.kind === 'observed_option'));
  for (const id of ['quantity', 'notes', 'choice']) assert.equal(await f.page.locator(`#${id}`).inputValue(), '');
  assert.equal(result.assertions.filter(item => item.outcome === 'fail').length, 0);
});

test('search inputs receive live text edge cases rather than becoming unsupported form gaps', { timeout:15000 },async t=>{
 const f=await fixture(t,'<label>Search tasks<input id="query" type="search" required minlength="3"></label>');
 const result=await runLiveFormChecks(f.page,f.options);
 assert.equal(result.formTesting.fieldsFilled,1);assert.ok(result.formTesting.negativeCases>=2);
 assert.ok(result.fields[0].trials.some(trial=>trial.kind==='unicode'));
 assert.deepEqual(result.coverageLimitations,[]);assert.equal(await f.page.locator('#query').inputValue(),'');
 assert.equal(f.requests.filter(r=>r.method!=='GET').length,0);
});

test('native modal ownership excludes inert background inputs, tabs and naming checks', { timeout:15000 },async t=>{
 const f=await fixture(t,`<div role="tablist"><button id="background-tab" role="tab" aria-selected="false">Details</button></div><form><input id="background" value="private-value"><button id="unnamed"></button></form><dialog id="modal"><form><label>Record name<input id="record" name="record" required minlength="3"></label></form><button type="button" onclick="modal.close()">Close</button></dialog><script>modal.showModal()</script>`);
 const inventory=await inspectJevPage(f.page);
 assert.equal(inventory.tabs.length,0);assert.equal(inventory.fieldCount,1);assert.equal(inventory.forms.length,1);
 const result=await runLiveFormChecks(f.page,f.options);
 assert.equal(result.formTesting.fieldsFilled,1);assert.equal(result.gaps.length,0);assert.equal(result.fields[0].field,'record');
 assert.equal(await f.page.locator('#record').inputValue(),'');assert.equal(await f.page.locator('#background').inputValue(),'private-value');
 const naming=await runJevAccessibility(f.page);
 assert.ok(naming.assertions.length>0&&naming.assertions.every(a=>a.outcome==='pass'));
 await f.page.locator('dialog button').click();
 assert.equal((await inspectJevPage(f.page)).tabs.length,1,'Closing the modal restores the background inventory.');
});

test('cancellation restores filled values and retains egress quarantine; missing isolation never edits fields', { timeout: 15000 }, async t => {
  const f = await fixture(t, '<input id="text" required>'), controller = new AbortController();
  const absent = await runLiveFormChecks(f.page); assert.equal(absent.assertions.length, 0); assert.ok(absent.gaps.length);
  await assert.rejects(runLiveFormChecks(f.page, { ...f.options, signal: controller.signal, onAction(step) { if (step.phase === 'after') controller.abort(new Error('Stop input trial')); } }), /Stop input trial/);
  assert.equal(await f.page.locator('#text').inputValue(), '');
  await assert.rejects(f.page.evaluate(() => fetch('/late-after-cancel')));
  assert.ok(!f.requests.some(request => request.url === '/late-after-cancel'));
});

test('detached controls during a live trial cannot produce restoration or pass claims', { timeout: 10000 }, async t => {
  const f = await fixture(t, '<input id="text" oninput="this.remove()">');
  const result = await runLiveFormChecks(f.page, f.options);
  assert.equal(result.success, false); assert.equal(result.code, 'QA_INPUT_RESTORE_FAILED');
  assert.equal(result.formTesting.restored, false); assert.equal(result.assertions.length, 0);
});

test('popups initiated by an input event inherit quarantine and cannot escape the side-effect guard', { timeout: 10000 }, async t => {
  const f = await fixture(t, '<input id="text" oninput="if(!window.opened){window.opened=true;window.open(\'/popup-side-effect\')}">');
  const result = await runLiveFormChecks(f.page, f.options);
  assert.ok(result.formTesting.casesExecuted > 0);
  assert.ok(result.formTesting.blockedNetworkAttempts > 0);
  assert.ok(!f.requests.some(request => request.url === '/popup-side-effect'));
  assert.ok(result.gaps.some(gap => /network dependencies/.test(gap)));
});

test('blocked telemetry cannot erase an observed local menu pass or confirm an unverified failure', { timeout: 10000 }, async t => {
  const f = await fixture(t, '<button id="menu" aria-controls="panel" aria-expanded="false" onclick="fetch(\'/telemetry\',{method:\'POST\'}).catch(()=>{});const open=this.getAttribute(\'aria-expanded\')!==\'true\';this.setAttribute(\'aria-expanded\',String(open));panel.hidden=!open">Menu</button><section id="panel" hidden>Local navigation</section>');
  const result = await runJevBrowserCheck(f.page, { action: 'disclosure', selector: '#menu', restore: true });
  assert.ok(result.blockedRequests.length); assert.ok(result.gaps.length);
  assert.ok(result.assertions.length >= 2 && result.assertions.every(item => item.outcome === 'pass'));
  assert.ok(!f.requests.some(request => request.url === '/telemetry'));
});
