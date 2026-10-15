import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandSelection, summarizeCombos, groupEnvironmentsByDevice, debounce, coverageCellMeta } from '../public/deviceMatrixView.js';

test('expandSelection cross-products devices × OS × browsers in input order', () => {
	const combos = expandSelection({
		devices: [
			{ slug: 'IPHONE16PRO', display: 'iPhone 16 Pro' },
			{ slug: 'IPADAIRM2', display: 'iPad Air (M2)' }
		],
		osVersions: [
			{ id: 'ios:18.3', display: 'iOS 18.3' },
			{ id: 'ios:26.1', display: 'iOS 26.1' }
		],
		browsers: [{ code: 'chrome', version: '141', display: 'Chrome 141' }]
	});
	assert.equal(combos.length, 4);
	assert.deepEqual(combos.map((c) => `${c.device}|${c.osVersion}|${c.browser}`), [
		'IPHONE16PRO|ios:18.3|chrome',
		'IPHONE16PRO|ios:26.1|chrome',
		'IPADAIRM2|ios:18.3|chrome',
		'IPADAIRM2|ios:26.1|chrome'
	]);
	assert.equal(combos[0].deviceDisplay, 'iPhone 16 Pro');
	assert.equal(combos[0].browserVersion, '141');
});

test('expandSelection tolerates empty dimensions (no NaN, no phantom combos)', () => {
	assert.deepEqual(expandSelection({ devices: [{ slug: 'A', display: 'A' }] }), []);
	assert.deepEqual(expandSelection({}), []);
	assert.deepEqual(expandSelection(null), []);
});

test('summarizeCombos truncates beyond the limit with a remainder marker', () => {
	const combos = Array.from({ length: 8 }, (_, i) => ({ device: `d${i}`, osVersion: 'o', browser: 'b' }));
	const summarized = summarizeCombos(combos, 5);
	assert.equal(summarized.length, 6);
	assert.equal(summarized[5].summaryOnly, true);
	assert.equal(summarized[5].remaining, 3);
	assert.deepEqual(summarizeCombos(combos.slice(0, 5), 5).map((c) => c.device), ['d0', 'd1', 'd2', 'd3', 'd4']);
});

test('groupEnvironmentsByDevice keeps device order and groups rows', () => {
	const grouped = groupEnvironmentsByDevice([
		{ envId: 'E1', device: 'iPhone 16 Pro' },
		{ envId: 'E2', device: 'iPad Air (M2)' },
		{ envId: 'E3', device: 'iPhone 16 Pro' }
	]);
	assert.deepEqual(grouped.map((g) => g.device), ['iPhone 16 Pro', 'iPad Air (M2)']);
	assert.deepEqual(grouped[0].rows.map((r) => r.envId), ['E1', 'E3']);
	assert.deepEqual(groupEnvironmentsByDevice([]), []);
});

test('debounce collapses bursts into a single trailing call', async () => {
	let calls = 0;
	const fn = debounce(() => { calls += 1; }, 20);
	fn(); fn(); fn();
	assert.equal(calls, 0);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal(calls, 1);
});

test('coverageCellMeta maps every cell state to a distinct honest label', () => {
	assert.deepEqual(coverageCellMeta(undefined), { label: '', cls: 'cov-none', title: 'Never run' });
	assert.deepEqual(coverageCellMeta(null), { label: '', cls: 'cov-none', title: 'Never run' });
	// Live states pulse; they are never a pass.
	assert.equal(coverageCellMeta({ status: 'running' }).cls, 'cov-live');
	assert.equal(coverageCellMeta({ status: 'awaiting_input' }).cls, 'cov-live');
	// An idle run was created but never started — static, not in flight.
	assert.equal(coverageCellMeta({ status: 'idle' }).cls, 'cov-idle');
	// Executed with verdict.
	assert.equal(coverageCellMeta({ status: 'done', verdict: 'pass' }).cls, 'cov-pass');
	assert.equal(coverageCellMeta({ status: 'done', verdict: 'pass_with_issues' }).cls, 'cov-pass-warn');
	assert.equal(coverageCellMeta({ status: 'done', verdict: 'fail' }).cls, 'cov-fail');
	assert.equal(coverageCellMeta({ status: 'done', verdict: 'blocked' }).cls, 'cov-blocked');
	// Executed WITHOUT a verdict: neutral "executed", never a pass.
	assert.equal(coverageCellMeta({ status: 'done' }).cls, 'cov-exec');
	assert.equal(coverageCellMeta({ status: 'error', verdict: undefined }).cls, 'cov-exec');
	// Every cls used by the matrix is distinct.
	const classes = [
		'cov-none', 'cov-idle', 'cov-live', 'cov-pass', 'cov-pass-warn', 'cov-fail', 'cov-blocked', 'cov-exec'
	];
	assert.equal(new Set(classes).size, classes.length);
});
