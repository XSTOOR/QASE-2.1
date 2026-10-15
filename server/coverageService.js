/**
 * Coverage dashboard aggregation (Phase 7): joins test cases × environments
 * against executed runs into one honest matrix payload.
 *
 * Honesty rules (mirroring the project-wide stance):
 * - Only a completed run (status done/error) counts as executed.
 * - A pass is only ever `report.verdict` pass | pass_with_issues — a completed
 *   run with no report is "executed" with verdict undefined, never a pass.
 * - Runs join cases on the caseNumber STRING (session.testCaseId stores the
 *   case number, not the uuid) and environments on environmentId ?? snapshot.envId.
 */

import { computeMatrixCoverage } from './matrixCoverage.js';

const EXECUTED_STATUSES = new Set(['done', 'error']);
const PASS_VERDICTS = new Set(['pass', 'pass_with_issues']);

export function pct(numerator, denominator) {
	if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator <= 0) return 0;
	return Math.round((numerator / denominator) * 1000) / 10;
}

function cellOf(run) {
	return {
		latestRunId: run.id,
		at: run.updatedAt,
		status: run.status,
		verdict: EXECUTED_STATUSES.has(run.status) ? (run.report?.verdict ?? undefined) : undefined,
		executionLevel: run.executionLevel ?? run.runtimeFacts?.executionLevel ?? undefined,
		title: run.title
	};
}

/**
 * Pure aggregation. Inputs are already-loaded records:
 * - testCases: [{caseNumber, title, tags, environmentIds, deleted}]
 * - environments: [{envId, device, platform, browser, browserVersion, os, osVersion}]
 * - runs: FULL session records (need status + report.verdict + updatedAt)
 */
export function computeCoverage({ testCases = [], environments = [], runs = [] } = {}) {
	const envIndex = new Map(environments.map(environment => [environment.envId, environment]));
	const caseIndex = new Map(testCases.map(testCase => [testCase.caseNumber, testCase]));

	// Two indexes per (caseNumber, envId) pair:
	// - `latest`: most recent run of ANY status (drives the cell display, so a
	//   running run shows as live).
	// - `latestExecuted`: most recent done/error run (drives executed/passed
	//   counting — a pair counts as executed once it has ≥1 completed run, even
	//   if a newer run is currently live).
	// Runs not linked to a case or an assigned environment are still counted in
	// runsConsidered but never make a pair covered (a run against an unassigned
	// environment is evidence the case team should see, so we also surface it as
	// an extra cell).
	const latest = new Map();
	const latestExecuted = new Map();
	for (const run of runs) {
		const caseNumber = typeof run.testCaseId === 'string' ? run.testCaseId : undefined;
		const environmentId = run.environmentId ?? run.environmentSnapshot?.envId ?? undefined;
		if (!caseNumber || !environmentId) continue;
		const key = `${caseNumber}::${environmentId}`;
		const newer = (candidate) => !candidate || (run.updatedAt ?? 0) > (candidate.updatedAt ?? 0);
		if (newer(latest.get(key))) latest.set(key, run);
		if (EXECUTED_STATUSES.has(run.status) && newer(latestExecuted.get(key))) latestExecuted.set(key, run);
	}

	const rows = testCases.filter(testCase => !testCase.deleted).map(testCase => {
		const assigned = (testCase.environmentIds ?? []).filter(environmentId => envIndex.has(environmentId));
		const cells = {};
		let executed = 0;
		let passed = 0;
		for (const environmentId of assigned) {
			const display = latest.get(`${testCase.caseNumber}::${environmentId}`);
			if (display) cells[environmentId] = cellOf(display);
			const doneRun = latestExecuted.get(`${testCase.caseNumber}::${environmentId}`);
			if (doneRun) {
				executed += 1;
				if (PASS_VERDICTS.has(doneRun.report?.verdict)) passed += 1;
			}
		}
		return {
			caseNumber: testCase.caseNumber,
			title: testCase.title,
			tags: testCase.tags ?? [],
			environmentIds: assigned,
			cells,
			executed,
			passed,
			total: assigned.length
		};
	});

	// Runs whose environment is NOT assigned to their case surface as extra
	// evidence cells so the dashboard never hides real executions.
	const extraCells = {};
	for (const [key, run] of latest) {
		const [caseNumber, environmentId] = key.split('::');
		const testCase = caseIndex.get(caseNumber);
		if (!testCase || (testCase.environmentIds ?? []).includes(environmentId)) continue;
		if (!envIndex.has(environmentId)) continue; // environment since removed — nothing to show
		extraCells[caseNumber] = extraCells[caseNumber] ?? {};
		extraCells[caseNumber][environmentId] = { ...cellOf(run), unassigned: true };
	}
	for (const row of rows) {
		if (extraCells[row.caseNumber]) row.cells = { ...extraCells[row.caseNumber], ...row.cells };
	}

	const assignedPairs = rows.reduce((sum, row) => sum + row.total, 0);
	const executedPairs = rows.reduce((sum, row) => sum + row.executed, 0);
	const passedPairs = rows.reduce((sum, row) => sum + row.passed, 0);

	return {
		metrics: {
			environments: environments.length,
			testCases: testCases.length,
			assignedPairs,
			executedPairs,
			passedPairs,
			coveragePct: pct(executedPairs, assignedPairs),
			passRatePct: pct(passedPairs, executedPairs),
			runsConsidered: runs.length
		},
		rows,
		environments
	};
}

/**
 * #14652 (NI04): matrix-run gap report computed from stored matrix items.
 * Additive — the legacy payload shape is untouched; `matrix` is added only
 * when matrix runs exist (or is the honest zero-run aggregate otherwise).
 */
export function computeMatrixGapReport(matrixRuns = []) {
	return computeMatrixCoverage(matrixRuns);
}

/**
 * Service facade wired in serviceFactory: pulls test cases, environments and
 * full runs from sibling services and returns the coverage payload.
 * `loadRuns` must supply FULL session records (verdict lives on session.report).
 */
export function createCoverageService({ testCases, environments, runs, listRuns, listMatrixRuns, tenantContext } = {}) {
	if (!testCases || !environments || !runs && !listRuns) {
		throw new TypeError('Coverage requires the testCases, environments and runs services.');
	}
	const caseList = async () => {
		// testCases.list takes the FILTERS as its only argument (tenant is
		// injected by the service itself), same convention as environments.
		const payload = await testCases.list({});
		return Array.isArray(payload) ? payload : (payload.testCases ?? []);
	};
	const environmentList = async () => {
		// Page through the whole active-environment dimension. The repository
		// caps a single list at 1000; a workspace with more environments must
		// not silently drop columns (dropped columns would inflate coveragePct
		// by excluding their assigned pairs).
		// NOTE: environments.list takes the FILTERS as its only argument
		// (the tenant is injected by the service itself) — unlike
		// testCases.list(tenant, filters).
		const listEnvironments = (filters) => environments.list(filters);
		const rows = [];
		const pageSize = 1000;
		for (let offset = 0; ; offset += pageSize) {
			const payload = await listEnvironments({ active: true, limit: pageSize, offset });
			const page = Array.isArray(payload) ? payload : (payload.environments ?? payload ?? []);
			rows.push(...page);
			if (page.length < pageSize) break;
		}
		return rows;
	};
	const runList = async () => {
		if (typeof listRuns === 'function') return listRuns();
		if (typeof runs.coverageSnapshot === 'function') return runs.coverageSnapshot();
		// Fallback: page through the capped list and pull full records.
		const summary = await runs.list({ limit: 100 });
		return Promise.all(summary.map(run => runs.get(run.id)));
	};
	return {
		async snapshot() {
			const [caseRows, environmentRows, runRows] = await Promise.all([caseList(), environmentList(), runList()]);
			const payload = computeCoverage({
				testCases: caseRows.filter(row => !row.deleted),
				environments: environmentRows.map(environment => ({
					envId: environment.envId,
					device: environment.device,
					platform: environment.platform,
					browser: environment.browser,
					browserVersion: environment.browserVersion,
					os: environment.os,
					osVersion: environment.osVersion
				})),
				runs: runRows.filter(Boolean)
			});
			// #14652 (NI04): additive matrix gap report — every number from
			// actual stored matrix items, never hardcoded.
			if (typeof listMatrixRuns === 'function') {
				payload.matrix = computeMatrixGapReport(await listMatrixRuns());
			}
			return payload;
		}
	};
}
