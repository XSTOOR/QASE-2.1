/** Actual dashboard/SSE, disposable injected services. No live account/model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createApplication } from '../server/app.js';
import { hybridProfile } from '../server/hybridConfig.js';
import { prepareHostDecision } from '../server/hybridContinuation.js';

const session = { id: randomUUID(), title: 'Live preview fixture', mode: 'qa', qaExecutionMode: 'hybrid', status: 'running',
  targetUrl: 'https://fixture.test/', device: 'desktop', engine: 'chromium', createdAt: Date.now(), updatedAt: Date.now(), runStartedAt: Date.now(),
  environmentSnapshot: { device: 'Desktop', deviceType: 'desktop', platform: 'macos', browser: 'Chrome' },
  messages: [], activities: [], todos: [], findings: [], secretNames: [],
  hybrid: { counts: { planned: 2, passed: 0 }, scenarios: [{ id: 'nav', category: 'navigation', status: 'planned' }, { id: 'layout', category: 'responsive', status: 'planned' }] } };
const listeners = new Set(), streams = new Set();
const publish = (s, type, payload = {}) => { for (const listener of listeners) listener({ type, sessionId: s.id, ts: Date.now(), ...payload }); };
const config = { provider: 'custom', model: 'preview-fixture', ready: true, hasApiKey: true, providers: ['custom'], headless: true };
const services = {
  tenantContext: { organizationId: randomUUID(), projectId: randomUUID(), actorUserId: randomUUID(), actorEmail: 'fixture@example.test', actorName: 'Fixture owner' },
  runs: { load() {}, async create() { throw new Error('This fixture never creates user runs.'); }, get: id => id === session.id ? session : null, list: () => [session], async delete() { return false; },
    async commit(s, type, payload) { publish(s, type, payload); }, async addMessage() {}, async addActivity() {}, async updateActivity() {}, async setStatus() {} },
  events: { publish, async subscribe(_id, listener) { listeners.add(listener); return () => listeners.delete(listener); } },
  configuration: { getPublic: () => config, save: () => config, testConnection: async () => ({ ok: true }) },
  secrets: { names: () => [], clear() {}, store: () => [] }, reports: { buildMarkdown: () => '' },
  agent: { ensureRuntime() {}, async runTurn() { throw new Error('No model execution in the UI fixture.'); }, async closeBrowser() {}, stop() {}, getLiveState: () => ({ running: true }), invalidateIdleRuntimes: () => ({ kept: 1 }) },
  environments: { seed() {}, async list() { return []; }, async facets() { return { total: 0, devices: [], osVersions: [], browsers: [] }; }, async get() { return null; }, async availability() { return { available: 0, busy: 0 }; }, async catalogVersion() { return 'fixture'; } },
  feedback: { async create() {}, async get() { return null; }, async update() {}, async remove() {}, async forRun() { return null; }, async list() { return []; }, async stats() { return {}; } },
  bugs: { async list() { return []; } }, readiness: { check: async () => ({ ready: true }) }, lifecycle: { close: async () => {} }
};
const application = createApplication({ services, environment: { NODE_ENV: 'production' } });
const server = await new Promise(resolve => { const value = application.app.listen(0, '127.0.0.1', () => resolve(value)); });
server.on('request', (request, response) => { if (request.url.endsWith('/events')) streams.add(response); });
const browser = await chromium.launch(), base = `http://127.0.0.1:${server.address().port}`;
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/profile', route => route.fulfill({ json: { email: 'fixture@example.test', displayName: 'Fixture owner', profile: { timezone: 'Asia/Kolkata' } } }));
  await page.route('**/api/memory*', route => route.fulfill({ json: [] }));
  await page.goto(`${base}/#/runs/${session.id}`);
  await page.waitForFunction(() => document.querySelector('#status-chip')?.textContent === 'Running');
  const deadline = Date.now() + 3000;
  while (!listeners.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(listeners.size, 'Actual authenticated fixture SSE must be connected.');
  session.hybrid.counts = { passed: 1, planned: 1 }; session.hybrid.scenarios[0].status = 'passed';
  publish(session, 'hybrid.state', { hybrid: session.hybrid });
  await page.waitForFunction(() => document.querySelector('#progress-steps')?.textContent === '1/2');
  session.hybrid.scenarios[0].routeCounts = { attempted: 2, gaps: 1 };
  session.hybrid.inputTesting = { fieldsFilled: 2, casesExecuted: 8, negativeCases: 3, submissionExecuted: false };
  publish(session, 'hybrid.state', { hybrid: session.hybrid });
  await page.waitForFunction(() => document.querySelector('#progress-steps')?.textContent === '0/2' && document.querySelector('#plan-list')?.textContent.includes('navigation — partial'));
  assert.match(await page.locator('#plan-list').textContent(), /Live inputs: 2 field trials · 8 input cases · 3/);
  session.hybrid.scenarios[0].routeCounts.gaps = 0;
  publish(session, 'hybrid.state', { hybrid: session.hybrid });
  await page.waitForFunction(() => document.querySelector('#progress-steps')?.textContent === '1/2');
  publish(session, 'frame', { frame: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', mimeType: 'image/png', url: 'https://fixture.test/docs', title: 'Live docs', viewport: { width: 1440, height: 900 } } });
  await page.waitForFunction(() => document.querySelector('#browser-url')?.textContent === 'https://fixture.test/docs' && document.querySelector('#chrome-url')?.textContent === 'fixture.test');
  const selectedImage = await page.locator('#frame').getAttribute('src');
  const viewport = { phase: 'responsive_sample', primary: { width: 1440, height: 900 }, current: { width: 390, height: 900 }, restored: false };
  session.hybrid.viewport = viewport; publish(session, 'qa.viewport', { viewport });
  publish(session, 'frame', { frame: { base64: 'different-temporary-mobile-frame', mimeType: 'image/png', url: 'https://fixture.test/docs', viewport: viewport.current, viewportTesting: viewport } });
  await page.waitForFunction(() => document.querySelector('#viewport-test-status')?.textContent.includes('390px'));
  assert.equal(await page.locator('#frame').getAttribute('src'), selectedImage, 'Temporary mobile samples must not replace the selected-device preview.');
  session.hybrid.viewport = { ...viewport, phase: 'selected_device', current: viewport.primary, restored: true }; publish(session, 'qa.viewport', { viewport: session.hybrid.viewport });
  await page.waitForFunction(() => document.querySelector('#viewport-test-status')?.hidden === true);
  const activity = value => { const index = session.activities.findIndex(item => item.id === value.id); if (index < 0) session.activities.push(value); else session.activities[index] = value; publish(session, 'activity', { activity: value }); };
  activity({ id: 'outer', status: 'running', label: 'Tested observed routes', ts: Date.now() });
  activity({ id: 'child', status: 'running', label: 'Tested menu or accordion', detail: '#faq', ts: Date.now() });
  await page.waitForFunction(() => document.querySelector('#current-activity-state')?.textContent.includes('Tested menu or accordion'));
  activity({ id: 'child', status: 'done', label: 'Tested menu or accordion', ts: Date.now() });
  await page.waitForFunction(() => document.querySelector('#current-activity-state')?.textContent === 'Tested observed routes');
  session.hybrid.telemetry = { elapsedMs: 137706, browserActions: 18, reasoner: {}, classifier: {} };
  session.hybrid.status = 'paused'; session.hybrid.recovery = { resumeBlockedReason: 'usage_unverified' };
  session.status = 'interrupted';
  publish(session, 'hybrid.state', { hybrid: session.hybrid });
  publish(session, 'status', { status: 'interrupted', detail: 'HYBRID_USAGE_UNRESOLVED: classifier usage must be reconciled.' });
  await page.waitForFunction(() => document.querySelector('#resume-run')?.disabled && document.querySelector('#journey-run-title')?.textContent.includes('usage review'));
  assert.equal(await page.locator('#timer-chip').textContent(), '02:17');
  assert.match(await page.locator('#journey-run-description').textContent(), /reconciliation/);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#timer-chip')?.textContent === '02:17');
  assert.equal(await page.locator('#resume-run').isDisabled(), true);
  // Completing a run must preserve the route and selected tab on desktop/mobile.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    session.status = 'running'; session.hybrid.status = 'running'; session.hybrid.recovery = {};
    publish(session, 'hybrid.state', { hybrid: session.hybrid }); publish(session, 'status', { status: 'running' });
    await page.waitForFunction(() => document.querySelector('#status-chip')?.textContent === 'Running');
    const routeBefore = new URL(page.url()).hash;
    const workspaceBefore = await page.locator('body').getAttribute('data-workspace-view');
    const tabBefore = await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('id');
    session.status = 'done'; session.report = { verdict: 'partial', summary: 'Fixture scope remains untested.' };
    publish(session, 'report', { report: session.report }); publish(session, 'status', { status: 'done' });
    await page.waitForFunction(() => document.querySelector('#status-chip')?.textContent === 'Completed with gaps');
    assert.equal(new URL(page.url()).hash, routeBefore);
    assert.equal(await page.locator('body').getAttribute('data-workspace-view'), workspaceBefore);
    assert.equal(await page.locator('[role="tab"][aria-selected="true"]').first().getAttribute('id'), tabBefore);
    if (width === 390) {
      await page.locator('.workspace-mobile-nav button[data-workspace-view="results"]').click();
      await page.waitForURL(`**/#/runs/${session.id}/results`);
      await page.locator('#results-page-back').click();
      await page.waitForURL(`**/#/runs/${session.id}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#journey-run-action').click();
  await page.waitForURL(`**/#/runs/${session.id}/results`);
  await page.locator('#results-page-back').click();
  await page.waitForURL(`**/#/runs/${session.id}`);
  assert.equal(new URL(page.url()).hash, `#/runs/${session.id}`);
  // Completed-run restoration is a separate boot path from live completion.
  // Cover remembered, latest-run fallback, root re-entry and run refresh.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const remembered of [session.id, null, randomUUID()]) {
      await page.evaluate(id => { if (id) localStorage.setItem('qase.session', id); else localStorage.removeItem('qase.session'); }, remembered);
      await page.goto(base);
      await page.waitForURL(`**/#/runs/${session.id}`);
      await page.waitForFunction(() => document.body.dataset.page === 'run' && !document.body.dataset.pageLoading);
      assert.equal(await page.locator('body').getAttribute('data-workspace-view'), 'agent');
      await page.reload();
      await page.waitForFunction(() => document.body.dataset.page === 'run' && !document.body.dataset.pageLoading);
      assert.equal(new URL(page.url()).hash, `#/runs/${session.id}`);
      assert.notEqual(await page.locator('body').getAttribute('data-workspace-view'), 'results');
    }
    await page.goto(`${base}/?run=${session.id}`);
    await page.waitForURL(`**/#/runs/${session.id}`);
    await page.waitForFunction(() => document.body.dataset.page === 'run' && !document.body.dataset.pageLoading);
    if (width === 390) await page.locator('.workspace-mobile-nav button[data-workspace-view="results"]').click();
    else await page.locator('#journey-run-action').click();
    await page.waitForURL(`**/#/runs/${session.id}/results`);
    // An explicitly opened Results URL remains usable, including refresh.
    await page.reload();
    await page.waitForFunction(() => document.body.dataset.page === 'results' && !document.body.dataset.pageLoading);
    await page.locator('#results-page-back').click();
    await page.waitForURL(`**/#/runs/${session.id}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  assert.deepEqual(errors, []);
  session.qaExecutionMode = 'legacy'; delete session.hybrid; session.jev = {}; session.status = 'done'; session.report = { verdict: 'partial', summary: 'Fixture coverage gaps remain.' };
  session.todos = ['completed', 'tested', 'partial', 'not_tested', 'not_observed', 'tested', 'tested', 'tested', 'partial', 'partial', 'not_tested', 'completed', 'completed'].map(status => ({ status: 'completed', text: `Check — ${status}: Recorded evidence` }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#progress-steps')?.textContent === '7/13' && document.querySelector('#count-plan')?.textContent === '7/13');
  assert.match(await page.locator('#qa-agent-mode').textContent(), /JEV-only.*no Opus/);
  assert.deepEqual(errors, []);
  session.qaExecutionMode = 'hybrid'; session.hybrid = { authentication: { status: 'unrequested', required: true } };
  session.status = 'awaiting_input'; session.pendingQuestion = { question: 'Provide test account credentials securely or continue public-only?', credentialLike: true, options: ['Provide test account', 'Continue public-only'] };
  await page.reload();
  const credentialForm = page.locator('.cred-form'); await credentialForm.waitFor();
  await credentialForm.getByLabel('Username or email', { exact: true }).fill('fixture@example.invalid');
  await credentialForm.getByLabel('Password', { exact: true }).fill('fixture-password');
  assert.equal(await credentialForm.locator('input[type=checkbox]').evaluate(element => element.required), true);
  assert.equal(await credentialForm.getByLabel('One-time code or extra field').count(), 0);
  await credentialForm.locator('input[type=checkbox]').check();
  await credentialForm.getByLabel('Expected signed-in page URL').fill('https://outside.test/');
  const refused = page.waitForResponse(response => response.url().endsWith('/credentials') && response.status() === 400);
  await credentialForm.getByRole('button', { name: 'Store and continue' }).click(); await refused;
  assert.equal(await credentialForm.getByLabel('Password', { exact: true }).inputValue(), 'fixture-password', 'Validation failure must retain the secure question/form.');
  await credentialForm.getByRole('button', { name: 'Skip login' }).click();
  await credentialForm.waitFor({ state: 'detached' });
  assert.equal(session.hybrid.authentication.status, 'declined');
  assert.deepEqual(errors, []);
  // Host continuation decisions must remain normal option buttons, even
  // when access/account wording would otherwise select the credential form.
  session.ownerUserId = services.tenantContext.actorUserId;
  session.hybrid = { continuationPolicyVersion: 1, budgets: hybridProfile({ apiKey: 'fixture-key' }, {}).budgets,
    telemetry: { reasoner: { inputTokens: 190000 }, classifier: {}, elapsedMs: 1000 }, modelBudget: { roles: {} }, scenarios: [] };
  const decision = prepareHostDecision(session, { closing: true });
  session.pendingQuestion = { toolCallId: decision.id, ...decision.input, options: decision.input.options.map(label => ({ label })), hybridDecision: 'budget', credentialLike: false };
  session.status = 'awaiting_input'; await page.reload();
  await page.getByRole('button', { name: decision.input.options[0], exact: true }).waitFor();
  assert.equal(await page.locator('.cred-form').count(), 0);
  const choice = page.waitForResponse(response => response.url().endsWith('/answer') && response.status() === 200);
  await page.getByRole('button', { name: decision.input.options[0], exact: true }).click(); await choice;
  assert.equal(session.hybrid.budgets.reasonerTokens, 600000);
  assert.equal(session.hybrid.telemetry.reasoner.inputTokens, 190000);
  assert.equal(session.hybrid.budgetApprovals.length, 1);
  assert.equal(new URL(page.url()).hash, `#/runs/${session.id}`);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, liveProgress: true, chromeUrlUpdated: true, responsivePreviewStable: true, responsiveStatusClearedAfterRestore: true, nestedActivityUpdated: true, honestLegacyCoverage: true, explicitAgentIdentity: true,
    receiptRecoveryExplained: true, pausedTimerStableAfterReload: true, completionKeepsDesktopAndMobileView: true, explicitResultsNavigation: true,
    completedRunStartupAndRefreshStayOnRun: true, latestRunFallbackStaysOnRun: true, launchHandleStaysOnRun: true, explicitResultsRefreshPreserved: true,
    budgetContinuationOptionUsable: true, exactBudgetApprovalPreservesUsage: true, secureCredentialConsent: true, failedCredentialQuestionPreserved: true, publicOnlyDecisionRemembered: true, pageErrors: errors }));
} finally {
  for (const response of streams) if (!response.writableEnded) response.end();
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
