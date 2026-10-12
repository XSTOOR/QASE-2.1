import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

/* #15969: the merged Phase-1 contract (selection checkbox + View scope
 * button) was superseded by the platform-tabs + one-click-row device
 * selector. Updated to pin the NEW single-action contract. */
test('device rows use one explicit selection action', () => {
	assert.match(app, /dataset\.role = 'device-row'/);
	assert.match(app, /toggleDevice\(next, device\.key, !selection\.deviceKeys\.has\(device\.key\)\)/);
	assert.doesNotMatch(app, /dataset\.role = 'device-view'/);
	assert.doesNotMatch(app, /Inspect this device without changing your selection/);
});

test('selection summary clearly separates devices, browsers, and runs', () => {
	// #15970: primary line is browsers × devices → runs; the one-at-a-time
	// honesty note remains a secondary segment.
	assert.match(app, /browser\$\{dimensions\.families === 1 \? '' : 's'\} × /);
	assert.match(app, /runs one browser at a time/);
});

test('device controls remain reachable at narrow widths', () => {
	// #15969: device rows wrap and platform tabs scroll horizontally.
	assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.qa-matrix-device-row \{ flex-wrap: wrap; \}/);
	assert.match(styles, /\.qa-matrix-platform-tabs \{ overflow-x: auto; flex-wrap: nowrap; \}/);
});
