import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./brand.css', import.meta.url), 'utf8');
const mark = readFileSync(new URL('./qase-mark.svg', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const whiteMark = readFileSync(new URL('./qase-mark-white.svg', import.meta.url), 'utf8');
const legacyStyles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('shared brand layer loads after page-specific styles and uses a local vector favicon', () => {
  assert.ok(html.indexOf('href="brand.css?') > html.indexOf('href="resultsPage.css?'));
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="qase-mark.svg"/);
  assert.match(mark, /viewBox="0 0 80 80"/);
  assert.match(mark, /linearGradient/);
  assert.doesNotMatch(mark, /<script|<image/);
});

test('brand styling covers each existing destination without replacing navigation handlers', () => {
  for (const selector of ['.runs', '.feature-dock', '#qa-start', '.account-section', '.bugs-view', '.results-page-head', '#auth-gate', '.modal-head']) {
    assert.ok(css.includes(selector), `${selector} has shared brand presentation`);
  }
  for (const id of ['sidebar-collapse-toggle', 'sidebar-new-run', 'sidebar-open-settings', 'sidebar-open-profile', 'sidebar-sign-out', 'new-run', 'new-sqa', 'new-founder', 'open-bugs']) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `${id} remains unique`);
  }
  assert.match(html, /class="brand-mark" aria-label="QASE"/);
});

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + .05) / (darker + .05);
}
test('both palettes have accessible text, muted text, and primary-button contrast', () => {
  const themes = css.split('/* Shared vector mark')[0].matchAll(/--surface-1: (#[a-f\d]+);[\s\S]*?--text: (#[a-f\d]+);[\s\S]*?--text-muted: (#[a-f\d]+);[\s\S]*?--brand-primary: (#[a-f\d]+);[\s\S]*?--brand-on-primary: (#[a-f\d]+);/gi);
  let count = 0;
  for (const [, surface, text, muted, primary, onPrimary] of themes) {
    count++;
    assert.ok(contrast(text, surface) >= 7, 'body text meets AAA');
    assert.ok(contrast(muted, surface) >= 4.5, 'secondary text meets AA');
    assert.ok(contrast(primary, onPrimary) >= 4.5, 'primary action label meets AA');
  }
  assert.equal(count, 2);
});

test('keyboard focus, reduced motion, and narrow-screen layouts remain supported', () => {
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /\.journey-step\[hidden\] \{ display: none; \}/);
});

test('background feedback loading cannot interrupt destination navigation', () => {
  const sync = app.slice(app.indexOf('async function syncFeedbackForSession'), app.indexOf('async function openFeedbackModal'));
  assert.doesNotMatch(sync, /openFeedbackModal\(\)/);
  assert.match(app, /provideFeedback\.onclick = \(\) => openFeedbackModal\(\)/);
});

test('dark palette is strictly neutral and uses the white vector mark', () => {
  const dark = css.split('html[data-theme="dark"] body.studio-workspace {')[1].split('}')[0];
  const colors = [...dark.matchAll(/#([a-f\d]{6})(?![a-f\d])/gi)];
  assert.ok(colors.length >= 25);
  for (const [, hex] of colors) {
    assert.equal(hex.slice(0, 2), hex.slice(2, 4), hex);
    assert.equal(hex.slice(2, 4), hex.slice(4, 6), hex);
  }
  assert.match(dark, /--brand-primary: #ffffff/);
  assert.match(dark, /--brand-on-primary: #000000/);
  assert.match(dark, /--brand-mark-image: url\("qase-mark-white.svg"\)/);
  assert.doesNotMatch(whiteMark, /linearGradient|<image|<script/);
  assert.equal([...whiteMark.matchAll(/fill="#fff"/g)].length, 2);
  assert.match(css, /background: var\(--brand-primary-hover\)/);
  assert.match(app, /applied === 'dark' \? 'qase-mark-white.svg' : 'qase-mark.svg'/);
});

test('dark surfaces have a deliberate gray elevation hierarchy and contained focus styles', () => {
  const dark = css.split('html[data-theme="dark"] body.studio-workspace {')[1].split('}')[0];
  const shade = token => parseInt(dark.match(new RegExp(`${token}: #([a-f\\d]{6})`))[1].slice(0, 2), 16);
  assert.ok(shade('--panel-sidebar') < shade('--panel-chat'));
  assert.ok(shade('--canvas') < shade('--surface-2'));
  assert.ok(shade('--surface-2') < shade('--surface-1'));
  assert.ok(shade('--surface-1') < shade('--surface-3'));
  assert.ok(shade('--surface-3') < shade('--surface-hover'));
  assert.match(css, /#composer:focus-within \{ outline: 1px solid var\(--text-muted\)/);
  assert.match(css, /#composer textarea \{ background: transparent; border: 0;/);
});

test('semantic lights restore colors without tinting dark chrome or primary actions', () => {
  for (const [status, signal] of [['done', 'success'], ['completed', 'success'], ['running', 'running'], ['awaiting_input', 'warning'], ['blocked', 'warning'], ['error', 'error'], ['queued', 'muted']]) {
    const rule = css.split('\n').find(line => line.includes(`[data-status="${status}"]`) && line.includes('--status-light:'));
    assert.ok(rule?.includes(`var(--signal-${signal})`), status);
  }
  assert.match(css, /\.run \.dot \{\s*background: var\(--status-light\) !important/);
  assert.match(css, /\.status-chip, \.run-status, \.live-pill\)::before \{\s*background: var\(--status-light\) !important/);
  assert.match(css, /#browser-dot \{ background: var\(--status-light\)/);
  assert.match(app, /el\.browserDot\.dataset\.status = displayStatus/);
  assert.match(css, /#ldv-live\):not\(\[hidden\]\)/);
});

test('all primary-action states have readable palettes without Founder-only overrides', () => {
  assert.doesNotMatch(legacyStyles, /\.founder-submit\s*\{[^}]*!important/);
  assert.match(css, /\.btn:disabled \{\s*opacity: 1;/);
  assert.match(css, /\.btn-primary:disabled \{\s*color: #bdbdbd; background: #343434;/);
  for (const [foreground, background] of [['#ffffff', '#315de7'], ['#000000', '#ffffff'], ['#bdbdbd', '#343434'], ['#aaaaaa', '#282828']]) {
    assert.ok(contrast(foreground, background) >= 4.5, `${foreground} on ${background}`);
  }
});

test('browser choices retain full brand colors and explicit selected/unavailable states in dark mode', () => {
  assert.match(css, /:is\(\.mx-brand-icon, \.mp-browser-icon, \.browser-icon\) \{ filter: none; \}/);
  assert.doesNotMatch(css, /:is\([^)]*\.mx-brand-icon[^)]*\) \{ filter: grayscale/);
  for (const browser of ['chrome', 'edge', 'firefox', 'safari', 'brave', 'opera', 'duckduckgo']) {
    assert.ok(css.includes(`[data-family="${browser}"] { --browser-brand:`));
  }
  assert.match(css, /\.mp-browser\[aria-pressed="true"\]/);
  assert.match(css, /\.mp-browser:disabled \{ opacity: 1;/);
});
