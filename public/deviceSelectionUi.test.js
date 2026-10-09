import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

test('device cards use one explicit selection action', () => {
	assert.match(app, /qa-matrix-device-select/);
	assert.match(app, /selectDevice\.setAttribute\('aria-pressed', String\(isActiveScope\)\)/);
	assert.match(app, /Select device/);
	assert.doesNotMatch(app, /deviceRow\.setAttribute\('role', 'button'\)/);
	assert.doesNotMatch(app, /deviceRow\.addEventListener\('click'/);
	assert.doesNotMatch(app, /deviceRow\.addEventListener\('keydown'/);
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
