import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeErrorDetail } from './errorSanitizer.js';

test('external error details remove credentials, query data, control characters, and excess length', () => {
	const detail = sanitizeErrorDetail(new Error(
		'Provider failed Authorization: Bearer example-sensitive-value ' +
		'password=hunter2 at https://user:pass@example.test/model?token=value#private\u0000 ' +
		'x'.repeat(3_000)
	));
	assert.doesNotMatch(detail, /example-sensitive-value|hunter2|user:pass|token=value|#private/);
	assert.match(detail, /\[redacted/);
	assert.match(detail, /https:\/\/example\.test\/model/);
	assert.ok(detail.length <= 1_000);
});

test('plain operational messages remain readable', () => {
	assert.equal(sanitizeErrorDetail(new Error('runtime configuration invalid')), 'runtime configuration invalid');
});
