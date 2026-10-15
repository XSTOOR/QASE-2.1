import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCaseSummary, environmentPatch, matchesSearch } from '../public/testCaseView.js';
import { pairsToRun } from '../public/bulkRunView.js';

test('testCaseSummary handles 0, 1, and many', () => {
	assert.equal(testCaseSummary([]), 'No test cases yet.');
	assert.equal(testCaseSummary([{ caseNumber: 'TC-0001' }]), '1 test case');
	assert.equal(testCaseSummary([{}, {}, {}]), '3 test cases');
});

test('environmentPatch computes add/remove diffs and null for no-op', () => {
	assert.equal(environmentPatch(['A', 'B'], ['B', 'A']), null);
	assert.deepEqual(environmentPatch(['A'], ['A', 'B']), { addEnvironmentIds: ['B'] });
	assert.deepEqual(environmentPatch(['A', 'B'], ['A']), { removeEnvironmentIds: ['B'] });
	assert.deepEqual(environmentPatch([], ['X', 'Y']), { addEnvironmentIds: ['X', 'Y'] });
	assert.deepEqual(environmentPatch(['X'], []), { removeEnvironmentIds: ['X'] });
});

test('matchesSearch matches number, title, and tags; blank term matches everything', () => {
	const testCase = { caseNumber: 'TC-0042', title: 'Checkout completes', tags: ['smoke', 'regression'] };
	assert.equal(matchesSearch(testCase, ''), true);
	assert.equal(matchesSearch(testCase, 'tc-0042'), true);
	assert.equal(matchesSearch(testCase, 'checkout'), true);
	assert.equal(matchesSearch(testCase, 'SMOKE'), true);
	assert.equal(matchesSearch(testCase, 'login'), false);
});

test('pairsToRun expands all-assigned or single-environment selections', () => {
	const cases = [
		{ caseNumber: 'TC-0001', environmentIds: ['E1', 'E2'] },
		{ caseNumber: 'TC-0002', environmentIds: ['E2'] },
		{ caseNumber: 'TC-0003', environmentIds: [] }
	];
	const all = pairsToRun(cases, 'all');
	assert.deepEqual(all.map((p) => `${p.testCase.caseNumber}@${p.envId}`), ['TC-0001@E1', 'TC-0001@E2', 'TC-0002@E2']);

	const single = pairsToRun(cases, 'E2');
	assert.deepEqual(single.map((p) => `${p.testCase.caseNumber}@${p.envId}`), ['TC-0001@E2', 'TC-0002@E2']);

	const none = pairsToRun(cases, 'E-NOPE');
	assert.equal(none.length, 0);
	assert.deepEqual(pairsToRun([], 'all'), []);
});
