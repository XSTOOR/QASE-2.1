import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

/* #16043: per-browser selection UX contract — mode control, assignment
 * chips, active-family picker semantics, honest disabling, summary. */

test('mode control offers both modes and switches through the model', () => {
	assert.match(app, /dataset\.role = `mode-\$\{mode\}`/);
	assert.match(app, /'All devices for every browser'/);
	assert.match(app, /'One device per browser'/);
	assert.match(app, /setSelectionMode\(qaMatrixState\.selection, qaMatrixState\.index, mode\)/);
	// the active mode button is visually and semantically pressed
	assert.match(app, /qa-matrix-mode-btn.*is-active/s);
	assert.match(app, /button\.setAttribute\('aria-pressed'/);
});

test('per-browser mode renders an assignment chip per selected card', () => {
	assert.match(app, /qa-matrix-assignment-chip/);
	assert.match(app, /No device — pick one/);
	assert.match(app, /`→ \$\{row\.deviceLabel\}`/);
});

test('active browser card is unmistakable', () => {
	assert.match(app, /card\.classList\.add\('is-active'\)/);
	assert.match(app, /card\.setAttribute\('aria-current', 'true'\)/);
	assert.match(app, /Picking a device for \$\{family\.label\}/);
	assert.match(styles, /\.qa-matrix-browser-card\.is-active \{/);
});

test('device row click assigns to the active family in per-browser mode', () => {
	assert.match(app, /assignDevice\(qaMatrixState\.selection, qaMatrixState\.index, activeFamily, device\.key\)/);
	assert.match(app, /unassignDevice\(qaMatrixState\.selection, activeFamily\)/);
	// clicking a browser card makes that family the active picker target
	assert.match(app, /if \(perBrowser && willSelect\) qaMatrixState\.activeFamily = family\.code;/);
});

test('impossible devices are honestly disabled for the active browser', () => {
	assert.match(app, /No configurations for \$\{activeLabel\} on this device\./);
	assert.match(app, /Select a browser first — the device list picks one device for each browser\./);
});

test('assigned rows carry the family brand icons', () => {
	assert.match(app, /qa-matrix-assigned-family-icon/);
	assert.match(app, /Device for \$\{families\.find\(\(family\) => family\.code === code\)\?\.label \?\? code\}/);
});

test('summary reads "N browsers × 1 device each" in per-browser mode', () => {
	assert.match(app, /× 1 device each/);
	assert.match(app, /browser\$\{unassignedFamilies === 1 \? '' : 's'\} need\$\{unassignedFamilies === 1 \? 's' : ''\} a device/);
	assert.match(app, /browser × device pair configuration/);
});

test('bulk device actions hidden in per-browser mode; picker hint shown', () => {
	assert.match(app, /if \(!perBrowser\) \{/);
	assert.match(app, /Pick a device for \$\{activeLabel\} — one click assigns it\./);
	assert.match(app, /Select a browser above, then pick its device here\./);
});

test('cross mode behavior unchanged: device toggle path still present', () => {
	assert.match(app, /toggleDevice\(next, device\.key, !selection\.deviceKeys\.has\(device\.key\)\)/);
	// the cross product summary line is intact
	assert.match(app, /browser\$\{dimensions\.families === 1 \? '' : 's'\} × \$\{dimensions\.devices/);
});

test('#16043: all-selected-no-assignment state says "pick a device", not the generic empty message', () => {
	assert.match(app, /selected — pick a device\$\{unassignedFamilies === 1 \? '' : ' for each'\}\./);
});
