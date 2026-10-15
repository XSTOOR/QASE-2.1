import test from 'node:test';
import assert from 'node:assert/strict';
import { attachBrowserBridge } from './browserBridge.js';
import { preflightSqaRuntime } from './sqaRuntime.js';
import { createSqaState } from './sqaService.js';
import { createSqaTools } from './sqaTools.js';

test('SQA iPad/WebKit can launch, exercise a workflow, and record real browser evidence', { timeout: 45_000 }, async () => {
  const environment = {
    envId: 'sqa-webkit-integration', platform: 'ipados', device: 'iPad Pro 12.9 (5th Gen)',
    browserCode: 'safari', browser: 'Safari', os: 'iPadOS', osVersion: '18.3',
    deviceType: 'tablet', executionProvider: 'local'
  };
  const engine = await preflightSqaRuntime({ environment });
  assert.equal(engine, 'webkit');
  const session = {
    id: 'sqa-webkit-regression', mode: 'sqa', engine, activities: [],
    sqa: createSqaState({ authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application', 'user_interface'],
      target: { name: 'Local workflow fixture', release: 'test', environment: 'integration' } })
  };
  const store = { async commit() {}, publish() {}, subscribe() { return () => {}; } };
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
    await page.setContent('<form><label>Name<input required name="name"></label><button>Save</button><output></output></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.querySelector("output").textContent="Saved: "+new FormData(e.target).get("name")}</script>');
    await page.getByRole('button', { name: 'Save' }).click();
    assert.equal(await page.locator('output').textContent(), '', 'empty required input is rejected');
    await page.getByLabel('Name').fill('SQA fixture');
    await page.getByRole('button', { name: 'Save' }).click();
    assert.equal(await page.locator('output').textContent(), 'Saved: SQA fixture');
    const facts = await bridge.readRuntimeFacts();
    assert.match(facts.userAgent, /AppleWebKit/);
    assert.equal(bridge.execution.level, 'SIMULATED', 'never claim this is physical Safari/iPad');
    session.activities.push({ id: 'verified-form', toolName: 'browser_snapshot', status: 'done', ts: Date.now(),
      summary: 'Verified required-field rejection and successful form submission in the local WebKit fixture.' });
    const record = createSqaTools(session, store).find(tool => tool.name === 'record_sqa_control');
    await record.run({ control_id: 'SQA-QUA-001', status: 'pass', evidence: [{ type: 'test_result',
      summary: 'Required name rejected when empty; submitting SQA fixture produced Saved: SQA fixture.' }] });
    assert.equal(session.sqa.observations[0].status, 'pass');
    assert.match(session.sqa.observations[0].evidence[0].reference, /activities\/verified-form\/evidence\//);
  } finally {
    bridge?.dispose?.();
    await service.browser?.close();
  }
});
