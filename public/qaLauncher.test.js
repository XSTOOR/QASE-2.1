import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQaKickoffMessage } from '../public/qaKickoff.js';

test('buildQaKickoffMessage returns null for a full sweep (plain URL kickoff)', () => {
	assert.equal(buildQaKickoffMessage([
		'desktop-layout', 'mobile-layout', 'ui-consistency', 'content-validation',
		'forms', 'console-errors', 'navigation', 'accessibility', 'security'
	]), null);
	assert.equal(buildQaKickoffMessage(undefined), null, 'no selection = default sweep');
});

test('buildQaKickoffMessage builds a focused instruction for a subset', () => {
	const message = buildQaKickoffMessage(['forms', 'console-errors']);
	assert.ok(message.startsWith('Test this website, focusing on: '), message);
	assert.match(message, /forms and input validation/);
	assert.match(message, /console errors and failed network requests/);
});

test('buildQaKickoffMessage covers the new UI/UX scope values', () => {
	const message = buildQaKickoffMessage(['ui-consistency', 'content-validation']);
	assert.ok(message.startsWith('Test this website, focusing on: '), message);
	assert.match(message, /UI consistency: buttons, fonts, colors, spacing/);
	assert.match(message, /content and text validation: displayed text, labels, headings/);
});

test('buildQaKickoffMessage returns null when nothing is selected', () => {
	assert.equal(buildQaKickoffMessage([]), null);
});
