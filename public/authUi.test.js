import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./auth.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const gate = html.slice(html.indexOf('<section class="auth-gate"'), html.indexOf('<a class="skip-link"'));

test('sign-in has its own responsive identity layer and no terminal effects', () => {
  assert.ok(html.indexOf('href="auth.css?') > html.indexOf('href="brand.css?'));
  assert.doesNotMatch(html, /src="entry-motion.js|href="entry-terminal.css/);
  assert.match(gate, /class="auth-brand"[^>]+aria-label="QASE home"/);
  assert.match(css, /background: var\(--brand-mark-image\)/);
  assert.match(css, /height: 100dvh/);
  assert.match(css, /overflow: auto/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /max-height: 800px/);
  assert.match(css, /input:not\(\[type="checkbox"\]\) \{ font-size: 16px; \}/);
  assert.match(css, /\.auth-story \{ display: none; \}/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});
test('all existing authentication controls remain unique and properly associated', () => {
  for (const id of ['auth-form', 'auth-email', 'auth-password', 'auth-show-password', 'auth-submit', 'auth-switch', 'auth-forgot-switch', 'forgot-form', 'recover-form', 'otp-form', 'reset-form']) {
    assert.equal(gate.split(`id="${id}"`).length - 1, 1, id);
  }
  assert.match(gate, /label for="auth-email"/);
  assert.match(gate, /type="email" autocomplete="email"/);
  assert.match(gate, /autocomplete="current-password"/);
  assert.match(gate, /id="auth-error" role="alert" hidden/);
  assert.match(app, /passwordHint\.hidden = !register/);
  assert.match(app, /focus\(\{ preventScroll: true \}\)/);
});
test('entry actions have loading, failure, visibility, and keyboard feedback', () => {
  assert.match(app, /'Creating account…' : 'Signing in…'/);
  assert.match(app, /el\.authSubmit\.textContent = authRegisterMode \? 'Create account' : 'Sign in'/);
  assert.match(css, /\.auth-submit::after \{ content: none; \}/);
  assert.match(css, /input:not\(\[type="checkbox"\]\):focus/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(css, /linear-gradient|drop-shadow/i);
  assert.match(app, /signin: 'auth-title', forgot: 'forgot-title', recover: 'recover-title'/);
});
