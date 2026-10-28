import test from 'node:test';
import assert from 'node:assert/strict';
import { featureStateKey, featureRouteFromTransition } from './qaFeatureState.js';
import { hybridRoutePolicy } from './hybridRoutePolicy.js';

test('functional state identity ignores private copy/values and distinguishes subfeatures at one URL', () => {
  const first = { url: 'https://fixture.test/app', headings: ['Projects'], fieldCount: 1, navigationControls: [{ label: 'Reports' }] };
  assert.equal(featureStateKey(first), featureStateKey({ ...first, text: 'private conversation', value: 'a password', capturedAt: Date.now() }));
  assert.notEqual(featureStateKey(first), featureStateKey({ ...first, headings: ['Project details'] }));
});

test('same-URL features carry bounded observed paths and keep publication pending', () => {
  const route = { url: 'https://fixture.test/app' };
  const result = { hostEvidenceId: 'evidence', inventory: { url: route.url }, transition: { from: 'root', to: 'projects', control: { selector: '#projects', label: 'Projects' } } };
  const feature = featureRouteFromTransition(route, result, 'public');
  assert.equal(feature.featurePath[0].evidenceId, 'evidence'); assert.equal(feature.kind, 'feature');
  assert.equal(featureRouteFromTransition({ ...route, featurePath: Array(4).fill({}) }, result, 'public'), null);
  assert.equal(featureRouteFromTransition(route, { ...result, hostEvidenceId: undefined }, 'public'), null);
  const policy = hybridRoutePolicy({ scope: ['navigation'], exploration: { maxPages: 8, routes: [{ ...route, status: 'tested' }, feature] } });
  assert.equal(policy.canExplore, true); assert.equal(policy.publicationAllowed, false);
});
