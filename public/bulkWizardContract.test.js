import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

/* Phase D6 (#13782) — source-contract tests for the bulk wizard's D6 spec
 * acceptance items: no Ctrl/Cmd-click hint; checkbox case list with Select
 * all / Clear all / live counter; step-3 summary shows per-device
 * availability before launch. */

test('#13782: no Ctrl/Cmd-click multi-select hint anywhere in the wizard', async () => {
	const html = await readFile('public/index.html', 'utf8');
	const start = html.indexOf('id="bulk-run"');
	const end = html.indexOf('</dialog>', start);
	assert.ok(start >= 0, '#bulk-run dialog must exist');
	const dialog = html.slice(start, end);
	assert.ok(!dialog.includes('Ctrl/Cmd'), 'bulk wizard must not hint Ctrl/Cmd-click');
	assert.ok(!dialog.includes('id="bulk-cases"'), 'legacy multi-select #bulk-cases must be gone');
	assert.ok(dialog.includes('id="bulk-case-list"'), 'checkbox case list must exist');
	assert.ok(dialog.includes('id="bulk-cases-all"') && dialog.includes('id="bulk-cases-none"'), 'Select all / Clear all must exist');
	assert.ok(dialog.includes('id="bulk-cases-count"'), 'live selected counter must exist');
	assert.ok(dialog.includes('id="bulk-availability"'), 'step-3 availability container must exist');
});

test('#13782: bulkRunView drives a checkbox list, not a multi-select', async () => {
	const src = await readFile('public/bulkRunView.js', 'utf8');
	assert.match(src, /chosenCases/, 'selection state must be a checkbox-driven Set');
	assert.match(src, /type = 'checkbox'/, 'cases render as checkboxes');
	assert.ok(!src.includes('casesSelect?.selectedOptions'), 'legacy selectedOptions path must be gone');
	assert.match(src, /renderAvailability/, 'per-device availability must render');
	assert.match(src, /setRuntimeBoardFetch/, 'availability must be wired to the runtime board');
});

test('#13782: availability rows are honest — status from the board, level labeled, per-device run counts', async () => {
	const src = await readFile('public/bulkRunView.js', 'utf8');
	const start = src.indexOf('function renderAvailability');
	const body = src.slice(start, src.indexOf('function setRuntimeBoardFetch', start) < 0 ? undefined : src.indexOf('let boardFetch', start));
	assert.ok(start >= 0, 'renderAvailability must exist');
	assert.match(body, /board\?\.status \?\? 'UNKNOWN'/, 'unknown board status must be labeled honestly');
	assert.match(body, /maximumLevel/, 'execution level must be shown');
	assert.match(body, /Busy — will queue/, 'busy devices must say they will queue');
	assert.match(body, /count \+= 1/, 'per-device run count must aggregate');
});
