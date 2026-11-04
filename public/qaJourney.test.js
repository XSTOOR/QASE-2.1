import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaJourney, normalizeWebsite } from './qaJourney.js';
import { workflowStatus } from './workflowStatus.js';

for (const ready of [true, false]) test(`platform model readiness (${ready}) never requires provider setup`, () => {
	const nodes = new Map();
	const node = id => {
		if (!nodes.has(id)) nodes.set(id, {
			value: '', dataset: {}, listeners: {},
			addEventListener(type, callback) { this.listeners[type] = callback; },
			setAttribute() {}, removeAttribute() {}, setCustomValidity() {},
			querySelector() { return { focus() {}, scrollTop: 0 }; },
			querySelectorAll(selector) { return selector === '[data-journey-panel]' ? [node('panel0'), node('panel1'), node('panel2')] : []; }
		});
		return nodes.get(id);
	};
	node('qa-target-url').value = 'https://example.com';
	const journey = createQaJourney({ document: { getElementById: node }, changed() {}, getState: () => ({ config: { ready, model: 'platform-model' }, checks: 1, configurations: 1 }) });
	journey.start();
	node('journey-next').listeners.click();
	node('journey-next').listeners.click();
	assert.equal(journey.step, 2);
	assert.equal(node('qa-submit').hidden, false);
	assert.equal(node('journey-review-model').textContent, 'platform-model');
	assert.equal(nodes.has('journey-setup'), false);
	assert.equal(nodes.has('journey-configure'), false);
	assert.doesNotMatch(node('journey-footer-hint').textContent, /API key|[Cc]onnect|[Ss]ettings/);
	if (!ready) assert.match(node('journey-footer-hint').textContent, /model service is unavailable/);
});

test('a bare domain becomes a valid HTTPS target while explicit HTTP is preserved', () => {
	assert.equal(normalizeWebsite(' example.com/path?q=1 '), 'https://example.com/path?q=1');
	assert.equal(normalizeWebsite('http://localhost:5173/demo'), 'http://localhost:5173/demo');
});

test('browser validation blocks Review and Start consistently and recovers without losing the selected browser', () => {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', dataset: {}, listeners: {},
      addEventListener(type, callback) { this.listeners[type] = callback; }, setAttribute() {}, removeAttribute() {}, setCustomValidity() {},
      querySelector() { return { focus() {}, scrollTop: 0 }; },
      querySelectorAll(selector) { return selector === '[data-journey-panel]' ? [node('panel0'), node('panel1'), node('panel2')] : []; } });
    return nodes.get(id);
  };
  let blocked = 'Refresh browser details. Your setup is kept.';
  node('qa-target-url').value = 'https://example.com';
  const journey = createQaJourney({ document: { getElementById: node }, changed() {}, getState: () => ({ config: { ready: true }, checks: 8, configurations: 1, browserLabel: 'Chrome 151', blocked }) });
  journey.start(); node('journey-next').listeners.click();
  assert.equal(journey.step, 1); assert.equal(node('journey-next').disabled, true);
  assert.match(node('journey-footer-hint').textContent, /Refresh browser details/);
  node('journey-next').listeners.click(); assert.equal(journey.step, 1);
  blocked = null; journey.sync();
  assert.equal(node('journey-next').disabled, false);
  node('journey-next').listeners.click(); assert.equal(journey.step, 2);
  assert.equal(node('journey-review-devices').textContent, 'Chrome 151'); assert.equal(node('qa-submit').disabled, false);
  blocked = 'Browser disconnected'; journey.sync();
  assert.equal(node('qa-submit').disabled, true);
});
test('unsupported schemes and URLs containing credentials cannot become launcher targets', () => {
	for (const input of ['', 'https://', 'file:///etc/passwd', 'ftp://example.com', 'https://user:secret@example.com', 'not a website']) assert.equal(normalizeWebsite(input), '', input);
});
test('a blocked terminal run is explained as blocked rather than successful', () => {
	const guidance = workflowStatus({ status: 'done', report: { verdict: 'blocked' }, findings: [] });
	assert.equal(guidance.destination, 'results');
	assert.equal(guidance.tone, 'attention');
	assert.match(guidance.title, /prerequisite/);
});
test('pending questions take priority over an active status', () => {
	const guidance = workflowStatus({ status: 'running', pendingQuestion: { question: 'Sign in?' } });
	assert.equal(guidance.destination, 'question');
});
test('completed runs guide users to results and include the observed finding count', () => {
	const guidance = workflowStatus({ status: 'done', findings: [{}, {}] });
	assert.equal(guidance.destination, 'results');
	assert.match(guidance.description, /^2 findings/);
});
