import test from 'node:test';
import assert from 'node:assert/strict';
import { QA_SCOPE_OPTIONS, BROWSER_ONLY_SCOPE_VALUES, buildQaKickoffMessage, normalizeQaScopeSelection } from '../public/qaScopeCatalog.js';

test('catalogue groups the UI & User Experience options', () => {
	const uiux = QA_SCOPE_OPTIONS.filter(option => option.group === 'uiux').map(option => option.value);
	assert.deepEqual(uiux, ['desktop-layout', 'mobile-layout', 'ui-consistency', 'content-validation', 'browser-compatibility']);
	const other = QA_SCOPE_OPTIONS.filter(option => option.group === 'other').map(option => option.value);
	assert.deepEqual(other, ['forms', 'console-errors', 'navigation', 'accessibility', 'security']);
});

test('buildQaKickoffMessage never emits browser-compatibility to the agent', () => {
	const message = buildQaKickoffMessage(['desktop-layout', 'browser-compatibility']);
	assert.equal(message, 'Test this website, focusing on: desktop layout and responsive behaviour across viewport widths.');
});

test('normalizeQaScopeSelection whitelists, de-duplicates and drops junk', () => {
	assert.deepEqual(normalizeQaScopeSelection(['forms', 'junk', 'forms']), ['forms']);
	assert.deepEqual(normalizeQaScopeSelection([]), []);
	assert.deepEqual(normalizeQaScopeSelection('forms'), undefined);
	assert.deepEqual(normalizeQaScopeSelection(null), undefined);
});
