import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { previewCollapsed } from '../public/previewLayout.js';

const app = await readFile('public/app.js', 'utf8');
const html = await readFile('public/index.html', 'utf8');
const styles = await readFile('public/styles.css', 'utf8');

const STAGE_BLOCK = /\/\* ── Post-run layout[\s\S]*?function toggleStageCollapse\(\) \{[\s\S]*?\n\}/;

test('post-run stage collapse block exists in the frontend source', () => {
	assert.match(app, STAGE_BLOCK);
});

test('terminal statuses default to compact preview while live runs stay expanded', () => {
 for (const status of ['done', 'error', 'interrupted', 'idle', 'cancelled']) assert.equal(previewCollapsed({ available: true, status, hasSession: true }), true);
 for (const status of ['running', 'awaiting_input']) assert.equal(previewCollapsed({ available: true, status, hasSession: true }), false);
 assert.match(app, /const collapsed = previewCollapsed\(/);
});

test('explicit per-run expansion and minimization override lifecycle defaults', () => {
 assert.equal(previewCollapsed({ available: true, status: 'done', hasSession: true, preference: false }), false);
 assert.equal(previewCollapsed({ available: true, status: 'running', hasSession: true, preference: true }), true);
 assert.match(app, /preference: state\.stageCollapsePreferences\.get\(state\.sessionId\)/);
 assert.match(app, /state\.stageCollapsePreferences\.set\(state\.sessionId, !el\.viewer\.classList\.contains\('stage-collapsed'\)\)/);
});

test('expand/collapse control is a real button with accessible state', () => {
	assert.match(html, /<button id="stage-toggle" class="btn btn-sm preview-toggle" type="button" hidden\s+aria-expanded="true" aria-label="Minimize live preview"/);
	assert.match(app, /el\.stageToggle\.textContent = collapsed \? '⤢' : '⤡';/);
	assert.match(app, /el\.stageToggle\.setAttribute\('aria-expanded', String\(!collapsed\)\);/);
	// The button only appears once a preview exists (no collapsing an empty stage).
	assert.match(app, /el\.stageToggle\.hidden = !previewAvailable;/);
});

test('toggling preserves browser state — the frame is never unmounted or reset', () => {
	// The collapse is pure CSS class toggling on the viewer; the frame element and
	// its overlay children are static in index.html and never re-created by the
	// collapse code path.
	const collapseBlock = app.match(STAGE_BLOCK)?.[0] ?? '';
	assert.ok(collapseBlock, 'stage collapse block must exist');
	for (const forbidden of ['stageInner.innerHTML', 'frame.remove()', 'frame.src', 'location.reload']) {
		assert.ok(!collapseBlock.includes(forbidden), `collapse path must not touch ${forbidden}`);
	}
	assert.match(html, /<img id="frame" alt="Live view of the site under test">/);
});

test('collapsed layout frees the grid rows for findings and report', () => {
	const collapsedBlocks = styles.match(/\.viewer\.stage-collapsed \{[^}]*\}/g) ?? [];
	assert.ok(collapsedBlocks.length >= 1, 'compact collapsed stage rules must exist');
});

test('the live status chip is still wired for all run states', () => {
	// The status chip vocabulary lives in its own suite (statusChipUi); here we only
	// assert the chip element and the status→dataset wiring survived the merge.
	assert.match(html, /id="status-chip"/);
	assert.match(app, /body\.dataset\.runStatus/);
});
