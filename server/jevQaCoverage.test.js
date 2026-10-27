import test from 'node:test';
import assert from 'node:assert/strict';
import { jevQaCoverage } from './jevQaCoverage.js';
import { jevActionCandidates } from './jevRuntime.js';

const observation = (extra = {}) => ({
  page: { url: 'https://site.test/', title: 'Example', bodyText: 'Rendered content', viewport: { width: 1280, height: 720 } },
  diagnostics: { console: [], network: [], formValidation: { fieldCount: 0 } }, ...extra
});
test('standard QA distinguishes executed sampling from untested workflows', () => {
  const result = jevQaCoverage(['navigation', 'forms', 'authentication', 'search', 'responsive', 'broken_links', 'media', 'console_health'], [observation()]);
  assert.equal(result.blocked, false);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.outcomes.map(item => item.status), ['partial', 'not_tested', 'not_tested', 'not_tested', 'partial', 'partial', 'not_tested', 'tested']);
  assert.match(result.notCovered.join(' '), /No form fields were recorded/);
  assert.ok(result.covered.some(text => text.includes('1 distinct observed routes')));
});
test('only completed explicit scope can pass; missing diagnostics cannot', () => {
  assert.equal(jevQaCoverage(['console_health'], [observation()]).incomplete, false);
  const unavailable = jevQaCoverage(['console_health'], [observation({ diagnostics: { success: false } })]);
  assert.equal(unavailable.blocked, true);
  assert.equal(jevQaCoverage(['console_health'], [observation(), observation({ diagnostics: {} })]).blocked, true);
});
test('unrendered pages never establish successful coverage', () => {
  for (const page of [{ loading: true }, { loadError: 'DNS failure' }, { bodyText: '' }]) {
    assert.equal(jevQaCoverage(['navigation', 'console_health'], [observation({ page: { ...observation().page, ...page } })]).blocked, true);
  }
  const result = jevQaCoverage(['navigation'], [], { browserError: 'Policy denied' });
  assert.match(result.notCovered[0], /Policy denied/);
});
test('form validation is partial inspection, not a successful form submission', () => {
  const result = jevQaCoverage(['forms'], [observation({ diagnostics: { formValidation: { fieldCount: 2 } } })]);
  assert.equal(result.blocked, false);
  assert.equal(result.outcomes[0].status, 'partial');
  assert.match(result.notCovered[0], /no forms were submitted/);
});
test('failed browser actions remain coverage gaps even with complete diagnostics', () => {
  const result = jevQaCoverage(['console_health'], [observation()], { failedActions: [{ label: 'Help', error: 'Timeout' }] });
  assert.equal(result.blocked, false);
  assert.equal(result.incomplete, true);
  assert.match(result.notCovered[0], /Help.*Timeout/);
});
test('an already attempted route is deduplicated across different source pages', () => {
  const first = { success: true, url: 'https://site.test/', elements: [{ href: '/help', text: 'Help' }] };
  const key = jevActionCandidates(first, first.url)[0].key;
  assert.equal(jevActionCandidates({ ...first, url: 'https://site.test/pricing' }, first.url, [key]).length, 0);
});
