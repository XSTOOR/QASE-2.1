import test from 'node:test';
import assert from 'node:assert/strict';
import { qaPlanProgress, qaExecutionModeLabel, qaLauncherModeLabel, qaLauncherSelectionProblem } from './qaExecutionView.js';

test('a 13-item administratively completed plan with six coverage gaps is only 7/13 exercised', () => {
  const statuses = ['completed', 'tested', 'partial', 'not_tested', 'not_observed', 'tested', 'tested', 'tested', 'partial', 'partial', 'not_tested', 'completed', 'completed'];
  const session = { mode: 'qa', todos: statuses.map(status => ({ status: 'completed', text: `Check — ${status}: Recorded evidence` })) };
  assert.deepEqual(qaPlanProgress(session), { total: 13, done: 7, percent: 54 });
  assert.equal(qaPlanProgress({ ...session, mode: 'sqa' }), null);
  assert.equal(qaPlanProgress({ ...session, mode: 'founder' }), null);
  assert.equal(qaPlanProgress({ ...session, qaExecutionMode: 'hybrid' }), null);
  assert.ok(session.todos.every(item => item.status === 'completed'), 'Rendering must not rewrite saved run history.');
});

test('run identity distinguishes the actual JEV controller from explicitly selected hybrid', () => {
  assert.match(qaExecutionModeLabel({ mode: 'qa', jev: {} }), /JEV-only.*no Opus/);
  assert.match(qaExecutionModeLabel({ mode: 'qa', report: { executionEvidence: { controller: 'coverage-decisions-v2' } } }), /JEV-only/);
  assert.match(qaExecutionModeLabel({ mode: 'qa', qaExecutionMode: 'hybrid' }), /Opus reasoning/);
  assert.match(qaExecutionModeLabel({ mode: 'qa' }), /hybrid not selected/);
  assert.equal(qaExecutionModeLabel({ mode: 'sqa' }), '');
  assert.match(qaLauncherModeLabel('legacy', { provider: 'jev' }), /no Opus/);
  assert.match(qaLauncherModeLabel('hybrid', {}), /Opus 4.7/);
  assert.match(qaLauncherModeLabel('', { hybridQa: { enabled: true } }), /Choose Hybrid/);
  assert.ok(qaLauncherSelectionProblem('', { hybridQa: { enabled: true } }));
  assert.equal(qaLauncherSelectionProblem('legacy', { hybridQa: { enabled: true } }), null);
  assert.equal(qaLauncherSelectionProblem('hybrid', { hybridQa: { enabled: true } }), null);
  assert.equal(qaLauncherSelectionProblem('', { hybridQa: { enabled: false } }), null);
});
