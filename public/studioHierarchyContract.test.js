import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [markup, app, workspaceStyles, embedStyles] = await Promise.all([
	readFile(new URL('./index.html', import.meta.url), 'utf8'),
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./studio-workspace.css', import.meta.url), 'utf8'),
	readFile(new URL('./studio-embed.css', import.meta.url), 'utf8')
]);

test('technical execution metadata is preserved behind a closed semantic disclosure', () => {
	assert.match(markup, /<details class="execution-details" id="execution-details" hidden>\s*<summary>Run details<\/summary>/);
	for (const id of ['run-env-current', 'run-env-execution', 'run-env-session', 'run-env-usage']) {
		assert.match(markup, new RegExp(`id="${id}"`));
	}
	assert.match(app, /details\.open = false/);
	assert.match(workspaceStyles, /#execution-target-block[\s\S]*display: none/);
});

test('running QA makes the browser primary and initially reveals the supporting plan', () => {
	assert.match(embedStyles, /data-run-status="running"[\s\S]*minmax\(480px, 1\.75fr\)/);
	assert.match(app, /function showRunningQaPlan\(\)[\s\S]*activateDetailTab\(\$\('tab-plan'\)\)/);
	assert.match(app, /state\.shownRunningPlan === session\.id/);
});

test('running header and current activity use clear customer language', () => {
	assert.match(app, /`Testing \$\{targetName\}`/);
	assert.match(app, /status === 'running' \? 'Running'/);
	assert.match(app, /currentActivityState\.textContent = label \|\| 'Working…'/);
	assert.match(workspaceStyles, /current-activity \.ca-label[\s\S]*text-transform: none/);
});

test('completed QA selects Findings for issues and Report for a clean run', () => {
	assert.match(app, /activateDetailTab\(\(session\.findings\?\.length \?\? 0\) > 0 \? \$\('tab-findings'\) : el\.reportTab\)/);
	assert.match(app, /STAGE_COLLAPSE_STATUSES = new Set\(\['done', 'error', 'interrupted', 'idle'\]\)/);
	assert.match(app, /state\.stageExpanded\.has\(state\.sessionId\)/);
});

test('finding and report hierarchy lead with user-facing evidence and action', () => {
	assert.ok(app.indexOf("stepsTitle.textContent = 'Reproduction'") < app.indexOf("evidenceTitle.textContent = 'Evidence'"));
	assert.ok(app.indexOf("section('Summary'") < app.indexOf("section('Recommended next action'"));
	assert.ok(app.indexOf("section('Recommended next action'") < app.indexOf('el.reportView.append(stats)'));
	assert.match(workspaceStyles, /\.report-section h3[\s\S]*text-transform: none/);
	assert.doesNotMatch(app, /finding\.classList\.toggle\('is-fixed'/);
});

test('empty Qase view keeps one primary launcher and routes composer URLs into setup', () => {
	assert.match(workspaceStyles, /\.empty-actions #empty-start \{ display: none/);
	assert.match(app, /if \(!state\.sessionId\) \{\s*await openQaStart\(\)/);
	assert.match(app, /qaUi\.targetUrl\.value = target\.href/);
});

test('tablet and mobile move directly to the primary execution surface', () => {
	assert.match(workspaceStyles, /min-width: 721px[\s\S]*data-run-status="running"[\s\S]*\.viewer \{ grid-row: 1; \}/);
	assert.match(app, /justStarted[\s\S]*setWorkspaceView\('browser'\)/);
	assert.match(app, /justCompleted[\s\S]*setWorkspaceView\('results'\)/);
});
