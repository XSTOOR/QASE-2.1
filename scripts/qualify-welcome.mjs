// Exercise the public sample and real sign-in UI with a signed-out API fixture.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { launchSqaTestBrowser } from './sqa-test-runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'test-results/welcome-redesign');
await mkdir(output, { recursive: true });
const app = express();
app.get('/api/auth/me', (_request, response) => response.status(401).json({ error: 'Signed-out fixture' }));
app.get('/api/pilot-status', (_request, response) => response.json({ pilot: false }));
app.use(express.static(path.join(root, 'public')));
const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
const base = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const browser = await launchSqaTestBrowser(name);
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      const errors = [], requests = [], failedAssets = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
      page.on('response', response => { if (response.status() >= 400) failedAssets.push(response.url()); });
      await page.goto(`${base}/welcome.html`);
      // WebKit's platform preference can skip links during plain Tab navigation.
      if (name === 'webkit') await page.locator('.skip').focus();
      else await page.keyboard.press('Tab');
      assert.equal(await page.locator('.skip').evaluate(el => el === document.activeElement), true, 'keyboard skip link is first');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#main').evaluate(el => el === document.activeElement), true, 'skip link moves focus to main');
      await page.locator('#motion-pause').waitFor({ state: 'visible' });
      await page.locator('#motion-pause').click();
      assert.equal(await page.locator('#motion-pause').textContent(), 'Resume');
      const pausedStage = await page.locator('#journey-demo').getAttribute('data-stage');
      await page.waitForTimeout(1100);
      assert.equal(await page.locator('#journey-demo').getAttribute('data-stage'), pausedStage, 'pause holds the sample');
      await page.locator('#motion-pause').click();
      await page.locator('#motion-pause').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#journey-demo').getAttribute('data-stage'), '3');
      await page.screenshot({ path: path.join(output, `${name}-desktop.png`), fullPage: true });
      await page.locator('#motion-replay').click();
      assert.equal(await page.locator('#motion-pause').isVisible(), true);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('#motion-replay').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#journey-demo').getAttribute('data-stage'), '3');

      await page.getByRole('button', { name: 'Healthy journey', exact: true }).click();
      assert.equal(await page.locator('#sample-outcome').textContent(), 'Passed assertion');
      await page.locator('#open-evidence').click();
      assert.equal(await page.locator('#evidence-result').textContent(), 'Passed assertion');
      assert.equal(await page.locator('#evidence-heading').textContent(), 'Pricing');
      assert.equal(await page.locator('#close-evidence').evaluate(el => el === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#evidence-dialog').isVisible(), false);
      assert.equal(await page.locator('#open-evidence').evaluate(el => el === document.activeElement), true);
      await page.getByRole('button', { name: 'Seeded defect', exact: true }).click();
      await page.locator('#open-evidence').click();
      assert.equal(await page.locator('#evidence-result').textContent(), 'Failed assertion');
      await page.screenshot({ path: path.join(output, `${name}-evidence.png`) });
      await page.locator('#close-evidence-bottom').click();

      for (const width of [900, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no overflow at ${width}px`);
        if (width === 390) {
          await page.screenshot({ path: path.join(output, `${name}-mobile.png`), fullPage: true });
          await page.locator('#open-evidence').click();
          assert.equal(await page.locator('#evidence-dialog').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'dialog fits mobile');
          await page.locator('#close-evidence').click();
        }
      }
      assert.deepEqual(failedAssets, [], 'public page assets load');
      assert.equal(requests.some(request => request.url.includes('/api/') || request.method !== 'GET'), false, 'sample never calls APIs or starts a run');
      assert.deepEqual(errors, [], 'public page JavaScript errors');

      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByRole('link', { name: 'Start testing', exact: false }).first().click();
      await page.locator('#auth-gate').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).hash, '#/runs/new', 'launcher destination survives sign-in gate');
      await page.getByRole('link', { name: 'QASE home', exact: true }).click();
      await page.locator('#hero-title').waitFor();

      const noJs = await browser.newContext({ javaScriptEnabled: false });
      const fallback = await noJs.newPage();
      await fallback.goto(`${base}/welcome.html`);
      assert.equal(await fallback.locator('#hero-title').isVisible(), true);
      assert.equal(await fallback.locator('.demo-finding').isVisible(), true, 'static sample available without JS');
      assert.equal(await fallback.getByRole('link', { name: 'Start testing', exact: false }).first().isVisible(), true);
      await noJs.close();
      if (process.env.QASE_WELCOME_LIVE_URL && name === 'chromium') {
        const live = await context.newPage();
        const liveErrors = [];
        live.on('pageerror', error => liveErrors.push(error.message));
        await live.goto(new URL('/welcome.html', process.env.QASE_WELCOME_LIVE_URL).href);
        await live.locator('#motion-pause').waitFor({ state: 'visible' });
        await live.getByRole('button', { name: 'Healthy journey', exact: true }).click();
        assert.equal(await live.locator('#sample-outcome').textContent(), 'Passed assertion');
        await live.getByRole('link', { name: 'Start testing', exact: false }).first().click();
        await live.waitForFunction(() => !document.getElementById('auth-gate')?.hidden || document.getElementById('qa-start')?.open);
        assert.equal(new URL(live.url()).hash, '#/runs/new');
        assert.deepEqual(liveErrors, [], 'actual server serves working scripts and launcher');
        await live.close();
        console.log('Actual local server: landing and launcher smoke passed');
      }
      results.push({ browser: name, version: browser.version(), result: 'passed', checks: ['pause/resume/replay', 'reduced motion', 'sample scenarios', 'evidence dialog and focus', '900/390/320px layouts', 'no sample API calls', 'authentication boundary', 'no-JS fallback'] });
      console.log(`${name}: welcome and sample checks passed`);
    } finally { await browser.close(); }
  }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ results }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
