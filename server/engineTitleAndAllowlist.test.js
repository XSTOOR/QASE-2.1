import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static contract tests for #13234 quick fixes: engine tag rendered next to
 * run titles (run list + chat header) and the own-origin browser allowlist.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appJs = fs.readFileSync(path.join(here, '../public/app.js'), 'utf8');
const styles = fs.readFileSync(path.join(here, '../public/styles.css'), 'utf8');
const policyJs = fs.readFileSync(path.join(here, './browserPolicy.js'), 'utf8');

test('run list title carries an engine chip for non-chromium runs', () => {
	const runListTitle = appJs.slice(
		appJs.indexOf('title.textContent = run.targetUrl ? hostOf(run.targetUrl) : run.title'),
		appJs.indexOf('title.textContent = run.targetUrl ? hostOf(run.targetUrl) : run.title') + 600
	);
	assert.match(runListTitle, /run\.engine && run\.engine !== 'chromium'/, 'non-chromium gate');
	assert.match(runListTitle, /run-engine-pill/, 'chip class reused');
});

test('chat header shows the engine tag for non-chromium runs', () => {
	const renderHeaderStart = appJs.indexOf('function renderHeader()');
	const headerTitle = appJs.slice(
		renderHeaderStart,
		appJs.indexOf('function runProgress()', renderHeaderStart)
	);
	assert.ok(renderHeaderStart >= 0, 'renderHeader exists');
	assert.match(headerTitle, /session\.engine && session\.engine !== 'chromium'/, 'non-chromium gate');
	assert.match(headerTitle, /run-engine-pill/, 'chip class reused');
});

test('engine chip styling exists inside titles', () => {
	assert.match(styles, /\.run-title \.run-engine-pill/);
	assert.match(styles, /\.chat-title \.run-engine-pill/);
});

test('browser policy treats the own public origin as allowed', () => {
	assert.match(policyJs, /QASE_PUBLIC_URL/, 'policy reads the instance origin');
	assert.match(policyJs, /ownOriginHost/, 'own-origin host derived');
	assert.match(policyJs, /cleanHost\(hostname\) === ownOriginHost/, 'exact-host match, no suffix games');
});
