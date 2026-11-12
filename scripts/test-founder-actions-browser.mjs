import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chromium, request } from 'playwright';
import { createApplication } from '../server/app.js';
import { createLocalApplicationServices } from '../server/localServices.js';
import { createTenantContext } from '../server/tenancy.js';
import { createInstanceAccess } from '../server/instanceAccess.js';
import { createDrytisIntegrationConfig } from '../server/drytisIntegrationConfig.js';
import { createDrytisDeliveryClient, DRYTIS_OUTBOUND_HEADERS, signDrytisRequest } from '../server/drytisTransport.js';
import { createFounderBrowserFixture } from './founder-browser-fixture.mjs';
import { isolatedSqaEnvironment } from './sqa-test-runtime.mjs';

// Real local authentication, owned runs, HTTP handlers and atomic file storage.
// The real signing client has a controlled fetch receiver; nothing reaches Studio.
const originalDirectory = process.cwd(), output = path.resolve('test-results/founder-actions');
const originalAuthPath=path.join(originalDirectory,'.qase','auth.json');
async function authFingerprint(){try{return createHash('sha256').update(await fs.readFile(originalAuthPath)).digest('hex');}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const originalAuthFingerprint=await authFingerprint();
const runtimeDirectory = path.join(output, `runtime-${Date.now()}`);
await fs.mkdir(runtimeDirectory, { recursive: true }); process.chdir(runtimeDirectory);
const tenant = createTenantContext(), checks = [], errors = [], unexpected = [], deliveries = [];
let application, services, server, port = 0, base, browser, page, owner, other;
let modelCalls = 0, failNextSave = false, saveGate, deliveryGate, failNextDelivery = false;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const transportConfig = createDrytisIntegrationConfig({ QASE_DRYTIS_API_ORIGIN: 'https://studio.fixture.test', QASE_DRYTIS_ALLOWED_ORIGINS: 'https://studio.fixture.test', QASE_DRYTIS_HMAC_KEY: randomBytes(32).toString('base64url') });
const deliveryClient = createDrytisDeliveryClient({ config: transportConfig, fetchImpl: async (url, options) => {
  const destination = new URL(url), headers = DRYTIS_OUTBOUND_HEADERS;
  assert.equal(destination.origin, 'https://studio.fixture.test');
  const signature = signDrytisRequest({
    signingKey: transportConfig.signingKey, signer: 'qase', method: options.method,
    requestTarget: destination.pathname + destination.search, body: Buffer.from(options.body),
    timestamp: options.headers[headers.timestamp], nonce: options.headers[headers.nonce],
    idempotencyKey: options.headers[headers.idempotencyKey], correlationId: options.headers[headers.correlationId]
  });
  const call = { body: Buffer.from(options.body).toString('utf8'), key: options.headers[headers.idempotencyKey], signed: options.headers[headers.signature] === signature };
  assert.ok(call.signed);
  deliveries.push(call); if (deliveryGate) await deliveryGate.promise;
  if (failNextDelivery) { failNextDelivery = false; return new Response(JSON.stringify({ error: 'Controlled receiver unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }); }
  return new Response(JSON.stringify({ accepted: true, jobId: `fixture-job-${deliveries.length}` }), { status: 202, headers: { 'Content-Type': 'application/json' } });
} });
async function start(configured = true, automaticFounderHandoff = false) {
  services = createLocalApplicationServices({ tenantContext: tenant, authFile: path.join(runtimeDirectory,'.qase','auth.json') }); await services.runs.load();
  services.tenantContext = tenant;
  services.configuration.getPublic = () => ({ provider: 'custom', model: 'fixture', ready: true, hasApiKey: true, providers: ['custom'] });
  services.agent.runTurn = async () => { modelCalls++; throw new Error('Model calls forbidden in action acceptance.'); };
  services.agent.ensureRuntime = services.agent.runTurn;
  application = createApplication({ services, tenantContext: tenant, authRequired: true, environment: isolatedSqaEnvironment(), access: createInstanceAccess({ tenantContext: tenant }),
    drytisDelivery: configured ? { deliveryClient, founderHandoffTarget: '/handoff', automaticFounderHandoff } : undefined });
  server = await new Promise(resolve => { const candidate = application.app.listen(port, '127.0.0.1', () => resolve(candidate)); });
  port = server.address().port; base = `http://127.0.0.1:${port}`;
}
async function stop() {
  if (!server) return;
  await application.whenIdle(); await new Promise(resolve => server.close(resolve));
  await services.lifecycle.close(); server = undefined;
}
async function api(client, endpoint, method = 'GET', data) {
  const csrf = (await client.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf');
  return client.fetch(`${base}/api${endpoint}`, { method, ...(data ? { data } : {}), headers: csrf ? { 'X-CSRF-Token': decodeURIComponent(csrf.value) } : {} });
}
async function state(session, client = owner) { const response = await api(client, `/founder/state?runId=${session.id}`); assert.equal(response.status(), 200); return (await response.json()).state; }
const input = (session, saved, ids = saved.selections) => ({ runId: session.id, reviewKey: saved.reviewKey, expectedRevision: saved.revision, selectedRecommendationIds: ids });
const root = () => page.locator('#report-view');
const checkbox = id => root().locator(`input[data-recommendation-id="${id}"]`);
async function open(session) {
  await page.goto(`${base}/#/runs/${session.id}`);
  await root().locator('.founder-report-navigation').waitFor();
  await page.waitForFunction(id => document.querySelector('#report-view')?.dataset.founderRun === id && document.querySelector('#report-view [data-recommendation-id]')?.getAttribute('aria-disabled') === 'false', session.id);
  await root().locator('[data-founder-section-choice]').selectOption('recommendations');
  await root().getByRole('button', { name: 'Go to section', exact: true }).click();
}
try {
  await start(); owner = await request.newContext(); other = await request.newContext();
  const password = `Fixture password ${randomUUID()}`;
  const ownerResponse = await api(owner, '/auth/register', 'POST', { email: `owner-${randomUUID()}@example.test`, password, displayName: 'Actions owner' }); assert.equal(ownerResponse.status(), 201);
  const user = await ownerResponse.json();
  const otherResponse = await api(other, '/auth/register', 'POST', { email: `other-${randomUUID()}@example.test`, password, displayName: 'Other owner' }); assert.equal(otherResponse.status(), 201);
  const otherUser = await otherResponse.json();
  await stop();
  const sessions = await Promise.all(Array.from({ length: 4 }, () => createFounderBrowserFixture()));
  const [a,b,c,foreign] = sessions;
  sessions.forEach((session, i) => { session.title = session.founder.scope.target.name = `Founder action report ${i+1}`; session.ownerUserId = i === 3 ? otherUser.id : user.id; });
  await fs.writeFile(path.join(runtimeDirectory, '.qase', 'sessions.json'), JSON.stringify(sessions));
  await start();
  const ids = a.founder.report.recommendations.map(item => item.id);
  assert.equal((await api(other, `/founder/state?runId=${a.id}`)).status(), 404);
  assert.equal((await api(owner, '/founder/state/selections', 'PATCH', { selectedRecommendationIds: [ids[0]] })).status(), 409);
  const wrong = await state(b);
  assert.equal((await api(owner, '/founder/state/selections', 'PATCH', { ...input(a, wrong, [ids[0]]), organizationId: 'untrusted' })).status(), 409);
  checks.push('Owned report bindings reject another account, unbound writes and a different publication even when recommendation IDs repeat.');

  browser = await chromium.launch();
  const context = await browser.newContext({ storageState: await owner.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage(); page.setDefaultTimeout(12_000); page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.EventSource = class { constructor() { window.fixtureStream = this; setTimeout(() => this.onopen?.(), 0); } close() {} };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { async writeText() { throw new Error('Controlled clipboard denial'); } } });
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && pathname === '/api/founder/state/selections') {
      if (saveGate) await saveGate.promise;
      if (failNextSave) { failNextSave = false; return route.fulfill({ status: 503, json: { error: 'Controlled storage outage' } }); }
      return route.continue();
    }
    if (request.method() !== 'GET' && pathname !== '/api/founder/handoff') { unexpected.push(`${request.method()} ${pathname}`); return route.fulfill({ status: 405, json: { error: 'Unexpected mutation in acceptance.' } }); }
    return route.continue();
  });
  await open(a); saveGate = deferred();
  await checkbox(ids[0]).check(); await root().getByText('Saving selection…', { exact: true }).first().waitFor();
  assert.equal(deliveries.length, 0); assert.ok(await root().getByRole('button', { name: 'Send to Studio', exact: true }).isDisabled());
  saveGate.resolve(); saveGate = undefined; await root().getByText(`1 of ${ids.length} selected`, { exact: true }).waitFor();
  await page.reload(); await open(a); assert.ok(await checkbox(ids[0]).isChecked());
  await open(b); assert.equal(await checkbox(ids[0]).isChecked(), false);
  await checkbox(ids[1]).check(); await root().getByText(`1 of ${ids.length} selected`, { exact: true }).waitFor();
  await open(a); assert.ok(await checkbox(ids[0]).isChecked()); assert.equal(await checkbox(ids[1]).isChecked(), false);
  checks.push('Saving shows immediate feedback without delivery; selections survive reload and stay independent across reports with repeated IDs.');

  failNextSave = true; await checkbox(ids[1]).check();
  await root().getByRole('alert').filter({ hasText: 'not saved' }).waitFor(); assert.equal(await checkbox(ids[1]).isChecked(), false);
  await root().getByRole('button', { name: 'Retry saving selection' }).click(); await root().getByText(`2 of ${ids.length} selected`, { exact: true }).waitFor();
  const savedA = await state(a);
  assert.equal((await api(owner, '/founder/state/selections', 'PATCH', input(a, savedA, [ids[0]]))).status(), 200);
  await checkbox(ids[2]).check(); await root().getByRole('alert').filter({ hasText: 'saved selection changed' }).waitFor();
  assert.ok(await checkbox(ids[0]).isChecked()); assert.equal(await checkbox(ids[1]).isChecked(), false); assert.equal(await checkbox(ids[2]).isChecked(), false);
  assert.equal(await root().getByRole('button', { name: 'Retry saving selection' }).count(), 0);
  checks.push('Failed writes roll back visibly and retry explicitly; stale-tab edits reload the winning selection without silently overwriting it.');

  await root().getByRole('button', { name: 'Copy requirements' }).click(); await root().getByRole('alert').filter({ hasText: 'Use Download requirements' }).waitFor();
  const beforeExport = await state(a), downloadEvent = page.waitForEvent('download');
  await root().getByRole('button', { name: 'Download requirements' }).click();
  const download = await downloadEvent, exportedFile = path.join(output, 'selected-requirements.json'); await download.saveAs(exportedFile);
  const exported = JSON.parse(await fs.readFile(exportedFile, 'utf8'));
  assert.equal(exported.sourceRunId, a.id); assert.deepEqual(exported.ordered, [ids[0]]); assert.equal(exported.recommendationSet.reviewKey, beforeExport.reviewKey);
  assert.deepEqual(await state(a), beforeExport); assert.equal(deliveries.length, 0);
  checks.push('Clipboard denial offers Download; the downloaded payload has the exact report and ordered selection and causes no delivery or state mutation.');

  const initialSend = input(a, await state(a)); deliveryGate = deferred();
  await root().getByRole('button', { name: 'Send to Studio', exact: true }).click();
  await root().getByRole('button', { name: 'Sending to Studio…', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#report-view [data-role="send-to-studio"]')?.disabled);
  const deadline = Date.now() + 5000; while (!deliveries.length && Date.now() < deadline) await page.waitForTimeout(40);
  assert.equal(deliveries.length, 1);
  assert.equal((await api(owner, '/founder/handoff', 'POST', initialSend)).status(), 409);
  await open(b); assert.equal(await root().getByRole('button', { name: 'Sending to Studio…' }).count(), 0);
  assert.ok(await checkbox(ids[1]).isChecked());
  deliveryGate.resolve(); deliveryGate = undefined;
  await open(a); await root().getByText(/Studio accepted 1 recommendation/).waitFor();
  assert.match(await root().textContent(), /fixture-job-1/); assert.equal(deliveries.length, 1);
  const duplicate = await api(owner, '/founder/handoff', 'POST', initialSend); assert.equal(duplicate.status(), 200); assert.equal((await duplicate.json()).deduplicated, true); assert.equal(deliveries.length, 1);
  checks.push('Sending feedback appears immediately; a concurrent POST is rejected, late completion stays with its report, and a completed duplicate returns its original receipt.');

  await open(b); failNextDelivery = true;
  await root().getByRole('button', { name: 'Send to Studio', exact: true }).click();
  await root().getByRole('button', { name: 'Retry delivery' }).waitFor(); assert.ok(await checkbox(ids[1]).isChecked());
  await root().getByRole('button', { name: 'Retry delivery' }).click(); await root().getByText(/Studio accepted 1 recommendation/).waitFor();
  assert.equal(deliveries.length, 3); assert.equal(deliveries[1].key, deliveries[2].key); assert.equal(deliveries[1].body, deliveries[2].body); assert.notEqual(deliveries[0].key, deliveries[1].key);
  assert.ok(deliveries.every(call => call.signed && call.key.length <= 128));
  checks.push('The real signing client retries a failed controlled receiver with the same complete payload/key and reads the returned job reference from its response body.');

  await open(a); await checkbox(ids[0]).uncheck(); await root().getByText(`0 of ${ids.length} selected`, { exact: true }).waitFor();
  await checkbox(ids[1]).check(); await root().getByText(`1 of ${ids.length} selected`, { exact: true }).waitFor(); deliveryGate = deferred();
  await root().getByRole('button', { name: 'Send to Studio', exact: true }).click(); await root().getByRole('button', { name: 'Sending to Studio…', exact: true }).waitFor();
  await page.reload(); await root().locator('.founder-report-navigation').waitFor();
  await root().getByText(/saved selection is locked while delivery is pending/).waitFor();
  deliveryGate.resolve(); deliveryGate = undefined;
  await root().getByText(/Studio accepted 1 recommendation/).waitFor(); assert.equal(deliveries.length, 4);
  checks.push('Reload reads the durable pending intent, polls saved status and shows acceptance without dispatching another handoff.');

  await stop(); await start(false); await open(c);
  await checkbox(ids[0]).check(); await root().getByText(`1 of ${ids.length} selected`, { exact: true }).waitFor();
  assert.ok(await root().getByRole('button', { name: 'Studio unavailable' }).isDisabled());
  const unavailable = await api(owner, '/founder/handoff', 'POST', input(c, await state(c))); assert.equal(unavailable.status(), 200); assert.equal((await unavailable.json()).unavailable, true);
  await page.reload(); await open(c); assert.ok(await checkbox(ids[0]).isChecked());
  assert.equal((await api(other, '/founder/state')).status(), 200); assert.equal((await (await api(other, '/founder/state')).json()).state, null);
  assert.equal(deliveries.length, 4);
  checks.push('Restart preserves both selections and receipts; an unconfigured integration exposes export actions and never claims a build or delivers.');

  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('[data-workspace-view="results"]').click(); await page.locator('#tab-report').click();
  await root().getByRole('button', { name: 'Download requirements' }).scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  for (const label of ['Copy requirements','Download requirements']) assert.ok((await root().getByRole('button', { name: label }).boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(output, 'mobile-actions.png') });
  await page.setViewportSize({ width: 1440, height: 1000 }); await root().getByRole('button',{name:'Download requirements'}).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(output, 'desktop-actions.png') });

  await stop(); await start(true, true);
  const launched = await api(owner, '/founder/sessions', 'POST', {
    authorizationConfirmed: true, target: { name: 'Automatic Studio fixture', url: 'https://fixture.test/' }
  });
  assert.equal(launched.status(), 201);
  const run = await services.runs.getAny((await launched.json()).id);
  assert.equal(run.founder.automaticStudioHandoff, true);
  assert.equal(deliveries.length, 4);
  const finished = await createFounderBrowserFixture();
  run.founder = { ...finished.founder, automaticStudioHandoff: run.founder.automaticStudioHandoff };
  Object.assign(run, { status: 'done', targetUrl: finished.targetUrl, activities: finished.activities, todos: finished.todos });
  const autoIds = run.founder.report.recommendations.map(item => item.id);
  deliveryGate = deferred();
  await services.runs.commit(run, 'founder.finalized', { report: run.founder.report });
  services.runs.publish(run, 'founder.finalized', { report: run.founder.report });
  await page.goto(`${base}/#/runs/${run.id}`);
  await root().locator('.founder-report-navigation').waitFor();
  await root().getByText('Sending recommendations to Studio…', { exact: true }).waitFor();
  assert.equal(await root().locator('input[data-recommendation-id]:visible').count(), 0);
  assert.equal(await root().locator('[data-founder-selection-action]:visible').count(), 0);
  assert.equal(await root().locator('[data-role="send-to-studio"]:visible').count(), 0);
  assert.equal(deliveries.length, 5);
  assert.deepEqual(JSON.parse(deliveries.at(-1).body).ordered, autoIds);
  assert.equal(JSON.parse(deliveries.at(-1).body).sourceRunId, run.id);
  deliveryGate.resolve(); deliveryGate = undefined;
  await root().getByText(new RegExp(`Studio accepted ${autoIds.length} recommendations.*fixture-job-5`)).waitFor();
  assert.ok(await root().getByRole('button', { name: 'Download requirements' }).isEnabled());
  await page.reload();
  await root().getByText(/Studio reference fixture-job-5/).waitFor();
  assert.equal(deliveries.length, 5);
  assert.equal((await state(run)).handoff.reference, 'fixture-job-5');
  await root().getByRole('button', { name: 'Download requirements' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'automatic-studio.png') });
  checks.push('An operator-launched Founder review sends every finalized recommendation automatically, deduplicates replay, hides manual selection and send controls, and shows the signed receiver reference after reload.');

  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.equal(modelCalls, 0);
  assert.equal(await authFingerprint(),originalAuthFingerprint,'The integration checkout authentication file must remain unchanged.');
  const result = { status: 'passed', checks, modelCalls, deliveries: deliveries.length, receiver: 'Controlled fetch for the real HMAC signing client; no external Studio request', pageErrors: errors, unexpectedMutations: unexpected };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} catch (error) {
  await page?.screenshot({ path: path.join(output,'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(output,'result.json'),JSON.stringify({status:'failed',checks,error:error.message,modelCalls,pageErrors:errors,unexpectedMutations:unexpected,deliveries:deliveries.length},null,2)); throw error;
} finally {
  saveGate?.resolve(); deliveryGate?.resolve(); await browser?.close(); await Promise.allSettled([owner?.dispose(),other?.dispose()]); await stop(); process.chdir(originalDirectory);
}
