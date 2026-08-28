import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMobileAudit, runMobileAudit } from './mobileAudit.js';

test('summarize is undefined when nothing is wrong', () => {
	assert.equal(summarizeMobileAudit({
		viewport: { present: true, content: 'width=device-width, initial-scale=1', userScalable: true, widthDeviceWidth: true },
		overflow: { clientWidth: 393, scrollWidth: 393, overflowsBy: 0 },
		tapTargets: []
	}), undefined);
});

test('summarize reports missing viewport meta', () => {
	const result = summarizeMobileAudit({
		viewport: { present: false, content: '', userScalable: true, widthDeviceWidth: false },
		overflow: { clientWidth: 393, scrollWidth: 393, overflowsBy: 0 },
		tapTargets: []
	});
	assert.ok(result);
	assert.equal(result.problems.length, 1);
	assert.equal(result.problems[0].kind, 'viewport_missing');
});

test('summarize reports disabled scaling and non device-width viewport', () => {
	const result = summarizeMobileAudit({
		viewport: { present: true, content: 'width=1024, user-scalable=no', userScalable: false, widthDeviceWidth: false },
		overflow: { clientWidth: 393, scrollWidth: 393, overflowsBy: 0 },
		tapTargets: []
	});
	const kinds = result.problems.map(p => p.kind);
	assert.deepEqual(kinds.sort(), ['viewport_no_scaling', 'viewport_not_device_width'].sort());
});

test('summarize flags horizontal overflow beyond 1 pixel only', () => {
	const clean = summarizeMobileAudit({
		viewport: { present: true, content: 'width=device-width', userScalable: true, widthDeviceWidth: true },
		overflow: { clientWidth: 393, scrollWidth: 394, overflowsBy: 1 },
		tapTargets: []
	});
	assert.equal(clean, undefined);
	const bad = summarizeMobileAudit({
		viewport: { present: true, content: 'width=device-width', userScalable: true, widthDeviceWidth: true },
		overflow: { clientWidth: 393, scrollWidth: 450, overflowsBy: 57 },
		tapTargets: []
	});
	assert.equal(bad.problems[0].kind, 'horizontal_overflow');
	assert.equal(bad.problems[0].scrollWidth, 450);
});

test('summarize reports small tap targets and returns at most 5 examples', () => {
	const tapTargets = Array.from({ length: 12 }, (_, i) => ({ tag: 'a', label: 'link ' + i, width: 20, height: 20 }));
	const result = summarizeMobileAudit({
		viewport: { present: true, content: 'width=device-width', userScalable: true, widthDeviceWidth: true },
		overflow: { clientWidth: 393, scrollWidth: 393, overflowsBy: 0 },
		tapTargets
	});
	assert.equal(result.problems[0].kind, 'small_tap_targets');
	assert.equal(result.problems[0].examples.length, 5);
	assert.equal(result.undersizedCount, 12);
});

test('runMobileAudit tolerates a missing/faulty page without throwing', async () => {
	assert.equal(await runMobileAudit(undefined), undefined);
	assert.equal(await runMobileAudit({ evaluate: async () => { throw new Error('boom'); } }), undefined);
});
