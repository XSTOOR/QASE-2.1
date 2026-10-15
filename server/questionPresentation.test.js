import assert from 'node:assert/strict';
import test from 'node:test';
import { isCredentialQuestion } from '../public/questionPresentation.js';

test('persisted plural credential questions recover to the vault form', () => {
	assert.equal(isCredentialQuestion({
		question: 'How should the assessment proceed?',
		options: [{ label: 'Use vaulted credentials' }, { label: 'Public-only scope' }],
		credentialLike: false
	}), true);
	assert.equal(isCredentialQuestion({
		question: 'Provide credentials for the authenticated workflows.',
		options: [],
		credentialLike: false
	}), true);
});

test('ordinary decisions are not routed to the credential vault', () => {
	assert.equal(isCredentialQuestion({
		question: 'Choose the assessment scope.',
		options: [{ label: 'Public pages' }, { label: 'Full product' }],
		credentialLike: false
	}), false);
});
