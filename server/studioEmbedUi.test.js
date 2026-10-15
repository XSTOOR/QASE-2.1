import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/studioMode.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/studio-embed.css', import.meta.url), 'utf8');

test('mock Studio shell is opt-in and leaves standalone as the default', () => {
	// Cache-busted asset URLs (v=20261009-1) still load studioMode + embed skin.
	assert.match(html, /<script src="studioMode\.js\?v=[\w-]+"><\/script>/);
	assert.match(html, /<link rel="stylesheet" href="studio-embed\.css\?v=[\w-]+">/);
	assert.match(script, /params\.get\('studio'\) === 'mock'/);
	assert.match(script, /enabled \? 'studio-mock' : 'standalone'/);
	assert.match(styles, /\.studio-demo-shell,[\s\S]*?display: contents;/);
	assert.match(styles, /html\[data-qase-layout="studio-mock"\] \.studio-demo-shell/);
});

test('Studio shell communicates host, context, and center tool ownership', () => {
	assert.match(html, /class="studio-host-rail" aria-label="Drytis navigation"/);
	assert.match(html, /class="studio-context" id="studio-context"/);
	assert.match(html, /class="studio-tool-workspace" aria-label="Qase in Drytis Studio"/);
	assert.match(html, /id="studio-project-name"/);
	assert.match(html, /id="studio-project-target"/);
	assert.match(html, /class="studio-demo-badge">Studio demo/);
	assert.match(styles, /--studio-context-width: 280px/);
	assert.match(styles, /grid-template-columns: 64px var\(--studio-context-width\) 7px minmax\(0, 1fr\)/);
	assert.match(styles, /\.feature-dock > \.feature-device \{\s*display: none/);
});

test('Studio context values are bounded and written without HTML injection', () => {
	assert.match(script, /slice\(0, maximum\)/);
	assert.match(script, /\['http:', 'https:'\]\.includes/);
	assert.match(script, /project\.textContent = context\.project/);
	assert.match(script, /target\.textContent = new URL\(context\.targetUrl\)\.host/);
	assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/);
});

test('context collapse is a labelled keyboard button and mobile keeps the Qase workspace', () => {
	assert.match(html, /id="studio-context-toggle"[^>]+type="button"[^>]+aria-controls="studio-context"[^>]+aria-expanded="true"/);
	assert.match(script, /toggle\.setAttribute\('aria-expanded'/);
	assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.studio-tool-workspace[\s\S]*?min-height: 100dvh/);
	assert.doesNotMatch(styles, /transition:\s*all/);
});

test('embedded project target is reused by every launcher without changing standalone defaults', () => {
	assert.match(app, /function studioProjectContext\(\)/);
	assert.match(app, /if \(context\?\.mode !== 'mock-studio'\) return undefined/);
	assert.match(app, /applyStudioTarget\(qaUi\.targetUrl\)/);
	assert.match(app, /applyStudioTarget\(sqaUi\.targetUrl\)/);
	assert.match(app, /applyStudioTarget\(founderUi\.targetUrl\)/);
	assert.match(app, /founderUi\.targetName\.value = studioContext\.project/);
});
