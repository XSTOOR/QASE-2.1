import test from 'node:test';
import assert from 'node:assert/strict';
import { runCardDetails } from './runCard.js';

test('snapshot details do not render missing values or duplicate devices', () => {
 const details = runCardDetails({ device: 'mac', engine: 'webkit', environmentSnapshot: { device: 'iMac (24-inch M1)', browserVersion: undefined } }, [{ id: 'mac', label: 'Duplicate device' }]);
 assert.equal(details.environment, 'iMac (24-inch M1) · WebKit');
 assert.equal(runCardDetails({ environmentSnapshot: { browser: 'undefined', device: 'null' } }).environment, '');
 assert.equal(runCardDetails({ environmentSnapshot: { device: 'Desktop', browserVersion: '151' } }).environment, 'Desktop');
});
test('uses known device profiles and preserves browser identity', () => {
 assert.equal(runCardDetails({ device: 'ipad', engine: 'chromium', deviceLandscape: true }, [{ id: 'ipad', label: 'iPad Pro' }]).environment, 'iPad Pro · Chromium · Landscape');
 assert.equal(runCardDetails({ environmentSnapshot: { device: 'Desktop', browser: 'Chrome', browserVersion: '151' } }).environment, 'Desktop · Chrome 151');
});
test('progress is finite, integral and bounded', () => {
 for (const [completed, total, expected] of [[undefined, 13, 0], [-2, 8, 0], [20, 8, 100], [2, 0, 0], [NaN, Infinity, 0]]) {
  const details = runCardDetails({ todoCompleted: completed, todoTotal: total });
  assert.equal(details.percent, expected);
  assert.ok(details.completed >= 0 && details.completed <= details.total);
 }
});
test('mode and findings have concise readable labels without missing data', () => {
 assert.equal(runCardDetails({ mode: 'founder', findingCount: 3 }).mode, 'Founder');
 assert.equal(runCardDetails({ mode: 'sqa' }).mode, 'Quality');
 assert.equal(runCardDetails({}).mode, 'Test');
 assert.equal(runCardDetails({ findingCount: -1 }).findings, 0);
});
