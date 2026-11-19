import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { menuMotionFixture } from './fixtures/menu-motion.mjs';
import { assertSqaTestBrowser, launchSqaTestBrowser } from './sqa-test-runtime.mjs';
import { runJevBrowserCheck } from '../server/jevBrowserChecks.js';
import { createQaInputIsolation } from '../server/qaInputIsolation.js';

const { values } = parseArgs({ options: {
  python: { type: 'string' },
  browser: { type: 'string', multiple: true },
  'output-dir': { type: 'string' }
} });
const engines = [...new Set(values.browser ?? ['chromium', 'firefox', 'webkit'])];
engines.forEach(assertSqaTestBrowser);
const python = values.python ?? 'python';
if (values.python) process.env.QASE_OPENCV_PYTHON = path.resolve(values.python);
const output = path.resolve(values['output-dir'] ?? `test-results/redesign/opencv-menu-motion/${Date.now()}`);
const comparator = fileURLToPath(new URL('./compare-menu-motion-frames.py', import.meta.url));
const runProcess = promisify(execFile);
const viewport = { width: 960, height: 540 };
const frameKeys = new Map([
  ['Before opening', 'closed'], ['After first opening', 'first'], ['After second opening', 'second']
]);

async function capture(browser, engine, preference, variant) {
  const context = await browser.newContext({
    viewport, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: preference,
    offline: true, serviceWorkers: 'block'
  });
  try {
    const isolation = createQaInputIsolation();
    isolation.attach(context);
    const page = await context.newPage();
    await page.setContent(menuMotionFixture({ broken: variant === 'stuck-opacity', covered: variant === 'covered-menu' }));
    await page.evaluate(() => document.fonts.ready);
    const box = await page.locator('#main-menu').boundingBox();
    assert.ok(box, 'The fixture menu must occupy a measurable region.');
    const x = Math.floor(box.x), y = Math.floor(box.y);
    const region = [x, y, Math.ceil(box.x + box.width) - x, Math.ceil(box.y + box.height) - y];
    const frames = {};
    const result = await runJevBrowserCheck(page, { action: 'menu_motion' }, {
      menuMotion: { label: 'Main menu', url: page.url() },
      authorizeControl: selector => assert.equal(selector, '#menu-toggle'),
      protectInputs: current => isolation.protect(current),
      saveMotionFrame: async (bytes, phase) => {
        const key = frameKeys.get(phase);
        assert.ok(key);
        const filename = `${engine}-${preference}-${variant}-${key}.jpg`;
        await writeFile(path.join(output, filename), bytes);
        frames[key] = filename;
        return { artifactId: filename, capturedAt: new Date().toISOString() };
      }
    });
    assert.ok(result.success, result.error);
    const domOutcome = result.assertions[0]?.outcome;
    assert.equal(domOutcome, variant === 'stuck-opacity' ? 'fail' : 'pass', result.skipped ?? JSON.stringify(result.assertions));
    assert.equal(result.motion.screenshots.length, 3, 'Expected three captured frames.');
    if (variant !== 'stuck-opacity') {
      const expected = variant === 'covered-menu' ? 'fail' : 'pass';
      assert.equal(result.motion.visual.outcome, expected, JSON.stringify(result.motion.visual));
      assert.equal(result.assertions[1]?.outcome, expected);
    }
    return {
      variant, viewport: [viewport.width, viewport.height], region, frames, domOutcome,
      trials: result.motion.trials.map(({ visibleAtMs, finalOpacity }) => ({ visibleAtMs, finalOpacity }))
    };
  } finally {
    await context.close();
  }
}

await mkdir(path.dirname(output), { recursive: true });
await mkdir(output);
const groups = [];
for (const engine of engines) {
  const browser = await launchSqaTestBrowser(engine);
  try {
    for (const preference of ['no-preference', 'reduce']) {
      const reference = await capture(browser, engine, preference, 'reference');
      const healthy = await capture(browser, engine, preference, 'healthy');
      const stuck = await capture(browser, engine, preference, 'stuck-opacity');
      const covered = await capture(browser, engine, preference, 'covered-menu');
      const missing = { ...healthy, variant: 'missing-frame', frames: { ...healthy.frames, second: null } };
      groups.push({ engine, browserVersion: browser.version(), preference, reference, cases: [healthy, stuck, covered, missing] });
    }
  } finally {
    await browser.close();
  }
}

const manifest = path.join(output, 'capture-manifest.json');
await writeFile(manifest, JSON.stringify(groups, null, 2) + '\n');
const { stdout } = await runProcess(python, [comparator, manifest], { timeout: 30000, windowsHide: true });
const compared = JSON.parse(stdout);
assert.equal(compared.groups.length, groups.length);
const report = {
  scope: 'Controlled screenshot comparison of the settled menu. DOM/CSS measurements supply transition timing.',
  opencv: compared.opencv, numpy: compared.numpy, maxNormalizedError: compared.maxNormalizedError,
  groups: groups.map(({ engine, browserVersion, preference, cases }, index) => ({
    engine, browserVersion, preference, cases: cases.map(({ variant, domOutcome, frames }, caseIndex) => {
      const visual = compared.groups[index][caseIndex];
      assert.equal(visual.variant, variant);
      return { variant, domOutcome, ...visual, frames };
    })
  }))
};
await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
const expected = ['pass', 'fail', 'fail', 'inconclusive'];
for (const { engine, preference, cases } of report.groups) {
  console.log(`${engine} / ${preference}: ${cases.map(item => `${item.variant}=${item.outcome}`).join(', ')}`);
  assert.deepEqual(cases.map(item => item.outcome), expected, `${engine} / ${preference}: unexpected visual results`);
}
console.log(`Saved proof to ${path.join(output, 'result.json')}`);
