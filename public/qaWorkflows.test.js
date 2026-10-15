import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	lastRunByCase, caseStatus, statusRank,
	platformsOf, caseEnvLines,
	filterCasesForWizard, resolveCaseEnvIds, resolveRunPairs,
	wizardSummary, PRESETS, environmentsForPreset,
	buildBugMarkdown
} from '../public/qaWorkflows.js';

const iso = (ms) => new Date(ms).toISOString();
const NOW = 1_800_000_000_000;

describe('qaWorkflows · last-run aggregation', () => {
	test('lastRunByCase keeps the most recent session per case and skips non-QA modes', () => {
		const sessions = [
			{ testCaseId: 'TC-0001', status: 'done', findings: [], updatedAt: iso(NOW - 5000) },
			{ testCaseId: 'TC-0001', status: 'done', findings: [{ title: 'x' }], updatedAt: iso(NOW) },
			{ testCaseId: 'TC-0002', status: 'idle', updatedAt: iso(NOW) },
			{ testCaseSnapshot: { caseNumber: 'TC-0003' }, status: 'done', findings: [], updatedAt: iso(NOW - 10) },
			{ testCaseId: 'TC-0001', mode: 'founder', status: 'done', updatedAt: iso(NOW + 1) }
		];
		const map = lastRunByCase(sessions);
		assert.equal(map.size, 3);
		assert.equal(map.get('TC-0001').findings.length, 1); // newest qa wins, founder skipped
		assert.equal(map.get('TC-0002').status, 'idle');
		assert.ok(map.has('TC-0003'));
	});

	test('caseStatus: Passed / Failed / Running / Not run', () => {
		assert.equal(caseStatus({}, undefined), 'Not run');
		assert.equal(caseStatus({}, { status: 'running' }), 'Running');
		assert.equal(caseStatus({}, { status: 'awaiting_input' }), 'Running');
		assert.equal(caseStatus({}, { status: 'done', findings: [] }), 'Passed');
		assert.equal(caseStatus({}, { status: 'done', findings: [{ title: 'bug' }] }), 'Failed');
		assert.equal(caseStatus({}, { status: 'interrupted' }), 'Not run');
		assert.deepEqual(['Failed', 'Running', 'Not run', 'Passed'].sort((a, b) => statusRank(a) - statusRank(b)), ['Failed', 'Running', 'Not run', 'Passed']);
	});
});

describe('qaWorkflows · card metadata', () => {
	const envById = new Map([
		['ENV-IOS-1', { platform: 'ios', platformLabel: 'iOS', device: 'iPhone 16 Pro', os: 'iOS', osVersion: '18.3', browser: 'Safari' }],
		['ENV-AND-1', { platform: 'android', platformLabel: 'Android', device: 'Galaxy S24', os: 'Android', osVersion: '15', browser: 'Chrome' }]
	]);
	test('platformsOf and caseEnvLines derive display data from assigned envs', () => {
		const testCase = { environmentIds: ['ENV-IOS-1', 'ENV-AND-1'] };
		assert.deepEqual(platformsOf(testCase, envById), ['iOS', 'Android']);
		assert.deepEqual(caseEnvLines(testCase, envById), [
			'iPhone 16 Pro · iOS 18.3 · Safari',
			'Galaxy S24 · Android 15 · Chrome'
		]);
		assert.deepEqual(platformsOf({ environmentIds: [] }, envById), []);
	});
});

describe('qaWorkflows · wizard filters and run resolution', () => {
	const cases = [
		{ caseNumber: 'TC-1', environmentIds: ['a', 'b'] },
		{ caseNumber: 'TC-2', environmentIds: ['a'] },
		{ caseNumber: 'TC-3', environmentIds: [] }
	];
	const runs = new Map([
		['TC-1', { status: 'done', findings: [{ title: 'x' }] }],
		['TC-2', { status: 'done', findings: [] }]
	]);

	test('filterCasesForWizard: all / selected / failed / notRun', () => {
		assert.equal(filterCasesForWizard(cases, 'all', runs).length, 3);
		assert.deepEqual(filterCasesForWizard(cases, 'selected', runs, ['TC-3']).map((c) => c.caseNumber), ['TC-3']);
		assert.deepEqual(filterCasesForWizard(cases, 'failed', runs).map((c) => c.caseNumber), ['TC-1']);
		assert.deepEqual(filterCasesForWizard(cases, 'notRun', runs).map((c) => c.caseNumber), ['TC-3']);
	});

	test('resolveCaseEnvIds: current / all / choose (respecting assignment)', () => {
		assert.deepEqual(resolveCaseEnvIds(cases[0], 'current', { defaultEnvId: 'b' }), ['b']);
		assert.deepEqual(resolveCaseEnvIds(cases[0], 'current', {}), []);
		assert.deepEqual(resolveCaseEnvIds(cases[0], 'all'), ['a', 'b']);
		assert.deepEqual(resolveCaseEnvIds(cases[0], 'choose', { chosenEnvIds: ['a', 'zzz'] }), ['a']);
	});

	test('resolveRunPairs flattens case × env and skips empty assignments', () => {
		const pairs = resolveRunPairs(cases, 'all');
		assert.equal(pairs.length, 3);
		assert.deepEqual(resolveRunPairs([cases[2]], 'all'), []);
	});

	test('wizardSummary computes tests × devices and warns on large batches', () => {
		const big = wizardSummary(25, 8);
		assert.deepEqual({ ...big, warnText: big.warnText ? 'set' : '' }, { tests: 25, devices: 8, total: 200, warn: true, warnText: 'set' });
		const small = wizardSummary(2, 3);
		assert.equal(small.total, 6);
		assert.equal(small.warn, false);
	});
});

describe('qaWorkflows · presets', () => {
	const envs = [
		{ envId: '1', platform: 'ios', active: true },
		{ envId: '2', platform: 'android', active: true },
		{ envId: '3', platform: 'windows', active: true },
		{ envId: '4', platform: 'ios', active: false }
	];
	test('six presets exist with stable ids', () => {
		assert.deepEqual(PRESETS.map((p) => p.id), ['apple-mobile', 'android-mobile', 'windows-desktop', 'all-mobile', 'all-browsers', 'full-regression']);
	});
	test('environmentsForPreset filters by platform and skips inactive', () => {
		assert.deepEqual(environmentsForPreset('apple-mobile', envs).map((e) => e.envId), ['1']);
		assert.deepEqual(environmentsForPreset('android-mobile', envs).map((e) => e.envId), ['2']);
		assert.deepEqual(environmentsForPreset('windows-desktop', envs).map((e) => e.envId), ['3']);
		assert.deepEqual(environmentsForPreset('all-mobile', envs).map((e) => e.envId), ['1', '2']);
		assert.equal(environmentsForPreset('all-browsers', envs).length, 3);
		assert.equal(environmentsForPreset('full-regression', envs).length, 3);
		assert.deepEqual(environmentsForPreset('nope', envs), []);
	});
});

describe('qaWorkflows · bug report', () => {
	test('buildBugMarkdown renders findings with environment and steps', () => {
		const session = {
			id: 'abc123', title: 'Checkout run', updatedAt: iso(NOW), targetUrl: 'https://shop.example',
			testCaseId: 'TC-0007',
			environmentSnapshot: { device: 'iPhone 16 Pro', os: 'iOS', osVersion: '18.3', browser: 'Safari', browserVersion: '18.3' },
			findings: [{ title: 'Pay button dead', severity: 'high', category: 'checkout', expected: 'Pays', actual: 'Nothing', url: 'https://shop.example/pay', steps: ['Open cart', 'Click pay'] }]
		};
		const md = buildBugMarkdown(session);
		assert.match(md, /# Bug report — Checkout run \(abc123\)/);
		assert.match(md, /\*\*Environment:\*\* iPhone 16 Pro · iOS 18.3 · Safari 18.3/);
		assert.match(md, /\*\*Test case:\*\* TC-0007/);
		assert.match(md, /## Pay button dead \(high · checkout\)/);
		assert.match(md, /1\. Open cart/);
	});

	test('buildBugMarkdown handles a session with no findings and no environment', () => {
		const md = buildBugMarkdown({ id: 'x', title: 't', findings: [] });
		assert.match(md, /_No findings recorded on this run\._/);
		assert.match(md, /unknown environment/);
		assert.equal(buildBugMarkdown(null), '');
	});
});

test('caseStatus uses findingCount when findings array is absent (list payload)', () => {
	assert.equal(caseStatus({}, { status: 'done', findingCount: 2 }), 'Failed');
	assert.equal(caseStatus({}, { status: 'done', findingCount: 0 }), 'Passed');
	// Full array still wins when present.
	assert.equal(caseStatus({}, { status: 'done', findings: [], findingCount: 3 }), 'Passed');
	assert.equal(caseStatus({}, { status: 'done', findings: [{ id: 1 }], findingCount: 0 }), 'Failed');
});

test('listSessions-style payloads join to cases via testCaseId', () => {
	const runs = lastRunByCase([
		{ id: 'a', testCaseId: 'TC-1', mode: 'qa', status: 'done', findingCount: 1, updatedAt: '2026-01-02T00:00:00Z' },
		{ id: 'b', testCaseId: 'TC-1', mode: 'qa', status: 'done', findingCount: 0, updatedAt: '2026-01-01T00:00:00Z' }
	]);
	assert.equal(runs.get('TC-1').id, 'a');
	assert.equal(caseStatus({}, runs.get('TC-1')), 'Failed');
});
