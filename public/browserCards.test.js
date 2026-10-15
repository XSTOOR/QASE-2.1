import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pickerHarness } from './matrixPickerHarness.js';

/* #15968 Phase 1 — browser toggle cards. Source-assertion suite following
 * the project's qaUiSelection.test.js pattern (the launcher is a browser
 * script without a DOM harness), plus unit tests for the shared brandIcon
 * module against a minimal DOM shim.
 */
const [app, styles] = await Promise.all([
	readFile(new URL('./app.js', import.meta.url), 'utf8'),
	readFile(new URL('./styles.css', import.meta.url), 'utf8')
]);

const picker = await readFile(new URL('./matrixPicker.js', import.meta.url), 'utf8');
test('browser buttons replace the family instead of toggling multiple browsers', () => {
	const h = pickerHarness(); h.click('browser-firefox'); assert.deepEqual(h.ids(), ['ff']);
	h.click('browser-chrome'); assert.deepEqual(h.ids(), ['desktop']);
	assert.equal(h.get('browser-chrome').attributes['aria-pressed'], 'true');
	assert.equal(h.get('browser-firefox').attributes['aria-pressed'], 'false');
});
test('unavailable browsers stay disabled and explain why', () => {
	const h = pickerHarness(); assert.equal(h.get('browser-safari').disabled, true);
	assert.match(h.get('browser-safari').title, /Browser not installed/);
});
test('bulk and version selection are absent from the launcher', () => {
	const h = pickerHarness(); assert.equal(h.get('select-shown'), undefined);
	assert.doesNotMatch(h.text(h.hosts.root), /151|100|Review exact configurations|Select shown/);
});
test('browser icons and keyboard focus survive selection updates', () => {
	const h = pickerHarness(); h.get('browser-firefox').focus(); h.click('browser-firefox');
	assert.equal(h.document.activeElement.dataset.pickerFocus, 'browser-firefox');
	assert.equal(h.get('browser-firefox').children[0].tagName, 'svg');
});

/* brandIcons module — DOM-shimmed unit tests (no browser needed). */
const documentShim = {
	createElementNS(ns, tag) {
		return {
			tag,
			attrs: {},
			innerHTML: '',
			classList: {
				list: new Set(),
				add(c) { this.list.add(c); }
			},
			setAttribute(k, v) { this.attrs[k] = v; }
		};
	}
};
globalThis.document = documentShim;
const { brandIcon } = await import(new URL('./brandIcons.js', import.meta.url).href);

test('#15968: brandIcon returns a sized, aria-hidden SVG for every family', () => {
	for (const code of ['edge', 'chrome', 'brave', 'firefox', 'safari', 'opera', 'duckduckgo']) {
		const icon = brandIcon(code, 22);
		assert.equal(icon.tag, 'svg');
		assert.equal(icon.attrs['aria-hidden'], 'true');
		assert.equal(icon.attrs.width, '22');
		assert.ok(icon.innerHTML.length > 20, `${code} icon has a glyph`);
	}
	// Unknown codes fall back to a neutral glyph.
	const unknown = brandIcon('netscape', 22);
	assert.ok(unknown.innerHTML.includes('currentColor'));
});
