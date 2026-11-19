import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { menuMotionFixture } from './fixtures/menu-motion.mjs';
import { runJevBrowserCheck } from '../server/jevBrowserChecks.js';
import { createQaInputIsolation } from '../server/qaInputIsolation.js';
import { validateHybridFinding } from '../server/qaCompletionGate.js';
import { projectQaEvidence } from '../server/qaEvidence.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, 'output-dir': { type: 'string' }, browser: { type: 'string', multiple: true },
  'live-variant': { type: 'string', multiple: true }
} });
const engines = values.browser ?? (values['env-file'] ? ['chromium'] : ['chromium', 'firefox']);
engines.forEach(assertSqaTestBrowser);
const variants = values['live-variant'] ?? ['healthy', 'defective'];
assert.ok(variants.every(variant => ['healthy', 'defective', 'covered'].includes(variant)));
const output = path.resolve(values['output-dir'] ?? `test-results/redesign/phase-7/${Date.now()}`);
await mkdir(output, { recursive: true });
const requests = [];
const fixture = createServer((request, response) => {
  requests.push(request.method);
  const route = request.url?.split('?')[0];
  const recognized = ['/', '/healthy', '/defective', '/covered', '/ambiguous', '/network'].includes(route);
  const readOnly = ['GET', 'HEAD'].includes(request.method);
  const html = recognized
    ? menuMotionFixture({ broken: route === '/defective', covered: route === '/covered', ambiguous: route === '/ambiguous', network: route === '/network' })
    : '<!doctype html><html lang="en"><title>Fixture information</title><main><h1>Fixture information</h1><a href="./healthy">Home</a></main></html>';
  response.writeHead(readOnly ? 200 : 405, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(readOnly && request.method === 'GET' ? html : undefined);
});
fixture.listen(0, '127.0.0.1');
await once(fixture, 'listening');
const target = `http://127.0.0.1:${fixture.address().port}`;
const results = [];
const save = () => writeFile(path.join(output, 'result.json'), JSON.stringify({
  type: values['env-file'] ? 'live UI and configured gateway' : 'controlled browser trials',
  writes: requests.filter(method => !['GET', 'HEAD'].includes(method)).length, results
}, null, 2) + '\n');

async function measure(browser, engine, name, preference, repetition) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: preference, colorScheme: 'light', serviceWorkers: 'block' });
  const isolation = createQaInputIsolation();
  isolation.attach(context);
  await context.route('**/*', route => isolation.decision(route.request()) ? route.abort() : route.continue());
  const page = await context.newPage();
  const run = { engine, name, preference, repetition, browserVersion: browser.version() };
  try {
    await page.goto(`${target}/${name}`);
    await page.evaluate(() => document.fonts.ready);
    const result = await runJevBrowserCheck(page, { action: 'menu_motion' }, {
      menuMotion: { label: 'Main menu', url: page.url() }, protectInputs: current => isolation.protect(current),
      authorizeControl: async selector => assert.equal(selector, '#menu-toggle'),
      saveMotionFrame: repetition === 1 ? async (bytes, phase) => {
        const artifactId = `${engine}-${name}-${preference}-${phase.toLowerCase().replaceAll(' ', '-')}.jpg`;
        await writeFile(path.join(output, artifactId), bytes);
        return { artifactId, capturedAt: new Date().toISOString() };
      } : undefined
    });
    Object.assign(run, result);
    assert.ok(result.success, result.error);
    if (['ambiguous', 'network'].includes(name)) {
      assert.equal(result.assertions.length, 0);
      assert.match(result.skipped, name === 'ambiguous' ? /ambiguous/ : /network activity/);
      if (name === 'ambiguous') assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    } else {
      const expected = name === 'defective' ? 'fail' : 'pass';
      const [assertion] = result.assertions;
      assert.equal(assertion?.outcome, expected, result.skipped ?? JSON.stringify(result.motion));
      assert.equal(result.motion.trials.length, 2);
      assert.equal(result.motion.preference, preference);
      assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
      for (const trial of result.motion.trials) {
        assert.ok(trial.frames.every((frame, index) => !index || frame.elapsedMs >= trial.frames[index - 1].elapsedMs));
        if (preference === 'reduce') assert.ok(trial.frames.every(frame => !frame.transitioning));
      }
      if (expected === 'fail') assert.equal(assertion.reproduction?.confirmed, true);
      else assert.equal(assertion.reproduction, undefined);
    }
    run.accepted = true;
    console.log(`${engine} ${name} ${preference} #${repetition}: ${result.assertions[0]?.outcome ?? 'inconclusive'}`);
  } finally { results.push(run); await save(); await context.close(); }
}

async function launchLive(runtime, engine, variant) {
  const ui = await launchSqaTestBrowser('chromium');
  const page = await ui.newPage({ viewport: { width: 1440, height: 1000 } });
  const summary = { engine, variant };
  const get = async route => {
    const response = await page.request.get(`${runtime.base}/api${route}`);
    assert.ok(response.ok(), `${route} returned ${response.status()}`);
    return response.json();
  };
  let run;
  try {
    const qualificationDeadline = Date.now() + 180_000;
    let qualificationRequested = false;
    for (;;) {
      const config = (await get('/config')).hybridQa;
      if (config?.available) break;
      assert.ok(Date.now() < qualificationDeadline, config?.reason || 'Hybrid gateway did not qualify.');
      if (!qualificationRequested && ['qualification_required', 'qualification_expired', 'qualification_failed'].includes(config?.status)) {
        qualificationRequested = true;
        const response = await page.request.post(`${runtime.base}/api/config/hybrid/qualification`, { data: {}, timeout: 30_000 });
        assert.ok(response.ok(), `Qualification request returned HTTP ${response.status()}`);
      }
      await delay(2000);
    }
    await page.goto(`${runtime.base}/#/runs/new`);
    await page.locator('#qa-start[open]').waitFor();
    await page.locator('#qa-target-url').fill(`${target}/${variant}`);
    await page.locator('#qa-goal').fill([
      'Menu motion: Main menu',
      'For the remaining navigation scope, call qa_route_frontier with rank=false and run qa_test_routes on its observed routes.'
    ].join('\n'));
    await page.locator('#journey-next').click();
    await page.locator('#qa-customize > summary').click();
    const other = page.locator('input[name="qa-test"]:checked:not([value="navigation"]), .qa-scope:checked:not([value="navigation"])');
    while (await other.count()) await other.first().uncheck();
    await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
    await page.locator('#journey-next').click();
    const created = page.waitForResponse(response => response.url() === `${runtime.base}/api/sessions` && response.request().method() === 'POST');
    await page.locator('#qa-submit').click();
    const response = await created;
    assert.ok(response.ok(), `Launcher returned ${response.status()}`);
    summary.runId = (await response.json()).id;
    console.log(`${engine}/${variant}: started ${summary.runId}`);
    const finishBy = Date.now() + 480_000;
    while (Date.now() < finishBy) {
      run = await get(`/sessions/${summary.runId}`);
      if (!run.running && ['done', 'error', 'interrupted', 'awaiting_input', 'cancelled'].includes(run.status)) break;
      await delay(2000);
    }
    summary.status = run?.status;
    summary.verdict = run?.report?.verdict;
    summary.pauseReason = run?.hybrid?.pauseReason;
    summary.launchedEngine = run?.runtimeFacts?.launchedEngineId;
    assert.equal(run.status, 'done', summary.pauseReason);
    assert.equal(summary.launchedEngine, engine);
    const evidence = await get(`/sessions/${summary.runId}/qa-evidence`);
    const motion = evidence.scenarios.find(item => item.category === 'menu_motion');
    summary.motion = motion?.motion;
    summary.assertion = variant === 'covered' ? motion?.assertions.find(item=>item.name==='Menu opening visibly changes the panel pixels') : motion?.assertions[0];
    if (variant === 'covered') {
      assert.equal(summary.motion?.visual?.outcome,'fail');
      assert.ok(summary.motion.trials.every(trial=>trial.reason==='met'));
    }
    const broken = variant !== 'healthy';
    assert.equal(summary.assertion?.outcome, broken ? 'fail' : 'pass', JSON.stringify({ motion, gap: run.report?.notCovered }));
    assert.equal(summary.motion.screenshots.length, 3);
    if (broken) {
      const finding = run.findings.find(item => item.id === summary.assertion.findingId);
      assert.ok(finding, 'The reproduced failure must have a confirmed evidence link.');
      validateHybridFinding(run, { assertion_id: summary.assertion.id, scenario_id: motion.id });
      const copy = structuredClone(run);
      copy.hybrid.evidence.find(item => item.id === summary.assertion.reference).result.motion.trials[0].finalOpacity = 0;
      assert.equal(projectQaEvidence(copy).scenarios.find(item => item.id === motion.id).motion, undefined);
    }
    await page.goto(`${runtime.base}/#/runs/${summary.runId}/results`);
    await page.reload();
    const view = page.locator('#qa-report-evidence .qe-scenario').filter({ hasText: 'Menu transition' });
    await view.getByText('Timing and screenshots', { exact: true }).click();
    await view.getByText(/Standard motion · 650 ms deadline/).waitFor();
    if (variant === 'covered') await view.getByText(/Visual comparison · fail/).waitFor();
    const screenshot = view.getByRole('link', { name: 'Open screenshot · Before opening', exact: true });
    const artifact = await page.request.get(new URL(await screenshot.getAttribute('href'), runtime.base).href);
    assert.equal(artifact.status(), 200);
    assert.match(artifact.headers()['content-type'], /image\/jpeg/);
    assert.ok((await artifact.body()).length > 1000);
    await view.screenshot({ path: path.join(output, `${engine}-${variant}-report.jpg`) });
    summary.accepted = true;
    console.log(`${engine}/${variant}: saved report passed acceptance`);
  } finally {
    if (summary.runId && run?.running !== false) await page.request.post(`${runtime.base}/api/sessions/${summary.runId}/stop`, { timeout: 5000 }).catch(() => {});
    results.push(summary);
    await save();
    await ui.close();
  }
}

let runtime;
try {
  if (values['env-file']) {
    assert.deepEqual(engines, ['chromium'], 'Live launcher qualification uses its default Chromium profile.');
    runtime = await createSqaTestServer(path.join(output, 'runtime'), { envFile: values['env-file'], hybridQa: true });
    await runtime.start();
    for (const variant of variants) await launchLive(runtime, 'chromium', variant);
  } else {
    for (const engine of engines) {
      const browser = await launchSqaTestBrowser(engine);
      try {
        for (let i = 1; i <= 3; i++) {
          await measure(browser, engine, 'healthy', 'no-preference', i);
          await measure(browser, engine, 'defective', 'no-preference', i);
          await measure(browser, engine, 'healthy', 'reduce', i);
        }
        for (const variant of ['ambiguous', 'network']) await measure(browser, engine, variant, 'no-preference', 1);
      } finally { await browser.close(); }
    }
  }
  assert.ok(requests.every(method => ['GET', 'HEAD'].includes(method)), 'The fixture received an unexpected write.');
  await save();
} finally {
  await runtime?.stop();
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
