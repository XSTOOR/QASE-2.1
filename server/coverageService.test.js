import assert from 'node:assert/strict';
import test from 'node:test';
import { computeCoverage, createCoverageService, pct } from './coverageService.js';

test('pct guards against zero denominators and non-integers', () => {
	assert.equal(pct(0, 0), 0);
	assert.equal(pct(1, 0), 0);
	assert.equal(pct(1.5, 2), 0);
	assert.equal(pct(1, 2), 50);
	assert.equal(pct(1, 3), 33.3);
});

test('computeCoverage: empty workspace yields zeros and empty rows, not an error', () => {
	const payload = computeCoverage({ testCases: [], environments: [], runs: [] });
	assert.deepEqual(payload.metrics, {
		environments: 0,
		testCases: 0,
		assignedPairs: 0,
		executedPairs: 0,
		passedPairs: 0,
		coveragePct: 0,
		passRatePct: 0,
		runsConsidered: 0
	});
	assert.deepEqual(payload.rows, []);
	assert.deepEqual(payload.environments, []);
});

test('computeCoverage: executed run without a verdict is never a pass', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro', platform: 'ios' }],
		runs: [{ id: 'r1', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 20, report: undefined }]
	});
	assert.equal(payload.rows[0].executed, 1);
	assert.equal(payload.rows[0].passed, 0);
	assert.equal(payload.metrics.executedPairs, 1);
	assert.equal(payload.metrics.passedPairs, 0);
	assert.equal(payload.metrics.coveragePct, 100);
	assert.equal(payload.metrics.passRatePct, 0);
	assert.equal(payload.rows[0].cells['ENV-1'].verdict, undefined);
});

test('computeCoverage: only done/error runs count as executed; latest run wins', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }],
		runs: [
			// Older pass, newer fail — latest executed by updatedAt must win.
			{ id: 'r-old', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 10, report: { verdict: 'pass' } },
			{ id: 'r-new', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 30, report: { verdict: 'fail' } },
			// Still running — never counted as a verdict, but the pair stays
			// executed (older done run) and the cell shows the live run.
			{ id: 'r-live', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'running', updatedAt: 40 }
		]
	});
	assert.equal(payload.rows[0].executed, 1);
	assert.equal(payload.rows[0].passed, 0);
	assert.equal(payload.rows[0].cells['ENV-1'].latestRunId, 'r-live');
	assert.equal(payload.rows[0].cells['ENV-1'].status, 'running');
});

test('computeCoverage: pass_with_issues counts as a pass', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }],
		runs: [{ id: 'r1', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 10, report: { verdict: 'pass_with_issues' } }]
	});
	assert.equal(payload.metrics.passedPairs, 1);
	assert.equal(payload.metrics.passRatePct, 100);
});

test('computeCoverage: deleted cases excluded and removed environments drop cells', () => {
	const payload = computeCoverage({
		testCases: [
			{ caseNumber: 'TC-1', title: 'Kept', tags: [], environmentIds: ['ENV-1', 'ENV-GONE'] },
			{ caseNumber: 'TC-2', title: 'Deleted', tags: [], environmentIds: ['ENV-1'], deleted: true }
		],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }],
		runs: [
			{ id: 'r1', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 10, report: { verdict: 'pass' } },
			{ id: 'r2', testCaseId: 'TC-1', environmentId: 'ENV-GONE', status: 'done', updatedAt: 20, report: { verdict: 'pass' } }
		]
	});
	assert.equal(payload.rows.length, 1);
	assert.equal(payload.rows[0].caseNumber, 'TC-1');
	// ENV-GONE is not in the environments dimension → not an assigned pair.
	assert.deepEqual(payload.rows[0].environmentIds, ['ENV-1']);
	assert.equal(payload.metrics.assignedPairs, 1);
	assert.equal(payload.rows[0].cells['ENV-GONE'], undefined);
	// r2 against a since-removed environment surfaces nowhere (env not in index).
	assert.equal(payload.metrics.runsConsidered, 2);
});

test('computeCoverage: run against an unassigned environment surfaces as an extra cell, never counts', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [
			{ envId: 'ENV-1', device: 'iPhone 16 Pro' },
			{ envId: 'ENV-2', device: 'MacBook Pro' }
		],
		runs: [
			{ id: 'r1', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 10, report: { verdict: 'pass' } },
			{ id: 'r2', testCaseId: 'TC-1', environmentId: 'ENV-2', status: 'done', updatedAt: 20, report: { verdict: 'fail' } }
		]
	});
	const row = payload.rows[0];
	assert.equal(row.cells['ENV-2']?.unassigned, true);
	// Assigned pairs only count ENV-1.
	assert.equal(payload.metrics.assignedPairs, 1);
	assert.equal(payload.metrics.executedPairs, 1);
	assert.equal(row.executed, 1);
});

test('computeCoverage: environment snapshot fallback join when environmentId is absent', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }],
		runs: [{ id: 'r1', testCaseId: 'TC-1', environmentSnapshot: { envId: 'ENV-1' }, status: 'done', updatedAt: 10, report: { verdict: 'pass' } }]
	});
	assert.equal(payload.metrics.executedPairs, 1);
	assert.equal(payload.metrics.passedPairs, 1);
});

test('computeCoverage: runs without a case or environment link count in runsConsidered only', () => {
	const payload = computeCoverage({
		testCases: [{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] }],
		environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }],
		runs: [
			{ id: 'no-case', environmentId: 'ENV-1', status: 'done', updatedAt: 10, report: { verdict: 'pass' } },
			{ id: 'no-env', testCaseId: 'TC-1', status: 'done', updatedAt: 10, report: { verdict: 'pass' } }
		]
	});
	assert.equal(payload.metrics.runsConsidered, 2);
	assert.equal(payload.metrics.executedPairs, 0);
	assert.equal(payload.metrics.coveragePct, 0);
});

test('createCoverageService: requires the sibling services', () => {
	assert.throws(() => createCoverageService({}), TypeError);
});

test('createCoverageService: snapshot aggregates from sibling services, preferring listRuns', async () => {
	const calls = { listRuns: 0, coverageSnapshot: 0, list: 0 };
	const testCases = {
		list: async () => ({ testCases: [
			{ caseNumber: 'TC-1', title: 'Case', tags: [], environmentIds: ['ENV-1'] },
			{ caseNumber: 'TC-X', title: 'Deleted', tags: [], environmentIds: ['ENV-1'], deleted: true }
		] })
	};
	const environments = {
		list: async () => ({ environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro', platform: 'ios', browser: 'safari', browserVersion: '18.3', os: 'iOS', osVersion: '18.3', extra: 'stripped' }] })
	};

	const runs = {
		list: async () => { calls.list++; return [{ id: 'r1' }]; },
		coverageSnapshot: () => { calls.coverageSnapshot++; return []; }
	};
	const listRuns = () => { calls.listRuns++; return [
		{ id: 'r1', testCaseId: 'TC-1', environmentId: 'ENV-1', status: 'done', updatedAt: 5, report: { verdict: 'pass' } }
	]; };
	const service = createCoverageService({ testCases, environments, runs, listRuns, tenantContext: {} });
	const payload = await service.snapshot();
	assert.equal(calls.listRuns, 1);
	assert.equal(calls.coverageSnapshot, 0);
	assert.equal(calls.list, 0);
	assert.equal(payload.metrics.testCases, 1); // deleted case filtered
	assert.equal(payload.metrics.environments, 1);
	assert.equal(payload.metrics.executedPairs, 1);
	// Environment dimension is trimmed to the documented keys.
	assert.deepEqual(Object.keys(payload.environments[0]).sort(),
		['browser', 'browserVersion', 'device', 'envId', 'os', 'osVersion', 'platform']);
});

test('createCoverageService: accepts an array payload from environments.list', async () => {
	const testCases = { list: async () => [] };
	const environments = { list: async () => ([{ envId: 'ENV-1' }]) };
	const runs = { list: async () => [] };
	const service = createCoverageService({ testCases, environments, runs, listRuns: () => [], tenantContext: {} });
	const payload = await service.snapshot();
	assert.equal(payload.metrics.environments, 1);
});

test('createCoverageService: pages the environment dimension past the 1000 cap', async () => {
	const pages = [
		Array.from({ length: 1000 }, (_, i) => ({ envId: `ENV-${i}`, device: 'iPhone' })),
		[{ envId: 'ENV-1000', device: 'MacBook Pro' }]
	];
	let offsetSeen = [];
	const environments = {
		// Real signature: list(filters) — single argument.
		list: async (filters) => {
			offsetSeen.push(filters.offset);
			return { environments: pages[offsetSeen.length - 1] ?? [] };
		}
	};
	const testCases = { list: async () => [] };
	const runs = { list: async () => [] };
	const service = createCoverageService({ testCases, environments, runs, listRuns: () => [], tenantContext: {} });
	const payload = await service.snapshot();
	assert.equal(payload.metrics.environments, 1001); // both pages aggregated
	assert.deepEqual(offsetSeen, [0, 1000]); // stopped after the short page
});

// #14652 (NI04): the service-facade wiring — snapshot() must surface the
// matrix gap report computed from the REAL listMatrixRuns input (regression
// for the serviceFactory ordering bug where services.matrix was bound before
// it existed in the postgres branch).
test('createCoverageService: snapshot embeds payload.matrix from listMatrixRuns with real coverage numbers', async () => {
	const environments = { list: async () => ({ environments: [{ envId: 'ENV-1', device: 'iPhone 16 Pro' }] }) };
	const testCases = { list: async () => [] };
	const runs = { list: async () => [] };
	const matrixRuns = [{
		id: 'matrix-1',
		title: 'NI04 wiring run',
		status: 'done',
		items: [
			{ id: 'it-1', status: 'PASSED', platform: 'ios', device: 'iPhone 17 Pro', os: 'iOS', osVersion: '26.0', browser: 'Safari', browserCode: 'safari', browserVersion: '26.0', profileId: 'iphone17pro-ios26-safari26' },
			{ id: 'it-2', status: 'NOT_SUPPORTED', platform: 'ios', device: 'iPhone 17 Pro', browser: 'DuckDuckGo', browserCode: 'duckduckgo', browserVersion: null, profileId: 'iphone17pro-ddg', reason: 'DuckDuckGo is a mobile-only browser with no Playwright build.' }
		]
	}];
	const listMatrixRuns = () => matrixRuns;
	const service = createCoverageService({ testCases, environments, runs, listRuns: () => [], listMatrixRuns, tenantContext: {} });
	const payload = await service.snapshot();
	assert.ok(payload.matrix, 'snapshot must embed payload.matrix when listMatrixRuns is provided');
	assert.equal(payload.matrix.execution.profilesRequested, 2);
	assert.equal(payload.matrix.execution.profilesExecuted, 1);
	assert.equal(payload.matrix.execution.notSupported, 1);
	const safari = payload.matrix.browsers.find(b => b.browser === 'safari');
	assert.equal(safari.executed, 1);
	assert.equal(safari.covered, true);
	const ddg = payload.matrix.browsers.find(b => b.browser === 'duckduckgo');
	assert.equal(ddg.covered, false);
	assert.match(ddg.gapReason, /no Playwright build/);
	assert.equal(payload.matrix.runs[0].gaps.length, 1);
	assert.equal(payload.matrix.runs[0].gaps[0].profileId, 'iphone17pro-ddg');
});

test('createCoverageService: no listMatrixRuns leaves payload.matrix absent (legacy shape)', async () => {
	const environments = { list: async () => ({ environments: [] }) };
	const testCases = { list: async () => [] };
	const runs = { list: async () => [] };
	const service = createCoverageService({ testCases, environments, runs, listRuns: () => [], tenantContext: {} });
	const payload = await service.snapshot();
	assert.equal(payload.matrix, undefined);
	assert.ok(payload.metrics, 'legacy fields still present');
});
