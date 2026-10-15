/**
 * Matrix coverage gap aggregation tests (#14652 NI04).
 *
 * Honesty rules verified: every number from actual item records; browsers/
 * categories covered only with executed items; DuckDuckGo carries its
 * recorded reason; empty matrix reports zeros; unknown statuses are
 * preserved, never coerced to PASS.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { computeMatrixCoverage, categoryOf, gapLabel } from './matrixCoverage.js';

function item(patch = {}) {
	return {
		id: patch.id ?? 'i1',
		profileId: patch.profileId ?? 'profile-x',
		platform: patch.platform ?? 'ios',
		deviceType: patch.deviceType ?? 'mobile',
		device: patch.device ?? 'iPhone 17 Pro',
		os: patch.os ?? 'iOS',
		osVersion: patch.osVersion ?? '26.0',
		browserCode: patch.browserCode ?? 'chrome',
		browser: patch.browser ?? 'chrome',
		browserVersion: patch.browserVersion ?? '151',
		status: patch.status ?? 'PENDING',
		reason: patch.reason ?? null,
		error: patch.error ?? null,
		...patch
	};
}

test('categoryOf splits android phones vs tablets and ios vs ipados', () => {
	assert.equal(categoryOf(item({ platform: 'android', deviceType: 'mobile' })), 'android_phone');
	assert.equal(categoryOf(item({ platform: 'android', deviceType: 'tablet' })), 'android_tablet');
	assert.equal(categoryOf(item({ platform: 'ios' })), 'ios');
	assert.equal(categoryOf(item({ platform: 'ipados' })), 'ipados');
	assert.equal(categoryOf(item({ platform: 'windows' })), 'windows');
	assert.equal(categoryOf(item({ platform: 'macos' })), 'macos');
	assert.equal(categoryOf(item({ platform: 'linux' })), null);
});

test('counts come from actual items; passed+failed = executed', () => {
	const runs = [{
		id: 'r1', title: 'T', status: 'done', requestedBrowsers: ['chrome'],
		items: [
			item({ status: 'PASSED' }),
			item({ status: 'FAILED', browserCode: 'firefox', error: 'login failed' }),
			item({ status: 'NOT_RUN', reason: 'Deselected by user.', browserCode: 'opera' }),
			item({ status: 'ERROR', reason: 'interrupted', browserCode: 'brave' })
		]
	}];
	const report = computeMatrixCoverage(runs);
	assert.equal(report.execution.profilesRequested, 4);
	assert.equal(report.execution.profilesExecuted, 2);
	assert.equal(report.execution.passed, 1);
	assert.equal(report.execution.failed, 1);
	assert.equal(report.execution.notRun, 1);
	assert.equal(report.execution.error, 1);
	// Statuses that never appeared are 0, never null/undefined.
	assert.equal(report.execution.notSupported, 0);
	assert.equal(report.execution.blocked, 0);
	assert.equal(report.execution.unavailable, 0);
});

test('device categories covered only when executed; catalog presence is not coverage', () => {
	const report = computeMatrixCoverage([{
		id: 'r1', title: 'T', status: 'done', items: [
			item({ platform: 'ios', status: 'PASSED' }),
			item({ platform: 'ipados', status: 'PENDING' })
		]
	}]);
	const ios = report.deviceCategories.find((c) => c.category === 'ios');
	const ipados = report.deviceCategories.find((c) => c.category === 'ipados');
	assert.equal(ios.covered, true);
	assert.equal(ios.executed, 1);
	assert.equal(ipados.covered, false);
	assert.equal(ipados.gapReason, 'PENDING');
});

test('duckduckgo line carries its recorded reason and no pass', () => {
	const ddgReason = 'DuckDuckGo is a mobile-only browser with no Playwright build — no local execution provider can run it.';
	const report = computeMatrixCoverage([{
		id: 'r1', title: 'T', status: 'done', items: [
			item({ browserCode: 'duckduckgo', status: 'NOT_SUPPORTED', reason: ddgReason }),
			item({ browserCode: 'chrome', status: 'PASSED' })
		]
	}]);
	const ddg = report.browsers.find((b) => b.browser === 'duckduckgo');
	assert.equal(ddg.covered, false);
	assert.equal(ddg.executed, 0);
	assert.equal(ddg.gapReason, ddgReason);
	const chrome = report.browsers.find((b) => b.browser === 'chrome');
	assert.equal(chrome.covered, true);
});

test('empty matrix reports zeros, never invented numbers', () => {
	const report = computeMatrixCoverage([]);
	assert.equal(report.execution.profilesRequested, 0);
	assert.equal(report.execution.profilesExecuted, 0);
	assert.equal(report.runs.length, 0);
	for (const category of report.deviceCategories) {
		assert.equal(category.requested, 0);
		assert.equal(category.covered, false);
	}
});

test('per-run gaps preserve every reason and profile identity', () => {
	const report = computeMatrixCoverage([{
		id: 'r1', title: 'T', status: 'error', items: [
			item({ profileId: 'p1', status: 'NOT_SUPPORTED', reason: 'nope', browserCode: 'duckduckgo', durationMs: 4200, updatedAt: '2027-02-11T09:00:00.000Z' }),
			item({ profileId: 'p2', status: 'PASSED' })
		]
	}]);
	const run = report.runs[0];
	assert.equal(run.profiles, 2);
	assert.equal(run.gaps.length, 1);
	assert.equal(run.gaps[0].profileId, 'p1');
	assert.equal(run.gaps[0].reason, 'nope');
	assert.equal(run.gaps[0].status, 'NOT_SUPPORTED');
	assert.equal(run.gaps[0].durationMs, 4200);
	assert.equal(run.gaps[0].updatedAt, '2027-02-11T09:00:00.000Z');
});

test('pending items appear as pending gap rows with no duration — never vanish, never pass', () => {
	const report = computeMatrixCoverage([{
		id: 'r1', title: 'T', status: 'pending', items: [
			item({ profileId: 'wait', status: 'PENDING' }),
			item({ profileId: 'ran', status: 'FAILED' })
		]
	}]);
	const run = report.runs[0];
	const pending = run.gaps.find((g) => g.profileId === 'wait');
	assert.ok(pending, 'PENDING item stays visible in per-profile results');
	assert.equal(pending.status, 'PENDING');
	assert.equal(pending.durationMs, null);
	// FAILED is executed — it appears in counts, not in gaps.
	assert.equal(run.gaps.some((g) => g.profileId === 'ran'), false);
	assert.equal(report.execution.failed, 1);
});

test('unknown browser codes surface instead of being dropped', () => {
	const report = computeMatrixCoverage([{
		id: 'r1', title: 'T', status: 'done', items: [item({ browserCode: 'somebrowser', status: 'PASSED' })]
	}]);
	assert.ok(report.browsers.some((b) => b.browser === 'somebrowser'));
});

test('gapLabel maps statuses to human-readable text', () => {
	assert.equal(gapLabel('NOT_RUN'), 'not run');
	assert.equal(gapLabel('NOT_SUPPORTED'), 'not supported');
	assert.equal(gapLabel('WHATEVER'), 'whatever');
	assert.equal(gapLabel(null), '');
});
