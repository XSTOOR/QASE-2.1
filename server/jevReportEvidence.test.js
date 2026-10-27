import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createQaTools } from './qaTools.js';
import { clearSecrets, storeSecrets } from './secrets.js';

test('JEV report projects host evidence, preserves unresolved review and redacts candidate evidence', async t => {
  const session = {
    id: randomUUID(), mode: 'qa', targetUrl: 'https://site.test/', findings: [], messages: [],
    todos: [{ text: 'Record tested scope', status: 'completed' }],
    activities: [{ toolName: 'browser_snapshot', status: 'done' }],
    runtimeFacts: { executionLevel: 'SIMULATED', userAgent: 'Mozilla/5.0 Chrome/153', os: 'Linux' },
    jev: { qa: {
      version: 2, visits: [{ url: 'https://site.test/' }], checks: [{ action: 'tabs', success: true, assertions: [], trials: [{ skipped: 'Blocked dependency private-fixture-value' }] }], executedScenarios: 0, observations: 2, nativeConstraintAssertions: 0,
      issueReview: [{ key: 'observed', title: 'One request failed', status: 'unresolved', reason: 'Could not reproduce',
        actual: 'private-fixture-value', verification: { confirmed: false, attempts: 2 }, modelConfidence: 0.55 }]
    } }
  };
  storeSecrets(session.id, { password: 'private-fixture-value' });
  t.after(() => clearSecrets(session.id));
  const finish = createQaTools(session, { async commit() {} }).find(tool => tool.name === 'finish_qa_report');
  const result = await finish.run({ verdict: 'partial', summary: 'Rendered one route.', covered: ['Rendered page'], not_covered: ['Request failure remains unresolved.'],
    executionEvidence: { executedScenarios: 999, issueReview: [{ key: 'invented', status: 'confirmed' }] }
  });
  assert.equal(result.success, true);
  const evidence = session.report.executionEvidence;
  assert.equal(evidence.executedScenarios, 0);
  assert.equal(evidence.observations, 2);
  assert.equal(evidence.checks[0].action, 'tabs');
  assert.match(evidence.checks[0].trials[0].skipped, /Blocked dependency/);
  assert.equal(evidence.totalAssertions, 0);
  assert.equal(evidence.issueReview.length, 1);
  assert.equal(evidence.issueReview[0].key, 'observed');
  assert.equal(evidence.issueReview[0].status, 'unresolved');
  assert.equal(evidence.issueReview[0].verification.confirmed, false);
  assert.equal(session.report.findings, 0);
  assert.doesNotMatch(JSON.stringify(evidence), /private-fixture-value|invented/);
  session.jev.qa.checks = Array.from({ length: 251 }, (_, index) => ({ action: 'disclosure', assertions: [{ outcome: index === 250 ? 'fail' : 'pass' }] }));
  assert.equal((await finish.run({ verdict: 'partial', summary: 'Bounded projection.', covered: ['Executed assertions'], not_covered: ['Remaining review.'] })).success, true);
  assert.equal(session.report.executionEvidence.checks.length, 250);
  assert.equal(session.report.executionEvidence.omittedCheckRecords, 1);
  assert.equal(session.report.executionEvidence.totalAssertions, 251);
  assert.equal(session.report.executionEvidence.failedAssertions, 1, 'Failure totals must include evidence beyond the projection cap.');
});
