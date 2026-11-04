/** Real dashboard/catalog/UI; isolated memory services. No model or target runs. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.js';
import { buildQaConfigurations } from '../server/qaConfigurations.js';
import { launcherConfigurations } from './fixtures/launcher-catalog.mjs';

const environments = launcherConfigurations.map(row => ({ ...row, active: true, isRealDevice: false,
  executionLevel: 'SIMULATED', browserSupport: { engine: 'chromium', status: 'supported', provider: 'local-playwright' } }));
const configuration = { provider: 'custom', model: 'fixture-model', ready: true, hasApiKey: true, providers: ['custom'], headless: true,
  hybridQa: { enabled: true, qualified: true, available: true, reasoner: 'drytis/claude-opus-4.7', classifier: 'jev-1.13' } };
const noop = () => {};
const services = {
  tenantContext: { organizationId: randomUUID(), projectId: randomUUID(), actorUserId: randomUUID(), actorEmail: 'fixture@example.test', actorName: 'Launcher fixture' },
  runs: { load: noop, async list() { return []; }, async get() { return null; }, create() { throw new Error('No real fixture run may be created'); }, delete: noop, commit: noop, addMessage: noop, addActivity: noop, updateActivity: noop, setStatus: noop },
  feedback: { create: noop, get: noop, async list() { return []; }, update: noop, remove: noop, stats: () => ({}), forRun: noop },
  events: { publish: noop, subscribe: () => noop }, configuration: { getPublic: () => configuration, save: noop, testConnection: noop },
  secrets: { clear: noop, names: () => [], store: noop }, reports: { buildMarkdown: () => '' },
  agent: { ensureRuntime() { throw new Error('Model execution is forbidden in this fixture'); }, runTurn: noop, closeBrowser: noop, getLiveState: () => ({}), stop: noop, invalidateIdleRuntimes: noop },
  environments: { seed: noop, async list() { return environments; }, async get(id) { return environments.find(row => row.envId === id); },
    async facets() { return { total: environments.length, devices: [], osVersions: [], browsers: [] }; }, availability: () => ({}), catalogVersion: () => 'fixture' },
  readiness: { check: async () => ({ ready: true }) }, lifecycle: { close: noop }
};
const { app } = createApplication({ services, environment: { NODE_ENV: 'production' } });
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
const output = path.resolve('test-results', 'hybrid-launcher-ux'); fs.mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [], errors = [];
let metadata = true, failCatalog = false, unavailable = false, attemptedLaunch;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.addInitScript(() => sessionStorage.setItem('qase.qa.executionMode', 'legacy'));
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.route('**/api/profile', route => route.fulfill({ json: { email: 'fixture@example.test', displayName: 'Fixture', profile: { timezone: 'Asia/Kolkata' } } }));
  await page.route('**/api/memory*', route => route.fulfill({ json: [] }));
  await page.route('**/api/qa-configurations*', async route => {
    if (failCatalog) return route.fulfill({ status: 503, json: { error: 'Fixture browser catalog offline' } });
    const url = new URL(route.request().url());
    const rows = unavailable ? environments.map(row => ({ ...row, browserSupport: { status: 'not_supported', reason: 'Fixture offline' } })) : environments;
    const payload = await buildQaConfigurations({ environmentsService: { async list() { return rows; } }, index: url.searchParams.has('index'), limit: 200 });
    // Reproduce the exact previous wire contract: available compact rows
    // without the heavy browserSupport metadata or executionEngine field.
    if (!metadata && payload.index) for (const row of payload.index) delete row.executionEngine;
    return route.fulfill({ json: payload });
  });
  await page.route('**/api/sessions', route => {
    if (route.request().method() !== 'POST') return route.continue();
    attemptedLaunch = route.request().postDataJSON();
    return route.fulfill({ status: 400, json: { error: 'Fixture captured launch. No run was created.' } });
  });
  await page.goto(`${base}/#/runs/new`);
  await page.locator('#auth-gate').waitFor({ state: 'hidden' });
  await page.locator('#qa-start[open]').waitFor();
  await page.locator('#qa-target-url').fill('https://example.test/');
  await page.locator('#qa-goal').fill('Keep this focus while recovering browser details.');
  await page.locator('#journey-next').click();
  assert.equal(await page.locator('#qa-execution-mode').inputValue(), 'hybrid');
  assert.equal(await page.locator('select[name="qaExecutionMode"]').count(), 0);
  assert.match(await page.locator('#qa-selected-agent').textContent(), /Opus.*JEV/);
  checks.push('New QA runs use hybrid directly, without an agent selector');
  await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
  assert.match(await page.locator('#qa-browser-status-title').textContent(), /Chrome 140/);
  assert.match(await page.locator('#qa-browser-status-detail').textContent(), /not a physical device/);
  assert.equal(await page.locator('#journey-next').isEnabled(), true);
  checks.push('Actual compact catalog engine validates Focused hybrid selection; exact browser and emulation are visible');
  await page.screenshot({ path: path.join(output, 'desktop.png'), animations: 'disabled' });

  metadata = false;
  await page.locator('#qa-browser-status-action').click();
  // Change browser opens the real advanced controls without losing the URL.
  assert.equal(await page.locator('#qa-customize').evaluate(node => node.open), true);
  checks.push('Change browser opens customization directly');
  await page.locator('#qa-close').click();
  await page.locator('#new-run').click();
  await page.locator('#qa-start[open]').waitFor();
  assert.equal(await page.locator('#qa-execution-mode').inputValue(), 'hybrid');
  checks.push('Reopening the launcher keeps hybrid and ignores old agent preferences');
  await page.locator('#qa-target-url').fill('https://example.test/');
  await page.locator('#qa-goal').fill('Keep this focus while recovering browser details.');
  await page.locator('#journey-next').click();
  // Select the visible, observed configuration in the custom mode inherited
  // above. Metadata absence must not be mislabeled as browser unavailability.
  await page.locator('#qa-browser-status[data-state="blocked"]').waitFor();
  if ((await page.locator('#qa-browser-status-action').textContent()).includes('recommended')) {
    // For this stale-contract fixture retain the previously selected Chrome
    // by re-opening with the same stored custom selection instead of guessing.
    throw new Error('Stale metadata fixture unexpectedly lost its selected browser');
  }
  assert.match(await page.locator('#qa-browser-status-title').textContent(), /refresh/i);
  assert.equal(await page.locator('#journey-next').isDisabled(), true);
  assert.match(await page.locator('#journey-footer-hint').textContent(), /Refresh browser details/);
  metadata = true;
  await page.locator('#qa-browser-status-action').click();
  await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
  assert.equal(await page.locator('#qa-target-url').inputValue(), 'https://example.test/');
  assert.match(await page.locator('#qa-goal').inputValue(), /Keep this focus/);
  checks.push('Stale metadata has one-click refresh, preserves task input, and consistently gates Review');

  async function reopenCoverage() {
    await page.locator('#qa-close').click(); await page.locator('#new-run').click();
    await page.locator('#qa-start[open]').waitFor(); await page.locator('#journey-next').click();
  }
  failCatalog = true;
  await reopenCoverage();
  await page.locator('#qa-browser-status-title').filter({ hasText: 'Browser list could not load' }).waitFor();
  assert.equal(await page.locator('#journey-next').isDisabled(), true);
  failCatalog = false;
  await page.locator('#qa-browser-status-action').click();
  await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
  assert.match(await page.locator('#qa-goal').inputValue(), /Keep this focus/);
  checks.push('Catalog failure exposes a direct Retry action and recovers without losing input');

  unavailable = true;
  await reopenCoverage();
  await page.locator('#qa-browser-status-title').filter({ hasText: 'No supported browser is ready' }).waitFor();
  assert.equal(await page.locator('#journey-next').isDisabled(), true);
  unavailable = false;
  await page.locator('#qa-browser-status-action').click();
  await page.locator('#qa-browser-status[data-state="ready"]').waitFor();
  checks.push('Unavailable catalog never claims Ready and recovers through Refresh');

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#qa-browser-status').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop-dark.png'), animations: 'disabled' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#qa-customize').evaluate(node => { node.open = false; });
  await page.locator('#qa-browser-status').scrollIntoViewIfNeeded();
  const geometry = await page.locator('#qa-browser-status').evaluate(node => {
    const rect = node.getBoundingClientRect(), action = node.querySelector('button').getBoundingClientRect();
    return { left: rect.left, right: rect.right, actionWidth: action.width, actionHeight: action.height, pageOverflow: document.documentElement.scrollWidth > innerWidth };
  });
  assert.ok(geometry.left >= 0 && geometry.right <= 390); assert.equal(geometry.pageOverflow, false);
  assert.ok(geometry.actionWidth >= 40 && geometry.actionHeight >= 40);
  await page.screenshot({ path: path.join(output, 'mobile.png'), animations: 'disabled' });
  checks.push('390px mobile layout has no horizontal overflow and exposes a reachable browser action');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#journey-next').click();
  await page.locator('#qa-submit').waitFor({ state: 'visible' });
  assert.match(await page.locator('#journey-review-devices').textContent(), /Chrome 140/);
  assert.match(await page.locator('#journey-review-model').textContent(), /Opus.*JEV/);
  await page.locator('#qa-submit').click();
  await page.locator('#qa-form-error').filter({ hasText: 'Fixture captured launch' }).waitFor();
  assert.equal(attemptedLaunch.qaExecutionMode, 'hybrid'); assert.equal(attemptedLaunch.engine, 'chromium');
  assert.equal(attemptedLaunch.environmentId, 'fixture-chrome');
  checks.push('Review names the exact browser/models and dispatches explicit hybrid environment/engine through the session API');
  configuration.hybridQa.available = false; configuration.hybridQa.reason = 'Fixture qualification expired. Requalify the gateway.';
  await page.reload(); await page.locator('#qa-start[open]').waitFor();
  await page.locator('#qa-target-url').fill('https://example.test/'); await page.locator('#journey-next').click();
  assert.equal(await page.locator('#journey-next').isDisabled(), true);
  assert.match(await page.locator('#journey-footer-hint').textContent(), /qualification expired/);
  assert.equal(await page.locator('select[name="qaExecutionMode"]').count(), 0);
  checks.push('Unavailable hybrid is explained and blocked; it never falls back to another agent');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: true, fixtureOnly: true, modelCalls: 0, checks, pageErrors: errors }, null, 2));
  console.log(JSON.stringify({ passed: true, output, checks, modelCalls: 0 }, null, 2));
} finally { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
