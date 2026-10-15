/**
 * QA matrix results model — Phase 4 (#14942).
 *
 * PURE functions over a stored matrix-run record (GET /api/matrix-runs/:id).
 * Everything is derived from recorded item data: status, verdict, runtimeFacts
 * (actual device/OS/browser/engine from the runner), artifactRefs, sessionId.
 * Nothing hardcoded, nothing invented:
 *   - an unexecuted configuration can NEVER surface as Passed (guard below);
 *   - evidence belongs to the item that produced it and is never merged;
 *   - totals include every status in the honest vocabulary, plus coverage
 *     gaps (planned − terminal, each with its recorded reason).
 */

export const RESULT_STATUSES = Object.freeze([
	'PENDING', 'QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED'
]);

/** Server item vocabulary includes honest pre-terminal states we surface as
 *  distinct gap statuses rather than result statuses. */
const GAP_STATUSES = Object.freeze(['NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'ERROR']);

export const STATUS_LABELS = Object.freeze({
	PENDING: 'Pending',
	QUEUED: 'Queued',
	RUNNING: 'Running',
	PASSED: 'Passed',
	FAILED: 'Failed',
	BLOCKED: 'Blocked',
	SKIPPED: 'Skipped',
	CANCELLED: 'Cancelled',
	NOT_RUN: 'Not run',
	UNAVAILABLE: 'Unavailable',
	NOT_SUPPORTED: 'Not supported',
	ERROR: 'Error'
});

export const TERMINAL_STATUSES = Object.freeze([
	'PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED', 'NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'ERROR'
]);

/**
 * Honest-pass guard: only a PASSED status counts as passed, and only when the
 * item records a completed execution (verdict or session link). Anything else
 * — including hand-patched status fields — surfaces as its true status.
 */
export function isExecutedPass(item) {
	if (!item || item.status !== 'PASSED') return false;
	return Boolean(item.verdict || item.sessionId);
}

/** Actual execution type from the runner: runtimeFacts carry the truth. */
export function executionTypeOf(item) {
	const facts = item?.runtimeFacts;
	return facts?.executionType
		?? facts?.executionLevel
		?? item?.executionLevel
		?? null;
}

/** Actual browser/engine identity from the runner — never the requested one. */
export function actualBrowserOf(item) {
	const facts = item?.runtimeFacts;
	return {
		browser: facts?.browser ?? facts?.launchedBrowser ?? item?.browser ?? null,
		browserVersion: facts?.browserVersion ?? item?.browserVersion ?? null,
		engine: facts?.launchedEngine ?? facts?.engine ?? null,
		brandedBinary: facts?.brandedBinary ?? facts?.browserBinary ?? null,
		userAgent: facts?.userAgent ?? null
	};
}

/**
 * Normalize one stored item into a result row for the UI. All fields come
 * from the record; missing evidence stays absent (null / empty arrays).
 */
export function toResultRow(item) {
	if (!item) return null;
	const actual = actualBrowserOf(item);
	return {
		id: item.id ?? null,
		ordinal: item.ordinal ?? null,
		device: item.device ?? null,
		platform: item.platform ?? null,
		os: item.os ?? null,
		osVersion: item.osVersion ?? null,
		requestedBrowser: item.browser ?? item.browserCode ?? null,
		requestedBrowserVersion: item.browserVersion ?? null,
		executionType: executionTypeOf(item),
		actualBrowser: actual.browser,
		actualBrowserVersion: actual.browserVersion,
		engine: actual.engine,
		brandedBinary: actual.brandedBinary,
		status: item.status ?? null,
		statusLabel: STATUS_LABELS[item.status] ?? String(item.status ?? ''),
		// The honest-pass guard: a "PASSED" row without a completed execution
		// is rendered by its status but never counted as passed.
		passed: isExecutedPass(item),
		verdict: item.verdict ?? null,
		reason: item.reason ?? null,
		error: item.error ?? null,
		// Pipeline Phase 3/5 (#15493/#15500): the unanswered question that
		// blocked an unattended item travels with the row so the board shows
		// WHY, not just "Blocked".
		question: item.question ?? null,
		autoAnswers: item.autoAnswers ?? 0,
		autoAnswerEvidence: Array.isArray(item.autoAnswerEvidence) ? [...item.autoAnswerEvidence] : [],
		durationMs: item.durationMs ?? null,
		sessionId: item.sessionId ?? null,
		artifacts: Array.isArray(item.artifactRefs) ? [...item.artifactRefs] : [],
		findings: Array.isArray(item.findings) ? [...item.findings] : [],
		defects: Array.isArray(item.defects) ? [...item.defects] : [],
		retryCount: item.retryCount ?? 0,
		updatedAt: item.updatedAt ?? null
	};
}

/**
 * Totals for a whole run: planned (all items), completed (terminal executed),
 * per-status counts, and coverage gaps = planned − terminal, each gap carrying
 * its recorded status + reason so the report explains itself.
 */
export function computeTotals(items = []) {
	const counts = Object.fromEntries(
		[...RESULT_STATUSES, ...GAP_STATUSES].map((status) => [status, 0])
	);
	let passed = 0;
	for (const item of items) {
		const status = item?.status;
		if (status in counts) counts[status] += 1;
		if (isExecutedPass(item)) passed += 1;
	}
	const terminal = items.filter((item) => TERMINAL_STATUSES.includes(item?.status));
	const gaps = items
		.filter((item) => !TERMINAL_STATUSES.includes(item?.status))
		.map((item) => ({
			device: item.device ?? null,
			requestedBrowser: item.browser ?? item.browserCode ?? null,
			browserVersion: item.browserVersion ?? null,
			status: item.status,
			statusLabel: STATUS_LABELS[item.status] ?? String(item.status),
			reason: item.reason ?? item.error ?? null
		}));
	return {
		planned: items.length,
		completed: terminal.length,
		/** Honest pass count — never includes unexecuted items. */
		passed,
		failed: counts.FAILED,
		blocked: counts.BLOCKED,
		skipped: counts.SKIPPED,
		cancelled: counts.CANCELLED,
		pending: counts.PENDING,
		queued: counts.QUEUED,
		running: counts.RUNNING,
		notRun: counts.NOT_RUN,
		unavailable: counts.UNAVAILABLE,
		notSupported: counts.NOT_SUPPORTED,
		error: counts.ERROR,
		statusCounts: counts,
		coverageGaps: gaps
	};
}

/**
 * Group rows for sectioned rendering: platform → device → rows. Keys are
 * stable strings; ordering follows insertion (catalog ordinal).
 */
export function groupResults(rows = []) {
	const groups = new Map();
	for (const row of rows) {
		const platformKey = row.platform ?? 'unknown';
		if (!groups.has(platformKey)) groups.set(platformKey, { platform: platformKey, devices: new Map() });
		const group = groups.get(platformKey);
		const deviceKey = row.device ?? 'Unknown device';
		if (!group.devices.has(deviceKey)) group.devices.set(deviceKey, { device: deviceKey, rows: [] });
		group.devices.get(deviceKey).rows.push(row);
	}
	return [...groups.values()].map((group) => ({
		platform: group.platform,
		devices: [...group.devices.values()]
	}));
}

/**
 * Filter rows by the facets the results view offers: status, browser family,
 * execution type, free-text search (device/OS/browser/version). Pure: returns
 * a new array.
 */
export function filterResults(rows = [], filters = {}) {
	const status = filters.status || null;
	const browser = filters.browser || null;
	const executionType = filters.executionType || null;
	const search = String(filters.search ?? '').trim().toLowerCase();
	return rows.filter((row) => {
		if (status && row.status !== status) return false;
		if (browser && row.requestedBrowser !== browser) return false;
		if (executionType && row.executionType !== executionType) return false;
		if (search) {
			const haystack = [
				row.device, row.platform, row.os, row.osVersion,
				row.requestedBrowser, row.requestedBrowserVersion,
				row.actualBrowser, row.actualBrowserVersion, row.engine
			].filter(Boolean).join(' ').toLowerCase();
			if (!haystack.includes(search)) return false;
		}
		return true;
	});
}

/** Distinct filter option values present in the rows (for the facet selects). */
export function facetValues(rows = []) {
	const statuses = new Set();
	const browsers = new Set();
	const executionTypes = new Set();
	for (const row of rows) {
		if (row.status) statuses.add(row.status);
		if (row.requestedBrowser) browsers.add(row.requestedBrowser);
		if (row.executionType) executionTypes.add(row.executionType);
	}
	return {
		statuses: [...statuses],
		browsers: [...browsers],
		executionTypes: [...executionTypes]
	};
}
