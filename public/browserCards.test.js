import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
test("browser chips expose explicit pressed state and a single family toggle", () => {
	assert.ok(picker.includes("mp-browser"), "mp-browser");
	assert.ok(picker.includes("aria-pressed"), "aria-pressed");
	assert.ok(picker.includes("next.browserFamilies.delete(family.code)"), "next.browserFamilies.delete(family.code)");
	assert.ok(picker.includes("next.browserFamilies.add(family.code)"), "next.browserFamilies.add(family.code)");
});

test("unavailable browsers stay disabled and explain their reason", () => {
	assert.ok(picker.includes("item.disabled = !family.available"), "item.disabled = !family.available");
	assert.ok(picker.includes("family.reason"), "family.reason");
});

test("bulk selection is explicitly scoped to shown devices", () => {
	assert.ok(picker.includes("Select shown devices"), "Select shown devices");
	assert.ok(picker.includes("visible.flatMap"), "visible.flatMap");
	assert.ok(picker.includes("Clear shown devices"), "Clear shown devices");
});

test("browser icons and exact version review are retained", () => {
	assert.ok(picker.includes("brandIcon(family.code, 20)"), "brandIcon(family.code, 20)");
	assert.ok(picker.includes("config.browserVersion"), "config.browserVersion");
	assert.ok(picker.includes("Review exact configurations"), "Review exact configurations");
});

test("keyboard focus is restored after selection changes", () => {
	assert.ok(picker.includes("focusKey"), "focusKey");
	assert.ok(picker.includes("focus({ preventScroll: true })"), "focus({ preventScroll: true })");
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
