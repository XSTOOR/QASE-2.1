import test from 'node:test';
import assert from 'node:assert/strict';
import { renderProbeIds, hasInteractiveSurface } from './renderHealth.js';

test('paint probes follow full-page destinations rather than the intentionally hidden sidebar', () => {
  assert.deepEqual(renderProbeIds('bugs'), ['bugs-view']);
  assert.deepEqual(renderProbeIds('account'), ['profile-dialog']);
  assert.deepEqual(renderProbeIds('new-run'), ['qa-start']);
  assert.deepEqual(renderProbeIds('matrix-run'), ['qa-matrix-run-dialog']);
  assert.deepEqual(renderProbeIds('results'), ['results-page-head', 'workspace-viewer']);
  assert.deepEqual(renderProbeIds('run'), ['workspace-runs', 'workspace-agent']);
});
const element = ({ width = 64, height = 40, visible = true, children = [] } = {}) => ({
  getBoundingClientRect: () => ({ width, height }),
  checkVisibility: () => visible,
  querySelectorAll: () => children
});
test('an interactive 64px collapsed sidebar is healthy', () => {
  assert.equal(hasInteractiveSurface(element({ children: [element()] })), true);
});
test('missing, zero-size, hidden, or entirely non-interactive surfaces remain unhealthy', () => {
  assert.equal(hasInteractiveSurface(null), false);
  assert.equal(hasInteractiveSurface(element({ width: 0, children: [element()] })), false);
  assert.equal(hasInteractiveSurface(element({ visible: false, children: [element()] })), false);
  assert.equal(hasInteractiveSurface(element()), false);
  assert.equal(hasInteractiveSurface(element({ children: [element({ visible: false })] })), false);
});
