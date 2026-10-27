import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { createHybridScenarioTool } from './hybridQaTools.js';
import { hybridCompletion, validateHybridFinding, validateHybridReport } from './qaCompletionGate.js';
import { prepareHybridInference } from './hybridContext.js';
import { createQaTools } from './qaTools.js';
import { digestEvidence } from './qaScenarioLedger.js';

function fixture(selectedTests = ['navigation', 'broken_links', 'responsive'], version = 2, paths = ['/docs', '/contact']) {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: 'https://fixture.test/', selectedTests, messages: [], findings: [], activities: [], todos: [], secretNames: [] };
  const record = { bridge: { authorizeHybridAction: async () => {} } }, profile = hybridProfile({ apiKey: 'fixture' }, {});
  let runtime = createHybridRuntime({ session, runStore: { async commit() {} }, profile, record });
  if (version === 1) {
    session.hybrid.exploration.version = 1;
    runtime = createHybridRuntime({ session, runStore: { async commit() {} }, profile, record });
  }
  runtime.router.classifier = async (_state, questions) => Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, { choice: Object.keys(question.criteria)[0] }]));
  let url = session.targetUrl, calls = 0;
  const inventory = () => ({ url, title: 'Fixture', forms: [], search: [], images: 0, players: 0, disclosures: [], tabs: [], links: [...paths, '/delete-account', '/?secret=not-allowed', 'https://outside.test/'].map((href, i) => ({ href: new URL(href, session.targetUrl).href, selector: `#link-${i}`, label: href })) });
  const base = { name: 'browser_qa_check', parametersSchema: { properties: {} }, description: 'Fixture check', async run(input) {
    calls++;
    if (['inspect', 'scroll'].includes(input.action)) return { success: true, url, inventory: inventory(), assertions: [] };
    if (input.action === 'navigation') { url = input.expected; return { success: true, url, assertions: [
      { check: 'navigation', name: 'Observed link reaches its destination', outcome: 'pass', expected: url, actual: url },
      { check: 'broken_links', name: 'Destination renders usable content', outcome: url.endsWith('/docs') ? 'fail' : 'pass', expected: 'HTTP success', actual: { url, status: url.endsWith('/docs') ? 404 : 200 }, reproduction: { confirmed: url.endsWith('/docs'), observations: 2 } }
    ] }; }
    return { success: true, url, assertions: [{ check: input.action, name: 'Fixed host assertion', outcome: 'pass', expected: 'Supported contract', actual: 'Observed result' }] };
  } };
  const tools = new Map([base, createHybridScenarioTool(base), { name: 'browser_open', async run(input) { calls++; url = input.url; return { success: true, url }; } }].map(tool => [tool.name, runtime.wrapTool(tool)]));
  record.invokeHybridTool = async (name, input, signal) => tools.get(name).run(input, { signal });
  return { session, runtime, record, tools, base, calls: () => calls };
}

test('multi-route batches validate observed candidates, retain cross-category failures and persist each browser receipt', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const frontier = f.runtime.tools.find(tool => tool.name === 'qa_route_frontier');
  const routes = await frontier.run({ rank: false });
  assert.equal(routes.candidates.length, 3); assert.ok(routes.candidates.every(item => !/delete|outside|secret/.test(item.url)));
  const batch = f.runtime.tools.find(tool => tool.name === 'qa_test_routes');
  const before = f.calls();
  await assert.rejects(batch.run({ route_ids: ['invented'] }), /observed/);
  await assert.rejects(batch.run({ route_ids: [routes.candidates[0].id], checks: ['authentication'] }), /selected scope/);
  assert.equal(f.calls(), before);
  const result = await batch.run({ route_ids: routes.candidates.map(item => item.id) });
  assert.equal(result.coverage.tested, 3); assert.ok(f.session.hybrid.actions.length > 10);
  assert.equal(f.session.hybrid.scenarios.length, 3, 'Page count must not multiply the category plan.');
  assert.equal(f.session.hybrid.actions.every(item => ['done', 'failed'].includes(item.status)), true);
  const failed = f.session.hybrid.scenarios.find(item => item.category === 'broken_links' && item.status === 'failed');
  assert.ok(failed, 'A navigation success must not discard a broken-link failure from the same observation.');
  const finding = validateHybridFinding(f.session, { scenario_id: failed.id, assertion_id: failed.assertions.find(item => item.outcome === 'fail').id });
  assert.ok(finding.evidenceRefs.length);
  const restored = structuredClone(f.session);
  assert.ok(validateHybridFinding(restored, { scenario_id: failed.id, assertion_id: failed.assertions.find(item => item.outcome === 'fail').id }), 'Object-valued facts must survive persistence without false reference-identity mismatches.');
  assert.equal(result.failures.length, 1); assert.ok(JSON.stringify(result).length < 9000);
  await assert.rejects(batch.run({ route_ids: [routes.candidates[0].id] }), /not previously attempted/);
});

test('JEV route ranking is bounded, cached and advisory; it does not dispatch a browser action', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' }); let ranks = 0;
  f.runtime.router.classifier = async (state, questions) => { ranks++; assert.ok(state.candidates.length <= 16); return { next: { choice: Object.keys(questions.next.criteria)[0] } }; };
  const frontier = f.runtime.tools.find(tool => tool.name === 'qa_route_frontier'), before = f.calls();
  assert.equal((await frontier.run({})).recommendation.authority, 'advisory'); await frontier.run({});
  assert.equal(ranks, 1); assert.equal(f.calls(), before);
});

test('route suites execute selected-device checks before temporary responsive samples', async () => {
  const f = fixture(['responsive', 'accessibility']);
  await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const route = f.session.hybrid.exploration.routes.find(item => item.url === f.session.targetUrl);
  await f.runtime.tools.find(tool => tool.name === 'qa_test_routes').run({ route_ids: [route.id] });
  const actions = f.session.hybrid.actions.map(item => item.input.action).filter(Boolean);
  assert.ok(actions.indexOf('accessibility') >= 0);
  assert.ok(actions.indexOf('accessibility') < actions.indexOf('responsive'));
  const before = f.calls();
  await assert.rejects(f.tools.get('browser_qa_check').run({ action: 'disclosure', selector: '#menu' }), /outside the selected test scope/);
  assert.equal(f.calls(), before, 'Out-of-scope checks must not dispatch browser actions.');
});

test('suite continuation preserves earlier failures, route gaps and action evidence without adding plans or replaying', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const scenario = f.session.hybrid.scenarios.find(item => item.category === 'responsive');
  const routes = f.session.hybrid.exploration.routes.slice(0, 2);
  routes[0].status = 'running'; await f.runtime.ledger.startRoute(scenario.id, routes[0].url);
  const action = await f.runtime.ledger.beginAction('browser_qa_check', { action: 'responsive' });
  await f.runtime.ledger.record(action, { success: true, url: routes[0].url, assertions: [{ check: 'responsive', name: 'Overflow', expected: 'fits', actual: 'does not fit', outcome: 'fail', reproduction: { confirmed: true, observations: 2 } }] });
  await f.runtime.ledger.close(scenario.id, 'complete');
  routes[1].status = 'running'; await f.runtime.ledger.startRoute(scenario.id, routes[1].url);
  await assert.rejects(f.runtime.ledger.close(scenario.id, 'complete'), /new executed/);
  assert.equal(scenario.status, 'running', 'Rejected completion must not mutate the suite status.');
  await f.runtime.ledger.close(scenario.id, 'inconclusive', 'No assertion on the second page.');
  assert.equal(scenario.status, 'failed'); assert.equal(scenario.routeRuns[1].status, 'inconclusive');
  await assert.rejects(f.runtime.ledger.close(scenario.id, 'not_executed', 'Erase the earlier failure'), /cannot be relabeled/);
  assert.equal(scenario.status, 'failed');
  assert.match(hybridCompletion(f.session).gaps.join(' '), /route executions remain/);
  assert.equal(await f.runtime.ledger.startRoute(scenario.id, routes[1].url), null);
  assert.equal(f.session.hybrid.scenarios.length, 3);
  assert.ok(validateHybridFinding(f.session, { scenario_id: scenario.id, assertion_id: scenario.assertions[0].id }));
});

test('identical repeated scenario proposals are idempotent, not duplicate planning items', async () => {
  const f = fixture();
  const input = { category: 'responsive', objective: 'Investigate the observed panel', expected: { source: 'hypothesis', text: 'Requires supported evidence' } };
  await f.runtime.ledger.plan([input, input]); await f.runtime.ledger.plan([input]);
  assert.equal(f.session.hybrid.scenarios.length, 4);
});

test('observed absent controls produce gaps without repeated empty checks or fabricated passes', async () => {
  const f = fixture(['forms', 'search']); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const routes = (await f.runtime.tools.find(tool => tool.name === 'qa_route_frontier').run({ rank: false })).candidates;
  await f.runtime.tools.find(tool => tool.name === 'qa_test_routes').run({ route_ids: routes.map(route => route.id) });
  assert.equal(f.session.hybrid.scenarios.length, 2);
  assert.ok(!f.session.hybrid.actions.some(action => ['forms', 'search'].includes(action.input.action)));
  for (const scenario of f.session.hybrid.scenarios) await f.runtime.ledger.close(scenario.id, 'not_executed', 'No eligible controls in the sampled inventories.');
  assert.equal(hybridCompletion(f.session).passedAssertions, 0);
  assert.ok(hybridCompletion(f.session).gaps.some(gap => /Observed absence/.test(gap)));
  assert.throws(() => validateHybridReport(f.session, { verdict: 'pass' }), /Unsupported pass/);
});

test('bounded batch summaries retain omitted failures and provide a failure-only evidence recovery path', async () => {
  const f = fixture(['responsive']); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const original = f.base.run;
  f.base.run = async input => input.action !== 'responsive' ? original(input) : { success: true, url: f.session.targetUrl,
    assertions: [...Array.from({ length: 200 }, () => ({ check: 'responsive', name: 'Repeated passing check', expected: 'fits', actual: 'fits', outcome: 'pass' })),
      ...Array.from({ length: 12 }, (_, i) => ({ check: 'responsive', name: `Failure ${i}`, expected: 'fits', actual: `overflow ${i}`, outcome: 'fail', reproduction: { confirmed: true, observations: 2 } }))] };
  const root = f.session.hybrid.exploration.routes.find(route => route.url === f.session.targetUrl);
  const result = await f.runtime.tools.find(tool => tool.name === 'qa_test_routes').run({ route_ids: [root.id] });
  assert.equal(result.failures.length, 8); assert.equal(result.omittedFailures, 4);
  assert.equal(result.evidenceForMoreFailures.length, 1);
  const reader = f.runtime.tools.find(tool => tool.name === 'qa_read_evidence');
  let offset = 0, data = '';
  do {
    const page = await reader.run({ evidence_id: result.evidenceForMoreFailures[0], view: 'failed_assertions', offset, length: 6000 });
    data += page.data; offset = page.nextOffset;
  } while (offset !== null);
  const assertions = JSON.parse(data);
  assert.equal(assertions.length, 12); assert.ok(assertions.every(assertion => assertion.outcome === 'fail'));
  assert.ok(!data.includes('Repeated passing check'));
});

test('persisted version-one exploration keeps its original per-route execution strategy on continuation', async () => {
  const f = fixture(['navigation', 'broken_links', 'responsive'], 1);
  await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const routes = (await f.runtime.tools.find(tool => tool.name === 'qa_route_frontier').run({ rank: false })).candidates;
  await f.runtime.tools.find(tool => tool.name === 'qa_test_routes').run({ route_ids: routes.map(route => route.id) });
  assert.equal(f.session.hybrid.exploration.version, 1);
  assert.ok(f.session.hybrid.scenarios.length > 3);
  assert.ok(f.session.hybrid.scenarios.every(scenario => !scenario.routeRuns));
});

test('route batches reject changed observation provenance before dispatching any action', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const route = (await f.runtime.tools.find(tool => tool.name === 'qa_route_frontier').run({ rank: false })).candidates.find(item => item.url.endsWith('/docs'));
  const before = f.calls();
  const evidence = f.session.hybrid.evidence.find(item => item.result?.inventory);
  evidence.result.inventory.links = [];
  // Even a recomputed digest cannot turn a stale route into an observed link.
  evidence.digest = digestEvidence(evidence.result);
  await assert.rejects(f.runtime.tools.find(tool => tool.name === 'qa_test_routes').run({ route_ids: [route.id] }), /provenance/);
  assert.equal(f.calls(), before);
});

test('SDK dispatch barrier waits for a complete response and fails closed on interruption or cancellation', async () => {
  const f = fixture();
  // Usage validation is tested at the transport/router boundary. Isolate the
  // subsequent SDK dispatch boundary here with a deterministic model stream.
  f.runtime.router.reasoner = (chat, messages, options) => chat(messages, options);
  const service = { async *chat() { yield { type: 'tool_call', id: 'first' }; yield { type: 'tool_call', id: 'last' }; } };
  f.runtime.wrapChat(service);
  const stream = await service.chat([], {}), iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  let dispatched = false;
  const waiting = f.runtime.awaitToolDispatch().then(() => { dispatched = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dispatched, false);
  await iterator.next(); await iterator.next(); await waiting;
  assert.equal(dispatched, true);
  const interrupted = await service.chat([], {});
  await interrupted.next(); await interrupted.return();
  await assert.rejects(f.runtime.awaitToolDispatch(), /complete verified model tool batch/);
  const pending = await service.chat([], {}), controller = new AbortController();
  const cancelled = f.runtime.awaitToolDispatch(controller.signal);
  controller.abort(new Error('Explicit cancellation'));
  await assert.rejects(cancelled, /Explicit cancellation/);
  await pending.next(); await pending.return();
});

test('cancellation preserves interrupted batches and never automatically replays their chosen routes', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const route = (await f.runtime.tools.find(tool => tool.name === 'qa_route_frontier').run({ rank: false })).candidates[0];
  const batch = f.runtime.tools.find(tool => tool.name === 'qa_test_routes'), controller = new AbortController();
  f.record.invokeHybridTool = async () => { controller.abort(new Error('Fixture interruption')); throw controller.signal.reason; };
  await assert.rejects(batch.run({ route_ids: [route.id] }, { signal: controller.signal }));
  assert.equal(f.session.hybrid.exploration.batches[0].status, 'interrupted');
  assert.equal(f.session.hybrid.exploration.routes.find(item => item.id === route.id).status, 'interrupted');
  await assert.rejects(batch.run({ route_ids: [route.id] }), /not previously attempted/);
});

test('stage routing exposes a small useful catalog; loading a tool cannot grant unknown/blocked capabilities', async () => {
  const f = fixture(); f.runtime.registerToolCatalog(['browser_click', 'browser_open', 'qa_test_routes', 'qa_load_tools', 'finish_qa_report']);
  const finish = createQaTools(f.session, { async commit() {} }).find(tool => tool.name === 'finish_qa_report');
  const options = { tools: [finish, { name: 'browser_open' }, { name: 'browser_click' }, { name: 'qa_test_routes' }, { name: 'security_check' }] };
  const first = prepareHybridInference([], options, f.session);
  assert.ok(!first.options.tools.some(tool => tool.name === 'browser_click' || tool.name === 'security_check'));
  const loader = f.runtime.tools.find(tool => tool.name === 'qa_load_tools');
  await assert.rejects(loader.run({ names: ['execute_command'] }));
  await loader.run({ names: ['browser_click'] });
  assert.ok(prepareHybridInference([], options, f.session).options.tools.some(tool => tool.name === 'browser_click'));
});

test('hundreds of passing assertions remain durable but do not inflate model-facing summaries or closeout', async () => {
  const f = fixture(), scenario = f.session.hybrid.scenarios.find(item => item.category === 'responsive');
  const tool = f.runtime.wrapTool(createHybridScenarioTool({ name: 'browser_qa_check', parametersSchema: { properties: {} }, async run() { return { success: true, assertions: Array.from({ length: 400 }, () => ({ check: 'responsive', name: 'Repeated pass', expected: 'Supported', actual: 'Observed', outcome: 'pass' })) }; } }));
  const result = await tool.run({ scenario_id: scenario.id, action: 'responsive' });
  assert.equal(result.assertionCounts.passed, 400); assert.equal(result.hostAssertions.length, 0); assert.ok(JSON.stringify(result).length < 1000);
  assert.equal(scenario.assertions.length, 400); assert.equal(f.session.hybrid.evidence[0].digest, digestEvidence(f.session.hybrid.evidence[0].result));
  const ledger = await f.runtime.tools.find(tool => tool.name === 'qa_ledger').run({});
  assert.ok(JSON.stringify(ledger).length < 6000);
});

test('single-page dispositions cannot masquerade as adequate observed-route depth or a full pass', async () => {
  const f = fixture(); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  for (const scenario of f.session.hybrid.scenarios) await f.runtime.ledger.close(scenario.id, 'not_executed', 'Fixture has not executed this scope.');
  assert.throws(() => validateHybridReport(f.session, { verdict: 'partial' }), /observed-route depth/);
  f.session.hybrid.budgetFinalizing = true;
  assert.equal(validateHybridReport(f.session, { verdict: 'partial' }).verdict, 'blocked');
  assert.ok(hybridCompletion(f.session).gaps.some(item => /Observed-route coverage/.test(item)));
});

test('six of eight pages plus a three-route request executes the two fitting routes and explicitly defers one', async () => {
  const f = fixture(['responsive'], 2, Array.from({ length: 8 }, (_, i) => `/area-${i}`));
  await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const frontier = f.runtime.tools.find(tool => tool.name === 'qa_route_frontier');
  const batch = f.runtime.tools.find(tool => tool.name === 'qa_test_routes');
  const initial = await frontier.run({ rank: false });
  await batch.run({ route_ids: initial.candidates.slice(0, 3).map(r => r.id) });
  await batch.run({ route_ids: initial.candidates.slice(3, 6).map(r => r.id) });
  const remaining = await frontier.run({ rank: false });
  assert.equal(remaining.coverage.attempted, 6); assert.equal(remaining.coverage.remainingSlots, 2);
  assert.equal(remaining.hostSuggestion.routeIds.length, 2);
  const requested = remaining.candidates.map(r => r.id);
  const before = f.calls();
  await assert.rejects(batch.run({ route_ids: [requested[0], requested[1], 'invented'] }), /observed/);
  assert.equal(f.calls(), before, 'Even a deferred candidate must pass provenance checks before any execution.');
  const result = await batch.run({ route_ids: requested });
  assert.equal(result.success, true); assert.equal(result.coverage.tested, 8);
  assert.equal(result.coverage.attempted, 8); assert.equal(result.coverage.remainingSlots, 0);
  assert.deepEqual(result.executedRouteIds, requested.slice(0, 2));
  assert.deepEqual(result.deferredRouteIds, requested.slice(2));
  assert.equal(f.session.hybrid.exploration.routes.find(r => r.id === requested[2]).status, 'pending');
  assert.equal(f.session.hybrid.exploration.batches.at(-1).routeIds.length, 2);
  assert.equal(result.nextCandidates.length, 0);
  assert.equal(validateHybridReport(f.session, { verdict: 'partial' }).verdict, 'partial');
  assert.equal(f.session.hybrid.exploration.maxPages, 8);
  const blocked = await batch.run({ route_ids: result.deferredRouteIds });
  assert.equal(blocked.code, 'HYBRID_ROUTE_CAPACITY_REACHED');
  assert.equal((await frontier.run({ rank: false })).hostSuggestion.routeIds.length, 0);
});

test('failed page attempts consume capacity without being credited as tested or replayed', async () => {
  const f = fixture(['responsive']); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  f.session.hybrid.exploration.maxPages = 2;
  const batch = f.runtime.tools.find(tool => tool.name === 'qa_test_routes');
  const ids = f.session.hybrid.exploration.routes.map(r => r.id);
  const open = f.tools.get('browser_open');
  f.tools.set('browser_open', f.runtime.wrapTool({ name: 'browser_open', async run() { return { success: false }; } }));
  const failure = await batch.run({ route_ids: [ids[0]] });
  assert.equal(failure.coverage.attempted, 1); assert.equal(failure.coverage.tested, 0);
  f.tools.set('browser_open', open);
  const final = await batch.run({ route_ids: ids.slice(1) });
  assert.equal(final.coverage.attempted, 2); assert.equal(final.coverage.tested, 1);
  assert.deepEqual(final.deferredRouteIds, [ids[2]]);
  await assert.rejects(batch.run({ route_ids: [ids[0]] }), /not previously attempted/);
});

test('unsupported-only scope can publish an honest blocker instead of being forced into an unexecutable depth contract', async () => {
  const f = fixture(['authentication']); await f.tools.get('browser_qa_check').run({ action: 'inspect' });
  const frontier = await f.runtime.tools.find(tool => tool.name === 'qa_route_frontier').run({ rank: false });
  assert.equal(frontier.coverage.stopReason, 'unsupported_scope');
  assert.equal(frontier.coverage.canExplore, false); assert.equal(frontier.hostSuggestion.routeIds.length, 0);
  for (const scenario of f.session.hybrid.scenarios) await f.runtime.ledger.close(scenario.id, 'blocked', 'No authorized account workflow was supplied.');
  assert.equal(validateHybridReport(f.session, { verdict: 'blocked' }).verdict, 'blocked');
  assert.throws(() => validateHybridReport(f.session, { verdict: 'pass' }), /Unsupported pass/);
  const finish = createQaTools(f.session, { async commit() {} }).find(tool => tool.name === 'finish_qa_report');
  const prepared = prepareHybridInference([], { tools: [finish, ...f.runtime.tools] }, f.session);
  assert.ok(prepared.options.tools.some(tool => tool.name === 'finish_qa_report'));
  assert.equal(prepared.options.tools.some(tool => tool.name === 'qa_test_routes'), false);
});
