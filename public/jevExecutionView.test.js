import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { jevExecutionModel, renderJevExecution } from './jevExecutionView.js';
test('QA evidence distinguishes failed assertions from confirmed findings and omits old smoke claims', () => {
  assert.equal(jevExecutionModel({}), null);
  const model = jevExecutionModel({ controller: 'coverage-decisions-v2', routes: 2, scenarios: 5, checks: [{ assertions: [{ outcome: 'pass' }, { outcome: 'fail' }] }] });
  assert.equal(model.assertions, 2); assert.equal(model.failed, 1);
  assert.equal(model.routes, 2); assert.equal(model.scenarios, 5);
  const bounded = jevExecutionModel({ controller: 'coverage-decisions-v2', checks: [], totalAssertions: 300, failedAssertions: 2, omittedCheckRecords: 50 });
  assert.equal(bounded.assertions, 300);
  assert.equal(bounded.failed, 2);
  assert.equal(bounded.omittedCheckRecords, 50);
  assert.doesNotMatch(readFileSync(new URL('./jevExecutionView.js', import.meta.url), 'utf8'), /innerHTML/);
});

test('candidate review keeps unresolved evidence separate from findings and distinguishes observations from behavior', () => {
  const model = jevExecutionModel({
    controller: 'coverage-decisions-v2', routes: 3, scenarios: 20, executedScenarios: 6, observations: 12, nativeConstraintAssertions: 3,
    checks: [], issueReview: [
      { status: 'confirmed', title: 'Reproduced overflow' },
      { status: 'unresolved', title: 'Transient image load' },
      { status: 'excluded', title: 'Policy-blocked request' },
      { status: 'pass', title: 'Unsupported status cannot clear evidence' }
    ]
  });
  assert.equal(model.confirmed, 1);
  assert.equal(model.unresolved, 2);
  assert.equal(model.excluded, 1);
  assert.equal(model.executedScenarios, 6);
  assert.equal(model.observations, 12);
  assert.equal(model.nativeConstraintAssertions, 3);
});

test('rendered review labels uncertain candidates and preserves untrusted evidence only as text', () => {
  const elements = [];
  const document = { createElement(tag) {
    const node = { tag, children: [], textContent: '', append(...children) { this.children.push(...children); } };
    elements.push(node); return node;
  } };
  renderJevExecution({ controller: 'coverage-decisions-v2', routes: 1, scenarios: 4, executedScenarios: 0, observations: 4, nativeConstraintAssertions: 0, checks: [], issueReview: [{
    title: '<img src=x onerror=alert(1)>', status: 'unresolved', actual: '<script>unsafe()</script>',
    reason: 'Not reproduced after reload', modelConfidence: 0.54, verification: { confirmed: false, attempts: 2 }
  }] }, document);
  const text = elements.map(element => element.textContent).join('\n');
  assert.match(text, /0 behavior scenarios/);
  assert.match(text, /0 confirmed findings · 1 unresolved candidates/);
  assert.match(text, /UNRESOLVED — <img src=x onerror=alert\(1\)>/);
  assert.match(text, /Observed: <script>unsafe\(\)<\/script>/);
  assert.match(text, /Not confirmed across 2 observations/);
  assert.equal(elements.some(element => ['script', 'img'].includes(element.tag)), false);
});
