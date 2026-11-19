import test from 'node:test';
import assert from 'node:assert/strict';
import { featureStateKey, featureRouteFromTransition, awaitFeatureInventory } from './qaFeatureState.js';

test('functional state identity ignores private copy/values and distinguishes subfeatures at one URL', () => {
  const first = { url: 'https://fixture.test/app', headings: ['Projects'], fieldCount: 1, navigationControls: [{ label: 'Reports' }] };
  assert.equal(featureStateKey(first), featureStateKey({ ...first, text: 'private conversation', value: 'a password', capturedAt: Date.now() }));
  assert.notEqual(featureStateKey(first), featureStateKey({ ...first, headings: ['Project details'] }));
});

test('same-URL panels with identical headings and field counts remain distinct features', () => {
  const shell = { url: 'https://fixture.test/app', headings: ['Workspace'], fieldCount: 1, navigationControls: [{ label: 'Projects' }, { label: 'Meeting' }] };
  assert.notEqual(featureStateKey({ ...shell, controls: [{ label: 'New draft', role: 'button' }] }), featureStateKey({ ...shell, controls: [{ label: 'Start meeting', role: 'button' }] }));
  assert.equal(featureStateKey({ ...shell, text: 'Timer 01:00' }), featureStateKey({ ...shell, text: 'Timer 02:00' }));
});


test('feature restoration tolerates hydration reads but never relaxes identity or replays controls', async () => {
  let reads = 0;
  const result = await awaitFeatureInventory('verified', async () => ({ stateKey: ++reads < 3 ? 'hydrating' : 'verified' }), undefined, 0);
  assert.equal(result.stateKey, 'verified'); assert.equal(reads, 3);
  reads = 0;
  assert.equal(await awaitFeatureInventory('verified', async () => { reads++; return { stateKey: 'changed' }; }, undefined, 0), null);
  assert.equal(reads, 4);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(awaitFeatureInventory('verified', async () => { throw new Error('Must not read'); }, controller.signal), { name: 'AbortError' });
});
