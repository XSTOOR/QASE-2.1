import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withSnapshotTimeout, withBrowserOperationTimeout } from './browserBridge.js';

/*
 * The operation timeout bound exists because real security runs wedged in
 * 'running' forever: browser_snapshot (twice) and browser_diagnostics (once)
 * hung with no per-call timeout anywhere in the MCP path — and Stop could not
 * recover them because the abort only breaks the model stream, not an awaited
 * tool promise. These tests pin the bound's contract: fast work passes
 * through, hung work rejects with a retryable, self-describing error, and
 * real errors surface immediately rather than waiting out the timer.
 */

test('withSnapshotTimeout resolves fast work normally', async () => {
	const result = await withSnapshotTimeout(async () => ({ elements: [1, 2, 3] }), 5000);
	assert.equal(result.elements.length, 3);
});

test('withSnapshotTimeout rejects hung work after the bound with a retryable error', async () => {
	const start = Date.now();
	await assert.rejects(
		withSnapshotTimeout(() => new Promise(() => {}), 50),
		error => {
			assert.equal(error.name, 'BrowserOperationTimeout');
			assert.equal(error.timedOut, true);
			assert.match(error.message, /timed out after 50 ms/);
			assert.match(error.message, /not tested with a reason/);
			return true;
		}
	);
	assert.ok(Date.now() - start < 5000, 'rejected promptly');
});

test('withSnapshotTimeout propagates work errors immediately', async () => {
	await assert.rejects(
		withSnapshotTimeout(async () => { throw new Error('page crashed'); }, 5000),
		error => error.message === 'page crashed'
	);
});

test('withSnapshotTimeout floor: non-positive bound still awaits the work', async () => {
	const result = await withSnapshotTimeout(async () => 'ok', 0);
	assert.equal(result, 'ok');
});

test('withBrowserOperationTimeout accepts an already-started promise', async () => {
	const promise = (async () => ({ ok: true }))();
	const result = await withBrowserOperationTimeout(promise, 5000, 'browser_diagnostics');
	assert.equal(result.ok, true);
});

test('withBrowserOperationTimeout names the operation in the timeout error', async () => {
	await assert.rejects(
		withBrowserOperationTimeout(() => new Promise(() => {}), 40, 'browser_diagnostics'),
		error => error.message.startsWith('browser_diagnostics timed out after 40 ms')
	);
});
