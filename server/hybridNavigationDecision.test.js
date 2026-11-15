import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHybridRuntime, initializeHybridState } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { prepareHybridInference } from './hybridContext.js';
import { createHybridScenarioTool } from './hybridQaTools.js';
import { hydrateHybrid, hybridStorage } from './hybridPersistence.js';

const origin = 'https://fixture.test';
const link = (path, label) => ({ selector: '#' + path, href: origin + '/' + path, label });
const links = [link('plans', 'Compare plan features'), link('rates', 'See monthly rates')];
const excluded = [link('delete', 'Delete record'), { ...link('external', 'External'), href: 'https://other.test/' },
  { ...link('download', 'Download'), download: true }, { ...link('query', 'Query'), href: origin + '/?variant=1' }];

function setup({ scope = 'navigation', strategy = true, answer = 'rates', stale = false, cancel = false, single = false } = {}) {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: origin + '/', selectedTests: [scope],
    messages: [{ role: 'user', text: 'Find monthly rates' }], findings: [], todos: [] };
  const profile = hybridProfile({ apiKey: 'test-key' }, {});
  initializeHybridState(session, profile, { jevNavigation: strategy });
  const record = {}, controller = new AbortController();
  let calls = 0, inspections = 0, clicks = 0;
  const runtime = createHybridRuntime({ session, profile, record, runStore: { async commit() {} }, async fetchImpl(_url, options) {
    calls++;
    const { state, questions } = JSON.parse(options.body);
    assert.deepEqual(state.candidates.map(candidate => candidate[1]), ['Compare plan features · /plans', 'See monthly rates · /rates']);
    const [plansId, ratesId] = Object.keys(questions.next.criteria);
    if (cancel && calls === 1) controller.abort(new Error('Stopped before click'));
    return Response.json({ model: 'jev-1.13', id: 'fixture-provider-id', usage: { input_tokens: 13, output_tokens: 2 },
      answers: { next: { type: 'choice', choice: ({ plans: plansId, rates: ratesId })[answer] ?? answer } } });
  } });
  const inspect = runtime.wrapTool({ name: 'browser_qa_check', async run() {
    const candidates = ++inspections === 2 && stale ? [links[0]] : single ? [links[1], ...excluded] : [...links, ...excluded];
    return { success: true, action: 'inspect', inventory: { url: session.targetUrl, stateKey: 'entry', readiness: { ready: true }, links: candidates } };
  } });
  const click = runtime.wrapTool(createHybridScenarioTool({ name: 'browser_qa_check', parametersSchema: { properties: {} },
    async run(input, context) {
      assert.equal(context.qaseNavigationGuard.source, session.targetUrl);
      assert.equal(context.qaseNavigationGuard.label, links[1].label);
      clicks++;
      return { success: true, url: session.targetUrl, source: session.targetUrl, destination: input.expected,
        assertions: [{ name: 'Observed anchor reaches its destination', check: 'navigation', expected: input.expected, actual: input.expected, outcome: 'pass' }] };
    }
  }));
  record.invokeHybridTool = (name, input, signal) => (name === 'browser_qa_check' ? inspect : click).run(input, { signal });
  const tool = runtime.tools.find(item => item.name === 'qa_choose_navigation');
  return { session, profile, runtime, tool, controller, get calls() { return calls; }, get inspections() { return inspections; }, get clicks() { return clicks; },
    run: (input = { scenario_id: session.hybrid.scenarios[0].id }, signal = controller.signal) => runtime.wrapTool(tool).run(input, { signal }) };
}

test('pinned strategy exposes a single observed link without a model call and persists its assertion reference', async () => {
  const f = setup({ single: true });
  const result = await f.run();
  const [decision] = f.session.hybrid.navigationDecisions;
  assert.equal(result.outcome, 'executed');
  assert.equal(decision.source, 'host');
  assert.equal(decision.candidateIds.length, 1);
  assert.equal(decision.usage, undefined);
  assert.equal(f.calls, 0);
  assert.equal(f.clicks, 1);
  assert.equal(f.inspections, 2);
  const saved = { mode: 'qa' };
  hydrateHybrid(saved, JSON.parse(hybridStorage(f.session)));
  assert.deepEqual(saved.hybrid.navigationDecisions, f.session.hybrid.navigationDecisions);
  assert.ok(saved.hybrid.scenarios[0].assertions.some(item => item.evidenceRef === decision.evidenceRef && item.actionId === decision.actionId));
});

test('the model chooses only from observed safe links and its decision links to verified usage and a browser assertion', async () => {
  const f = setup();
  assert.equal((await f.run()).outcome, 'executed');
  const [decision] = f.session.hybrid.navigationDecisions;
  assert.equal(decision.source, 'jev');
  assert.equal(decision.candidateIds.length, 2);
  assert.equal(decision.usage.providerCallId, 'fixture-provider-id');
  assert.equal(f.session.hybrid.modelBudget.roles.classifier.reservations[0].status, 'settled');
  assert.equal(f.calls, 1);
  assert.equal(f.clicks, 1);
});

for (const [name, options, outcome] of [
  ['unknown', { answer: 'unknown' }, 'unknown'],
  ['invented or out-of-scope ID', { answer: 'https://other.test/' }, 'invalid'],
  ['link changed on the same page', { stale: true }, 'stale']
]) test(`${name} returns a durable replan outcome with zero clicks`, async () => {
  const f = setup(options);
  const result = await f.run();
  assert.equal(result.code, 'QA_NAVIGATION_REPLAN');
  assert.equal(result.outcome, outcome);
  assert.equal(f.session.hybrid.navigationDecisions[0].outcome, outcome);
  assert.equal(f.session.hybrid.scenarios[0].assertions.length, 0);
  assert.equal(f.clicks, 0);
  assert.equal((await f.run()).code, 'QA_NAVIGATION_REPLAN');
  assert.equal(f.calls, 1);
});

test('out-of-scope scenarios, model-supplied selectors, and late cancellation dispatch no click', async () => {
  const excludedScope = setup({ scope: 'responsive' });
  assert.equal(excludedScope.tool, undefined);
  const legacy = setup({ strategy: false });
  initializeHybridState(legacy.session, legacy.profile, { jevNavigation: true });
  assert.equal(legacy.session.hybrid.navigationDecisionVersion, undefined);
  assert.equal(legacy.tool, undefined);
  const f = setup({ cancel: true });
  const tools = prepareHybridInference([], { tools: f.runtime.tools }, f.session).options.tools;
  assert.deepEqual(tools.find(item => item.name === 'qa_choose_navigation').parametersSchema.properties.scenario_id.enum, [f.session.hybrid.scenarios[0].id]);
  await assert.rejects(f.run({ scenario_id: 'out-of-scope', selector: '#rates' }), /only the existing/);
  await assert.rejects(f.run({ scenario_id: 'out-of-scope' }), /Unknown scenario/);
  assert.equal(f.inspections, 0);
  await assert.rejects(f.run(), /Stopped before click/);
  assert.equal(f.session.hybrid.navigationDecisions[0].outcome, 'interrupted');
  assert.equal(f.clicks, 0);
});

test('the navigation schema omits the choice when another category owns the browser', async () => {
  const f = setup();
  f.session.hybrid.scope.push('content');
  const scenarios = await f.runtime.ledger.plan([{ category: 'content', objective: 'Verify the heading',
    expected: { text: 'Heading', source: 'hypothesis' } }]);
  await f.runtime.ledger.start(scenarios.find(item => item.category === 'content').id);
  const tools = prepareHybridInference([], { tools: f.runtime.tools }, f.session).options.tools;
  assert.ok(!tools.some(item => item.name === 'qa_choose_navigation'));
});

test('a verified resume can make one fresh decision when Stop arrived before click dispatch', async () => {
  const f = setup({ cancel: true });
  await assert.rejects(f.run(), /Stopped before click/);
  assert.equal(f.session.hybrid.navigationDecisions[0].dispatchStarted, false);
  f.session.hybrid.recovery = { verificationRequired: true };
  const signal = new AbortController().signal;
  await assert.rejects(f.run(undefined, signal), /verified browser state/);
  await f.runtime.wrapTool({ name: 'browser_snapshot', async run() { return { success: true, url: f.session.targetUrl }; } }).run({}, { signal });
  assert.equal((await f.run(undefined, signal)).outcome, 'executed');
  assert.equal(f.calls, 2);
  assert.equal(f.clicks, 1);
});
