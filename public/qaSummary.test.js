import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

/* #15970 Phase 3 — live summary + Start gating copy. */
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

const { selectionDimensions } = await import(new URL('./qaConfigMatrix.js', import.meta.url));

const config = (envId, browserCode, device, platform = 'ios', manufacturer = 'Apple') => ({
	envId, browserCode, device, platform, manufacturer
});

test('#15970: selectionDimensions counts families, devices, runs', () => {
	const configurations = [
		config('E1', 'chrome', 'iPhone 11'),
		config('E2', 'firefox', 'iPhone 11'),
		config('E3', 'chrome', 'Pixel 10', 'android', 'Google'),
		config('E4', 'safari', 'MacBook Pro', 'macos')
	];
	assert.deepEqual(selectionDimensions(configurations, ['E1', 'E2', 'E3']), {
		families: 2, devices: 2, runs: 3
	});
	assert.deepEqual(selectionDimensions(configurations, []), { families: 0, devices: 0, runs: 0 });
	assert.deepEqual(selectionDimensions(configurations, ['E4']), { families: 1, devices: 1, runs: 1 });
	// Granular deselects reduce the run count (selection model interplay).
	assert.deepEqual(selectionDimensions(configurations, ['E1', 'E2', 'E3'].filter(id => id !== 'E1')), {
		families: 2, devices: 2, runs: 2
	});
});

test('#15970: summary primary line is browsers × devices → runs', () => {
	assert.match(app, /dimensions\.families\.toLocaleString\(\)\} browser/);
	assert.match(app, /dimensions\.devices\.toLocaleString\(\)\} device/);
	assert.match(app, /dimensions\.runs\.toLocaleString\(\)\} run/);
	// selectionDimensions is imported and used in the render.
	assert.match(app, /selectionDimensions\(qaMatrixState\.index, qaMatrixState\.selectedEnvIds\)/);
});

test('#15970: zero states are plain language', () => {
	assert.match(app, /No browsers or devices selected — pick at least one of each\./);
	assert.match(app, /No browsers or devices available — connect an execution provider\./);
});

test('#15970: honesty notes are kept as secondary segments', () => {
	assert.match(app, /available configurations/);
	assert.match(app, /will run as \$\{Math\.ceil\(summary\.total \/ MATRIX_BATCH_SIZE\)\} batches/);
	assert.match(app, /runs one browser at a time/);
	assert.match(app, /providerNotes\.join\(', '\)/);
});

test('#15970: Start gating tooltip matches the two-selector model', () => {
	assert.match(app, /'Select at least one browser and one device\.'/);
	// The old wording is gone.
	assert.doesNotMatch(app, /Select at least one available browser and device\./);
	assert.doesNotMatch(app, /Choose an available browser and device to start\./);
});

test('#15970: summary tooltip keeps per-family counts', () => {
	assert.match(app, /summary\.byFamily[\s\S]{0,200}map\(\(\[code, count\]\) => `\$\{code\}: \$\{count\}`\)/);
});

test('#15970 (Phase 1 carry-over): browser card version display is capped', () => {
	assert.match(app, /family\.versions\.slice\(0, 2\)\.join\(', '\)/);
	assert.match(app, /family\.versions\.length - 2/);
});
