import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { request } from 'playwright';
import { createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { createApplicationDiscovery } from '../server/qaApplicationDiscovery.js';
import { runJevBrowserCheck } from '../server/jevBrowserChecks.js';
import { hybridCompletion, validateHybridFinding } from '../server/qaCompletionGate.js';
import { createQaScenarioLedger } from '../server/qaScenarioLedger.js';
import { projectQaEvidence } from '../server/qaEvidence.js';
import { hybridStorage, hydrateHybrid } from '../server/hybridPersistence.js';
import { legacyModeHash } from '../server/modeIntegrity.js';

const directory = path.resolve(process.env.QASE_EVIDENCE_OUTPUT || 'test-results/qa-evidence-workspace');
const runtimeDirectory = path.join(directory, `runtime-${randomUUID()}`);
const runtime = await createSqaTestServer(runtimeDirectory, { authRequired: true });
const expected = 'Plans and pricing';
const wrong = 'Page unavailable';
const pages = {
  '/': '<h1>Example product</h1><nav><a id="solutions" href="/solutions">Solutions</a></nav>',
  '/solutions': '<h1>Solutions</h1><nav><a id="pricing" href="/pricing">Pricing</a></nav>',
  '/pricing': heading => `<h1>${heading}</h1><p>Choose a plan for your team.</p>`
};
let heading = expected;
const target = createServer((req, res) => {
  const body = pages[req.url];
  if (!body) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><html lang="en"><title>Evidence test fixture</title><main>${typeof body === 'function' ? body(heading) : body}</main></html>`);
});

async function collect(page, targetUrl, ownerUserId, broken) {
  heading = broken ? wrong : expected;
  const session = {
    id: randomUUID(), ownerUserId, mode: 'qa', qaExecutionMode: 'hybrid', status: 'done', targetUrl,
    title: broken ? 'Wrong-copy fixture' : 'Healthy fixture', device: 'desktop', engine: 'chromium',
    createdAt: Date.now(), startedAt: Date.now(), completedAt: Date.now(), updatedAt: Date.now(),
    selectedTests: ['navigation', 'content', 'search', 'visual_consistency'],
    messages: [{ id: randomUUID(), role: 'user', text: `Go through Solutions to Pricing. Expect “${expected}”.`, ts: Date.now() }],
    activities: [], todos: [], findings: [], secretNames: [],
    environmentSnapshot: { device: 'Desktop', browser: 'Chrome', executionType: 'browser_emulation' },
    runtimeFacts: { executionLevel: 'SIMULATED', executionEngine: 'chromium', viewport: page.viewportSize() },
    hybrid: { version: 1, discovery: { version: 1, status: 'pending', features: [], observations: [], probes: [] } }
  };
  const ledger = createQaScenarioLedger(session);
  const run = async (tool, input = {}) => {
    const action = await ledger.beginAction(tool, input);
    let result;
    if (tool === 'browser_qa_check') result = await runJevBrowserCheck(page, input);
    else if (tool === 'browser_get_url') result = { url: page.url() };
    else if (tool === 'browser_open') { await page.goto(input.url); result = { url: page.url() }; }
    else if (tool === 'browser_snapshot') result = { url: page.url(), bodyText: await page.locator('body').innerText() };
    else throw new Error(`Unknown fixture tool ${tool}`);
    const receipt = await ledger.record(action, result);
    return { ...result, hostEvidenceId: receipt.id };
  };
  await page.goto(targetUrl);
  const discovery = createApplicationDiscovery({ session, invoke: run, checkpoint: async () => {} });
  const discovered = await discovery.tool.run();
  assert.equal(discovered.discovery.ready, true);
  const navigation = ledger.state.scenarios.find(scenario => scenario.category === 'navigation');
  const pricing = ledger.state.scenarios.find(scenario => scenario.category === 'content');
  await ledger.plan([{
    id: pricing.id, category: 'content', objective: 'Check the requested copy on the Pricing page.',
    expected: { source: 'request', text: expected },
    feature_ids: [ledger.state.discovery.features.find(feature => feature.kind === 'surface' && feature.location.endsWith('/pricing')).id]
  }]);
  await page.goto(targetUrl);
  await ledger.start(navigation.id);
  for (const link of ['solutions', 'pricing']) {
    const result = await run('browser_qa_check', { action: 'navigation', selector: `#${link}`, expected: targetUrl + link });
    assert.equal(result.responseStatus, 200);
    assert.equal(result.assertions[0].outcome, 'pass');
  }
  await ledger.close(navigation.id, 'complete');
  await ledger.start(pricing.id);
  const observed = await run('browser_snapshot');
  const result = await ledger.assertSnapshot({ scenarioId: pricing.id, evidenceId: observed.hostEvidenceId, predicate: 'text_contains', expected });
  assert.equal(result.outcome, broken ? 'fail' : 'pass');
  if (broken) {
    assert.throws(() => validateHybridFinding(session, { scenario_id: pricing.id, assertion_id: result.id }), /unresolved/);
    await page.reload();
    const repeated = await run('browser_snapshot');
    const assertion = await ledger.assertSnapshot({ scenarioId: pricing.id, evidenceId: repeated.hostEvidenceId, predicate: 'text_contains', expected });
    const finding = validateHybridFinding(session, { scenario_id: pricing.id, assertion_id: assertion.id });
    session.findings.push({ id: randomUUID(), title: 'Pricing shows the wrong copy', category: 'content', severity: 'high',
      description: 'The fixture returned HTTP 200 with the wrong visible copy.', ts: Date.now(), hybridEvidence: finding });
  }
  await ledger.close(pricing.id, 'complete');
  const visual = ledger.state.scenarios.find(scenario => scenario.category === 'visual_consistency');
  await ledger.close(visual.id, 'blocked', 'No approved design reference was supplied.');
  const search = ledger.state.scenarios.find(scenario => scenario.category === 'search');
  const pricingObservation = ledger.state.discovery.observations.find(item => item.location.endsWith('/pricing'));
  session.hybrid.exploration = { routes: [{ url: targetUrl + 'pricing', status: 'tested', absentChecks: [{ category: 'search', evidenceId: pricingObservation.evidenceId }] }] };
  await ledger.close(search.id, 'not_executed', 'No search control was present in the sampled page.');
  const completion = hybridCompletion(session);
  session.report = { verdict: completion.verdict, summary: 'Controlled browser acceptance fixture.', notCovered: completion.gaps, covered: completion.covered, ts: Date.now() };
  return session;
}

let browser, owner, other, anonymous;
try {
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const targetUrl = `http://127.0.0.1:${target.address().port}/`;
  await runtime.start();
  owner = await request.newContext({ baseURL: runtime.base });
  const password = `Evidence fixture ${randomUUID()}`;
  const registered = await owner.post('/api/auth/register', { data: { email: 'evidence-owner@example.test', password, displayName: 'Evidence fixture' } });
  assert.equal(registered.status(), 201);
  const { id: ownerUserId } = await registered.json();
  browser = await launchSqaTestBrowser('chromium');
  const targetPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const healthy = await collect(targetPage, targetUrl, ownerUserId, false);
  const broken = await collect(targetPage, targetUrl, ownerUserId, true);
  const interrupted = structuredClone(healthy);
  const unfinished = interrupted.hybrid.scenarios.find(scenario => scenario.category === 'content');
  interrupted.id = randomUUID();
  interrupted.title = 'Interrupted evidence fixture';
  interrupted.status = 'interrupted';
  interrupted.hybrid.currentScenarioId = unfinished.id;
  interrupted.hybrid.pauseReason = 'The fixture was stopped before the copy check was saved.';
  interrupted.hybrid.evidence = interrupted.hybrid.evidence.filter(item => item.scenarioId !== unfinished.id)
    .map(item => ({ ...item, runId: interrupted.id }));
  unfinished.status = 'running';
  delete interrupted.report;
  const verified = projectQaEvidence(broken);
  assert.equal(verified.scenarios.find(item => item.category === 'content').failed, 2);
  // Model JSONB's reordering of object keys, including nested receipt data.
  const stored = JSON.parse(hybridStorage(broken), (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).reverse()) : value);
  const restored = { ...broken, hybrid: undefined, findings: structuredClone(broken.findings) };
  hydrateHybrid(restored, stored);
  assert.deepEqual(projectQaEvidence(restored), verified);
  assert.equal(hybridCompletion(restored).verdict, 'fail');
  const legacy = structuredClone(broken);
  for (const receipt of legacy.hybrid.evidence) {
    delete receipt.hashVersion;
    receipt.digest = legacyModeHash(receipt.result);
  }
  assert.deepEqual(projectQaEvidence(legacy), verified);
  const altered = structuredClone(broken);
  altered.hybrid.evidence.find(item => item.toolName === 'browser_snapshot').result.bodyText = 'Altered after receipt';
  assert.equal(projectQaEvidence(altered).scenarios.find(item => item.category === 'content').failed, 1);
  await targetPage.close();

  await runtime.stop();
  await mkdir(path.join(runtimeDirectory, '.qase'), { recursive: true });
  await writeFile(path.join(runtimeDirectory, '.qase', 'sessions.json'), JSON.stringify([healthy, broken, interrupted]));
  await runtime.start();
  const evidencePath = `/api/sessions/${broken.id}/qa-evidence`;
  const response = await owner.get(evidencePath);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()['cache-control'], 'no-store');
  assert.deepEqual(await response.json(), JSON.parse(JSON.stringify(verified)));
  anonymous = await request.newContext({ baseURL: runtime.base });
  assert.equal((await anonymous.get(evidencePath)).status(), 401);
  other = await request.newContext({ baseURL: runtime.base });
  assert.equal((await other.post('/api/auth/register', { data: { email: 'evidence-other@example.test', password, displayName: 'Other owner' } })).status(), 201);
  assert.equal((await other.get(evidencePath)).status(), 404);

  const context = await browser.newContext({
    storageState: await owner.storageState(), viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce', colorScheme: 'light'
  });
  await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const root = page.locator('#qa-report-evidence');
  const scenario = category => root.locator('.qe-scenario').filter({ has: page.getByRole('heading', { name: category, exact: true }) });
  const navigate = async (session, results = true) => {
    await page.goto(`${runtime.base}/#/runs/${session.id}${results ? '/results' : ''}`);
    await page.waitForFunction(() => !document.body.dataset.pageLoading && document.body.dataset.hasRun === 'true');
  };
  await navigate(broken);
  await root.getByRole('heading', { name: 'Browser results' }).waitFor();
  assert.equal(await page.locator('#tab-report').getAttribute('aria-selected'), 'true');
  await scenario('Content').getByText('Failed', { exact: true }).waitFor();
  await scenario('Content').getByText(expected, { exact: true }).first().waitFor();
  await scenario('Content').getByText(new RegExp(wrong)).first().waitFor();
  await scenario('Navigation').getByText('Passed', { exact: true }).waitFor();
  await scenario('Search').getByText('Absent on sampled pages', { exact: true }).waitFor();
  await scenario('Visual comparison').getByText('Blocked', { exact: true }).waitFor();
  await root.getByText('Animation timing, visual regressions and theme flashes have no recorded checks here.').waitFor();
  await root.getByText('Browser emulation · Chromium · 1440 × 900').waitFor();
  await page.screenshot({ path: path.join(directory, 'results-desktop.png'), animations: 'disabled' });
  const navigationReceipt = scenario('Navigation').getByText('Evidence receipt', { exact: true }).first();
  await navigationReceipt.click();
  await scenario('Navigation').getByText(/Browser assertion · HTTP 200/).first().waitFor();
  await scenario('Content').getByText('1 more assertion', { exact: true }).click();
  const repeated = scenario('Content').locator('.qe-assertion').last();
  await repeated.getByText('Evidence receipt', { exact: true }).click();
  await repeated.getByRole('button', { name: 'Open confirmed finding' }).click();
  await page.getByRole('button', { name: /Pricing shows the wrong copy/ }).waitFor();
  assert.equal(await page.locator('#tab-findings').getAttribute('aria-selected'), 'true');
  await page.locator('#tab-report').click();
  assert.equal(await repeated.locator('details').evaluate(node => node.open), true);

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const tabs = await page.locator('#tabs').evaluate(node => ({
    top: node.getBoundingClientRect().top,
    bottom: node.getBoundingClientRect().bottom,
    visible: [...node.querySelectorAll('.tab')].filter(tab => !tab.hidden).map(tab => tab.getBoundingClientRect().toJSON())
  }));
  assert.ok(tabs.visible.every(tab => tab.top >= tabs.top - 1 && tab.bottom <= tabs.bottom + 1 && tab.right <= 390),
    `All results tabs must fit on one mobile row. ${JSON.stringify(tabs)}`);
  await scenario('Content').getByText('1 more assertion', { exact: true }).click();
  await scenario('Content').evaluate(node => node.scrollIntoView({ block: 'start' }));
  const card = await scenario('Content').boundingBox();
  assert.ok(card.x >= 0 && card.x + card.width <= 390);
  await page.screenshot({ path: path.join(directory, 'results-mobile.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#pane-report').evaluate(node => { node.scrollTop = 0; });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(directory, 'results-dark.png'), animations: 'disabled' });

  await navigate(healthy);
  await scenario('Content').getByText('Passed', { exact: true }).waitFor();
  assert.equal(await root.getByText(wrong, { exact: false }).count(), 0);
  await navigate(interrupted, false);
  await page.locator('#tab-plan').click();
  const progress = page.locator('#qa-plan-evidence');
  await progress.getByRole('heading', { name: 'Test progress' }).waitFor();
  await progress.getByText('The fixture was stopped before the copy check was saved.').waitFor();
  assert.equal(await progress.getByText('Interrupted', { exact: true }).count(), 1);
  assert.equal(await progress.getByText(wrong, { exact: false }).count(), 0);
  await page.screenshot({ path: path.join(directory, 'progress-desktop.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ healthy: 'passed', wrongCopyWithHttp200: 'failed', resumedView: 'saved progress', authorizedEvidence: true, reorderedReceipts: 'verified', legacyReceipts: 'verified', screenshots: directory, modelCalls: 0 }, null, 2));
} finally {
  await Promise.all([owner?.dispose(), other?.dispose(), anonymous?.dispose(), browser?.close(), runtime.stop()]);
  target.closeAllConnections();
  target.close();
}
