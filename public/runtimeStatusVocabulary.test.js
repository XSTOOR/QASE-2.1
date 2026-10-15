import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Behavioral coverage for the runtime-status vocabulary (UI Fix Phase 3):
// every one of the 10 spec words must map cleanly through runtimeStatusFor
// AND render as a concrete pill label (no generic '○ UPPER' fallback).

const RUNTIME_STATUSES = Object.freeze([
	'queued', 'reserving', 'connecting', 'connected', 'running',
	'blocked', 'completed', 'failed', 'device_unavailable', 'released'
]);

async function loadModule() {
	const src = readFileSync(new URL('./activeRuntimeEnvironment.js', import.meta.url), 'utf8');
	const module = { exports: {} };
	// Transform ESM exports to CJS for evaluation in the test harness.
	const cjs = src.replace(/export\s+function\s+(\w+)/g, 'module.exports.$1 = function $1')
		.replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =')
		.replace(/^import[^\n]*$/gm, '');
	new Function('module', 'exports', cjs)(module, module.exports);
	return module.exports;
}

test('runtimeStatusFor maps every vocabulary word for sessionStatus inputs', async () => {
	const { runtimeStatusFor } = await loadModule();
	const expectations = {
		queued: 'queued',
		starting: 'queued',
		resuming: 'connecting',
		awaiting_input: 'connected',
		running: 'running',
		blocked: 'blocked',
		done: 'completed',
		error: 'failed',
		interrupted: 'failed',
		cancelled: 'failed'
	};
	for (const [status, expected] of Object.entries(expectations)) {
		assert.equal(runtimeStatusFor({ sessionStatus: status }), expected, `sessionStatus=${status}`);
	}
});

test('runtimeStatusFor maps deviceSessionStatus inputs including blocked/released', async () => {
	const { runtimeStatusFor } = await loadModule();
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', deviceSessionStatus: 'queued' }), 'queued');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', deviceSessionStatus: 'created' }), 'connecting');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', deviceSessionStatus: 'blocked' }), 'blocked');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', deviceSessionStatus: 'released' }), 'released');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', deviceSessionStatus: 'failed' }), 'failed');
});

test('runtimeStatusFor maps board availability to device_unavailable', async () => {
	const { runtimeStatusFor } = await loadModule();
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', availability: 'OFFLINE' }), 'device_unavailable');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', availability: 'NOT_EXECUTABLE' }), 'device_unavailable');
	assert.equal(runtimeStatusFor({ sessionStatus: 'running', availability: 'AVAILABLE' }), 'running');
});

test('runtimeStatusFor never returns a value outside the vocabulary', async () => {
	const { runtimeStatusFor } = await loadModule();
	for (const sessionStatus of [null, undefined, '', 'weird', 'RUNNING', 'Paused']) {
		const out = runtimeStatusFor({ sessionStatus });
		assert.ok(RUNTIME_STATUSES.includes(out), `sessionStatus=${sessionStatus} produced out-of-vocabulary '${out}'`);
	}
});

test('RUNTIME_STATUSES constant contains all 10 spec words including BLOCKED and RELEASED', async () => {
	const src = readFileSync(new URL('./activeRuntimeEnvironment.js', import.meta.url), 'utf8');
	const m = src.match(/RUNTIME_STATUSES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/);
	assert.ok(m, 'RUNTIME_STATUSES constant not found');
	const words = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
	assert.ok(words.includes('blocked'), 'blocked missing');
	assert.ok(words.includes('released'), 'released missing');
	assert.equal(words.length, 10);
	assert.deepEqual(words, [...RUNTIME_STATUSES], 'constant must match the spec vocabulary exactly');
});

test('header statusMap in app.js renders a label for every vocabulary word (no fallback path needed)', async () => {
	const src = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
	const m = src.match(/const statusMap = \{([\s\S]*?)\};/);
	assert.ok(m, 'statusMap not found in app.js');
	const words = [...m[1].matchAll(/^\s*(\w+):/gm)].map((x) => x[1]);
	for (const word of RUNTIME_STATUSES) {
		assert.ok(words.includes(word), `statusMap is missing '${word}'`);
	}
});
