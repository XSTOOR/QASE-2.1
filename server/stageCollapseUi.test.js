import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const app = await readFile('public/app.js', 'utf8');
const html = await readFile('public/index.html', 'utf8');
const styles = await readFile('public/styles.css', 'utf8');

const STAGE_BLOCK = /\/\* ── Post-run layout[\s\S]*?function toggleStageCollapse\(\) \{[\s\S]*?\n\}/;

test('post-run stage collapse block exists in the frontend source', () => {
	assert.match(app, STAGE_BLOCK);
});

test('only terminal statuses collapse the browser view; live statuses keep it expanded', () => {
	assert.match(app, /STAGE_COLLAPSE_STATUSES = new Set\(\['done', 'error', 'interrupted', 'idle'\]\)/);
	// A run in progress (or paused for user input) restores the full live view and
	// clears the manual expansion override for the session.
	assert.match(
		app,
		/if \(status === 'running' \|\| status === 'awaiting_input'\) \{[\s\S]*?state\.stageExpanded\.delete\(state\.sessionId\);[\s\S]*?renderStageCollapse\(\);/
	);
});

test('manual expansion is respected — render only collapses when the session is not in the override set', () => {
	// Results-first redesign: preview availability gates the collapse; an ended run
	// collapses to the compact strip unless the user expanded it for this session.
	assert.match(app, /const collapsed = previewAvailable[\s\S]*?\? ended && !state\.stageExpanded\.has\(state\.sessionId\)/);
	// toggleStageCollapse adds/removes the session from the override set rather than
	// toggling a global flag, so later status syncs of the same run cannot re-collapse
	// a view the user expanded.
	assert.match(app, /function toggleStageCollapse\(\) \{[\s\S]*?state\.stageExpanded\.add\(state\.sessionId\);[\s\S]*?state\.stageExpanded\.delete\(state\.sessionId\);[\s\S]*?\}/);
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
