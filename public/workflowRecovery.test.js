import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowStatus } from './workflowStatus.js';

const paused = hybrid => ({ mode: 'qa', qaExecutionMode: 'hybrid', status: 'interrupted', hybrid });
test('unknown classifier usage offers saved progress instead of an ineffective resume', () => {
  for (const hybrid of [{ recovery: { resumeBlockedReason: 'usage_unverified' } }, { pauseReason: 'classifier has an unverified prior usage receipt.' }]) {
    const guidance = workflowStatus(paused(hybrid));
    assert.match(guidance.resumeBlocked, /receipt/);
    assert.equal(guidance.destination, 'progress');
    assert.doesNotMatch(guidance.description, /HYBRID_USAGE_/);
  }
});
test('budget exhaustion cannot be bypassed through resume; user-paused and other modes stay resumable', () => {
  assert.ok(workflowStatus(paused({ pauseReason: 'Execution time budget exhausted.' })).resumeBlocked);
  assert.equal(workflowStatus(paused({})).resumeBlocked, undefined);
  for (const mode of ['sqa', 'founder']) assert.equal(workflowStatus({ ...paused({}), mode }).resumeBlocked, undefined);
});
test('completion offers an explicit results action and preserves partial coverage messaging', () => {
  assert.equal(workflowStatus({ mode: 'qa', status: 'done', findings: [] }).destination, 'results');
  assert.equal(workflowStatus({ mode: 'qa', status: 'done', report: { verdict: 'partial' } }).action, 'Review coverage');
  const closed = workflowStatus({ mode: 'qa', qaExecutionMode: 'hybrid', status: 'done', report: { verdict: 'partial' }, hybrid: { budgetFinalizing: true } });
  assert.match(closed.description, /Start a new test/); assert.equal(closed.destination, 'results');
});
