import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

test('device cards use one explicit selection action', () => {
	// Merge resolution: NIHARIKA's Phase-1 explicit selection model — the row
	// carries a SELECTION checkbox (device-select) plus a VIEW button for
	// scope inspection; DEV's "Select device" scope button was superseded.
	assert.match(app, /dataset\.role = 'device-select'/);
	assert.match(app, /dataset\.role = 'device-view'/);
	assert.match(app, /viewButton\.textContent = 'View'/);
	assert.match(app, /Inspect this device without changing your selection/);
});

test('selection summary clearly separates devices, browsers, and runs', () => {
	assert.match(app, /1 device · \$\{browserCount\.toLocaleString\(\)\} browser/);
	assert.match(app, /\$\{selectedCount\.toLocaleString\(\)\} run/);
	assert.match(app, /Runs one browser at a time/);
});

test('device controls remain reachable at narrow widths', () => {
	assert.match(styles, /@media \(max-width: 560px\)[\s\S]+\.qa-matrix-device-select \{ width: 100%;/);
	assert.doesNotMatch(styles, /\.qa-matrix-device\.is-clickable/);
});
