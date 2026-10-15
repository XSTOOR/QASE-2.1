import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [markup, app, mode, workspaceStyles, embedStyles] = await Promise.all([
	readFile(new URL('./index.html', import.meta.url), 'utf8'),
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./studioMode.js', import.meta.url), 'utf8'),
	readFile(new URL('./studio-workspace.css', import.meta.url), 'utf8'),
	readFile(new URL('./studio-embed.css', import.meta.url), 'utf8')
]);

test('default Qase owns the shared product workspace', () => {
	assert.match(markup, /<body class="cli-theme studio-workspace" data-has-run="false">/);
	assert.match(workspaceStyles, /body\.studio-workspace\[data-run-status="running"\] \.app/);
	assert.match(workspaceStyles, /body\.studio-workspace\[data-run-status="done"\] \.app/);
	assert.match(workspaceStyles, /body\.studio-workspace:is\(\[data-run-status="running"\], \[data-run-status="done"\]\) \.app/);
});

test('customer navigation collapse works outside the Studio wrapper', () => {
	assert.match(mode, /sidebarPreferenceKey = 'qase\.sidebar'/);
	assert.match(mode, /document\.documentElement\.dataset\.qaseSidebar = sidebarPreference/);
	assert.ok(mode.indexOf("dataset.qaseSidebar = sidebarPreference") < mode.indexOf('if (enabled) {'));
	assert.match(workspaceStyles, /html\[data-qase-sidebar="collapsed"\] body\.studio-workspace:not\(\[data-page="results"\]\) \.app/);
});

test('normal customer surfaces keep technical duplicates out of the permanent layout', () => {
	for (const id of ['#token-chip', '#live-pill', '#execution-target-block', '#ldv-exec', '#ldv-change-device']) {
		assert.match(workspaceStyles, new RegExp(id.replace('#', '#')));
	}
	assert.match(markup, /<summary>Run details<\/summary>/);
	assert.match(app, /Model usage: \$\{usage\}/);
});

test('default empty state is concise and has one desktop primary launcher', () => {
	assert.match(markup, /<h2>Confidence before your next release\.<\/h2>/);
	assert.doesNotMatch(markup, /class="empty-note"/);
	assert.match(workspaceStyles, /\.empty-actions #empty-start \{ display: none/);
	assert.match(workspaceStyles, /data-has-run="false"\] \.viewer :is\(#tabs, \.tab-body\)/);
	assert.match(app, /state\.sessionId && \(session\.targetUrl \|\| session\.title\)/);
	assert.match(app, /dataset\.hasRun = String\(hasRun\)/);
	assert.match(app, /statusChip\.hidden = !hasRun/);
	assert.doesNotMatch(app, /checklist\.append/);
});

test('the Studio stylesheet remains a host wrapper', () => {
	assert.match(embedStyles, /\.studio-host-rail/);
	assert.match(embedStyles, /\.studio-context/);
	assert.match(embedStyles, /\.studio-tool-workspace/);
	assert.doesNotMatch(embedStyles, /#execution-target-block/);
	assert.doesNotMatch(embedStyles, /\.welcome-checklist/);
});

test('customer preview and statuses use plain language', () => {
	assert.match(markup, /id="ldv-title">Preview<\/span>/);
	for (const label of ['Running', 'Complete', 'Needs attention']) assert.match(app, new RegExp(`'${label}'`));
	assert.match(app, /hasSavedPreview \? 'Saved'/);
	assert.match(app, /completed \? 'Complete' : 'Idle'/);
	assert.doesNotMatch(app.slice(app.indexOf('const statusMap = {'), app.indexOf('const liveLabel =')), /●|◆|✕/);
});

test('the workspace exposes one polished theme action', () => {
	assert.match(markup, /id="theme-toggle"[^>]+aria-label="Switch to dark theme"/);
	assert.match(markup, /id="theme-toggle-text">Light</);
	assert.doesNotMatch(markup, /id="theme-select"/);
	assert.match(app, /themeStore\.applied\(\) === 'dark' \? 'light' : 'dark'/);
});

test('the customer sidebar stays focused and collapses cleanly', () => {
	for (const removedId of ['sidebar-view-report', 'sidebar-retest', 'perf-panel', 'perf-restore']) {
		assert.doesNotMatch(markup, new RegExp(`id="${removedId}"`));
	}
	assert.match(app, /age\.className = 'run-age'/);
	assert.match(workspaceStyles, /grid-template-columns: 64px/);
	// #15643/#15723 merge: brand-mark is hidden via the combined :is(.brand-mark, .brand-sub) rule.
	assert.match(workspaceStyles, /data-qase-sidebar="collapsed"[^}]+:is\(\.brand-mark, \.brand-sub\) \{ display: none/);
});

test('launchers keep their final controls reachable at short viewport heights', () => {
	assert.match(workspaceStyles, /:is\(\.qa-modal, \.sqa-modal, \.founder-modal\)\[open\][^{]+\{[^}]+overflow: hidden/s);
	assert.match(workspaceStyles, /:is\(\.qa-modal, \.sqa-modal, \.founder-modal\) \.modal-body[^{]+\{[^}]+overflow-y: auto/s);
	assert.match(workspaceStyles, /:is\(\.qa-modal, \.sqa-modal, \.founder-modal\) \.modal-foot[^{]+\{[^}]+position: static/s);
});

test('account settings use a structured, independently scrolling surface', () => {
	for (const section of ['account-profile-heading', 'account-password-heading', 'account-memory-heading']) {
		assert.match(markup, new RegExp(`id="${section}"`));
	}
	assert.match(markup, /class="account-shell route-page-shell"/);
	assert.match(markup, /class="account-body"/);
	assert.match(workspaceStyles, /\.account-body[^{]+\{[^}]+overflow-y: auto/s);
});

test('routed setup and account screens present as full product pages', () => {
	assert.match(markup, /id="qa-start" data-route-page="new-run"/);
	assert.match(markup, /id="profile-dialog" class="account-dialog route-page" data-route-page="account"/);
	assert.match(markup, /aria-label="Test setup sections"/);
	assert.match(markup, /aria-label="Account sections"/);
	assert.match(markup, /id="account-page-content"/);
	assert.match(workspaceStyles, /\.route-page\[open\][^{]+\{[^}]+height: 100dvh/s);
	assert.match(workspaceStyles, /\.account-dialog\.route-page \.account-body[^{]+\{[^}]+grid-template-columns: 200px/s);
});

test('completed runs use a focused routed results page', () => {
	assert.match(markup, /class="results-page-head" id="results-page-head"/);
	assert.match(markup, /id="results-page-back"/);
	assert.match(app, /session\.status === 'done' \? 'results' : 'run'/);
	assert.match(app, /renderResultsPageHeader\(\)/);
	assert.match(workspaceStyles, /data-page="results"[^}]+\.app[^{]+\{[^}]+grid-template-columns: minmax\(0, 1fr\)/s);
	assert.match(workspaceStyles, /data-page="results"[^}]+\.viewer[^{]+\{[^}]+width: min\(1180px, 100%\)/s);
	assert.match(embedStyles, /data-qase-layout="studio-mock"[^}]+data-page="results"[^}]+\.app/);
});

test('desktop pane seams resize by drag without visible plus or minus controls', () => {
	for (const pane of ['runs', 'agent']) {
		assert.match(markup, new RegExp(`id="${pane}-pane-resizer"[\\s\\S]+role="separator"`));
	}
	assert.doesNotMatch(markup, /data-pane-resize=/);
	assert.match(mode, /qase\.pane\.runs/);
	assert.match(mode, /qase\.pane\.agent/);
	assert.match(mode, /setPaneWidth/);
	assert.match(mode, /addEventListener\('pointermove'/);
	assert.match(workspaceStyles, /@media \(min-width: 1101px\)[^{]+\{[\s\S]+\.pane-resizer/);
	assert.match(workspaceStyles, /cursor: col-resize/);
});

test('the run header shows one elapsed-time treatment', () => {
	assert.match(workspaceStyles, /\.run-timer \{ display: none !important; \}/);
	assert.match(markup, /id="timer-chip"/);
});
