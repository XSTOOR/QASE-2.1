import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const entry = readFileSync(new URL('../public/entry.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('cinematic entry hands off directly to the workspace without application authentication controls', () => {
	assert.equal((html.match(/id="entry-welcome"/g) ?? []).length, 1);
	assert.equal((html.match(/id="entry-begin"/g) ?? []).length, 1);
	assert.match(html, /id="entry-begin"[\s\S]*?Begin transmission/);
	assert.match(html, /class="entry-index">01 \/ 01<\/span>/);
	assert.doesNotMatch(html, /id="entry-auth"|id="entry-auth-form"|id="sign-out"/);

	assert.match(entry, /window\.qaseEntryReady = new Promise/);
	assert.match(entry, /beginButton\.addEventListener\('click', revealWorkspace\)/);
	assert.match(entry, /setWorkspaceLocked\(false\)/);
	assert.doesNotMatch(entry, /\/api\/auth|qaseAuth|auth-expired/);

	assert.match(app, /await window\.qaseEntryReady/);
	assert.doesNotMatch(app, /\/auth\/session|\/auth\/logout|qaseAuth|auth-expired|signOut|csrf/i);
	assert.doesNotMatch(styles, /\.entry-auth|\.entry-back|\.entry-preview|\.auth-|\.signout-btn|data-view="auth"/);
});

test('workspace chrome is visually quiet while preserving the window controls', () => {
	const start = html.indexOf('<div class="workspace-chrome"');
	const end = html.indexOf('</div>', start);
	const chrome = html.slice(start, end);

	assert.ok(start >= 0 && end > start, 'workspace chrome should remain present');
	assert.match(chrome, /class="workspace-lights"/);
	assert.doesNotMatch(chrome, /workspace-command|workspace-context/);
	assert.doesNotMatch(chrome, /autonomous-qa|terminal workspace/i);
});

test('final workspace polish keeps all functional surfaces and prevents compact layout collisions', () => {
	for (const id of [
		'run-list',
		'transcript',
		'composer',
		'stage',
		'tabs',
		'new-run',
		'new-sqa',
		'new-founder',
		'device-select',
		'settings'
	]) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, `${id} should remain unique`);

	assert.match(styles, /Final workspace fit and finish/);
	assert.match(styles, /\.cli-theme \.panel-foot \{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\) auto;/);
	assert.match(styles, /\.cli-theme \.panel-foot \.foot-btn \{[\s\S]*?grid-column:\s*3/);
	assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*?\.feature-device \{[\s\S]*?flex-direction:\s*row/);
	assert.match(styles, /@media \(max-width: 1100px\) \{[\s\S]*?\.cli-theme \.toasts \{[\s\S]*?bottom:\s*calc\(82px \+ env\(safe-area-inset-bottom\)\)/);
	assert.match(styles, /@media \(max-width: 720px\) \{[\s\S]*?\.feature-dock \{[\s\S]*?position:\s*static[\s\S]*?grid-row:\s*2/);
	assert.match(styles, /@media \(max-width: 720px\) \{[\s\S]*?\.cli-theme \.chat \{\s*grid-row:\s*3/);
	assert.match(styles, /@media \(max-width: 720px\) \{[\s\S]*?\.cli-theme \.viewer \{\s*grid-row:\s*4/);
	assert.match(styles, /@media \(max-width: 520px\) \{[\s\S]*?\.feature-tooltip \{\s*display:\s*none/);
});
