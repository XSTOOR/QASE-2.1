import test from 'node:test';
import assert from 'node:assert/strict';
import { safeBrowserRoute } from './browserRouteSafety.js';

for (const message of ['Route is already handled!', 'Target page, context or browser has been closed']) test(`routing teardown is contained: ${message}`, async () => {
  let aborted = false, diagnostics = false;
  await safeBrowserRoute(async route => route.continue(), () => { diagnostics = true; })({ continue: async () => { throw new Error(message); }, abort: async () => { aborted = true; } });
  assert.equal(aborted, false); assert.equal(diagnostics, false);
});
test('unexpected route failures block the request and sanitize diagnostics; diagnostics cannot become another unhandled rejection', async () => {
  let forwarded = false, reason, diagnostic;
  const route = { continue: async () => { forwarded = true; }, abort: async value => { reason = value; } };
  await safeBrowserRoute(async () => { throw new Error('Unexpected transport error including private request content'); }, async value => { diagnostic = value; throw new Error('Diagnostic sink failure'); })(route);
  assert.equal(forwarded, false); assert.equal(reason, 'blockedbyclient'); assert.equal(diagnostic.code, 'BROWSER_ROUTE_DISPATCH_FAILED');
  assert.ok(!JSON.stringify(diagnostic).includes('private request'));
});
