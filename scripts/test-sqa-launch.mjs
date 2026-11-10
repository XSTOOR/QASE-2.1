import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { assertSqaTestBrowser, createSqaTestServer, launchSqaTestBrowser } from './sqa-test-runtime.mjs';

const { values } = parseArgs({ options: { browser: { type: 'string', default: 'chromium' }, 'output-dir': { type: 'string' } } });
const browserName = assertSqaTestBrowser(values.browser);
const directory = path.resolve(values['output-dir'] ?? `test-results/sqa-launch/${Date.now()}`);
await mkdir(directory, { recursive: true });
const runtime = await createSqaTestServer(directory, { authRequired: true });
let browser, releaseEnvironment;
try {
  await runtime.start();
  browser = await launchSqaTestBrowser(browserName);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const registered = await context.request.post(`${runtime.base}/api/auth/register`, { data: {
    email: `sqa-launch-${Date.now()}@local.example`, password: 'Local SQA launcher regression 2026', displayName: 'SQA launch fixture'
  } });
  assert.equal(registered.status(), 201);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Use a configured-looking UI without any provider key. Only the explicit
  // launch message is intercepted; assessment creation uses the real API.
  await page.route('**/api/config', route => route.fulfill({ json: { provider: 'custom', model: 'launch-fixture', ready: true, hasApiKey: true, providers: ['custom'], headless: true } }));
  let launchDispatches = 0, authorizeLaunch = false;
  await page.route('**/api/sessions/*/message', async route => {
    assert.equal(authorizeLaunch, true, 'Startup must never dispatch a model turn');
    assert.equal(route.request().postDataJSON().text, 'https://example.test/');
    launchDispatches++;
    await route.fulfill({ json: { accepted: true } });
  });
  async function openSqa() {
    await page.waitForFunction(() => document.body.dataset.page && !document.body.dataset.pageLoading);
    if (await page.locator('#qa-start').isVisible()) await page.locator('#qa-close').click();
    await page.locator('#new-sqa').click();
    await page.locator('#sqa-catalog-state').waitFor({ state: 'hidden' });
  }
  async function completeDetails() {
    await page.locator('#sqa-target-url').fill('https://example.test/');
    await page.locator('#sqa-customize').evaluate(node => { node.open = true; });
    await page.locator('#sqa-target-release').fill('launch-regression');
    await page.locator('#sqa-target-environment').fill('local');
    await page.locator('#sqa-authorization').check();
  }
  await page.goto(runtime.base);
  await openSqa();
  await completeDetails();
  // Explicit device selection remains available after a supported default.
  await page.locator('#sqa-start [data-test-on-change]').click();
  await page.locator('#mx-sidebar .mx-device-name').filter({ hasText: /^iPad \(10th Gen\)$/ }).first().click();
  await page.locator('#mx-columns').getByRole('group', { name: 'Edge versions', exact: true }).locator('.mx-version').first().click();
  assert.equal(await page.locator('#mx-target-url').isHidden(), true, 'SQA already has its own target field');
  await page.getByRole('button', { name: 'Continue to quality review' }).click();
  assert.equal(await page.locator('#device-picker').isHidden(), true);
  assert.equal(await page.locator('#sqa-target-url').inputValue(), 'https://example.test/');
  assert.match(await page.locator('#sqa-test-on').innerText(), /iPad \(10th Gen\)[\s\S]*Edge/);
  assert.equal(launchDispatches, 0, 'Continuing from the picker only returns to the form');
  assert.equal(await page.locator('#sqa-submit').isDisabled(), false);
  await page.locator('#sqa-target-url').fill('not-a-url');
  assert.equal(await page.locator('#sqa-submit').isDisabled(), true);
  assert.match(await page.locator('#sqa-launch-status').innerText(), /HTTP or HTTPS/);
  await page.locator('#sqa-target-url').fill('https://example.test/');
  await page.locator('#sqa-target-release').fill('');
  await page.locator('#sqa-target-environment').fill('');
  assert.equal(await page.locator('#sqa-submit').isDisabled(), false, 'Unknown release/environment must not block a review');
  await page.locator('#sqa-target-release').fill('launch-regression');

  const gate = new Promise(resolve => { releaseEnvironment = resolve; });
  await page.route(url => url.pathname === '/api/environments', async route => { await gate; await route.continue(); });
  await page.reload();
  await openSqa();
  await completeDetails();
  assert.equal(await page.locator('#sqa-submit').isDisabled(), true);
  releaseEnvironment();
  await page.waitForFunction(() => document.querySelector('#sqa-test-on').dataset.empty !== 'true');
  assert.equal(await page.locator('#sqa-submit').isDisabled(), false, 'Restoring a saved device must refresh launch readiness');
  assert.equal(await page.locator('#sqa-launch-status').innerText(), 'Ready to start the quality review.');
  await page.locator('#sqa-authorization').uncheck();
  assert.equal(await page.locator('#sqa-submit').isDisabled(), true);
  assert.match(await page.locator('#sqa-launch-status').innerText(), /testing permission/);
  await page.locator('#sqa-authorization').check();
  await page.screenshot({ path: `${directory}/desktop-ready.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const statusBox = await page.locator('#sqa-launch-status').boundingBox();
  const startBox = await page.locator('#sqa-submit').boundingBox();
  assert.ok(statusBox && startBox && statusBox.y + statusBox.height <= startBox.y, 'Mobile launch guidance must have its own row above the buttons');
  await page.screenshot({ path: `${directory}/mobile-ready.png` });
  assert.equal(launchDispatches, 0);
  const createdResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/sqa/sessions' && response.request().method() === 'POST');
  const dispatchedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/message') && response.request().method() === 'POST')
    .then(response => ({ response }), error => ({ error }));
  authorizeLaunch = true;
  await page.locator('#sqa-submit').click();
  const response = await createdResponse;
  assert.equal(response.status(), 201, await response.text());
  const created = await response.json();
  assert.equal(created.mode, 'sqa');
  assert.equal(created.sqa.scope.target.release, 'launch-regression');
  assert.equal(created.environmentSnapshot.device, 'iPad (10th Gen)');
  assert.equal(created.environmentSnapshot.browserCode, 'edge');
  await page.waitForURL(`**/#/runs/${created.id}`);
  await page.waitForFunction(() => !document.querySelector('#sqa-start').open);
  const dispatched = await dispatchedResponse;
  if (dispatched.error) throw dispatched.error;
  assert.equal(new URL(dispatched.response.url()).pathname, `/api/sessions/${created.id}/message`);
  assert.equal(launchDispatches, 1);
  assert.deepEqual(errors, []);
  const result = { browser: browserName, browserVersion: browser.version(), launcher: 'passed', delayedDeviceRestore: 'passed', explicitStart: 'passed', desktop: 'passed', mobile: 'passed', launchDispatches, modelCalls: 0, javascriptErrors: errors };
  await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { releaseEnvironment?.(); await browser?.close(); await runtime.stop(); }
