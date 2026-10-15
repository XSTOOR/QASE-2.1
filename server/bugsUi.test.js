import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const bugsView = readFileSync(new URL('../public/bugsView.js', import.meta.url), 'utf8');
const bugsStyles = readFileSync(new URL('../public/bugsView.css', import.meta.url), 'utf8');

test('the bugs view is a standalone section launched from the feature dock', () => {
	assert.match(html, /<section class="bugs-view" id="bugs-view" hidden aria-labelledby="bugs-title">/);
	assert.match(html, /id="open-bugs"[^>]+aria-label="Open the bug tracker"/);
	assert.match(html, /id="open-bugs"[^>]+data-feature="bugs"/);
	assert.equal((html.match(/id="bugs-view"/g) ?? []).length, 1);
	// The section lives outside the three-panel .app container.
	const sectionAt = html.indexOf('id="bugs-view"');
	const appAt = html.indexOf('class="app"');
	const appClose = html.indexOf('</div>', html.indexOf('feature-dock'));
	assert.ok(appAt < sectionAt && sectionAt > appClose, 'bugs view is a sibling of .app, not inside it');
});

test('bugs view exposes accessible filter groups, search, and table structure', () => {
	assert.match(html, /aria-label="Filter by status"[^>]*id="bugs-status-filter"/);
	assert.match(html, /aria-label="Filter by severity"[^>]*id="bugs-severity-filter"/);
	for (const status of ['open', 'in_progress', 'fixed', 'wont_fix']) {
		assert.match(html, new RegExp(`data-status="${status}"[^>]*aria-pressed="false"`));
	}
	for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
		assert.match(html, new RegExp(`data-severity="${severity}"`));
	}
	assert.match(html, /id="bugs-search-input"[^>]*type="search"/);
	assert.match(html, /<table class="bugs-table"/);
	for (const column of ['Severity', 'Status', 'Bug', 'Run', 'Page', 'Found']) {
		assert.ok(
			new RegExp(`<th scope="col"[^>]*>${column}</th>`).test(html),
			`missing table column ${column}`
		);
	}
	assert.match(html, /id="bugs-empty"[^>]+hidden/);
	assert.match(html, /id="bugs-summary"[^>]+role="status"[^>]+aria-live="polite"/);
});

test('the app wires the view toggle, live refresh, and run navigation', () => {
	assert.match(app, /import \{ createBugsView \} from '\.\/bugsView\.js';/);
	assert.match(app, /setBugsViewOpen/);
	assert.match(app, /if \(state\.bugsViewOpen\) bugsView\.scheduleRefresh\(\);/);
	// Opening a run from the table closes the bugs view first.
	assert.match(app, /openRun: runId => \{\s*\n\s*setBugsViewOpen\(false\);\s*\n\s*void selectSession\(runId\);/);
	assert.match(app, /bugsViewOpen: false/);
});

test('status changes are optimistic with rollback, and statuses use the tracked lifecycle', () => {
	assert.match(bugsView, /BUG_STATUS_LABELS/);
	assert.match(bugsView, /method: 'PATCH'/);
	assert.match(bugsView, /JSON\.stringify\(\{ status \}\)/);
	// Rollback restores the previous status on failure.
	assert.match(bugsView, /row\.status = previous;/);
	assert.match(bugsView, /select\.value = previous;/);
});

test('bugs styles use only the established token palette', () => {
	const colorLiterals = [...bugsStyles.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(match => match[0]);
	const allowed = new Set(['#a4d4f3', '#f0c98a', '#93e2ba', '#f5a0be', '#f5a1a5']);
	for (const literal of colorLiterals) {
		assert.ok(allowed.has(literal), `unexpected raw color ${literal} — use a design token`);
	}
	assert.match(bugsStyles, /var\(--accent\)/);
	assert.match(bugsStyles, /var\(--surface-1\)/);
	assert.match(bugsStyles, /var\(--radius-lg\)/);
	assert.match(bugsStyles, /font-variant-numeric: tabular-nums/);
});

test('search is debounced and refresh is coalesced', () => {
	assert.match(bugsView, /setTimeout\(\(\) => \{/);
	assert.match(bugsView, /REFRESH_COALESCE_MS/);
	assert.match(bugsView, /if \(refreshTimer\) return;/);
});

test('the bugs view stylesheet is linked and the dashboard hides while open', () => {
	assert.match(html, /<link rel="stylesheet" href="bugsView\.css(\?v=[\w-]+)?">/);
	assert.match(bugsStyles, /\.app\.is-hidden \{\s*\n\s*display: none;/);
	assert.match(app, /classList\.toggle\('is-hidden', open\)/);
});
