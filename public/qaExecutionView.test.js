import test from 'node:test';
import assert from 'node:assert/strict';
import { qaPlanProgress, qaExecutionModeLabel, qaLauncherModeLabel, qaLauncherSelectionProblem } from './qaExecutionView.js';

test('a 13-item administratively completed plan with six coverage gaps is only 7/13 exercised', () => {
  const statuses = ['completed', 'tested', 'partial', 'not_tested', 'not_observed', 'tested', 'tested', 'tested', 'partial', 'partial', 'not_tested', 'completed', 'completed'];
  const session = { mode: 'qa', todos: statuses.map(status => ({ status: 'completed', text: `Check — ${status}: Recorded evidence` })) };
  assert.deepEqual(qaPlanProgress(session), { total: 13, done: 7, percent: 54 });
  assert.equal(qaPlanProgress({ ...session, mode: 'sqa' }), null);
  assert.equal(qaPlanProgress({ ...session, mode: 'founder' }), null);
  assert.equal(qaPlanProgress({ ...session, hybrid: { version: 2 } }), null, 'engine runs report phase progress instead');
  assert.ok(session.todos.every(item => item.status === 'completed'), 'Rendering must not rewrite saved run history.');
});

test('run identity names the QA engine and labels older runs by their recorded engine', () => {
  assert.match(qaExecutionModeLabel({ mode: 'qa', hybrid: { version: 2 } }), /QA engine/);
  assert.match(qaExecutionModeLabel({ mode: 'qa', qaExecutionMode: 'hybrid', hybrid: { version: 1 } }), /Hybrid QA \(previous engine\)/);
  assert.match(qaExecutionModeLabel({ mode: 'qa', jev: {} }), /JEV-only/);
  assert.match(qaExecutionModeLabel({ mode: 'qa' }), /Single-model QA/);
  assert.equal(qaExecutionModeLabel({ mode: 'sqa' }), '');
  assert.match(qaLauncherModeLabel('hybrid', { hybridQa: { reasonerConfigured: true, reasoner: 'opus', classifierConfigured: true, classifier: 'jev' } }), /automated checks \+ opus \+ jev verification/);
  assert.equal(qaLauncherSelectionProblem(), null);
});
