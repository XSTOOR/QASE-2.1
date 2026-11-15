import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { validateHybridFinding } from '../server/qaCompletionGate.js';
import { projectQaEvidence } from '../server/qaEvidence.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, 'output-dir': { type: 'string' },
  browser: { type: 'string', multiple: true }, variant: { type: 'string', multiple: true }
} });
assert.ok(values['env-file'], 'Pass --env-file to opt in to the configured live gateway.');
const engines = values.browser ?? ['chromium', 'firefox'];
const variants = values.variant ?? ['healthy', 'defective'];
assert.ok(engines.every(engine => ['chromium', 'firefox'].includes(engine)), 'Choose chromium or firefox.');
assert.ok(variants.every(variant => ['healthy', 'defective'].includes(variant)), 'Choose healthy or defective.');

const directory = path.resolve(values['output-dir'] ?? `test-results/redesign/phase-3/${Date.now()}`);
await mkdir(directory, { recursive: true });
const runtime = await createSqaTestServer(path.join(directory, 'runtime'), { envFile: values['env-file'], hybridQa: true });
const expected = 'Plans and pricing';
let defective = false;
const visits = [];
const fixture = createServer((request, response) => {
  const route = request.url;
  const pages = {
    '/': '<h1>Example product</h1><p>Find tools for your team.</p><nav><a href="/solutions">Solutions</a></nav>',
    '/solutions': '<h1>Solutions</h1><p>Choose a plan for your team.</p><nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav>',
    '/pricing': `<h1>${defective ? 'Page unavailable' : expected}</h1><p>Plans and pricing options for your team.</p><nav><a href="/solutions">Solutions</a></nav>`
  };
  const status = !['GET', 'HEAD'].includes(request.method) ? 405 : Object.hasOwn(pages, route) ? 200 : 404;
  visits.push({ method: request.method, route, status });
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(status === 200 && request.method === 'GET'
    ? `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Example product</title></head><body><main>${pages[route]}</main></body></html>` : undefined);
});
const summary = { status: 'running', startedAt: new Date().toISOString(), cases: [] };
const save = () => writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2) + '\n');

async function api(page, route, options) {
  const response = await page.request.fetch(`${runtime.base}/api${route}`, options);
  assert.ok(response.ok(), `${route} returned HTTP ${response.status()}.`);
  return response.json();
}

async function runCase(browser, engine, variant, result) {
  defective = variant === 'defective';
  const visitOffset = visits.length;
  const target = `http://127.0.0.1:${fixture.address().port}/`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: 'light', reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.name));
  page.setDefaultTimeout(30000);
  let runId;
  let final;
  try {
    const readinessDeadline = Date.now() + 180_000;
    for (;;) {
      const config = await api(page, '/config');
      assert.ok(config.hasApiKey && config.ready, 'The isolated gateway configuration is unavailable.');
      if (config.hybridQa?.available) break;
      assert.ok(Date.now() < readinessDeadline, `Gateway qualification did not become available (${config.hybridQa?.status ?? 'unknown'}).`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    await page.goto(`${runtime.base}/#/runs/new`);
    await page.locator('#qa-start[open]').waitFor();
    await page.locator('#qa-target-url').fill(target);
    await page.locator('#qa-goal').fill(`Content validation for this read-only fixture. From Home, click Solutions and then Pricing. Verify the destination is ${target}pricing. The visible Pricing heading must read exactly "${expected}". If the heading does not match, check it again on a separate load before reporting a finding. No other features or origins are in scope.`);
    await page.locator('#journey-next').click();
    if (engine === 'firefox') {
      await page.locator('#journey-custom').click();
      const firefox = page.locator('[data-picker-focus="browser-firefox"]');
      await firefox.click();
      await page.getByLabel('Filter device type').selectOption('desktop');
      await page.locator('#qa-matrix-devices .mp-device').first().click();
    }
    await page.locator('#qa-customize > summary').click();
    const otherChecks = page.locator('input[name="qa-test"]:checked:not([value="navigation"])');
    while (await otherChecks.count()) await otherChecks.first().uncheck();
    const extraScope = page.locator('.qa-scope:checked:not([value="navigation"]):not([value="content-validation"])');
    while (await extraScope.count()) await extraScope.first().uncheck();
    assert.equal(await page.locator('input[name="qa-test"]:checked').count(), 1);
    await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
    await page.locator('#journey-next').click();
    const creation = page.waitForResponse(response => response.url() === `${runtime.base}/api/sessions` && response.request().method() === 'POST');
    await page.locator('#qa-submit').click();
    const created = await creation;
    assert.ok(created.ok(), `Launcher returned HTTP ${created.status()}.`);
    const launched = await created.json();
    runId = launched.id;
    result.runId = runId;
    assert.equal(launched.qaExecutionMode, 'hybrid');
    assert.equal(launched.engine, engine);
    assert.deepEqual(launched.selectedTests, ['navigation']);
    await page.waitForURL(`**/#/runs/${runId}`);
    await page.locator('#qa-plan-evidence').getByRole('heading', { name: 'Test progress' }).waitFor();
    const startedAt = Date.now();
    let previous = '';
    let started = false;
    while (Date.now() - startedAt < 510_000) {
      final = await api(page, `/sessions/${runId}`);
      const telemetry = final.hybrid?.telemetry;
      const progress = {
        status: final.status, running: final.running, reasonerCalls: telemetry?.reasoner?.calls ?? 0,
        classifierCalls: telemetry?.classifier?.calls ?? 0,
        browserActions: telemetry?.browserActions ?? 0,
        scenarios: final.hybrid?.scenarios?.map(item => [item.category, item.status]) ?? []
      };
      const current = JSON.stringify(progress);
      if (current !== previous) { console.log(`${engine}/${variant}: ${current}`); previous = current; }
      started ||= final.running || final.status !== 'idle';
      if (started && !final.running && ['done', 'error', 'interrupted', 'awaiting_input', 'cancelled'].includes(final.status)) break;
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    result.elapsedMs = Date.now() - startedAt;
    result.lifecycle = final?.status;
    result.verdict = final?.report?.verdict;
    result.launchedEngine = final?.runtimeFacts?.launchedEngineId;
    result.coverageGaps = final?.report?.notCovered;
    result.pauseReason = final?.hybrid?.pauseReason;
    result.scenarios = final?.hybrid?.scenarios?.map(({ category, status, assertions }) => ({ category, status, assertions: assertions.length }));
    result.usage = final?.hybrid?.telemetry ? {
      reasoner: final.hybrid.telemetry.reasoner, classifier: final.hybrid.telemetry.classifier,
      browserActions: final.hybrid.telemetry.browserActions
    } : undefined;
    result.visits = visits.slice(visitOffset).filter(visit => ['/', '/solutions', '/pricing'].includes(visit.route));
    const evidence = await api(page, `/sessions/${runId}/qa-evidence`);
    await writeFile(path.join(directory, `${engine}-${variant}-evidence.json`), JSON.stringify(evidence, null, 2) + '\n');
    await page.screenshot({ path: path.join(directory, `${engine}-${variant}-workspace.png`), animations: 'disabled' });
    assert.equal(final?.status, 'done', `Execution ended as ${final?.status ?? 'unknown'}.`);
    assert.equal(final.running, false);
    assert.equal(result.launchedEngine, engine, 'The captured browser engine must match the selected engine.');
    assert.ok(result.usage?.reasoner.calls > 0, 'No real reasoner call was recorded.');
    assert.ok(result.visits.some(visit => visit.route === '/pricing' && visit.status === 200), 'The browser did not load the Pricing fixture.');
    assert.ok(visits.slice(visitOffset).every(visit => ['GET', 'HEAD'].includes(visit.method)), 'Unexpected write on the fixture.');
    const assertions = evidence.scenarios.flatMap(scenario => scenario.assertions);
    for (const [source, destination] of [['', 'solutions'], ['solutions', 'pricing']]) {
      assert.ok(assertions.some(item => item.name === 'Observed anchor reaches its destination' &&
        item.source === target + source && item.destination === target + destination &&
        item.outcome === 'pass'), `No host click assertion passed for the ${destination} URL.`);
    }
    const pricing = assertions.filter(item => item.name === 'Snapshot heading_equals' && item.expected === expected && item.source === `${target}pricing`);
    const pricingResult = pricing.find(item => item.outcome === (defective ? 'fail' : 'pass') && (!defective || item.findingId));
    assert.ok(pricingResult, 'The expected pricing assertion and evidence-linked result are missing.');
    if (defective) {
      assert.ok(['fail', 'partial', 'pass_with_issues'].includes(final.report?.verdict), 'The report must acknowledge the confirmed defect or remaining gaps.');
      const finding = final.findings.find(item => item.id === pricingResult.findingId);
      assert.ok(finding?.hybridEvidence);
      const input = { scenario_id: finding.hybridEvidence.scenarioId, assertion_id: finding.hybridEvidence.assertionId };
      const validated = validateHybridFinding(final, input);
      assert.equal(validated.evidenceRefs.length, 2);
      for (const receiptId of validated.evidenceRefs) {
        for (const change of ['remove', 'corrupt']) {
          const copy = structuredClone(final);
          const receipts = copy.hybrid.evidence;
          const index = receipts.findIndex(item => item.id === receiptId);
          assert.ok(index >= 0, 'The finding must reference an existing receipt.');
          if (change === 'remove') receipts.splice(index, 1);
          else receipts[index].result.title = 'Changed after capture';
          assert.throws(() => validateHybridFinding(copy, input), /intact (?:reproduction )?evidence/);
          assert.ok(!projectQaEvidence(copy).scenarios.flatMap(scenario => scenario.assertions)
            .some(item => item.findingId === finding.id), 'The projection exposed a finding link with an unverifiable receipt.');
        }
      }
      result.receiptIntegrity = 'verified';
    } else {
      assert.ok(!pricing.some(item => item.outcome === 'fail'), 'Healthy pricing produced a failed assertion.');
      assert.equal(final.findings.length, 0, 'The healthy run produced an unexpected finding.');
    }

    await page.goto(`${runtime.base}/#/runs/${runId}/results`);
    const report = page.locator('#qa-report-evidence');
    await report.getByRole('heading', { name: 'Browser results' }).waitFor();
    await page.reload();
    await report.getByRole('heading', { name: 'Browser results' }).waitFor();
    const content = report.locator('.qe-scenario').filter({ has: page.getByRole('heading', { name: 'Content', exact: true }) });
    await content.getByText(expected, { exact: true }).first().waitFor();
    const receipt = content.locator(`[data-qe-key="receipt-${pricingResult.id}"]`);
    const openReceipt = receipt.locator('summary');
    if (!await openReceipt.isVisible()) await content.getByText(/^\d+ more assertions?$/).click();
    await openReceipt.click();
    const code = receipt.locator('code');
    await code.waitFor();
    assert.equal(await code.textContent(), pricingResult.reference);
    assert.deepEqual(await api(page, `/sessions/${runId}/qa-evidence`), evidence);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(directory, `${engine}-${variant}-reloaded.png`), animations: 'disabled' });
    if (defective) {
      await receipt.getByRole('button', { name: 'Open confirmed finding' }).click();
      assert.equal(await page.locator('#tab-findings').getAttribute('aria-selected'), 'true');
    }
    result.pricing = { outcome: pricingResult.outcome, receipt: pricingResult.reference, finding: pricingResult.findingId };
    result.reload = 'verified';
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.message.split('\n')[0];
    await page.screenshot({ path: path.join(directory, `${engine}-${variant}-failure.png`), animations: 'disabled', timeout: 5000 }).catch(() => undefined);
  } finally {
    if (runId && final?.running !== false) await api(page, `/sessions/${runId}/stop`, { method: 'POST', timeout: 5000 }).catch(() => undefined);
    await page.close();
    await save();
  }
}

try {
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  await runtime.start();
  for (const engine of engines) {
    const browser = await launchSqaTestBrowser(engine);
    try {
      for (const variant of variants) {
        const result = { engine, variant, browserVersion: browser.version(), status: 'running' };
        summary.cases.push(result);
        await save();
        await runCase(browser, engine, variant, result);
        console.log(`${engine}/${variant}: ${result.status}${result.error ? ` (${result.error})` : ''}`);
      }
    } finally { await browser.close(); }
  }
  summary.status = summary.cases.every(item => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  summary.status = 'failed';
  summary.error = error.message.split('\n')[0];
} finally {
  summary.finishedAt = new Date().toISOString();
  await save();
  await runtime.stop();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
console.log(`Phase 3 ${summary.status}. Results: ${path.join(directory, 'result.json')}`);
if (summary.status !== 'passed') process.exitCode = 1;
