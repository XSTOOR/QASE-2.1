import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/* #18482 — "Start Testing button not responding in Test Mode": verify the
 * submit path's recovery contract. The handler (qaUi.form.onsubmit in
 * app.js) must:
 *   1. guard rapid resubmits while busy (dataset.busy check at entry),
 *   2. set busy + disable + "Starting…" BEFORE the request,
 *   3. restore the label and re-run syncQaSubmitState() in `finally` — so a
 *      failure can never leave the button permanently disabled,
 *   4. surface the actual error via setQaFormError and KEEP the user's URL
 *      and selection (no reset on the failure path).
 * The backend duplicate guard (singleRunAdmission) is covered by its own
 * unit tests; this contract pins the FRONTEND side. */

const here = new URL('.', import.meta.url);
const read = name => readFile(new URL(name, here), 'utf8');

test('#18482 contract: submit handler guards busy re-entry', async () => {
	const app = await read('app.js');
	const start = app.indexOf('qaUi.form.onsubmit = async event =>');
	const body = app.slice(start, app.indexOf('/* ── Settings', start));
	assert.ok(start >= 0, 'qa submit handler must exist');
	assert.match(body, /if \(qaUi\.submit\.dataset\.busy === 'true'\) return;/,
		'rapid duplicate clicks must be ignored while a start is in flight');
});

test('#18482 contract: failure path restores the button and preserves input', async () => {
	const app = await read('app.js');
	const start = app.indexOf('qaUi.form.onsubmit = async event =>');
	const body = app.slice(start, app.indexOf('/* ── Settings', start));
	// busy/disable set before the request
	const busyAt = body.indexOf("qaUi.submit.dataset.busy = 'true'");
	const postAt = body.indexOf("apiWithTimeout('/qa-matrix-runs'");
	assert.ok(busyAt >= 0 && postAt > busyAt, 'busy flag must be set before the request');
	// finally restores label + re-syncs (no permanent disable)
	assert.match(body, /finally \{\s*[\s\S]*?qaUi\.submit\.dataset\.busy = 'false';\s*[\s\S]*?qaUi\.submit\.textContent = 'Start testing';\s*[\s\S]*?syncQaSubmitState\(\);\s*\}/,
		'finally must restore busy flag, label, and re-sync the button state');
	// error surfaces the actual reason
	assert.match(body, /catch \(error\) \{\s*setQaFormError\(error instanceof Error \? error\.message : String\(error\)\);/,
		'the actual failure reason must be shown');
	// URL/goal are cleared ONLY on success (they must survive a failure)
	const clear = body.indexOf("qaUi.targetUrl.value = ''");
	const successBranch = body.indexOf('matrixRun.reused');
	const finallyAt = body.indexOf('finally {');
	assert.ok(clear > 0 && clear < finallyAt, 'input clearing must live on the success path');
});

test('#18482 contract: error element is a visible alert inside the dialog', async () => {
	const html = await read('index.html');
	assert.match(html, /id="qa-form-error" role="alert" aria-live="assertive"/,
		'the QA dialog must carry a live error region for start failures');
});
