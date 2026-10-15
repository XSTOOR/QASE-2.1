import assert from 'node:assert/strict';
import test from 'node:test';
import { followUpSuggestions, buildFollowUpMessage } from '../public/followUp.js';

test('followUpSuggestions merges notCovered and recommendations, dedupes, keeps order', () => {
	const report = {
		notCovered: ['Checkout flow behind login', '', 'Mobile menu'],
		recommendations: ['mobile menu', 'Re-test after the fix deploy', 'Mobile menu']
	};
	assert.deepEqual(followUpSuggestions(report), [
		'Checkout flow behind login',
		'Mobile menu',
		'Re-test after the fix deploy'
	]);
});

test('followUpSuggestions tolerates missing report fields', () => {
	assert.deepEqual(followUpSuggestions(undefined), []);
	assert.deepEqual(followUpSuggestions({}), []);
	assert.deepEqual(followUpSuggestions({ notCovered: null, recommendations: null }), []);
});

test('buildFollowUpMessage lists each selected item under the target URL', () => {
	const message = buildFollowUpMessage('https://example.test/', ['Checkout flow', 'Mobile menu']);
	assert.match(message, /^Run a focused QA pass on https:\/\/example\.test\/\./);
	assert.match(message, /- Checkout flow/);
	assert.match(message, /- Mobile menu/);
});

test('buildFollowUpMessage rejects empty selections or missing URL', () => {
	assert.equal(buildFollowUpMessage('https://example.test/', []), null);
	assert.equal(buildFollowUpMessage(undefined, ['a']), null);
});
