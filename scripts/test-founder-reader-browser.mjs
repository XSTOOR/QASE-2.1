import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { chromium, request } from 'playwright';
import { createSqaTestServer } from './sqa-test-runtime.mjs';
import { createFounderBrowserFixture } from './founder-browser-fixture.mjs';

// Real application assets, owned action persistence and evidence API. Only
// configuration, selection timing and SSE are controlled; no model or Studio.
const { values } = parseArgs({ options: { 'session-file': { type: 'string' }, 'output-dir': { type: 'string' } } });
const directory = path.resolve(values['output-dir'] ?? 'test-results/founder-reader');
await fs.mkdir(directory, { recursive: true });
const runtimeDirectory = path.join(directory, `runtime-${Date.now()}`);
const runtime = await createSqaTestServer(runtimeDirectory, { authRequired: true });
const checks = [], errors = [], unexpectedMutations = [], externalRequests = [];
let browser, page, owner, stranger, anonymous, selectionGate, releaseSelection, evidenceGate, releaseEvidence;
let selectionRequests = 0, evidenceRequests = 0, failEvidence = false;


const source = values['session-file'] ? JSON.parse(await fs.readFile(path.resolve(values['session-file']), 'utf8')) : await createFounderBrowserFixture();
assert.equal(source.mode, 'founder'); assert.equal(source.status, 'done');
assert.ok(source.founder?.report && source.founder.finalizedAt && source.founder.observations.length);
const originalSource = JSON.stringify(source);
const first = structuredClone(source), second = await createFounderBrowserFixture(), legacy = await createFounderBrowserFixture();
second.title = second.founder.scope.target.name = 'Alternate report reader fixture';
legacy.title = legacy.founder.scope.target.name = 'Legacy report reader fixture';
legacy.founder.report.recommendations[0].evidenceObservationIds = ['missing-observation'];
const oldObservation = legacy.founder.observations[0];
oldObservation.title = '<img src=x onerror="window.readerInjected=true">';
oldObservation.evidence[0].reference = 'javascript:window.readerInjected=true';
delete oldObservation.evidence[0].digest;
legacy.activities = legacy.activities.filter(activity => activity.id !== 'reader-activity-1');
legacy.activities.find(activity => activity.id === 'reader-activity-2').summary = 'Changed after the recorded digest; deliberate mismatch fixture.';

const emit = (event, session = first) => page.evaluate(data => window.fixtureStream.onmessage({ data: JSON.stringify(data) }), { sessionId: session.id, ts: Date.now(), ...event });
const root = () => page.locator('#report-view');
async function settled() { await page.waitForTimeout(220); }
async function open(session) {
  await page.goto(`${runtime.base}/#/runs/${session.id}`);
  await page.waitForFunction(() => document.body.dataset.pageLoading !== 'true' && typeof window.fixtureStream?.onmessage === 'function' && document.querySelector('#tab-report')?.getAttribute('aria-selected') === 'true');
  await root().locator('.founder-report-navigation').waitFor();
  await settled();
}
async function navigate(section, surface = root()) {
  await surface.locator('[data-founder-section-choice]').selectOption(section);
  await surface.getByRole('button', { name: 'Go to section', exact: true }).click();
  await settled();
}
async function readingState() {
  return page.evaluate(() => {const pane=document.querySelector('#pane-report'),section=document.querySelector('#report-view [data-founder-section-choice]').value,target=[...document.querySelectorAll('#report-view [data-founder-section]')].find(node=>node.dataset.founderSection===section);return {top:pane.scrollTop,section,sectionTop:target.getBoundingClientRect().top-pane.getBoundingClientRect().top,open:[...document.querySelectorAll('#report-view [data-founder-disclosure]')].map(node=>[node.dataset.founderDisclosure,node.open])};});
}

try {
  await runtime.start();
  owner = await request.newContext({ baseURL: runtime.base });
  const email = `reader-${randomUUID()}@example.test`, password = `Reader fixture ${randomUUID()}`;
  const registered = await owner.post('/api/auth/register', { data: { email, password, displayName: 'Reader fixture owner' } });
  assert.equal(registered.status(), 201);
  const user = await registered.json(); assert.ok(user.id);
  await runtime.stop();
  for (const session of [first, second, legacy]) session.ownerUserId = user.id;
  await fs.writeFile(path.join(runtimeDirectory, '.qase', 'sessions.json'), JSON.stringify([first, second, legacy]));
  await runtime.start();
  // Cookie authentication remains real across the process restart.
  const evidencePath = `/api/sessions/${first.id}/founder/evidence/${encodeURIComponent(first.founder.observations[0].id)}/1`;
  const before = await (await owner.get(`/api/sessions/${first.id}`)).json();
  const receipt = await owner.get(evidencePath);
  assert.equal(receipt.status(), 200); assert.equal(receipt.headers()['cache-control'], 'no-store');
  assert.equal((await receipt.json()).integrity, 'verified');
  anonymous = await request.newContext({ baseURL: runtime.base });
  assert.equal((await anonymous.get(evidencePath)).status(), 401);
  stranger = await request.newContext({ baseURL: runtime.base });
  assert.equal((await stranger.post('/api/auth/register', { data: { email: `other-${randomUUID()}@example.test`, password, displayName: 'Other fixture owner' } })).status(), 201);
  assert.equal((await stranger.get(evidencePath)).status(), 404);
  const after = await (await owner.get(`/api/sessions/${first.id}`)).json();
  for (const field of ['founder', 'activities', 'tokenUsage', 'todos']) assert.deepEqual(after[field], before[field]);
  checks.push('Authenticated evidence lookup verifies an attached receipt; anonymous and other-owner access fail without changing the run.');

  browser = await chromium.launch();
  const context = await browser.newContext({ storageState: await owner.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', colorScheme: 'light' });
  page = await context.newPage(); page.setDefaultTimeout(12_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (/^https?:$/.test(url.protocol) && url.origin !== runtime.base) externalRequests.push(url.origin); });
  await page.addInitScript(() => { window.EventSource = class { constructor() { window.fixtureStream = this; setTimeout(() => this.onopen?.(), 0); } close() {} }; });
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (request.method() === 'PATCH' && pathname === '/api/founder/state/selections') {
      selectionRequests++;
      if (selectionGate) await selectionGate;
      return route.continue();
    }
    if (request.method() !== 'GET') { unexpectedMutations.push(`${request.method()} ${pathname}`); return route.fulfill({ status: 405, json: { error: 'Only selection fixture writes are allowed.' } }); }
    if (pathname.includes('/founder/evidence/')) {
      evidenceRequests++;
      if (failEvidence) { failEvidence = false; return route.fulfill({ status: 503, json: { error: 'Temporary evidence connection failure. Retry this saved record.' } }); }
      if (evidenceGate) await evidenceGate;
    }
    if (pathname === '/api/config') return route.fulfill({ json: { provider: 'custom', model: 'reader-fixture', ready: true, hasApiKey: true, providers: ['custom'] } });
    return route.continue();
  });
  await open(first);
  assert.equal(await root().locator('[data-founder-section]').count(), 12);
  const assumptions = root().locator('.founder-inline-assumptions').first();
  assert.ok(await assumptions.evaluate(node => node.open));
  assert.ok((await assumptions.locator('li').first().textContent()).length > 10);
  await navigate('recommendations');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.founderFocus), 'section-recommendations');
  assert.ok(await root().locator('[data-founder-section="recommendations"]').evaluate(node => node.getBoundingClientRect().top >= document.querySelector('#report-view .founder-report-navigation').getBoundingClientRect().bottom - 2));
  assert.equal(new URL(page.url()).hash, `#/runs/${first.id}`);
  checks.push('All 12 report sections are reachable with a labeled native navigation control; assumptions are expanded and section focus clears the sticky bar.');

  const criteria = root().locator('[data-founder-disclosure^="criteria-"]').first();
  await criteria.locator('summary').click();
  await assumptions.locator('summary').click();
  await navigate('recommendations');
  const box = root().locator('[data-recommendation-id]').first();
  selectionGate = new Promise(resolve => { releaseSelection = resolve; });
  await box.check(); await box.focus();
  await page.waitForFunction(() => document.querySelector('#report-view [data-recommendation-id]')?.getAttribute('aria-disabled') === 'true');
  await page.evaluate(() => { window.readerBox = document.querySelector('#report-view [data-recommendation-id]'); window.readerHeading = document.querySelector('#report-view [data-founder-section="recommendations"] h3'); });
  const position = await readingState();
  await emit({ type: 'activity', activity: { id: 'reader-refresh', toolName: 'reader_fixture', status: 'done', summary: 'Ordinary saved activity update', ts: Date.now() } });
  await emit({ type: 'status', status: 'done' });
  await emit({ type: 'founder.finalized', report: first.founder.report });
  await settled();
  assert.ok(await page.evaluate(() => window.readerBox === document.querySelector('#report-view [data-recommendation-id]') && document.activeElement === window.readerBox && window.readerBox.checked));
  assert.ok(Math.abs((await readingState()).top - position.top) <= 2);
  assert.ok(await criteria.evaluate(node => node.open)); assert.equal(await assumptions.evaluate(node => node.open), false);
  assert.equal(selectionRequests, 1);
  releaseSelection(); selectionGate = undefined;
  await root().getByText(/1 of \d+ selected/).waitFor();
  assert.ok(await box.isChecked());
  // Text selection survives ordinary updates as well as native checkbox focus.
  await page.evaluate(() => { const text = document.querySelector('#report-view [data-founder-section="summary"] .founder-thesis') ?? document.querySelector('#report-view [data-founder-section="summary"] p'); const range = document.createRange(); range.selectNodeContents(text); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); window.readerSelection = selection.toString(); });
  await emit({ type: 'status', status: 'done' }); await settled();
  assert.ok(await page.evaluate(() => getSelection().toString() === window.readerSelection && window.readerSelection.length > 0));
  checks.push('Activity/completion updates preserve mounted controls, focus, text selection, scroll, disclosures and the pending checkbox; selection alone never dispatches Studio.');

  await navigate('roadmap'); const savedPosition = await readingState();
  await page.locator('#tab-founder').click();
  const founderRoot = page.locator('#founder-view');
  await founderRoot.getByText(/1 of \d+ selected/).waitFor();
  await navigate('pricing', founderRoot);
  await page.locator('#tab-report').click(); await settled();
  assert.ok(Math.abs((await readingState()).top - savedPosition.top) <= 2);
  await page.reload(); await root().locator('.founder-report-navigation').waitFor(); await page.waitForFunction(() => document.body.dataset.pageLoading !== 'true'); await settled();
  const reloaded = await readingState();
  assert.equal(reloaded.section, savedPosition.section); assert.ok(Math.abs(reloaded.sectionTop - savedPosition.sectionTop) <= 2, `Reload reading anchor ${reloaded.sectionTop} / ${savedPosition.sectionTop}`);
  for (const [key, isOpen] of savedPosition.open) assert.equal(reloaded.open.find(([name]) => name === key)?.[1], isOpen);
  checks.push('Founder and Report keep independent positions; reload restores report section, scroll and disclosures while canonical selections remain checked.');

  await navigate('recommendations');
  const evidenceButton = root().locator('[data-founder-section="recommendations"] .founder-evidence-link').first();
  await evidenceButton.focus(); await evidenceButton.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Supporting observations' }); await dialog.waitFor();
  const inspect = dialog.getByRole('button', { name: /^Inspect browser record 1/ }).first();
  await inspect.click(); await dialog.getByText('Activity receipt verified', { exact: true }).first().waitFor();
  assert.match(await dialog.textContent(), /receipt binding, not page content, a screenshot/i);
  await emit({ type: 'status', status: 'done' }); assert.ok(await dialog.isVisible());
  await page.screenshot({ path: path.join(directory, 'evidence-desktop.png') });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
  assert.ok(await evidenceButton.evaluate(node => document.activeElement === node));
  checks.push('Keyboard evidence inspection uses the real saved receipt API, states its proof boundary, survives updates and returns focus on Escape.');

  failEvidence = true; await evidenceButton.click();
  const retryDialog = page.getByRole('dialog');
  await retryDialog.getByRole('button', { name: /^Inspect browser record 1/ }).first().click();
  await retryDialog.getByRole('alert').filter({ hasText: 'Temporary evidence connection failure' }).waitFor();
  await retryDialog.getByRole('button', { name: 'Retry evidence lookup' }).click();
  await retryDialog.getByText('Activity receipt verified', { exact: true }).first().waitFor();
  await page.keyboard.press('Escape');
  checks.push('A failed evidence lookup shows an inline error and retries the same read-only receipt without losing report state.');

  await open(second); await navigate('summary');
  await page.goto(`${runtime.base}/#/runs/${first.id}`); await page.waitForFunction(id => document.querySelector('#report-view')?.dataset.founderRun === id, first.id); await settled();
  await evidenceButton.click();
  evidenceGate = new Promise(resolve => { releaseEvidence = resolve; });
  await page.getByRole('dialog').getByRole('button', { name: /^Inspect browser record 1/ }).first().click();
  await page.getByRole('dialog').getByText('Checking the saved browser record…').waitFor();
  const pendingRequestCount = evidenceRequests;
  await page.getByRole('dialog').getByRole('button', { name: /^Inspect browser record 1/ }).first().press('Enter');
  await settled(); assert.equal(evidenceRequests, pendingRequestCount, 'Duplicate lookup while pending is ignored.');
  await page.goBack(); await page.waitForFunction(id => document.querySelector('#report-view')?.dataset.founderRun === id, second.id);
  releaseEvidence(); evidenceGate = undefined; await settled();
  assert.equal(await page.getByRole('dialog').count(), 0);
  checks.push('Switching runs closes evidence and ignores late lookup results; another report has independent reading state.');

  await open(legacy); await navigate('recommendations');
  await root().locator('[data-founder-section="recommendations"] .founder-evidence-link').first().click();
  await page.getByRole('dialog').getByText('Observation unavailable', { exact: true }).waitFor(); await page.keyboard.press('Escape');
  await navigate('evidence'); await root().getByRole('button', { name: /Browse all .* recorded observations/ }).click();
  const oldDialog = page.getByRole('dialog');
  await oldDialog.getByRole('button', { name: /^Inspect browser record 1/ }).first().click();
  await oldDialog.getByText('Reference not verified', { exact: true }).first().waitFor();
  await oldDialog.getByRole('button', { name: /^Inspect browser record 2/ }).first().click();
  await oldDialog.getByText('Original receipt unavailable', { exact: true }).first().waitFor();
  await oldDialog.getByRole('button', { name: /^Inspect browser record 3/ }).first().click();
  await oldDialog.getByText('Receipt does not match', { exact: true }).first().waitFor();
  assert.equal(await oldDialog.locator('img,iframe,script,a[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.readerInjected === true), false);
  await page.keyboard.press('Escape');
  checks.push('Missing observations, pruned receipts and untrusted references are explicit; stored markup is inert text and no external target is fetched.');

  await open(first); await navigate('summary');
  await page.screenshot({ path: path.join(directory, 'desktop.png') });
  await page.emulateMedia({ colorScheme: 'dark' }); await page.screenshot({ path: path.join(directory, 'desktop-dark.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-workspace-view="results"]').click(); await page.locator('#tab-report').click(); await navigate('recommendations');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false);
  assert.ok((await root().getByRole('button', { name: 'Go to section' }).boundingBox()).height >= 44);
  assert.ok((await root().locator('[data-founder-section="recommendations"] .founder-evidence-link').first().boundingBox()).height >= 44);
  await page.screenshot({ path: path.join(directory, 'mobile.png') });
  await root().locator('[data-founder-section="recommendations"] .founder-evidence-link').first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Inspect browser record 1/ }).first().click();
  await page.getByRole('dialog').getByText('Activity receipt verified', { exact: true }).first().waitFor();
  assert.ok(await page.getByRole('dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
  for (const button of await page.getByRole('dialog').getByRole('button').all()) {
    if (await button.isVisible()) assert.ok((await button.boundingBox()).height >= 44, `Mobile evidence target: ${await button.textContent()}`);
  }
  await page.screenshot({ path: path.join(directory, 'evidence-mobile.png') });
  checks.push('Desktop light/dark and 390px mobile render without horizontal overflow; navigation and evidence targets are at least 44px.');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedMutations, []); assert.deepEqual(externalRequests, []);
  assert.equal(JSON.stringify(source), originalSource, 'Source report must stay unchanged.');
  const result = { status: 'passed', source: values['session-file'] ? 'Recorded completed Founder session (read-only replay)' : 'Synthetic report validated through the original Founder publisher', modelCalls: 0, selectionRequests, evidenceRequests, checks, pageErrors: errors, unexpectedMutations, externalRequests };
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
  await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: 'failed', checks, error: error.message, pageErrors: errors, unexpectedMutations, externalRequests }, null, 2));
  throw error;
} finally {
  releaseSelection?.(); releaseEvidence?.();
  await browser?.close(); await Promise.allSettled([owner?.dispose(), stranger?.dispose(), anonymous?.dispose()]); await runtime.stop();
}
