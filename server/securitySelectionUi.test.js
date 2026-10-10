import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

const launcherBlock = () => app.slice(
	app.indexOf('const qaUi'),
	app.indexOf('async function openSqaStart') === -1 ? undefined : app.indexOf('async function openSqaStart')
);

test('the QA dialog renders grouped test categories with tri-state headers', () => {
	// Standard + Security sections inside the one fieldset, Studio grid reuse.
	assert.match(html, /<section class="qa-category" id="qa-category-standard">/);
	assert.match(html, /<section class="qa-category" id="qa-category-security" hidden>/);
	assert.match(html, /<div class="sqa-option-grid" id="qa-test-options"><\/div>/);
	assert.match(html, /<div class="sqa-option-grid" id="qa-security-options"><\/div>/);
	// Category header toggles for the tri-state select/deselect behavior.
	assert.match(html, /<input type="checkbox" id="qa-category-standard-toggle" checked>/);
	// Security ships UNCHECKED in the static markup: security checks are opt-in
	// (they require explicit authorization), and the section starts hidden until
	// the catalog paints it. syncQaCategoryToggles() drives checked/indeterminate
	// at runtime; the static default stays unchecked.
	assert.match(html, /<section class="qa-category" id="qa-category-security" hidden>\s*<h4[^>]*>\s*<label class="check qa-category-toggle">\s*<input type="checkbox" id="qa-category-security-toggle">/);
	assert.match(html, /<span>Security testing<\/span>/);
});

test('the frontend paints categories from the catalog payload', () => {
	const block = launcherBlock();
	// Grouping by category from the API payload (category + availability).
	assert.match(block, /test\.category \?\? 'standard'/);
	// Security grid is hidden until the catalog actually has security checks.
	assert.match(block, /qaUi\.securityCategory\.hidden = byCategory\.get\('security'\)\.length === 0/);
	// Tri-state sync: checked/indeterminate derived from the section's inputs.
	assert.match(block, /toggle\.indeterminate = checked > 0 && checked < inputs\.length/);
	// Category toggle select/deselects its own available checks.
	assert.match(block, /qaSelectableInputs\(section\)/);
	assert.match(block, /for \(const input of inputs\) input\.checked = willCheck/);
	// Bulk controls span both categories via qaSelectableInputs().
	assert.match(block, /qaUi\.selectAll\.onclick = \(\) => \{\s*for \(const input of qaSelectableInputs\(\)\)/);
	assert.match(block, /qaUi\.deselectAll\.onclick = \(\) => \{\s*for \(const input of qaSelectableInputs\(\)\)/);
});

test('unavailable checks render disabled, unchecked, and labeled — never selectable', () => {
	const block = launcherBlock();
	// Only non-disabled inputs count as selectable, checked or catalog size.
	assert.match(block, /querySelectorAll\('input\[name="qa-test"\]:not\(\[disabled\]\)'\)/);
	// Unavailable checks are disabled with aria-disabled and their reason shown.
	assert.match(block, /input\.disabled = true;\s*\n\s*input\.setAttribute\('aria-disabled', 'true'\)/);
	assert.match(block, /is-unavailable/);
	assert.match(block, /qa-unavailable-reason/);
	// Safe DOM construction only — no innerHTML anywhere in the block.
	assert.doesNotMatch(block, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/);
});

test('unavailable check styling matches Studio (muted, dashed, non-interactive)', () => {
	assert.match(styles, /\.sqa-option\.is-unavailable/);
	assert.match(styles, /\.qa-unavailable-reason/);
	assert.match(styles, /\.qa-category-toggle input:indeterminate/);
});
