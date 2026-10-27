import test from 'node:test';
import assert from 'node:assert/strict';
import { runJevQa, jevRequestedChecks, jevPrioritizeRoutes } from './jevQaRunner.js';

test('route fallback prioritizes new functional families over repeated legal pages without losing candidates', () => {
  const routes = ['legal/privacy', 'legal/terms', 'solutions', 'pricing'].map(path => ({ url: `https://site.test/${path}`, label: path }));
  const ranked = jevPrioritizeRoutes(routes, ['https://site.test/legal/dpa']);
  assert.deepEqual(ranked.map(route => route.label), ['solutions', 'pricing', 'legal/privacy', 'legal/terms']);
  assert.equal(routes[0].label, 'legal/privacy', 'Do not mutate the original frontier.');
});

test('operator accessibility/content/design requests are retained beyond legacy checkbox IDs', () => {
  assert.deepEqual(jevRequestedChecks({ selectedTests: ['responsive'], messages: [{ role: 'user', text: 'Test accessibility basics, content and text validation, and UI consistency.' }] }), ['responsive', 'accessibility', 'content', 'visual_consistency']);
  assert.deepEqual(jevRequestedChecks({ selectedTests: ['console_health'], messages: [{ role: 'assistant', text: 'accessibility' }] }), ['console_health']);
});

function harness({ maxPages = 3, failOpen = false, redirectAfterNavigation = false, partialHistory = false } = {}) {
  const base = 'https://site.test';
  let current = base + '/';
  const session = { id: 'run', selectedTests: ['navigation', 'responsive', 'console_health'], targetUrl: current, jev: { pages: [] }, messages: [], findings: [] };
  const calls = [];
  let report;
  const inventory = () => ({ url: current.endsWith('/alias') ? base + '/' : current, title: 'Fixture', text: current.endsWith('/blank') ? '' : 'Rendered fixture', viewport: { width: 1440, height: 900 }, forms: [], search: [], disclosures: [], images: 0, links: current === base + '/' || current.endsWith('/alias') ? [...(redirectAfterNavigation ? ['alias'] : []), 'blank', 'two', 'three'].map(path => ({ href: `${base}/${path}`, selector: `#${path}`, label: path })) : [] });
  async function* invoke(name, input = {}) {
    calls.push({ name, input });
    let result = { success: true };
    if (name === 'browser_open') { current = input.url; result.success = !failOpen; }
    if (name === 'browser_qa_check') {
      result = { success: true, action: input.action, url: current, assertions: [] };
      if (input.action === 'inspect') result.inventory = inventory();
      if (input.action === 'navigation') {
        const source = current;
        current = input.expected;
        result.destination = current;
        result.assertions = ['click', 'back', 'forward'].map(name => ({ check: 'navigation', name, outcome: 'pass', expected: current, actual: current }));
        result.assertions.push({ check: 'broken_links', name: 'render', outcome: 'pass', expected: 'Page', actual: current });
        if (partialHistory) { current = source; result.executionComplete = false; result.destinationReady = false; result.gaps = ['Browser back timed out. Partial anchor evidence retained; no replay.']; }
      }
      if (input.action === 'responsive') result.assertions = [390, 768, 1440].map(width => ({ check: 'responsive', name: `Geometry ${width}`, outcome: 'pass', expected: 'No overflow', actual: width }));
    }
    if (name === 'browser_snapshot') result = { success: true, url: current, title: 'Fixture', elements: [], bodyText: 'Fixture' };
    if (name === 'browser_diagnostics') result = { success: true, console: [], network: [] };
    if (name === 'finish_qa_report') report = input;
    yield { type: 'tool_result', toolName: name, result };
    return result;
  }
  async function decide(_state, questions) {
    if (questions.route) {
      assert.equal(Object.hasOwn(questions.route.criteria, 'finish'), false, 'Early finishing is not a valid route decision.');
      return { route: { choice: Object.keys(questions.route.criteria)[0] } };
    }
    // Even an overeager model verdict cannot bypass coverage evidence.
    return { verdict: { choice: 'pass' } };
  }
  return { session, calls, report: () => report, run: () => runJevQa({ session, runStore: { async commit() {} }, invoke, decide, diagnosticCandidates: () => [], signal: new AbortController().signal, maxPages }) };
}

test('incomplete history preserves partial facts as unresolved and never tests the source as the destination', async () => {
  const f = harness({ partialHistory: true });
  for await (const _ of f.run()) {}
  assert.equal(f.session.jev.qa.visits.length, 1);
  assert.equal(f.session.jev.qa.checks.filter(check => check.action === 'navigation').length, 3);
  assert.equal(f.session.jev.qa.issueReview.filter(item => item.kind === 'execution_gap' && item.status === 'unresolved').length, 1);
  assert.ok(f.report().not_covered.some(item => /Browser back timed out/.test(item)));
  assert.equal(f.session.findings.length, 0);
  assert.equal(f.report().verdict, 'partial');
  assert.equal(f.session.jev.qa.coverage.find(item => item.id === 'navigation').status, 'partial');
});

test('a blank route is retried once, recorded and bypassed while other planned routes continue', async () => {
  const fixture = harness();
  for await (const _ of fixture.run()) { /* monitor until the final artifact */ }
  assert.equal(fixture.session.jev.qa.visits.length, 3);
  assert.ok(fixture.session.jev.qa.visits.some(visit => visit.url.endsWith('/three')));
  assert.equal(fixture.session.jev.qa.checks.filter(check => check.action === 'render' && !check.success).length, 1);
  assert.equal(fixture.report().verdict, 'partial');
  assert.ok(fixture.report().not_covered.some(text => text.includes('one retry')));
  const finalPlan = fixture.calls.filter(call => call.name === 'update_todo').at(-1).input.items;
  assert.ok(finalPlan.every(item => item.status === 'completed'));
  assert.ok(finalPlan.some(item => item.content.includes('tested')));
});

test('route budget leaves explicit gaps and cannot be overridden by a model pass', async () => {
  const fixture = harness({ maxPages: 1 });
  for await (const _ of fixture.run()) {}
  assert.equal(fixture.session.jev.qa.visits.length, 1);
  assert.equal(fixture.report().verdict, 'partial');
  assert.match(fixture.report().not_covered.join(' '), /3 additional observed safe routes/);
  assert.ok(fixture.report().not_covered.some(text => text.includes('No safe internal anchor')));
});

test('no browser evidence is a real blocker, not a completed or passing test', async () => {
  const fixture = harness({ failOpen: true });
  for await (const _ of fixture.run()) {}
  assert.equal(fixture.report().verdict, 'blocked');
  assert.equal(fixture.session.jev.qa.visits.length, 0);
});

test('a delayed redirect to an already tested page cannot prematurely finish the remaining frontier', async () => {
  const fixture = harness({ redirectAfterNavigation: true });
  for await (const _ of fixture.run()) {}
  assert.ok(fixture.session.jev.qa.checks.some(check => check.action === 'redirect'));
  assert.ok(fixture.session.jev.qa.visits.some(visit => visit.url.endsWith('/three')));
  assert.equal(fixture.session.jev.qa.visits.length, 3);
});
