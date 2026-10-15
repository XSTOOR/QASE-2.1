import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* UI Fix Phase 3 — source-contract tests: right-panel device card reads the
 * single view-model; sidebar has no Device Matrix/Environments primary
 * entry; Device Management lives under Settings; the dock chip reads the
 * store; Results targets run history. */

test('#13778 contract: one-click Run reuses an existing idle run instead of duplicating', async () => {
	// Phase D2 residual gap (was a WARN in the Phase 23 review): repeated Run
	// clicks piled up duplicate IDLE runs. The guard must stay in
	// startEnvironmentRun: check /sessions for an idle run on the env and
	// route to it rather than calling createQaRun again.
	const app = await readFile('public/app.js', 'utf8');
	const start = app.indexOf('async function startEnvironmentRun');
	const body = app.slice(start, app.indexOf('function openExecFallback', start));
	assert.ok(start >= 0, 'startEnvironmentRun must exist in app.js');
	assert.match(body, /sessions\?limit=20/, 'guard must query recent sessions');
	assert.match(body, /status === 'idle'/, 'guard must match idle runs');
	assert.match(body, /selectSession\(recent\.id\)/, 'guard must select the existing run');
	assert.match(body, /already waiting/, 'guard must explain via toast');
	// The reuse branch returns BEFORE createQaRun — createQaRun must appear
	// only after the guard block in the available branch.
	assert.ok(body.indexOf('return;') < body.indexOf('createQaRun'), 'guard must return before createQaRun');
});

test('#13778 contract: queued session auto-launches the run on promotion', async () => {
	// Phase D2 residual gap (was a WARN in the Phase 23 review): queue
	// reserved a session but no run was ever created. The wiring must stay:
	// pollQueuePanel detects queued→running and launches createQaRun.
	const app = await readFile('public/app.js', 'utf8');
	const start = app.indexOf('async function pollQueuePanel');
	const body = app.slice(start, app.indexOf('function hideQueuePanel', start));
	assert.ok(start >= 0, 'pollQueuePanel must exist in app.js');
	assert.match(body, /status === 'running' && !queuePanelState\.launched/, 'must detect queued→running promotion exactly once');
	assert.match(body, /createQaRun/, 'promotion must launch the QA run');
	// The queue fallback action must hand the session to the tracker so the
	// auto-launch wiring above actually runs.
	const fbStart = app.indexOf('async function applyFallback');
	const fbBody = app.slice(fbStart, app.indexOf('/* Queue panel', fbStart));
	assert.match(fbBody, /trackQueuePanel\(result\.session/, 'queue fallback must track the session for auto-launch');
});

test('#15643 contract: Advanced section is fully removed from the sidebar', async () => {
	// The whole Advanced disclosure (nav buttons, Feedback Inbox, theme,
	// account, sign-out, connection status) was removed from the left rail
	// by customer request. The rail keeps only brand, Start testing,
	// Recent tests and the run action row.
	const html = await readFile('public/index.html', 'utf8');
	const asideStart = html.indexOf('<aside class="panel runs"');
	const asideEnd = html.indexOf('</aside>', asideStart);
	const aside = html.slice(asideStart, asideEnd);
	assert.ok(asideStart >= 0, 'sidebar aside must exist');
	for (const removed of ['sidebar-tools', 'sidebar-nav', 'panel-foot', 'theme-select', 'conn-dot', 'conn-label', 'feedback-panel', 'feedback-restore']) {
		assert.ok(!aside.includes(removed), `sidebar must not contain ${removed}`);
	}
	assert.ok(!/\bid="(open-profile|sign-out)"/.test(aside), 'sidebar must not use the legacy open-profile/sign-out ids');
	// Device Management stays reachable from the Settings dialog.
	const settingsBlock = html.slice(html.indexOf('id="settings"'), html.indexOf('</dialog>', html.indexOf('id="settings"')));
	assert.match(settingsBlock, /id="open-device-matrix"/, 'open-device-matrix must live inside #settings');
	// The streamlined rail keeps its essentials.
	assert.match(aside, /id="sidebar-collapse-toggle"/);
	assert.match(aside, /id="sidebar-new-run"/);
	assert.match(aside, /id="run-list"/);
});

test('device details entry targets the Settings-hosted Device Management surface', async () => {
	// #14132 removed the CURRENT TEST DEVICE card; Device Management stays
	// reachable from Settings -> Device Management (deviceMatrix view wires
	// #open-device-matrix inside the #settings dialog).
	const app = await readFile('public/app.js', 'utf8');
	const html = await readFile('public/index.html', 'utf8');
	const settings = html.slice(html.indexOf('id="settings"'));
	assert.ok(settings.includes('id="open-device-matrix"'), 'open-device-matrix must live inside #settings');
	assert.match(app, /createDeviceMatrixView\(\{/, 'device matrix view must be wired');
});

test('dock chip reads the active selection via the store accessor, not drawer state', async () => {
	const drawer = await readFile('public/deviceDrawer.js', 'utf8');
	const paint = drawer.slice(drawer.indexOf('function paintChip'), drawer.indexOf('// ── Drawer sections'));
	assert.match(paint, /__qaseActiveSelection\?\.\(\)/);
	assert.ok(!/^\t\tconst envId = state\.defaultEnvId/m.test(paint), 'the store must be the first source');
	const app = await readFile('public/app.js', 'utf8');
	assert.match(app, /__qaseActiveSelection = \(\) => activeTestEnvStore\.get\(\)/);
});

test('chip execution label comes from requested/attested levels only (honest)', async () => {
	const drawer = await readFile('public/deviceDrawer.js', 'utf8');
	const paint = drawer.slice(drawer.indexOf('function paintChip'), drawer.indexOf('// ── Drawer sections'));
	assert.match(paint, /executionLevelRequested \?\? env\.runtimeAttestedLevel \?\? null/);
	assert.ok(!paint.includes('env.isRealDevice'), 'catalog isRealDevice must not drive the chip badge');
});

test('quick actions strip is removed (#14102); results live in run history via sidebar', async () => {
	const html = await readFile('public/index.html', 'utf8');
	assert.ok(!html.includes('id="quick-actions"'), 'quick actions strip must not render');
	assert.ok(!html.includes('id="choose-device"'), 'inline Choose Device strip must not render');
	assert.ok(!html.includes('qa-run-all') && !html.includes('qa-preset'), 'quick action chips must not render');
	const app = await readFile('public/app.js', 'utf8');
	assert.ok(!app.includes('quickActions.'), 'dead quick-actions controller must be gone');
});

test('Phase 13A sidebar collapse control is shared, accessible and persistent', async () => {
	const html = await readFile('public/index.html', 'utf8');
	assert.match(html, /id="sidebar-collapse-toggle"[^>]*aria-controls="workspace-runs"[^>]*aria-expanded="true"/);
	assert.match(html, /aria-label="Collapse recent tests sidebar"/);
	const mode = await readFile('public/studioMode.js', 'utf8');
	assert.match(mode, /sidebarPreferenceKey = 'qase\.sidebar'/);
	assert.match(mode, /localStorage\.setItem\(sidebarPreferenceKey/);
	const workspace = await readFile('public/studio-workspace.css', 'utf8');
	assert.match(workspace, /data-qase-sidebar="collapsed"/);
	assert.match(workspace, /grid-template-columns:\s*64px/);
});

test('runtime status vocabulary covers the agreed states via one map', async () => {
	const are = await readFile('public/activeRuntimeEnvironment.js', 'utf8');
	const fn = are.slice(are.indexOf('export function runtimeStatusFor'), are.indexOf('export function executionTypeFor'));
	for (const word of ['queued', 'connecting', 'running', 'completed', 'failed', 'device_unavailable']) {
		assert.ok(fn.includes(`'${word}'`), `runtimeStatusFor must produce '${word}'`);
	}
	// The right-panel renderer reads only this vocabulary.
	const app = await readFile('public/app.js', 'utf8');
	const header = app.slice(app.indexOf('function renderLiveDeviceViewHeader'), app.indexOf('/* Environment card'));
	for (const word of ['Preparing…', 'Connecting…', 'Connected', 'Running', 'Complete', 'Failed', 'Unavailable']) {
		assert.ok(header.includes(word), `live header must render '${word}'`);
	}
});
