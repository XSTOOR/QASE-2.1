import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';

const { values } = parseArgs({ options: { 'env-file': { type: 'string' }, 'output-dir': { type: 'string' } } });
assert.ok(values['env-file'], 'Pass --env-file to opt in to the live gateway.');
const output = path.resolve(values['output-dir'] ?? `test-results/redesign/phase-4/${Date.now()}`);
await mkdir(output, { recursive: true });
const runtime = await createSqaTestServer(path.join(output, 'runtime'), { envFile: values['env-file'], hybridQa: true, jevNavigation: true });
const pages = {
  '/': '<h1>Plan resources</h1><nav><a id="overview" href="/plans">Compare plan features</a> <a id="rates" href="/rates">See monthly subscription rates</a></nav>',
  '/plans': '<h1>Plan comparison</h1><p>Compare feature limits.</p><a href="/">Home</a>',
  '/rates': '<h1>Monthly rates</h1><p>Team plan costs $20 per month.</p><a href="/">Home</a>'
};
const requests = [];
const fixture = createServer((request, response) => {
  requests.push({ method: request.method, route: request.url });
  const status = !['GET', 'HEAD'].includes(request.method) ? 405 : Object.hasOwn(pages, request.url) ? 200 : 404;
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(status === 200 && request.method === 'GET'
    ? `<!doctype html><html lang="en"><head><title>Plan resources</title></head><body><main>${pages[request.url]}</main></body></html>` : undefined);
});
let browser, page, runId, run;
const summary = { status: 'failed', startedAt: new Date().toISOString() };
try {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const target = `http://127.0.0.1:${fixture.address().port}/`;
  await runtime.start();
  browser = await launchSqaTestBrowser('chromium');
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const api = async route => {
    const response = await page.request.get(`${runtime.base}/api${route}`);
    assert.ok(response.ok(), `${route} returned HTTP ${response.status()}`);
    return response.json();
  };
  const deadline = Date.now() + 180_000;
  while (!(await api('/config')).hybridQa?.available) {
    assert.ok(Date.now() < deadline, 'Gateway qualification did not become available.');
    await delay(2000);
  }
  await page.goto(`${runtime.base}/#/runs/new`);
  await page.locator('#qa-start[open]').waitFor();
  await page.locator('#qa-target-url').fill(target);
  await page.locator('#qa-goal').fill('Find the page that shows what the team plan costs each month. Start on the entry page. Use qa_choose_navigation on the existing navigation scenario to choose and verify the matching link, then complete the required read-only route coverage.');
  await page.locator('#journey-next').click();
  await page.locator('#qa-customize > summary').click();
  const otherChecks = page.locator('input[name="qa-test"]:checked:not([value="navigation"])');
  while (await otherChecks.count()) await otherChecks.first().uncheck();
  const extraScope = page.locator('.qa-scope:checked:not([value="navigation"])');
  while (await extraScope.count()) await extraScope.first().uncheck();
  await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
  await page.locator('#journey-next').click();
  const creation = page.waitForResponse(response => response.url() === `${runtime.base}/api/sessions` && response.request().method() === 'POST');
  await page.locator('#qa-submit').click();
  const created = await creation;
  assert.ok(created.ok(), `Launcher returned HTTP ${created.status()}`);
  const session = await created.json();
  runId = summary.runId = session.id;
  assert.equal(session.hybrid?.navigationDecisionVersion, 1);
  await page.waitForURL(`**/#/runs/${runId}`);
  console.log(`Phase 4 live run ${runId}`);
  const finishBy = Date.now() + 490_000;
  while (Date.now() < finishBy) {
    run = await api(`/sessions/${runId}`);
    if (!run.running && ['done', 'error', 'interrupted', 'awaiting_input', 'cancelled'].includes(run.status)) break;
    await delay(2500);
  }
  summary.lifecycle = run?.status;
  summary.pauseReason = run?.hybrid?.pauseReason;
  summary.verdict = run?.report?.verdict;
  summary.decisions = run?.hybrid?.navigationDecisions;
  summary.classifierCalls = run?.hybrid?.telemetry?.classifier?.calls;
  summary.reasonerCalls = run?.hybrid?.telemetry?.reasoner?.calls;
  summary.browserVersion = browser.version();
  summary.launchedEngine = run?.runtimeFacts?.launchedEngineId;
  const decision = summary.decisions?.find(item => item.source === 'jev' && item.outcome === 'executed');
  assert.ok(decision, 'No live JEV navigation decision reached an executed browser assertion.');
  assert.equal(decision.candidateIds.length, 2);
  assert.notEqual(decision.observationRef, decision.revalidationRef);
  const usage = run.hybrid.modelBudget.roles.classifier.reservations.find(item => item.id === decision.usage?.reservationId);
  assert.equal(usage?.status, 'settled');
  assert.equal(usage.receipt.inputTokens, decision.usage.inputTokens);
  assert.equal(usage.receipt.outputTokens, decision.usage.outputTokens);
  assert.equal(summary.launchedEngine, 'chromium');
  const evidence = await api(`/sessions/${runId}/qa-evidence`);
  const assertion = evidence.scenarios.find(item => item.id === decision.scenarioId)?.assertions.find(item =>
    item.reference === decision.evidenceRef && item.name === 'Observed anchor reaches its destination');
  assert.equal(assertion?.outcome, 'pass');
  assert.equal(assertion.source, target);
  assert.equal(assertion.destination, `${target}rates`);
  const entry = run.hybrid.scenarios.find(item => item.id === decision.scenarioId)?.routeRuns?.find(item => item.url === target);
  assert.equal(entry?.status, 'passed', entry?.reason || 'Entry navigation coverage is missing');
  const entryReceipt = run.hybrid.evidence.find(item => entry.evidenceRefs.includes(item.id) && item.result.action === 'navigation');
  assert.equal(entryReceipt?.result.source, target);
  assert.ok(entryReceipt.result.assertions.some(item => item.check === 'navigation' && item.outcome === 'pass'));
  summary.entryNavigation = { status: entry.status, source: entryReceipt.result.source, destination: entryReceipt.result.destination, evidenceRef: entryReceipt.id };
  assert.ok(requests.every(item => ['GET', 'HEAD'].includes(item.method)));
  summary.assertion = assertion;
  assert.equal(run.status, 'done', run.statusDetail || summary.pauseReason);
  await page.goto(`${runtime.base}/#/runs/${runId}/results`);
  const report = page.locator('#qa-report-evidence');
  await report.getByRole('heading', { name: 'Browser results' }).waitFor();
  await page.reload();
  await report.getByRole('heading', { name: 'Browser results' }).waitFor();
  const receipt = report.locator(`[data-qe-key="receipt-${assertion.id}"]`);
  if (!await receipt.locator('summary').isVisible()) await report.getByText(/^\d+ more assertions?$/).first().click();
  await receipt.locator('summary').click();
  assert.equal(await receipt.locator('code').textContent(), decision.evidenceRef);
  await page.screenshot({ path: path.join(output, 'navigation-evidence.png') });
  summary.reload = 'verified';
  summary.status = 'passed';
} catch (error) {
  summary.error = error.message.split('\n')[0];
  console.error(summary.error);
} finally {
  if (runId && run?.running !== false) await page?.request.post(`${runtime.base}/api/sessions/${runId}/stop`, { timeout: 5000 }).catch(() => {});
  summary.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
  await browser?.close();
  await runtime.stop();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
console.log(`Phase 4 ${summary.status}. Results: ${path.join(output, 'result.json')}`);
if (summary.status !== 'passed') process.exitCode = 1;
