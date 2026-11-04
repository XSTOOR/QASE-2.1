import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planPresentation } from './planPresentation.js';

/* UI Fix Phase 1 — regression guards for the center tab workspace features
 * that are otherwise browser-verified only: plan status chips and the
 * report export bar. Source-contract tests (same pattern as the existing
 * server/*Ui.test.js suites). */

test('plan items carry readable status chips mapped to the run vocabulary', async () => {
	const app = await readFile('public/app.js', 'utf8');
	const renderTodos = app.slice(app.indexOf('function renderTodos'), app.indexOf('const SEVERITY_ORDER'));
	assert.match(renderTodos, /todo-chip/);
	for (const [status, label] of [['completed', 'Completed'], ['in_progress', 'Running'], ['failed', 'Failed'], ['blocked', 'Blocked']]) {
		assert.equal(planPresentation({ status }).label, label);
	}
	assert.equal(planPresentation({}).label, 'Queued');
	for (const disposition of ['not_tested', 'not_observed', 'partial', 'tested']) {
		const model = planPresentation({ status: 'completed', text: `Authentication — ${disposition}: Evidence` });
		assert.equal(model.key, disposition);
		assert.notEqual(model.label, 'Passed');
		if (disposition !== 'tested') assert.equal(model.mark, '—');
	}
	assert.match(renderTodos, /planPresentation\(todo\)/);
	// Chips are textContent-built (XSS-safe), never innerHTML.
	const chipBlock = renderTodos.slice(renderTodos.indexOf('todo-chip'), renderTodos.indexOf('todo-text'));
	assert.ok(!chipBlock.includes('innerHTML'), 'chip must not use innerHTML');
});

test('report tab exposes an Export report action only when a report exists', async () => {
	const app = await readFile('public/app.js', 'utf8');
	const renderReport = app.slice(app.indexOf('function renderReport()'), app.indexOf('function renderBugs'));
	assert.ok(renderReport.indexOf("if (!report)") < renderReport.indexOf('report-export-bar'), 'export bar must come after the no-report early return');
	assert.match(renderReport, /Export report/);
	assert.match(renderReport, /URL\.revokeObjectURL/);
	assert.match(renderReport, /application\/json/);
});

test('activity feed auto-scroll is unconditional after toggle removal (#14124)', async () => {
	const app = await readFile('public/app.js', 'utf8');
	const html = await readFile('public/index.html', 'utf8');
	assert.ok(!html.includes('activity-autoscroll'), 'toggle must not render in the tab bar');
	assert.ok(!app.includes('autoScrollState'), 'dead toggle state must be gone');
	const scrollFeed = app.slice(app.indexOf('function scrollFeed'), app.indexOf('function scrollFeed') + 400);
	assert.ok(!scrollFeed.includes('feedAutoScrolls'), 'scrollFeed must not gate on a removed toggle');
});
