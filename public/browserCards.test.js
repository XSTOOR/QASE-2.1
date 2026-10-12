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

test('#15968: browsers render as one-click toggle cards, not checkboxes', () => {
	assert.match(app, /dataset\.role = 'browser-card'/);
	assert.match(app, /qa-matrix-browser-cards/);
	assert.match(app, /qa-matrix-browser-card\$\{family\.available \? '' : ' is-unavailable'\}/);
	// The old checkbox checklist markup is gone from the render path.
	assert.doesNotMatch(app, /qa-matrix-family-label/);
	assert.doesNotMatch(app, /dataset\.family = family\.code;\s*\n\s*const input = document\.createElement\('input'\)/);
	assert.doesNotMatch(app, /qa-matrix-family-count/);
});

test('#15968: card click toggles the family exactly once through the explicit model', () => {
	const cardIndex = app.indexOf("card.dataset.role = 'browser-card'");
	assert.ok(cardIndex !== -1, 'browser card must exist');
	const cardBlock = app.slice(cardIndex, app.indexOf("matrix.browsers.append(cardList);"));
	assert.match(cardBlock, /toggleBrowserFamily\(next, qaMatrixState\.index, family\.code, !selection\.browserFamilies\.has\(family\.code\)\)/);
	assert.match(cardBlock, /qaMatrixApplySelection\(next\)/);
	// Cards expose pressed state for assistive tech.
	assert.match(cardBlock, /aria-pressed/);
});

test('#15968: unavailable browsers render disabled with an honest reason', () => {
	const cardIndex = app.indexOf("card.dataset.role = 'browser-card'");
	const cardBlock = app.slice(cardIndex, app.indexOf("matrix.browsers.append(cardList);"));
	assert.match(cardBlock, /card\.disabled = true/);
	assert.match(cardBlock, /family\.reason \?\? 'Not available'/);
	assert.match(cardBlock, /is-unavailable-badge/);
});

test('#15968: bulk actions remain (Select all available / Clear)', () => {
	assert.match(app, /select-all-browsers/);
	assert.match(app, /deselect-all-browsers/);
	assert.match(app, /textContent = 'Select all available'/);
	assert.match(app, /textContent = 'Clear'/);
	assert.match(app, /selectAllBrowsers\(qaMatrixState\.index, selection\)/);
});

test('#15968: cards carry brand icon + version + device count', () => {
	const cardIndex = app.indexOf("card.dataset.role = 'browser-card'");
	const cardBlock = app.slice(cardIndex, app.indexOf("matrix.browsers.append(cardList);"));
	assert.match(cardBlock, /brandIcon\(family\.code, 22\)/);
	assert.match(cardBlock, /qa-matrix-browser-card-version/);
	assert.match(cardBlock, /qa-matrix-browser-card-devices/);
});

test('#15968: styles define selected, unavailable and focus states', () => {
	assert.match(styles, /\.qa-matrix-browser-cards/);
	assert.match(styles, /\.qa-matrix-browser-card\.is-selected/);
	assert.match(styles, /\.qa-matrix-browser-card\.is-unavailable/);
	assert.match(styles, /\.qa-matrix-browser-card:focus-visible/);
	// Narrow-width fallback: cards go full-width on phones.
	assert.match(styles, /@media \(max-width: 560px\)[\s\S]*\.qa-matrix-browser-card \{ flex: 1 1 100%; \}/);
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
