/**
 * qaMatrixResults model tests — Phase 4 (#14942).
 * Pure-function coverage: normalization, honest-pass guard, totals + coverage
 * gaps, grouping, filtering, facets, execution-type/browser truth.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	RESULT_STATUSES, STATUS_LABELS, TERMINAL_STATUSES,
	isExecutedPass, executionTypeOf, actualBrowserOf, toResultRow,
	computeTotals, groupResults, filterResults, facetValues
} from './qaMatrixResults.js';

function item(overrides = {}) {
	return {
		id: 'item-1',
		ordinal: 0,
		device: 'iPhone 15 Pro',
		platform: 'ios',
		os: 'iOS',
		osVersion: '17.0',
		browser: 'safari',
		browserCode: 'safari',
		browserVersion: '17.0',
		status: 'PENDING',
		...overrides
	};
}

test('toResultRow maps recorded fields; runtimeFacts supply actual identity', () => {
	const row = toResultRow(item({
		status: 'PASSED',
		verdict: 'pass',
		sessionId: 'session-9',
		durationMs: 4200,
		runtimeFacts: {
			executionType: 'browser_emulation',
			browser: 'safari',
			browserVersion: '17.4.1',
			launchedEngine: 'webkit',
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari'
		},
		artifactRefs: [{ artifactId: 'a1', type: 'screenshot' }],
		findings: [{ id: 'f1' }],
		retryCount: 1
	}));
	assert.equal(row.status, 'PASSED');
	assert.equal(row.passed, true);
	assert.equal(row.executionType, 'browser_emulation');
	assert.equal(row.engine, 'webkit');
	assert.equal(row.actualBrowserVersion, '17.4.1');
	assert.equal(row.userAgentSource ?? row.actualBrowser, 'safari');
	assert.equal(row.sessionId, 'session-9');
	assert.equal(row.artifacts.length, 1);
	assert.equal(row.findings.length, 1);
	assert.equal(row.retryCount, 1);
});

test('honest-pass guard: PASSED without verdict/session is never counted passed', () => {
	const liar = item({ status: 'PASSED' }); // hand-patched, no execution
	assert.equal(isExecutedPass(liar), false);
	const row = toResultRow(liar);
	assert.equal(row.status, 'PASSED'); // true status still surfaced
	assert.equal(row.passed, false); // but never counted as a pass
	const honest = item({ status: 'PASSED', verdict: 'pass', sessionId: 's1' });
	assert.equal(isExecutedPass(honest), true);
});

test('every required status is distinct and labelled', () => {
	for (const status of ['PENDING', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED']) {
		assert.ok(RESULT_STATUSES.includes(status), status);
		assert.ok(STATUS_LABELS[status]);
	}
	assert.notEqual(STATUS_LABELS.SKIPPED, STATUS_LABELS.CANCELLED);
	assert.notEqual(STATUS_LABELS.BLOCKED, STATUS_LABELS.FAILED);
});

test('computeTotals: planned/completed/failed/blocked/skipped + coverage gaps with reasons', () => {
	const items = [
		item({ id: 'a', status: 'PASSED', verdict: 'pass', sessionId: 's1' }),
		item({ id: 'b', status: 'FAILED', verdict: 'fail', sessionId: 's2' }),
		item({ id: 'c', status: 'BLOCKED', error: 'Health check blocked execution: engine failed' }),
		item({ id: 'd', status: 'QUEUED' }),
		item({ id: 'e', status: 'UNAVAILABLE', reason: 'BrowserStack: not configured' }),
		item({ id: 'f', status: 'CANCELLED', reason: 'cancelled by user' })
	];
	const totals = computeTotals(items);
	assert.equal(totals.planned, 6);
	assert.equal(totals.completed, 5); // terminal incl. gap statuses
	assert.equal(totals.passed, 1);
	assert.equal(totals.failed, 1);
	assert.equal(totals.blocked, 1);
	assert.equal(totals.skipped, 0);
	assert.equal(totals.cancelled, 1);
	assert.equal(totals.queued, 1);
	// Coverage gaps = planned − terminal: only the QUEUED item.
	assert.equal(totals.coverageGaps.length, 1);
	assert.equal(totals.coverageGaps[0].status, 'QUEUED');
	// A terminal-but-unexecuted item is NOT a gap; it is a counted result.
	assert.equal(totals.unavailable, 1);
});

test('computeTotals: zero items is all zeros, no gaps', () => {
	const totals = computeTotals([]);
	assert.equal(totals.planned, 0);
	assert.equal(totals.passed, 0);
	assert.deepEqual(totals.coverageGaps, []);
});

test('computeTotals: SKIPPED counted distinctly from CANCELLED', () => {
	const totals = computeTotals([
		item({ status: 'SKIPPED', reason: 'dependency not met' }),
		item({ status: 'CANCELLED' })
	]);
	assert.equal(totals.skipped, 1);
	assert.equal(totals.cancelled, 1);
	assert.equal(totals.completed, 2);
});

test('groupResults: platform → device sections, rows in insertion order', () => {
	const rows = [
		toResultRow(item({ id: 'a', platform: 'android', device: 'Galaxy A15' })),
		toResultRow(item({ id: 'b', platform: 'android', device: 'Galaxy A15', browser: 'chrome' })),
		toResultRow(item({ id: 'c', platform: 'ios', device: 'iPhone 15 Pro' }))
	];
	const groups = groupResults(rows);
	assert.deepEqual(groups.map((g) => g.platform), ['android', 'ios']);
	const android = groups[0];
	assert.equal(android.devices.length, 1);
	assert.equal(android.devices[0].rows.length, 2);
});

test('filterResults: status, browser, execution type and search narrow together', () => {
	const rows = [
		toResultRow(item({ id: 'a', status: 'PASSED', browser: 'chrome', verdict: 'pass', sessionId: 's1', runtimeFacts: { executionType: 'virtual_machine' } })),
		toResultRow(item({ id: 'b', status: 'FAILED', browser: 'chrome' })),
		toResultRow(item({ id: 'c', status: 'PASSED', browser: 'firefox', verdict: 'pass', sessionId: 's2', device: 'MacBook Air M3', platform: 'macos', os: 'macOS', osVersion: '14.4' }))
	];
	assert.equal(filterResults(rows, { status: 'PASSED' }).length, 2);
	assert.equal(filterResults(rows, { browser: 'chrome' }).length, 2);
	assert.equal(filterResults(rows, { status: 'PASSED', browser: 'chrome' }).length, 1);
	assert.equal(filterResults(rows, { executionType: 'virtual_machine' }).length, 1);
	assert.equal(filterResults(rows, { search: 'iphone' }).length, 2); // a + b are iPhones
	assert.equal(filterResults(rows, { search: 'macbook' }).length, 1);
	assert.equal(filterResults(rows, {}).length, 3);
});

test('facetValues lists distinct statuses/browsers/execution types present', () => {
	const rows = [
		toResultRow(item({ status: 'RUNNING', browser: 'chrome', runtimeFacts: { executionType: 'physical' } })),
		toResultRow(item({ status: 'PASSED', browser: 'chrome', verdict: 'pass', sessionId: 's' })),
		toResultRow(item({ status: 'FAILED', browser: 'edge' }))
	];
	const facets = facetValues(rows);
	assert.deepEqual(facets.statuses.sort(), ['FAILED', 'PASSED', 'RUNNING']);
	assert.deepEqual(facets.browsers.sort(), ['chrome', 'edge']);
	assert.deepEqual(facets.executionTypes, ['physical']);
});

test('executionTypeOf falls back through runtimeFacts → item; null when absent', () => {
	assert.equal(executionTypeOf(item({ runtimeFacts: { executionType: 'simulator' } })), 'simulator');
	assert.equal(executionTypeOf(item({ executionLevel: 'REAL_DEVICE' })), 'REAL_DEVICE');
	assert.equal(executionTypeOf(item({})), null);
});

test('actualBrowserOf prefers runner facts over requested browser fields', () => {
	const actual = actualBrowserOf(item({
		browser: 'chrome',
		runtimeFacts: { launchedBrowser: 'brave', launchedEngine: 'chromium', browserVersion: '1.68' }
	}));
	// Runner truth wins: requested chrome must not masquerade as the outcome.
	assert.equal(actual.brandedBinary, null);
	assert.equal(actual.engine, 'chromium');
});

test('toResultRow never merges evidence across items', () => {
	const rowA = toResultRow(item({ id: 'a', artifactRefs: [{ artifactId: 'x' }] }));
	const rowB = toResultRow(item({ id: 'b' }));
	assert.equal(rowA.artifacts.length, 1);
	assert.equal(rowB.artifacts.length, 0);
	// mutate rowA's copy — rowB must not see it
	rowA.artifacts.push({ artifactId: 'y' });
	assert.equal(rowB.artifacts.length, 0);
});

test('TERMINAL_STATUSES includes cancelled/skipped/gap statuses; RUNNING is not terminal', () => {
	assert.ok(TERMINAL_STATUSES.includes('CANCELLED'));
	assert.ok(TERMINAL_STATUSES.includes('SKIPPED'));
	assert.ok(TERMINAL_STATUSES.includes('NOT_SUPPORTED'));
	assert.ok(!TERMINAL_STATUSES.includes('RUNNING'));
	assert.ok(!TERMINAL_STATUSES.includes('QUEUED'));
});
