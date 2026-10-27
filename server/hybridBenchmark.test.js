import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkMetrics } from './hybridBenchmark.js';

test('benchmark uses actual seeded classes and executed negative controls; unknown cost/recovery stay unavailable', () => {
  const session = { status: 'done', findings: [{ title: 'Page overflows horizontally' }, { title: 'Image fails to load', actual: '/healthy.svg' }], jev: { qa: { visits: [{}], checks: [
    { action: 'navigation', success: true, assertions: [{ name: 'Browser back restores source route', outcome: 'pass' }] },
    { action: 'media', success: true, assertions: [{ name: 'Image decoding', actual: '/healthy.svg', outcome: 'pass' }] }
  ] } } };
  const result = benchmarkMetrics(session);
  assert.equal(result.confirmedDefectRecall, 1 / 3);
  assert.equal(result.falseFindings, 1); assert.equal(result.falsePositiveRate, 0.5);
  assert.equal(result.workflowCompletionRate, 0.5);
  assert.equal(result.costPerCompletedWorkflow, null); assert.equal(result.recoverySuccess, null);
  assert.equal(benchmarkMetrics({ ...session, findings: [{ title: 'Unmapped speculative issue' }] }).falsePositiveRate, null);
});
