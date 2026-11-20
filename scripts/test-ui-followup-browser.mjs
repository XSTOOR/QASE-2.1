import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { request } from 'playwright';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { createFounderBrowserFixture } from './founder-browser-fixture.mjs';
import { createSqaRunState } from '../server/sqa/engine.js';
import { buildSqaReport } from '../server/sqa/report.js';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' }, 'output-dir': { type: 'string' } } });
const browserName = assertSqaTestBrowser(values.browser);
const output = path.resolve(values['output-dir'] ?? `test-results/ui-followup/${browserName}`);
await fs.mkdir(output, { recursive: true });
const directory = path.join(output, 'runtime-' + Date.now());
const runtime = await createSqaTestServer(directory, { authRequired: true });
const checks = [], errors = [];
let browser, page, api;
let dispatches = 0;
const now = Date.now();
// Compliance fixtures: a run where nothing could be tested, and one with a failed mandatory requirement.
function complianceFixture(title, results) {
  const session = { id: randomUUID(), mode: 'sqa', title, targetUrl: 'https://fixture.test/', status: 'done', createdAt: now, updatedAt: now, messages: [], activities: [], findings: [], todos: [], secretNames: [], sqa: createSqaRunState({ focus: 'Online courses for children' }) };
  Object.assign(session.sqa, {
    status: 'done', phase: 'report',
    phases: Object.fromEntries(['open', 'signin', 'identify', 'research', 'requirements', 'evidence', 'test', 'report'].map(id => [id, { status: 'done', detail: id === 'signin' ? 'skipped' : undefined }])),
    product: { name: 'Fixture Academy', category: 'education', subcategory: 'K-12 tutoring', summary: 'Courses for children with parent accounts.', audience: { description: 'Parents and pupils aged 8-14', children: true, students: true }, regions: ['United States'], dataHandled: ['children', 'accounts'], features: ['sign-up', 'video lessons'], evidence: ['/: hero names ages 8-14'] },
    frameworks: [
      { id: 'F1', name: 'COPPA (16 CFR Part 312)', url: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa', kind: 'privacy', jurisdiction: 'United States', applicability: 'Directed at children under 13.', mandatory: true },
      { id: 'F2', name: 'WCAG 2.2 Level AA', url: 'https://www.w3.org/TR/WCAG22/', kind: 'accessibility', jurisdiction: 'International', applicability: 'Accessibility baseline for a public learning site.', mandatory: false }
    ],
    requirements: results.map((result, index) => ({ id: `R${index + 1}`, frameworkId: index % 2 ? 'F2' : 'F1', clause: `${312 + index}.${index + 1}`, title: `Fixture requirement ${index + 1}`, check: 'A long, realistic requirement description that wraps across several lines on a narrow phone screen.', method: 'browser', severity: index ? 'medium' : 'critical', ...result })),
    evidence: [{ id: 'E1', kind: 'privacy.policy', title: 'Privacy policy link', status: 'ok', detail: 'Linked from the footer of every page.', urls: ['https://fixture.test/privacy'] }],
    sources: [{ url: 'https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa', title: 'COPPA rule', via: 'fetch' }],
    limitations: [{ phase: 'signin', message: 'No test account was provided; signed-in pages were not tested.' }]
  });
  session.report = buildSqaReport(session);
  return session;
}
const quality = complianceFixture('Controlled compliance UI fixture', [{ status: 'needs_documents', observed: 'Needs the parental consent records.' }, { status: 'untested' }]);
assert.equal(quality.report.verdict, 'not_assessed');
const failedQuality = complianceFixture('Controlled failed compliance UI fixture', [{ status: 'fail', observed: 'The privacy policy has no section for children.', fix: 'Add a children section with the COPPA notice items.', decidedBy: 'agent' }, { status: 'pass', observed: 'Every image has alternative text.', url: 'https://fixture.test/', decidedBy: 'agent' }]);
assert.equal(failedQuality.report.verdict, 'non_compliant');
const founder = await createFounderBrowserFixture();
const qa = { id: randomUUID(), mode: 'qa', title: 'Ordinary completed QA fixture', targetUrl: 'https://fixture.test/', status: 'done', createdAt: now, updatedAt: now, messages: [], activities: [], findings: [], todos: [], secretNames: [], report: { verdict: 'pass', summary: 'Controlled display fixture only.', generatedAt: new Date(now).toISOString() } };

async function openReport(session) {
  await page.goto(`${runtime.base}/#/runs/${session.id}/results`);
  // A hash navigation can resolve while the previous report is still visible.
  await page.waitForFunction(title => document.body.dataset.page === 'results' && !document.body.dataset.pageLoading
    && document.getElementById('results-page-title').title === title, session.title);
  await page.locator('#tab-report').click();
  await page.locator('#report-view').waitFor({ state: 'visible' });
}

async function contrast(selector) {
  return page.locator(selector).evaluate(element => {
    const parse = color => (color.match(/[\d.]+/g) ?? []).map(Number);
    const blend = (foreground, background) => foreground.slice(0, 3).map((value, i) => value * (foreground[3] ?? 1) + background[i] * (1 - (foreground[3] ?? 1)));
    const luminance = color => { const v = color.map(value => { value /= 255; return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4; }); return .2126 * v[0] + .7152 * v[1] + .0722 * v[2]; };
    const ancestors = [];
    for (let node = element; node; node = node.parentElement) ancestors.unshift(node);
    let background = [255, 255, 255];
    for (const node of ancestors) background = blend(parse(getComputedStyle(node).backgroundColor), background);
    const foreground = blend(parse(getComputedStyle(element).color), background);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  });
}

try {
  await runtime.start();
  api = await request.newContext({ baseURL: runtime.base });
  const registered = await api.post('/api/auth/register', { data: { email: `ui-followup-${randomUUID()}@example.test`, displayName: 'UI fixture owner', password: `Controlled UI fixture ${randomUUID()}` } });
  assert.equal(registered.status(), 201);
  const user = await registered.json();
  const csrf = decodeURIComponent((await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf').value);
  assert.equal((await api.put('/api/config', { headers: { Origin: runtime.base, 'X-CSRF-Token': csrf }, data: { provider: 'custom', model: 'ui-followup-fixture', baseUrl: 'https://example.test', apiKey: 'ui-followup-dummy-key' } })).status(), 200);
  await runtime.stop();
  for (const session of [quality, failedQuality, founder, qa]) session.ownerUserId = user.id;
  await fs.writeFile(path.join(directory, '.qase', 'sessions.json'), JSON.stringify([quality, failedQuality, founder, qa]));
  await runtime.start();
  const summaries = await (await api.get('/api/sessions')).json();
  assert.equal(summaries.find(item => item.id === quality.id).reportVerdict, 'not_assessed');
  assert.equal(summaries.find(item => item.id === quality.id).sqa, undefined);
  checks.push('Owned run summaries retain the compliance verdict without exposing the full assessment.');

  browser = await launchSqaTestBrowser(browserName);
  const context = await browser.newContext({ storageState: await api.storageState(), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/sessions/*/message', route => { dispatches++; return route.abort('blockedbyclient'); });
  await openReport(quality);
  assert.equal(await page.locator('#results-page-status').innerText(), 'Not assessed');
  assert.match(await page.locator('#results-page-findings').innerText(), /2 standards/);
  assert.equal(await page.locator(`#run-list [data-run-id="${quality.id}"] .run-status-label`).innerText(), 'Blocked');
  checks.push('A compliance run where nothing could be tested shows Not assessed, never Complete / zero findings.');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    assert.ok(await page.locator('#report-view .cmp-framework-why').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 13));
    assert.ok(await page.locator('#report-view .cmp-section-sub').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 12));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, `sqa-${width}.png`), animations: 'disabled' });
  }
  checks.push('Compliance report text stays readable, with no page overflow at 1440/390/320px.');

  await openReport(failedQuality);
  assert.equal(await page.locator('#results-page-status').innerText(), 'Serious compliance gaps');
  assert.match(await page.locator('#results-page-findings').innerText(), /1 failed/);
  assert.equal(await page.locator(`#run-list [data-run-id="${failedQuality.id}"] .run-status-label`).innerText(), 'Failed');
  assert.equal(await page.locator('#status-chip').innerText(), 'Failed');
  await page.locator('#report-view .cmp-req.is-fail summary').first().click();
  assert.match(await page.locator('#report-view .cmp-req.is-fail').first().innerText(), /Add a children section/);
  assert.match(await page.locator('#report-view .cmp-framework').first().innerText(), /COPPA[\s\S]*Legally required[\s\S]*0%/);
  checks.push('A failed compliance run shows Failed in the report, sidebar and workspace chip, with the gap, its fix and the per-standard score.');

  await openReport(founder);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    assert.ok(await page.locator('#report-view .founder-copy').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14));
    assert.ok(await page.locator('#report-view .founder-evidence-note').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 12));
    assert.ok(await page.locator('#report-view .founder-scope strong').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14));
    assert.ok(await page.locator('#report-view .founder-status').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 12));
    assert.ok(await page.locator('#tab-founder').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'The Founder tab and its status badge must not clip each other.');
    assert.ok(await page.evaluate(() => document.querySelector('#tabs').getBoundingClientRect().bottom <= document.querySelector('#pane-report').getBoundingClientRect().top + 1), 'Wrapped report tabs must not cover report content.');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, `founder-${width}.png`), animations: 'disabled' });
  }
  checks.push('Founder body and evidence notes retain readable sizes after brand overrides at desktop and mobile widths.');
  await openReport(qa);
  assert.equal(await page.locator('#results-page-status').innerText(), 'Complete');
  assert.equal(await page.locator('#results-page-findings').innerText(), '0 findings');
  checks.push('Ordinary completed QA keeps its existing result presentation.');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${runtime.base}/#/runs/${qa.id}`);
  await page.waitForFunction(() => document.body.dataset.page === 'run' && !document.body.dataset.pageLoading);
  await page.locator('#new-founder').click();
  await page.locator('#founder-target-url').fill('https://fixture.test/');
  await page.locator('#founder-detected-context').waitFor({ state: 'visible' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    assert.ok(await contrast('#founder-detected-context') >= 4.5, `${theme} context notice must be readable`);
    await page.screenshot({ path: path.join(output, `founder-context-${theme}.png`), animations: 'disabled' });
  }
  await page.locator('#founder-close').click();
  checks.push('The Founder context notice meets 4.5:1 text contrast in both light and dark themes.');

  await page.locator('#sidebar-open-settings').click();
  const customOption = await page.locator('#cfg-model option').filter({ hasText: /^Custom model ID/ }).first().getAttribute('value');
  await page.locator('#cfg-model').selectOption(customOption);
  const modelInput = page.getByRole('textbox', { name: 'Custom model ID', exact: true });
  await modelInput.fill('unsaved-ui-model-draft');
  await page.locator('#open-device-matrix').click();
  await page.locator('#device-matrix').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#dm-browse-list').children.length > 0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(output, `device-management-${width}.png`), animations: 'disabled' });
  }
  await page.locator('#device-matrix .dm-close').click();
  await page.locator('#settings').waitFor({ state: 'visible' });
  assert.equal(await modelInput.inputValue(), 'unsaved-ui-model-draft');
  checks.push('Settings opens Device Management, closes back to Settings and preserves the unsaved, accessibly named model field.');
  assert.equal(dispatches, 0);
  assert.deepEqual(errors, []);
  const result = { status: 'passed', browser: browserName, browserVersion: browser.version(), checks, modelCalls: 0, javascriptErrors: errors };
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: 'failed', checks, error: error.message, javascriptErrors: errors }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await api?.dispose();
  await runtime.stop();
}
