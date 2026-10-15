/**
 * Matrix-run coverage gap aggregation (#14652 NI04).
 *
 * Pure functions over stored matrix-run items. EVERY number is computed from
 * actual item records — nothing hardcoded, nothing invented. A browser with
 * no execution provider (DuckDuckGo) surfaces with its recorded reason; gaps
 * (NOT_RUN / UNAVAILABLE / NOT_SUPPORTED / BLOCKED / ERROR) each carry their
 * recorded reason so the report explains itself.
 */

import { DEFAULT_PROFILE_RULES } from './matrixService.js';

const CATEGORY_LABELS = Object.freeze({
	ios: 'iPhone',
	ipados: 'iPad',
	android_phone: 'Android phones',
	android_tablet: 'Android tablets',
	windows: 'Windows desktop/laptop',
	macos: 'macOS desktop/laptop'
});

// Human-readable gap labels for the UI (statuses stay the raw vocabulary).
export const GAP_LABELS = Object.freeze({
	NOT_RUN: 'not run',
	UNAVAILABLE: 'unavailable',
	NOT_SUPPORTED: 'not supported',
	BLOCKED: 'blocked',
	ERROR: 'error',
	PENDING: 'pending',
	RUNNING: 'running'
});

// RT5 (#14757): the user-facing coverage STATE vocabulary — each raw item
// status maps to exactly one distinct state; states are never collapsed.
// The mapping is total: an unknown status maps to 'Execution Failed' only
// when it is terminal-and-unsuccessful (never to Passed).
export const COVERAGE_STATES = Object.freeze({
	PASSED: { id: 'PASSED', label: 'Tested — Passed', from: ['PASSED'] },
	FAILED: { id: 'FAILED', label: 'Tested — Failed', from: ['FAILED'] },
	ENVIRONMENT_UNAVAILABLE: { id: 'ENVIRONMENT_UNAVAILABLE', label: 'Environment Unavailable', from: ['UNAVAILABLE'], match: (item) => /health check|environment|emulation|network/i.test(String(item?.reason ?? '')) },
	BROWSER_UNAVAILABLE: { id: 'BROWSER_UNAVAILABLE', label: 'Browser Unavailable', from: ['UNAVAILABLE'], match: (item) => /browser|engine|launch|executable|binary/i.test(String(item?.reason ?? item?.error ?? '')) },
	DEVICE_OFFLINE: { id: 'DEVICE_OFFLINE', label: 'Device Offline', from: ['UNAVAILABLE', 'ERROR'], match: (item) => /offline|device.*(unreachable|disconnected)|stale|gone|disappeared/i.test(String(item?.reason ?? item?.error ?? '')) },
	EXECUTION_FAILED: { id: 'EXECUTION_FAILED', label: 'Execution Failed', from: ['ERROR', 'BLOCKED'], match: (item) => true },
	NOT_SELECTED: { id: 'NOT_SELECTED', label: 'Not Selected', from: ['NOT_RUN'], match: (item) => /deselect/i.test(String(item?.reason ?? '')) },
	NOT_SUPPORTED: { id: 'NOT_SUPPORTED', label: 'Not Supported', from: ['NOT_SUPPORTED'] },
	NOT_RUN: { id: 'NOT_RUN', label: 'Not Run', from: ['NOT_RUN', 'PENDING'] },
	RUNNING: { id: 'RUNNING', label: 'Running', from: ['RUNNING'] }
});

/**
 * Resolve a stored matrix item to its distinct coverage state. Health-check
 * unavailability (the environment could not run) is distinguished from
 * browser-launch unavailability by the recorded reason — the orchestrator
 * writes exact reasons, so the split is data-driven, never guessed.
 */
export function coverageStateOf(item) {
	const status = item?.status;
	if (status === 'PASSED') return COVERAGE_STATES.PASSED;
	if (status === 'FAILED') return COVERAGE_STATES.FAILED;
	if (status === 'NOT_SUPPORTED') return COVERAGE_STATES.NOT_SUPPORTED;
	if (status === 'RUNNING') return COVERAGE_STATES.RUNNING;
	if (status === 'NOT_RUN') {
		return /deselect/i.test(String(item?.reason ?? ''))
			? COVERAGE_STATES.NOT_SELECTED
			: COVERAGE_STATES.NOT_RUN;
	}
	if (status === 'UNAVAILABLE') {
		const reason = String(item?.reason ?? item?.error ?? '');
		if (/offline|device.*(unreachable|disconnected)|disappeared/i.test(reason)) return COVERAGE_STATES.DEVICE_OFFLINE;
		// Health-check blocks are environment-level (the environment could
		// not be made ready) — checked BEFORE the browser regex so a health
		// message mentioning "launch" still reads as the environment gap.
		if (/health check/i.test(reason)) return COVERAGE_STATES.ENVIRONMENT_UNAVAILABLE;
		if (/browser|engine|launch|executable|binary/i.test(reason)) return COVERAGE_STATES.BROWSER_UNAVAILABLE;
		return COVERAGE_STATES.ENVIRONMENT_UNAVAILABLE;
	}
	if (status === 'ERROR') {
		const reason = String(item?.reason ?? item?.error ?? '');
		if (/offline|device.*(unreachable|disconnected)|disappeared/i.test(reason)) return COVERAGE_STATES.DEVICE_OFFLINE;
		return COVERAGE_STATES.EXECUTION_FAILED;
	}
	if (status === 'BLOCKED') {
		const reason = String(item?.reason ?? item?.error ?? '');
		if (/offline|device.*(unreachable|disconnected)|disappeared/i.test(reason)) return COVERAGE_STATES.DEVICE_OFFLINE;
		return COVERAGE_STATES.EXECUTION_FAILED;
	}
	if (status === 'PENDING') return COVERAGE_STATES.NOT_RUN;
	// #14937 Phase 3 statuses: queued work is not-yet-executed coverage
	// (distinct from running); cancelled items stay visible as gaps with their
	// recorded reason so the report never silently drops them.
	if (status === 'QUEUED') return COVERAGE_STATES.NOT_RUN;
	if (status === 'CANCELLED') return COVERAGE_STATES.NOT_SELECTED;
	return COVERAGE_STATES.EXECUTION_FAILED;
}

export function gapLabel(status) {
	return GAP_LABELS[status] ?? String(status ?? '').toLowerCase();
}

const BROWSER_ORDER = Object.freeze(['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo']);

/**
 * Classify a matrix item's platform+deviceType into the six NI01 categories.
 * Android phones vs tablets split on deviceType; ios/ipados are distinct
 * platforms; windows/macos are desktops.
 */
export function categoryOf(item) {
	if (item.platform === 'ios') return 'ios';
	if (item.platform === 'ipados') return 'ipados';
	if (item.platform === 'android') return item.deviceType === 'tablet' ? 'android_tablet' : 'android_phone';
	if (item.platform === 'windows') return 'windows';
	if (item.platform === 'macos') return 'macos';
	return null;
}

/**
 * Aggregate a set of matrix runs (each with .items) into the NI04 gap report.
 * @param {Array<{id,title,status,requestedBrowsers,items}>} matrixRuns
 * @returns device coverage, browser coverage, execution counts, per-run
 * summaries and gap reasons — all from the item records themselves.
 */
export function computeMatrixCoverage(matrixRuns = []) {
	const items = matrixRuns.flatMap((run) => (run.items ?? []).map((item) => ({ ...item, matrixRunId: run.id })));
	const counts = countBy(items, (item) => item.status);
	const requested = items.length;

	// Device categories: covered when at least one item in the category was
	// actually executed (PASSED/FAILED) — presence in the catalog is not
	// coverage. Everything else surfaces with its honest reason.
	const byCategory = new Map();
	for (const item of items) {
		const category = categoryOf(item);
		if (!category) continue;
		const bucket = byCategory.get(category) ?? { executed: 0, total: 0, statuses: new Map() };
		bucket.total += 1;
		if (item.status === 'PASSED' || item.status === 'FAILED') bucket.executed += 1;
		bucket.statuses.set(item.status, (bucket.statuses.get(item.status) ?? 0) + 1);
		byCategory.set(category, bucket);
	}
	const deviceCategories = Object.keys(CATEGORY_LABELS).map((category) => {
		const bucket = byCategory.get(category) ?? { executed: 0, total: 0, statuses: new Map() };
		const statuses = Object.fromEntries(bucket.statuses);
		return {
			category,
			label: CATEGORY_LABELS[category],
			requested: bucket.total,
			executed: bucket.executed,
			covered: bucket.executed > 0,
			// The dominant non-executed reason for this category, if any.
			gapReason: dominantGap(statuses, bucket.total - bucket.executed)
		};
	});

	// Browsers: same honesty rule — covered only with ≥1 executed item.
	// The DuckDuckGo line carries its recorded NOT_SUPPORTED reason verbatim.
	const byBrowser = new Map();
	for (const item of items) {
		const bucket = byBrowser.get(item.browserCode) ?? { executed: 0, total: 0, statuses: new Map(), reasons: new Map() };
		bucket.total += 1;
		if (item.status === 'PASSED' || item.status === 'FAILED') bucket.executed += 1;
		bucket.statuses.set(item.status, (bucket.statuses.get(item.status) ?? 0) + 1);
		if (item.reason) bucket.reasons.set(item.reason, (bucket.reasons.get(item.reason) ?? 0) + 1);
		byBrowser.set(item.browserCode, bucket);
	}
	const browsers = BROWSER_ORDER.map((code) => {
		const bucket = byBrowser.get(code) ?? { executed: 0, total: 0, statuses: new Map(), reasons: new Map() };
		const statuses = Object.fromEntries(bucket.statuses);
		return {
			browser: code,
			requested: bucket.total,
			executed: bucket.executed,
			covered: bucket.executed > 0,
			// Truthful gap line, e.g. DuckDuckGo: "runner unavailable …".
			gapReason: dominantReason(bucket.reasons, statuses, bucket.total - bucket.executed)
		};
	});
	// Browsers outside the agreed set that somehow appear in items — surfaced,
	// never silently dropped.
	for (const code of byBrowser.keys()) {
		if (!BROWSER_ORDER.includes(code)) {
			const bucket = byBrowser.get(code);
			browsers.push({
				browser: code,
				requested: bucket.total,
				executed: bucket.executed,
				covered: bucket.executed > 0,
				gapReason: dominantReason(bucket.reasons, Object.fromEntries(bucket.statuses), bucket.total - bucket.executed)
			});
		}
	}

	// Execution summary — straight from item statuses. Statuses that never
	// appeared report 0 (never null/undefined from missing map keys).
	const execution = {
		profilesRequested: requested,
		profilesExecuted: (counts.PASSED ?? 0) + (counts.FAILED ?? 0),
		passed: counts.PASSED ?? 0,
		failed: counts.FAILED ?? 0,
		// #14942 Phase 4: the full honest vocabulary is surfaced — every
		// status reports its own count so totals add up to the planned set.
		skipped: counts.SKIPPED ?? 0,
		cancelled: counts.CANCELLED ?? 0,
		queued: counts.QUEUED ?? 0,
		running: counts.RUNNING ?? 0,
		pending: counts.PENDING ?? 0,
		notRun: counts.NOT_RUN ?? 0,
		unavailable: counts.UNAVAILABLE ?? 0,
		notSupported: counts.NOT_SUPPORTED ?? 0,
		blocked: counts.BLOCKED ?? 0,
		error: counts.ERROR ?? 0,
		// RT5 (#14757): the distinct user-facing coverage-state breakdown.
		// Every state reports its own count — Tested-Passed / Tested-Failed /
		// Environment Unavailable / Browser Unavailable / Execution Failed /
		// Device Offline / Not Selected / Not Supported / Not Run / Running.
		states: Object.fromEntries(Object.values(COVERAGE_STATES).map((state) => [state.id, 0])),
		stateCounts: Object.values(COVERAGE_STATES).map((state) => ({ state: state.id, label: state.label, count: 0 }))
	};
	for (const item of items) {
		const state = coverageStateOf(item);
		execution.states[state.id] += 1;
		const bucket = execution.stateCounts.find((entry) => entry.state === state.id);
		if (bucket) bucket.count += 1;
	}

	// Per-run summaries with every gap reason preserved. PENDING items are
	// included as pending rows (spec: requested-but-unfinished profiles stay
	// visible in per-profile results, they don't vanish until executed).
	const runs = matrixRuns.map((run) => {
		const runCounts = countBy(run.items ?? [], (item) => item.status);
		const gaps = (run.items ?? [])
			.filter((item) => ['NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'BLOCKED', 'ERROR', 'PENDING', 'QUEUED', 'CANCELLED'].includes(item.status))
			.map((item) => ({
				profileId: item.profileId,
				device: item.device,
				browser: item.browser,
				browserVersion: item.browserVersion,
				os: item.os,
				osVersion: item.osVersion,
				status: item.status,
				// RT5 (#14757): the distinct user-facing state for this gap.
				coverageState: coverageStateOf(item).id,
				coverageStateLabel: coverageStateOf(item).label,
				reason: item.reason ?? item.error ?? null,
				// #14652 round-2: execution time from the recorded duration /
				// timestamps — absent until the profile actually executes.
				durationMs: item.durationMs ?? null,
				updatedAt: item.updatedAt ?? null
			}));
		return {
			id: run.id,
			title: run.title,
			status: run.status,
			requestedBrowsers: run.requestedBrowsers ?? null,
			profiles: (run.items ?? []).length,
			statusCounts: runCounts,
			gaps
		};
	});

	return {
		deviceCategories,
		browsers,
		execution,
		runs
	};
}

function countBy(items, keyOf) {
	const counts = {};
	for (const item of items) {
		const key = keyOf(item);
		if (key != null) counts[key] = (counts[key] ?? 0) + 1;
	}
	return counts;
}

/** The most frequent honest reason across a category's non-executed items. */
function dominantGap(statuses, nonExecuted) {
	if (!nonExecuted) return null;
	const ranked = Object.entries(statuses)
		.filter(([status]) => status !== 'PASSED' && status !== 'FAILED')
		.sort((a, b) => b[1] - a[1]);
	return ranked.length ? ranked[0][0] : null;
}

/** Most frequent recorded reason string, or the dominant status as fallback. */
function dominantReason(reasons, statuses, nonExecuted) {
	if (!nonExecuted) return null;
	const rankedReasons = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
	if (rankedReasons.length) return rankedReasons[0][0];
	return dominantGap(statuses, nonExecuted);
}
