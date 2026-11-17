import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { checkPrimaryViewport, responsiveWidths } from './qaViewport.js';
import { runJevBrowserCheck } from './jevBrowserChecks.js';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { hybridCompletion } from './qaCompletionGate.js';

test('responsive matrix starts at the selected device and includes bounded breakpoint edges without changing legacy sampling', () => {
  assert.deepEqual(responsiveWidths({ width: 1440 }, true), [1440, 389, 390, 391, 767, 768, 769]);
  assert.deepEqual(responsiveWidths({ width: 1440 }), [390, 768, 1440]);
  assert.equal(new Set(responsiveWidths({ width: 390 }, true)).size, 6);
});

test('host viewport drift fails before another action, without silently redefining the primary device', async () => {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', selectedTests: ['responsive'], targetUrl: 'https://fixture.test/', messages: [], findings: [] };
  let current = { width: 1440, height: 900 }, dispatched = 0;
  const page = { isClosed: () => false, viewportSize: () => current };
  const runtime = createHybridRuntime({ session, profile: hybridProfile({ apiKey: 'fixture' }, {}), runStore: { async commit() {} }, record: { bridge: { service: { activePage: page }, async authorizeHybridAction() {} } } });
  const tool = runtime.wrapTool({ name: 'browser_open', async run() { dispatched++; return { success: true }; } });
  await tool.run({ url: session.targetUrl });
  current = { width: 390, height: 900 };
  await assert.rejects(tool.run({ url: session.targetUrl }), error => error.code === 'HYBRID_VIEWPORT_DRIFT');
  assert.equal(dispatched, 1); assert.deepEqual(session.hybrid.viewport.primary, { width: 1440, height: 900 });
  assert.equal(session.hybrid.recovery.verificationRequired, true);
  assert.ok(checkPrimaryViewport(session, page));
});

test('a successful tool receipt in the wrong viewport cannot become evidence or a passed assertion', async () => {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', selectedTests: ['responsive'], targetUrl: 'https://fixture.test/', messages: [], findings: [] };
  let current = { width: 1440, height: 900 };
  const runtime = createHybridRuntime({ session, profile: hybridProfile({ apiKey: 'fixture' }, {}), runStore: { async commit() {} }, record: { bridge: { service: { activePage: { isClosed: () => false, viewportSize: () => current } }, async authorizeHybridAction() {} } } });
  const scenario = session.hybrid.scenarios[0]; await runtime.ledger.start(scenario.id);
  const tool = runtime.wrapTool({ name: 'browser_qa_check', async run() { current = { width: 390, height: 900 }; return { success: true, assertions: [{ check: 'responsive', name: 'Unsupported restoration pass', outcome: 'pass', expected: 'Selected viewport', actual: 'Wrong viewport' }] }; } });
  await assert.rejects(tool.run({ action: 'responsive' }), error => error.code === 'HYBRID_VIEWPORT_DRIFT');
  assert.equal(session.hybrid.actions.at(-1).status, 'uncertain');
  assert.equal(scenario.assertions.length, 0); assert.equal(session.hybrid.evidence.length, 0);
  session.hybrid.viewport.phase = 'restore_failed'; session.hybrid.viewport.restored = false;
  assert.ok(hybridCompletion(session).gaps.some(gap => /viewport has not been verified restored/.test(gap)));
});

test('responsive edge sampling restores selected viewport, scroll and focus, including cancellation', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent('<title>Viewport fixture</title><div style="height:1000px">Top</div><input id="original" aria-label="Original focus"><div style="height:1400px">Bottom</div>');
  await page.locator('#original').focus(); await page.evaluate(() => scrollTo(0, 900));
  const phases = [];
  const result = await runJevBrowserCheck(page, { action: 'responsive' }, { responsiveBoundaries: true, onViewport: value => phases.push(value) });
  assert.equal(result.success, true, result.error);
  assert.deepEqual(result.measurements.map(item => item.width), [1440, 389, 390, 391, 767, 768, 769]);
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
  assert.deepEqual(await page.evaluate(() => ({ y: scrollY, focus: document.activeElement.id })), { y: 900, focus: 'original' });
  assert.equal(phases.at(-1).phase, 'selected_device'); assert.equal(phases.at(-1).restored, true);
  const controller = new AbortController(), cancelledSamples = [];
  await assert.rejects(runJevBrowserCheck(page, { action: 'responsive' }, { signal: controller.signal, responsiveBoundaries: true,
    onViewport(value) { cancelledSamples.push(value); if (value.phase === 'responsive_sample' && value.current.width === 390) controller.abort(new Error('Cancel sample')); } }), /Cancel sample/);
  assert.equal(cancelledSamples.at(-1).phase, 'selected_device');
  assert.ok(!cancelledSamples.some(item => item.phase === 'responsive_sample' && item.current.width === 391));
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
  assert.equal(await page.evaluate(() => scrollY), 900);
});

test('responsive checks reproduce a cropped mobile control without flagging a carousel or hidden controls', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(`<!doctype html><title>Responsive clipping</title>
    <style>
      .row { width: 360px; white-space: nowrap; }
      .row button { margin-left: 200px; width: 140px; }
      .crop { overflow: hidden; }
      .carousel { width: 250px; overflow-x: auto; }
      .offscreen button { margin-left: 370px; }
      @media (max-width: 400px) { .crop { width: 250px; } }
    </style>
    <main><h1>Settings</h1>
      <div class="row crop"><div><button>Save preferences</button></div></div>
      <div class="row carousel"><button>Next slide</button></div>
      <div class="row crop offscreen"><button>Off-canvas control</button></div>
      <div class="row crop" inert><button>Inactive control</button></div>
    </main>`);
  const result = await runJevBrowserCheck(page, { action: 'responsive' });
  assert.equal(result.success, true, result.error);
  assert.ok(result.assertions.filter(item => /document overflow/.test(item.name)).every(item => item.outcome === 'pass'));
  const failures = result.assertions.filter(item => item.outcome === 'fail');
  assert.equal(failures.length, 1, JSON.stringify(result.assertions));
  const [failure] = failures;
  assert.match(failure.name, /390px/);
  assert.equal(failure.reproduction?.confirmed, true);
  const clipped = JSON.parse(failure.actual);
  assert.deepEqual(clipped.map(item => item.label), ['Save preferences']);
  assert.equal(clipped[0].cause, 'container');
  assert.ok(clipped[0].clipRight < (clipped[0].left + clipped[0].right) / 2);
  assert.deepEqual(page.viewportSize(), { width: 1440, height: 900 });
});

test('failed viewport restoration cannot return a successful responsive result', { timeout: 30000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent('<title>Restore failure</title><p>Read-only fixture</p>');
  const resize = page.setViewportSize.bind(page); let changed = false; const phases = [];
  page.setViewportSize = async value => { if (changed && value.width === 1440) throw new Error('Fixture restoration failure'); if (value.width !== 1440) changed = true; return resize(value); };
  const result = await runJevBrowserCheck(page, { action: 'responsive' }, { responsiveBoundaries: true, onViewport: value => phases.push(value) });
  assert.equal(result.success, false); assert.match(result.error, /restoration failure/);
  assert.equal(phases.at(-1).phase, 'restore_failed'); assert.equal(phases.at(-1).restored, false);
});

test('native click success does not conceal a reproduced keyboard activation failure', { timeout: 15000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close()); const page = await browser.newPage();
  await page.setContent('<title>Keyboard edge</title><button id="toggle" aria-expanded="false" aria-controls="panel" onkeydown="event.preventDefault()" onclick="const open=this.getAttribute(\'aria-expanded\')!==\'true\';this.setAttribute(\'aria-expanded\',String(open));panel.hidden=!open">FAQ</button><section id="panel" hidden>Answer</section>');
  const result = await runJevBrowserCheck(page, { action: 'disclosure', selector: '#toggle', restore: true });
  assert.equal(result.success, true, result.error); assert.equal(result.assertions[0].outcome, 'pass');
  const failure = result.assertions.find(item => item.reproduction?.kind === 'keyboard-disclosure');
  assert.equal(failure.outcome, 'fail'); assert.equal(failure.reproduction.confirmed, true);
  assert.equal(await page.locator('#toggle').getAttribute('aria-expanded'), 'false');
});
