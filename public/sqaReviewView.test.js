import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSqaVersions } from './sqaReviewView.js';

test('version comparison detects evidence-only, rationale and status changes by control ID', () => {
	const old = { results: [{ controlId: 'A', status: 'pass', evidence: [{ reference: 'old' }] }, { controlId: 'B', status: 'blocked', rationale: 'Missing.', evidence: [] }] };
	const current = { results: [{ controlId: 'B', status: 'pass', evidence: [{ reference: 'new' }] }, { controlId: 'A', status: 'pass', evidence: [{ reference: 'revised' }] }] };
	const changes = compareSqaVersions(old, current);
	assert.equal(changes.length, 2);
	assert.equal(changes.find(item => item.controlId === 'A').evidenceChanged, true);
	assert.deepEqual(compareSqaVersions(old, old), []);
});
