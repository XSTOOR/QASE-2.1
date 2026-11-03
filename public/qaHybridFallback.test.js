import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Resolve relative to THIS file, not process.cwd(): under
// `node --test --test-isolation=none` other suites chdir into temp dirs,
// which would strand cwd-relative reads (see the known suite-ordering notes).
const here = new URL('.', import.meta.url);
const read = name => readFile(new URL(name, here), 'utf8');

/* #18479 — "Review Test Run" dead-button in Test Mode when Hybrid QA is off.
 * The launcher's execution mode ships as <input type="hidden" value="hybrid">
 * in the markup. When /api/config reports hybridQa.enabled = false, every
 * gate check (qaLaunchBlockedReason → hybridLaunchOptions) rejects that mode
 * with "Hybrid QA is disabled by the server operator.", so the Review Test
 * Run button never enables and Test Mode is unusable. The fix: paintConfig
 * must fall back to the legacy single-model mode — mirroring the server's
 * selectQaExecutionMode(undefined) default — whenever the uncorrected
 * shipped default meets a disabled hybrid flag. */

test('#18479 contract: paintConfig falls back to legacy when hybrid QA is disabled', async () => {
	const app = await read('app.js');
	const start = app.indexOf('function paintConfig(config)');
	const body = app.slice(start, app.indexOf('function currentUiAssetVersion', start));
	assert.ok(start >= 0, 'paintConfig must exist in app.js');
	// The fallback keys on the server flag (enabled), not just availability:
	// disabled is permanent for the operator's choice; qualification issues
	// still surface as attention but the mode default only follows the flag.
	assert.match(body, /qaUi\.executionMode\.value === 'hybrid'/, 'must detect the shipped hybrid default');
	assert.match(body, /config\.hybridQa && !config\.hybridQa\.enabled/, 'must gate on hybridQa.enabled');
	assert.match(body, /qaUi\.executionMode\.value = 'legacy'/, 'must fall back to legacy');
	// The fallback must happen BEFORE qaJourney.sync()/syncQaSubmitState()
	// repaint the gate states, otherwise the button re-syncs with the stale
	// hybrid mode and stays disabled.
	assert.ok(body.indexOf("value = 'legacy'") < body.indexOf('qaJourney?.sync()'), 'fallback must precede journey re-sync');
});

test('#18479 contract: the launcher markup still ships hybrid as the default mode', async () => {
	const html = await read('index.html');
	assert.match(html, /id="qa-execution-mode" type="hidden" name="qaExecutionMode" value="hybrid"/,
		'the hidden mode input must keep its shipped hybrid default (paintConfig corrects it when the server disables hybrid)');
});
