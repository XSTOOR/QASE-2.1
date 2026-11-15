import test from 'node:test';
import assert from 'node:assert/strict';
import { menuMotionLabel } from './qaMenuMotion.js';
import { jevRequestedChecks } from './jevQaRunner.js';

test('menu motion requires a unique named control in the original hybrid kickoff', () => {
  const session = { qaExecutionMode: 'hybrid', selectedTests: ['navigation'], messages: [
    { role: 'user', text: 'https://example.test/\nUser focus for this run: Menu motion: Main menu' },
    { role: 'user', text: 'Menu motion: Other menu' }
  ] };
  assert.equal(menuMotionLabel(session), 'Main menu');
  assert.deepEqual(jevRequestedChecks(session), ['navigation', 'menu_motion']);
  assert.deepEqual(jevRequestedChecks({ ...session, qaExecutionMode: 'legacy' }), ['navigation']);
  assert.deepEqual(jevRequestedChecks({ ...session, messages: [{ role: 'user', text: 'Check animation and theme flashes.' }, session.messages[1]] }), ['navigation']);
  assert.equal(menuMotionLabel({ messages: [{ role: 'user', text: 'Menu motion: First\nMenu motion: Second' }] }), undefined);
});
