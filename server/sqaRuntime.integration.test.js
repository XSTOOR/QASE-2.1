import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserBridge } from './browserBridge.js';
import { preflightSqaRuntime } from './sqaRuntime.js';
import { createSqaState, recordSqaSmokeActivity } from './sqaService.js';
import { createSqaTools } from './sqaTools.js';
import { inspectSqaEvidence } from './sqaEvidence.js';

for (const [browserCode, expectedEngine] of [['chrome', 'chromium'], ['firefox', 'firefox'], ['safari', 'webkit']]) {
test(`SQA ${expectedEngine} can launch, exercise a workflow, and record verifiable browser evidence`, { timeout: 45_000 }, async () => {
  const environment = browserCode === 'safari' ? {
    envId: 'sqa-webkit-integration', platform: 'ipados', device: 'iPad Pro 12.9 (5th Gen)',
    browserCode: 'safari', browser: 'Safari', os: 'iPadOS', osVersion: '18.3',
    deviceType: 'tablet', executionProvider: 'local'
  } : { envId: `sqa-${expectedEngine}-integration`, platform: 'desktop', browserCode, browser: browserCode === 'chrome' ? 'Chrome' : 'Firefox', os: 'Windows', deviceType: 'desktop', executionProvider: 'local' };
  const engine = await preflightSqaRuntime({ environment });
  assert.equal(engine, expectedEngine);
  const session = {
    id: `sqa-${expectedEngine}-regression`, mode: 'sqa', engine, activities: [],
    sqa: createSqaState({ authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application', 'user_interface'],
      target: { name: 'Local workflow fixture', release: 'test', environment: 'integration' } })
  };
  const store = { async commit() {}, publish() {}, subscribe() { return () => {}; },
    async updateActivity(run, id, patch) { Object.assign(run.activities.find(activity => activity.id === id), patch); }
  };
  const service = {
    options: { headless: true },
    pages() { return this.context?.pages() ?? []; },
    async ensureContext() { throw new Error('The bridge must provide the selected engine.'); },
    async ensurePage() { return this.activePage ??= await (await this.ensureContext()).newPage(); },
    registerPage(page) { this.activePage = page; },
    async snapshot() { return { elements: [] }; }, async getDiagnostics() { return {}; },
    async locator(page) { return page.locator('body'); }, async fill() {}, async typeText() {},
    async suspend() {}, async restoreSession() {}
  };
  let bridge;
  try {
    bridge = await attachBrowserBridge(session, service, store, { environment });
    const page = await service.ensurePage();
    await page.setContent(`<form><label>Work email<input required type="email"></label><button>Validate</button><output></output></form>
      <script>const form = document.querySelector('form'), output = form.querySelector('output');
        const events = window.formEvents = [];
        form.addEventListener('invalid', event => { events.push(['invalid', event.isTrusted]); }, true);
        form.oninput = () => { output.textContent = ''; };
        form.onsubmit = event => { event.preventDefault(); events.push(['submit', event.isTrusted]); output.textContent = 'Email accepted locally'; };
      </script>`);
    const result = await bridge.sqaSmoke({ action: 'form_validation' });
    assert.equal(result.success, true, result.error);
    assert.equal(result.cases.length, 4);
    assert.equal(result.cases[1].submissionBlocked, true);
    assert.equal(result.cases[2].statusSignals[0].text, 'Email accepted locally');
    assert.equal(result.staleSuccessSignalAfterInvalid, false);
    assert.deepEqual(await page.evaluate(() => window.formEvents), [
      ['invalid', true], ['invalid', true], ['submit', true], ['invalid', true]
    ]);
    const facts = await bridge.readRuntimeFacts();
    assert.match(facts.userAgent, expectedEngine === 'firefox' ? /Firefox\// : expectedEngine === 'chromium' ? /Chrome\// : /AppleWebKit/);
    assert.equal(bridge.execution.level, 'SIMULATED', 'never claim this is physical Safari/iPad');
    session.activities.push({ id: 'verified-form', toolName: 'browser_sqa_smoke', status: 'running', ts: Date.now(), input: { action: 'form_validation' } });
    await recordSqaSmokeActivity(session, 'verified-form', result, { status: 'done' }, store);
    const record = createSqaTools(session, store).find(tool => tool.name === 'record_sqa_control');
    const observation = await record.run({ control_id: 'SQA-WEB-003', status: 'pass', evidence: [{ type: 'test_result',
      summary: 'Invalid email was rejected, a corrected email received local feedback, and invalid input cleared that feedback.' }] });
    assert.equal(observation.success, true, observation.error);
    assert.equal(session.sqa.observations[0].status, 'pass');
    assert.match(session.sqa.observations[0].evidence[0].reference, /activities\/verified-form\/evidence\//);
    assert.equal(inspectSqaEvidence(session, 'SQA-WEB-003', 1).integrity, 'verified');
  } finally {
    bridge?.dispose?.();
    await service.browser?.close();
  }
});
}
