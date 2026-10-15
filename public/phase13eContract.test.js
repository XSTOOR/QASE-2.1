import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, markup] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./index.html', import.meta.url), 'utf8')
]);

const launcher = app.slice(app.indexOf('function syncQaSubmitState'), app.indexOf('/* ── Settings'));
const qaReport = app.slice(app.indexOf("const actions = document.createElement('div');", app.indexOf('function renderReport')), app.indexOf('function renderFilesSection'));

test('QA launch enablement includes URL, authorization, checks, configuration and pending state', () => {
	for (const contract of [
		'!urlValid', '!authorizationReady', 'selected === 0', '!matrixReady', "dataset.busy === 'true'"
	]) {
		assert.match(launcher, new RegExp(contract.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), contract);
	}
	// Merge resolution: the 2,000 cap is NOT a launch gate — Phase 2 batches
	// oversized selections on submit, so withinCap must not appear.
	assert.doesNotMatch(launcher, /!withinCap/);
	assert.match(launcher, /Confirm that you are authorized to test this site/);
	assert.match(launcher, /Browsers and devices could not be loaded/);
});

test('QA submission is single-flight and only closes after create succeeds', () => {
	assert.match(launcher, /if \(qaUi\.submit\.dataset\.busy === 'true'\) return/);
	const request = launcher.indexOf("await api('/qa-matrix-runs'");
	const close = launcher.indexOf('closeQaStart({ updateRoute: false });', request);
	assert.ok(request >= 0 && close > request, 'the dialog closes only after the authoritative create response');
});

test('created matrix run selects its first real session before entering the shared workspace', () => {
	assert.match(launcher, /async function waitForFirstMatrixSession/);
	assert.match(launcher, /const createdSessionId = await waitForFirstMatrixSession\(matrixRun\)/);
	assert.match(launcher, /await selectSession\(createdSessionId\)/);
});

test('#16159: the queued-configurations results board never auto-opens after launch', () => {
	// The launch path must not call openQaMatrixRunDialog — the live run
	// workspace (selected above) is the landing surface; the board stays
	// reachable through explicit user actions.
	const request = launcher.indexOf("await api('/qa-matrix-runs'");
	const tail = launcher.slice(request);
	assert.doesNotMatch(tail, /openQaMatrixRunDialog/, 'launch flow must not open the results board modal');
	assert.match(launcher, /QA run started/);
});

test('sidebar and main Start testing controls share one launcher implementation', () => {
	assert.match(app, /el\.newRun\.onclick = openQaStart/);
	assert.match(app, /\$\('sidebar-new-run'\)\.onclick = openQaStart/);
	assert.match(markup, /id="qa-matrix-retry"/);
});

test('customer report actions lead while developer artifacts stay in Advanced', () => {
	assert.match(qaReport, /actions\.append\(pdf, provideFeedback\)/);
	assert.match(qaReport, /developerActions\.className = 'report-developer-actions'/);
	assert.match(qaReport, /developerSummary\.textContent = 'Advanced \/ developer tools'/);
	assert.match(qaReport, /developerButtons\.append\(download, copy, copyFixes, downloadFixes\)/);
	assert.match(qaReport, /developerButtons\.append\(generate\)/);
	assert.doesNotMatch(qaReport, /actions\.append\(generate\)/);
});
