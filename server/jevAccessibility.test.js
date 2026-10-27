import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { runJevAccessibility } from './jevAccessibility.js';

test('accessibility checks distinguish repeated missing names from labels, icons, decoration and hidden content', { timeout: 30000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><title>Accessible naming fixture</title>
    <label for="labelled">Email</label><input id="labelled">
    <label>Nested label<input id="nested"></label>
    <span id="hidden-label" hidden>Hidden naming reference</span><input id="referenced" aria-labelledby="hidden-label">
    <input id="placeholder" placeholder="Search docs"><input id="title" title="Product code">
    <button id="svg"><svg width="20" height="20"><title>Close dialog</title><path d="M0 0L20 20"/></svg></button>
    <button id="image-button"><img alt="Open help" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"></button>
    <button id="aria" aria-label="Open menu"><span aria-hidden="true">☰</span></button>
    <button id="text">Continue</button><input id="submit" type="submit">
    <input id="missing-field"><button id="missing-button"><span aria-hidden="true">×</span></button>
    <img id="missing-alt" width="20" height="20" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E">
    <img id="decorative" alt="" width="20" height="20"><img id="presentation" role="presentation" width="20" height="20">
    <div aria-hidden="true"><button id="aria-hidden"></button><img id="hidden-image" width="20" height="20"></div>
    <div hidden><input id="native-hidden"></div><div inert><button id="inert"></button></div>
    <div style="visibility:hidden"><button id="invisible"></button></div><input id="hidden-input" type="hidden">
  `);
  const result = await runJevAccessibility(page);
  const failures = result.assertions.filter(item => item.outcome === 'fail');
  assert.deepEqual(failures.map(item => JSON.parse(item.actual).selector).sort(), ['#missing-alt', '#missing-button', '#missing-field']);
  assert.ok(failures.every(item => item.reproduction.confirmed && item.reproduction.observations === 2));
  for (const selector of ['#labelled', '#nested', '#referenced', '#placeholder', '#title', '#svg', '#image-button', '#aria', '#text', '#submit', '#decorative', '#presentation']) {
    assert.ok(result.assertions.some(item => JSON.parse(item.actual).selector === selector && item.outcome === 'pass'), `${selector} should retain its valid naming/decoration evidence.`);
  }
  assert.ok(!result.assertions.some(item => /#(aria-hidden|hidden-image|native-hidden|inert|invisible|hidden-input)"/.test(item.actual)));
  assert.match(result.limitations, /contrast.*keyboard.*not evaluated/);
});
