import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createSqaTestServer } from './sqa-test-runtime.mjs';
import { validateHybridFinding } from '../server/qaCompletionGate.js';
import { modeReceiptHash } from '../server/modeIntegrity.js';

const { values } = parseArgs({ options: {
  'env-file': { type: 'string' }, 'output-dir': { type: 'string' }, 'browser': { type: 'string', default: 'chromium' },
  repeats: { type: 'string', default: '5' }, 'start-repeat': { type: 'string', default: '1' },
  variant: { type: 'string', multiple: true }
} });
const { browser } = values;
const repeats = Number(values.repeats);
const startRepeat = Number(values['start-repeat']);
assert.ok(values['env-file'], 'Pass --env-file to opt in to live inference.');
assert.ok(['chromium', 'firefox'].includes(browser));
assert.ok(Number.isInteger(repeats) && repeats >= 1 && repeats <= 10);
assert.ok(Number.isInteger(startRepeat) && startRepeat >= 1 && startRepeat <= repeats);
const directory = path.resolve(values['output-dir'] ?? `test-results/redesign/phase-5/${browser}-${Date.now()}`);
await mkdir(directory, { recursive: true });

const heading = 'Plans and pricing';
const strategies = ['baseline', 'jev'];
const fixtureVariants = ['healthy', 'defective'];
const variants = values.variant ?? fixtureVariants;
assert.ok(variants.every(variant => fixtureVariants.includes(variant)) && new Set(variants).size === variants.length);
const timeoutMs = 480_000;
const result = { status: 'running', browser, variants, startRepeat, repeats, timeoutMs, startedAt: new Date().toISOString(), runs: [] };
let saved = Promise.resolve();
const save = () => {
  const snapshot = JSON.stringify(result, null, 2) + '\n';
  saved = saved.then(() => writeFile(path.join(directory, 'result.json'), snapshot));
  return saved;
};
const writes = { healthy: 0, defective: 0 };
const fixture = createServer((request, response) => {
  const [_, variant, route = ''] = request.url.split('/');
  const pages = {
    '': '<h1>Plan resources</h1><nav><a id="plans" href="plans">Compare plan features</a> <a id="pricing" href="pricing">See monthly plan rates</a></nav>',
    plans: '<h1>Plan comparison</h1><p>Compare feature limits.</p><a href="./">Home</a>',
    pricing: `<h1>${variant === 'defective' ? 'Page unavailable' : heading}</h1><p>Plans and pricing options for your team.</p><a href="./">Home</a>`
  };
  const readable = ['GET', 'HEAD'].includes(request.method);
  if (!readable && Object.hasOwn(writes, variant)) writes[variant]++;
  const status = !readable ? 405 : variants.includes(variant) && Object.hasOwn(pages, route) ? 200 : 404;
  response.writeHead(status, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  response.end(status === 200 && request.method === 'GET'
    ? `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plan resources</title></head><body><main>${pages[route]}</main></body></html>` : undefined);
});

async function api(runtime, route, data) {
  const options = { signal: AbortSignal.timeout(15_000) };
  if (data !== undefined) Object.assign(options, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const response = await fetch(`${runtime.base}/api${route}`, options);
  assert.ok(response.ok, `${route} returned HTTP ${response.status}`);
  return response.json();
}

async function qualify(runtime) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const config = await api(runtime, '/config');
    assert.ok(config.hasApiKey && config.ready, 'The isolated live gateway configuration is unavailable.');
    if (config.hybridQa?.available) return;
    assert.ok(Date.now() < deadline, 'Live gateway qualification did not become available.');
    await delay(2000);
  }
}

async function runCase(runtime, trial) {
  const target = `http://127.0.0.1:${fixture.address().port}/${trial.variant}/`;
  const pricing = target + 'pricing';
  let run;
  try {
    const created = await api(runtime, '/sessions', { engine: browser, qaExecutionMode: 'hybrid', selectedTests: ['navigation'], scopeSelection: ['navigation', 'content-validation'] });
    trial.runId = created.id;
    assert.equal(created.hybrid?.navigationDecisionVersion ?? 0, trial.strategy === 'jev' ? 1 : 0);
    const began = Date.now();
    trial.kickoffAt = new Date(began).toISOString();
    await api(runtime, `/sessions/${created.id}/message`, { text: [
      target,
      'Read-only navigation and content validation. From Home choose the link that shows monthly plan rates, and verify the destination with a real link click.',
      'Choose the link before starting the content scenario. If qa_choose_navigation is available, use the Navigation scenario ID on Home; otherwise use the fixed navigation check on the observed anchor.',
      `On the pricing destination the visible heading must read exactly "${heading}". Use the heading assertion; recheck on a separate page load if it fails and report the confirmed defect.`,
      'Complete the remaining bounded navigation checks and publish the report. The fixture has no writes, authentication or external actions in scope.'
    ].join('\n') });
    let lastPoll = Date.now();
    do {
      run = await api(runtime, `/sessions/${created.id}`);
      const polledAt = Date.now();
      if (polledAt - lastPoll > 30_000) {
        trial.pollingGapMs = polledAt - lastPoll;
        break;
      }
      lastPoll = polledAt;
      if (!run.running && ['done', 'error', 'interrupted', 'awaiting_input', 'cancelled'].includes(run.status)) break;
      if (Date.now() - began >= timeoutMs) { trial.timedOut = true; break; }
      await delay(2000);
    } while (true);

    const state = run.hybrid;
    trial.elapsedMs = Date.now() - began;
    trial.activeMs = state?.telemetry?.elapsedMs;
    trial.lifecycle = run.status;
    trial.verdict = run.report?.verdict;
    trial.gaps = run.report?.notCovered ?? [];
    trial.pauseReason = state?.pauseReason;
    trial.launchedEngine = run.runtimeFacts?.launchedEngineId;
    trial.browserActions = state?.telemetry?.browserActions;
    trial.reportPublished = Boolean(run.report) && run.status === 'done';
    const usage = state?.telemetry;
    trial.usage = Object.fromEntries(['reasoner', 'classifier'].map(role => {
      const metric = usage?.[role];
      const reservations = state?.modelBudget?.roles?.[role]?.reservations ?? [];
      const known = metric && !metric.usageIncomplete && reservations.filter(item => item.status === 'settled').length === metric.calls &&
        !reservations.some(item => ['pending', 'uncertain'].includes(item.status));
      const receipts = reservations.filter(item => item.status === 'settled');
      const cost = known && receipts.every(item => Number.isFinite(item.reportedCost))
        ? receipts.reduce((sum, item) => sum + item.reportedCost, 0) : null;
      return [role, { calls: metric?.calls ?? null, tokens: known ? metric.inputTokens + metric.outputTokens : null, reportedCost: cost }];
    }));
    trial.reportedCost = Object.values(trial.usage).every(item => item.reportedCost !== null)
      ? Object.values(trial.usage).reduce((sum, item) => sum + item.reportedCost, 0) : null;
    const receipts = new Map(state?.evidence?.filter(item => item.success && item.runId === run.id && item.digest === modeReceiptHash(item)).map(item => [item.id, item]));
    const executed = state?.scenarios?.flatMap(item => item.assertions).filter(item => receipts.get(item.evidenceRef)?.actionId === item.actionId) ?? [];
    trial.firstAssertionMs = executed.length ? Math.min(...executed.map(item => Math.max(0, item.ts - began))) : null;
    trial.verifiedAssertions = executed.length;
    trial.navigationPass = executed.some(item => item.name === 'Observed anchor reaches its destination' && item.actual === pricing && item.outcome === 'pass' &&
      receipts.get(item.evidenceRef)?.result?.source === target);
    const content = executed.filter(item => item.name === 'Snapshot heading_equals' && item.expected === heading && receipts.get(item.evidenceRef)?.url === pricing);
    trial.headingPass = content.some(item => item.outcome === 'pass');
    const findings = (run.findings || []).map(finding => {
      try { return validateHybridFinding(run, { scenario_id: finding.hybridEvidence?.scenarioId, assertion_id: finding.hybridEvidence?.assertionId }); }
      catch { return null; }
    });
    const matches = findings.filter(item => trial.variant === 'defective' && item?.url === pricing && item.expected === heading &&
      content.some(assertion => assertion.id === item.assertionId && assertion.outcome === 'fail'));
    trial.seededDefectFound = trial.variant === 'defective' ? matches.length > 0 : null;
    trial.falseFindings = findings.length - Math.min(matches.length, 1);
    trial.decisionExecuted = Boolean(state?.navigationDecisions?.some(item => item.source === 'jev' && item.outcome === 'executed' &&
      executed.some(assertion => assertion.evidenceRef === item.evidenceRef && assertion.name === 'Observed anchor reaches its destination' && assertion.actual === pricing)));
    trial.accepted = !trial.pollingGapMs && !trial.timedOut && trial.reportPublished && trial.launchedEngine === browser && trial.navigationPass && trial.falseFindings === 0 &&
      (trial.variant === 'healthy' ? trial.headingPass : trial.seededDefectFound) &&
      trial.decisionExecuted === (trial.strategy === 'jev');
  } catch (error) {
    trial.error = error.message.split('\n')[0];
    trial.accepted = false;
  } finally {
    if (trial.runId && (run?.running !== false || trial.timedOut)) {
      await api(runtime, `/sessions/${trial.runId}/stop`, {}).catch(() => {});
      for (let attempt = 0; attempt < 10; attempt++) {
        const stopped = await api(runtime, `/sessions/${trial.runId}`).catch(() => null);
        if (!stopped?.running) break;
        await delay(1000);
      }
    }
  }
}

const runtimes = {};
try {
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  for (const variant of variants) {
    runtimes[variant] = {};
    for (const strategy of strategies) {
      runtimes[variant][strategy] = await createSqaTestServer(path.join(directory, variant, strategy),
        { envFile: values['env-file'], hybridQa: true, jevNavigation: strategy === 'jev' });
    }
  }
  // Each variant runs matched pairs in alternating order. Concurrent
  // variants use distinct server stores, sessions, and browser owners.
  for (const runtime of Object.values(runtimes).flatMap(Object.values)) await runtime.start();
  await save();
  const outcomes = await Promise.allSettled(variants.map(async variant => {
    for (const runtime of Object.values(runtimes[variant])) await qualify(runtime);
    for (let rep = startRepeat; rep <= repeats; rep++) {
      const order = (rep + fixtureVariants.indexOf(variant)) % 2 === 1 ? strategies : [...strategies].reverse();
      for (const strategy of order) {
        const trial = { variant, strategy, rep };
        result.runs.push(trial);
        await save();
        await runCase(runtimes[variant][strategy], trial);
        await save();
        console.log(`${browser}/${variant}/${strategy} #${rep}: ${trial.accepted ? 'accepted' : trial.error || trial.pauseReason || trial.lifecycle} (${trial.elapsedMs ?? '?'} ms, navigation ${trial.navigationPass}, heading ${trial.headingPass}, defect ${trial.seededDefectFound}, JEV choice ${trial.decisionExecuted})`);
      }
    }
  }));
  const failures = outcomes.filter(item => item.status === 'rejected');
  if (failures.length) throw new Error(failures.map(item => item.reason.message).join(' | '));
  result.status = 'measured';
} catch (error) {
  result.status = 'incomplete';
  result.error = error.message.split('\n')[0];
} finally {
  result.finishedAt = new Date().toISOString();
  result.targetWrites = writes;
  await save();
  await Promise.allSettled(Object.values(runtimes).flatMap(Object.values).map(runtime => runtime.stop()));
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
}
console.log(`${result.status}: ${path.join(directory, 'result.json')}`);
if (result.status !== 'measured') process.exitCode = 1;
