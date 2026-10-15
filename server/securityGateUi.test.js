import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const launcherBlock = () => app.slice(
	app.indexOf('const qaUi'),
	app.indexOf('async function openSqaStart') === -1 ? undefined : app.indexOf('async function openSqaStart')
);

test('the authorization gate block exists inside the Security testing section', () => {
	assert.match(html, /<div class="qa-security-auth" id="qa-security-auth" hidden>/);
	assert.match(html, /<input type="checkbox" id="qa-security-authorized">/);
	assert.match(html, /id="qa-security-notes"/);
	// The confirmation text names the requirement explicitly.
	assert.match(html, /explicitly authorized, isolated test environment/);
});

test('the gate shows only when a security check is selected and blocks submit', () => {
	const block = launcherBlock();
	// Gate visibility is derived from the live selection.
	assert.match(block, /qaUi\.securityAuth\.hidden = !needed/);
	assert.match(block, /qaUi\.securityAuthorized\.required = (?:true|false)/);
	// Submit blocks without confirmation, with the reason surfaced.
	assert.match(block, /if \(qaSecuritySelected\(\) && !securityAuthorization\) \{/);
	assert.match(block, /Confirm the target is an explicitly authorized, isolated test environment/);
	// The gate syncs on every selection change and on catalog paint.
	assert.match(block, /function refreshQaSelection\(\) \{[\s\S]*?syncQaSecurityGate\(\);/);
	assert.match(block, /function paintQaTestCatalog[\s\S]*?syncQaSecurityGate\(\);/);
});

test('confirmed authorization rides the run request; unselected security makes it inert', () => {
	const block = launcherBlock();
	assert.match(block, /if \(!qaSecuritySelected\(\)\) return undefined;/);
	assert.match(block, /notes \? \{ confirmed: true, notes \} : \{ confirmed: true \}/);
	assert.match(app, /body: JSON\.stringify\(\{[\s\S]*?device,[\s\S]*?deviceLandscape,[\s\S]*?engine,[\s\S]*?selectedTests,[\s\S]*?\.\.\.\(securityAuthorization \? \{ securityAuthorization \} : \{\}\)[\s\S]*?\}\)/);
	assert.match(app, /createQaRun\(\{[\s\S]*?targetUrl,[\s\S]*?device,[\s\S]*?deviceLandscape,[\s\S]*?selectedTests,[\s\S]*?securityAuthorization,/);
});

test('gate styling matches Studio (soft info block, no new component system)', () => {
	assert.match(styles, /\.qa-security-auth \{/);
	assert.match(styles, /\.qa-security-auth-confirm/);
});
