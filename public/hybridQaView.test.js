import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridQaModel, renderHybridQa, hybridLaunchOptions, hybridScenarioProgress, hybridScenarioPlan, hybridAvailabilityMessage, holdPrimaryPreview, viewportStatusText } from './hybridQaView.js';

test('hybrid launcher is explicit, qualified and exactly one observed available configuration', () => {
  const config = { hybridQa: { enabled: true, available: true } };
  const configurations = [{ envId: 'fixture-env', availability: 'AVAILABLE', browserSupport: { engine: 'chromium' } }];
  const input = { config, configurations, envIds: ['fixture-env'] };
  assert.equal(hybridLaunchOptions({ ...input, mode: 'legacy' }), null);
  assert.equal(hybridLaunchOptions(input), null);
  assert.deepEqual(hybridLaunchOptions({ ...input, mode: 'hybrid' }), { qaExecutionMode: 'hybrid', environmentId: 'fixture-env', engine: 'chromium' });
  assert.throws(() => hybridLaunchOptions({ ...input, config: {}, mode: 'hybrid' }), /unavailable/);
  assert.throws(() => hybridLaunchOptions({ ...input, mode: 'unknown' }), /Unknown/);
  for (const envIds of [[], ['fixture-env', 'second']]) assert.throws(() => hybridLaunchOptions({ ...input, mode: 'hybrid', envIds }), /one browser/);
  assert.throws(() => hybridLaunchOptions({ ...input, mode: 'hybrid', envIds: ['invented'] }), /no longer available/);
  assert.throws(() => hybridLaunchOptions({ ...input, mode: 'hybrid', configurations: [{ ...configurations[0], availability: 'UNAVAILABLE' }] }), /no longer available/);
});

test('launcher explains unavailable qualification instead of silently graying out hybrid mode', () => {
  const config = { hybridQa: { enabled: true, available: false, status: 'qualification_expired', reason: 'Hybrid QA is unavailable because its compatibility check expired.' } };
  assert.match(hybridAvailabilityMessage(config), /expired/);
  assert.throws(() => hybridLaunchOptions({ config, mode: 'hybrid' }), /expired/);
  assert.match(hybridAvailabilityMessage({ hybridQa: { available: true } }), /ready/);
  assert.match(hybridAvailabilityMessage({}), /unavailable/);
});

test('temporary responsive samples cannot replace the selected-device preview or masquerade as another device', () => {
  const viewportTesting = { phase: 'responsive_sample', primary: { width: 1440, height: 900 }, current: { width: 390, height: 900 } };
  const frame = { viewportTesting, viewport: viewportTesting.current };
  assert.equal(holdPrimaryPreview(frame, { qaExecutionMode: 'hybrid' }), true);
  assert.equal(holdPrimaryPreview(frame, { qaExecutionMode: 'legacy' }), false);
  assert.equal(holdPrimaryPreview({ ...frame, viewport: viewportTesting.primary }, { qaExecutionMode: 'hybrid' }), false);
  assert.match(viewportStatusText(viewportTesting), /390px.*1440×900/);
  assert.equal(viewportStatusText({ phase: 'selected_device' }), '');
  assert.match(viewportStatusText({ phase: 'restore_failed' }), /must pause/);
});

test('hybrid view is QA-only and separates lifecycle, coverage and unresolved observations', () => {
  assert.equal(hybridQaModel({ mode: 'sqa', qaExecutionMode: 'hybrid' }), null);
  assert.equal(hybridQaModel({ mode: 'qa' }), null);
  assert.equal(hybridQaModel({ mode: 'qa', qaExecutionMode: 'hybrid', status: 'error' }).status, 'startup failed');
  const elements = [];
  const document = { createElement() { const node = { textContent: '', setAttribute() {}, append() {} }; elements.push(node); return node; } };
  renderHybridQa({ mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { status: 'paused', scenarios: [{ id: 'a', objective: '<script>inject()</script>', status: 'inconclusive' }], currentScenarioId: 'a', observations: [{ status: 'unresolved' }], recovery: { verificationRequired: true }, budgets: { reasonerTokens: 300000 }, telemetry: { reasoner: { inputTokens: 76666, outputTokens: 551, reservedTokens: 0 }, classifier: {}, elapsedMs: 1200 } } }, document);
  const text = elements.map(item => item.textContent).join(' ');
  assert.match(text, /1 inconclusive/); assert.match(text, /1 unresolved/); assert.match(text, /0%/);
  assert.match(text, /<script>inject\(\)<\/script>/); assert.match(text, /fresh authorized browser snapshot/);
  assert.match(text, /77217 \/ 300000 provider-reported tokens · 0 pending reservation tokens/);
});

test('budget closeout explains that exploration stopped and untested work cannot pass', () => {
  const lines = [], document = { createElement() { const node = { textContent: '', setAttribute() {}, append() {} }; lines.push(node); return node; } };
  renderHybridQa({ mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { status: 'finalizing_budget', budgetFinalizing: true } }, document);
  const text = lines.map(item => item.textContent).join(' ');
  assert.match(text, /Finishing within the approved budget/); assert.match(text, /coverage gaps, not passed tests/);
});

test('route target separates available capacity from closeout and attempted pages from passes', () => {
  const lines = [], document = { createElement() { const node = { textContent: '', setAttribute() {}, append() {} }; lines.push(node); return node; } };
  renderHybridQa({ mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { exploration: { attempted: 6, target: 8, tested: 5, observed: 15, pending: 9, remainingSlots: 2, canExplore: false, stopReason: 'budget_closeout' } } }, document);
  const text = lines.map(item => item.textContent).join(' ');
  assert.match(text, /6\/8 attempted/); assert.match(text, /5\/15 observed pages tested/);
  assert.match(text, /does not prevent publication/);
  assert.doesNotMatch(text, /2 page slots remain/);
});

test('hybrid progress uses evidence-backed scenario coverage, never cosmetic todo completion', () => {
  const scenarios = Array.from({ length: 11 }, (_, i) => ({ id: String(i), category: 'fixture', status: i < 4 ? 'passed' : i < 6 ? 'inconclusive' : 'not_executed', uncertainty: [] }));
  const session = { mode: 'qa', qaExecutionMode: 'hybrid', todos: Array.from({ length: 3 }, () => ({ status: 'completed' })), hybrid: { scenarios } };
  assert.deepEqual(hybridScenarioProgress(session), { total: 11, done: 4, percent: 36 });
  assert.equal(hybridScenarioPlan(session).filter(item => item.status === 'passed').length, 4);
  assert.equal(hybridScenarioPlan(session).filter(item => item.status === 'not_tested').length, 5);
  assert.equal(hybridScenarioProgress({ ...session, mode: 'founder' }), null);
});

test('category-suite plan keeps page trials and gaps visible without duplicating planning items', () => {
  const session = { mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { scenarios: [{ id: 'navigation', category: 'navigation', status: 'failed', routeCounts: { attempted: 6, gaps: 1 } }] } };
  const plan = hybridScenarioPlan(session);
  assert.equal(plan.length, 1); assert.match(plan[0].text, /6 page trials, 1 gaps/);
});

test('passed assertions on some pages do not label a suite with route gaps as a full pass', () => {
  const session = { mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { counts: { passed: 1 }, scenarios: [{ id: 'forms', category: 'forms', status: 'passed', routeCounts: { attempted: 3, gaps: 1 } }] } };
  assert.equal(hybridScenarioPlan(session)[0].status, 'partial');
  assert.deepEqual(hybridScenarioProgress(session), { total: 1, done: 0, percent: 0 });
  assert.equal(hybridQaModel(session).coverage, 0);
});
