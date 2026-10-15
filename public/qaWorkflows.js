/**
 * QA workflows (Phase 11): pure helpers behind one-click Test Case runs, the
 * 3-step Bulk Runs wizard, quick-action filters and smart presets.
 *
 * No DOM here — everything is testable data-in/data-out. Views consume these.
 */

// ── Last-run aggregation ────────────────────────────────────────────────────

/** Map caseNumber → most recent QA session for that case. */
export function lastRunByCase(sessions = []) {
	const byCase = new Map();
	for (const session of sessions) {
		const caseNumber = session.testCaseId ?? session.testCaseSnapshot?.caseNumber;
		if (!caseNumber) continue;
		if (session.mode && session.mode !== 'qa') continue;
		const at = Date.parse(session.updatedAt ?? session.createdAt ?? '') || 0;
		const current = byCase.get(caseNumber);
		const currentAt = current ? Date.parse(current.updatedAt ?? current.createdAt ?? '') || 0 : -1;
		if (!current || at >= currentAt) byCase.set(caseNumber, session);
	}
	return byCase;
}

/**
 * Human status for a case given its last session:
 * Passed / Failed / Running / Not run.
 * Heuristic (no server verdict field exists): a finished QA run with recorded
 * findings counts as Failed; finished with none as Passed; anything still
 * live as Running; no session at all as Not run.
 */
export function caseStatus(testCase, lastRun) {
	if (!lastRun) return 'Not run';
	const status = String(lastRun.status ?? '').toLowerCase();
	if (['running', 'queued', 'starting', 'awaiting_input', 'resuming'].includes(status)) return 'Running';
	if (status !== 'done') return 'Not run';
	// List payloads carry findingCount (not the findings array) — accept both.
	const findings = Array.isArray(lastRun.findings) ? lastRun.findings : null;
	if (findings) return findings.length ? 'Failed' : 'Passed';
	const count = Number(lastRun.findingCount ?? 0);
	return count > 0 ? 'Failed' : 'Passed';
}

/** Sorted status rank for display ordering. */
export function statusRank(status) {
	return { Failed: 0, Running: 1, 'Not run': 2, Passed: 3 }[status] ?? 3;
}

// ── Environment-derived card metadata ───────────────────────────────────────

/** Platforms touched by a case's assigned environments, e.g. ['iOS','Android']. */
export function platformsOf(testCase, environmentsById) {
	const labels = new Set();
	for (const envId of testCase.environmentIds ?? []) {
		const env = environmentsById.get(envId);
		if (env?.platformLabel) labels.add(env.platformLabel);
		else if (env?.platform) labels.add(env.platform.toUpperCase());
	}
	return [...labels];
}

/** Device/OS/Browser summary lines for a case (unique, sorted). */
export function caseEnvLines(testCase, environmentsById) {
	const lines = new Set();
	for (const envId of testCase.environmentIds ?? []) {
		const env = environmentsById.get(envId);
		if (!env) continue;
		lines.add([env.device, [env.os, env.osVersion].filter(Boolean).join(' '), env.browser].filter(Boolean).join(' · '));
	}
	return [...lines];
}

// ── Wizard case filters ─────────────────────────────────────────────────────

/**
 * Wizard "what to run" modes → case sets.
 *  all        — every case
 *  selected   — the explicitly chosen ones
 *  failed     — last run Failed
 *  notRun     — never run (spec's "Not Run Recently")
 */
export function filterCasesForWizard(cases = [], mode = 'all', lastRuns = new Map(), selected = []) {
	if (mode === 'selected') {
		const chosen = new Set(selected);
		return cases.filter((c) => chosen.has(c.caseNumber));
	}
	if (mode === 'failed') return cases.filter((c) => caseStatus(c, lastRuns.get(c.caseNumber)) === 'Failed');
	if (mode === 'notRun') return cases.filter((c) => caseStatus(c, lastRuns.get(c.caseNumber)) === 'Not run');
	return [...cases];
}

// ── Run pairs ───────────────────────────────────────────────────────────────

/** Environment ids a run-target choice resolves to for one case. */
export function resolveCaseEnvIds(testCase, choice, { defaultEnvId = '', chosenEnvIds = [] } = {}) {
	const assigned = testCase.environmentIds ?? [];
	if (choice === 'current') return defaultEnvId ? [defaultEnvId] : [];
	if (choice === 'all') return assigned;
	if (choice === 'choose') return chosenEnvIds.filter((id) => assigned.includes(id));
	return [];
}

/** Flat (case, envId) execution list for the resolved targets. */
export function resolveRunPairs(cases = [], choice, context = {}) {
	const pairs = [];
	for (const testCase of cases) {
		for (const envId of resolveCaseEnvIds(testCase, choice, context)) {
			pairs.push({ testCase, envId });
		}
	}
	return pairs;
}

// ── Wizard math ─────────────────────────────────────────────────────────────

/** Auto-calculated wizard summary. Warns before large batches. */
export function wizardSummary(testCount, deviceCount) {
	const total = testCount * deviceCount;
	return {
		tests: testCount,
		devices: deviceCount,
		total,
		warn: total > 40,
		warnText: total > 40
			? `${total} executions will run one after another — this can take a while.`
			: ''
	};
}

// ── Smart presets ───────────────────────────────────────────────────────────

export const PRESETS = [
	{ id: 'apple-mobile', label: 'Apple Mobile', match: (env) => env.platform === 'ios' },
	{ id: 'android-mobile', label: 'Android Mobile', match: (env) => env.platform === 'android' },
	{ id: 'windows-desktop', label: 'Windows Desktop', match: (env) => env.platform === 'windows' },
	{ id: 'all-mobile', label: 'All Mobile', match: (env) => env.platform === 'ios' || env.platform === 'android' },
	{ id: 'all-browsers', label: 'All Browsers', match: () => true },
	{ id: 'full-regression', label: 'Full Regression', match: () => true }
];

/** Preset id → environments from a full list (empty array when nothing matches). */
export function environmentsForPreset(presetId, environments = []) {
	const preset = PRESETS.find((p) => p.id === presetId);
	if (!preset) return [];
	return environments.filter((env) => env.active !== false && preset.match(env));
}

// ── Bug report (Phase 6 entity is out of scope; prepared markdown now) ──────

/** Build a copy/paste-ready bug report from the latest failed QA session. */
export function buildBugMarkdown(session, environment) {
	if (!session) return '';
	const env = environment ?? session.environmentSnapshot;
	const envLine = env
		? [env.device, [env.os, env.osVersion].filter(Boolean).join(' '), [env.browser, env.browserVersion].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
		: 'unknown environment';
	const findings = Array.isArray(session.findings) ? session.findings : [];
	const lines = [
		`# Bug report — ${session.title ?? 'QA run'} (${session.id ?? 'no id'})`,
		'',
		`- **When:** ${session.updatedAt ?? session.createdAt ?? 'unknown'}`,
		`- **Environment:** ${envLine}`,
		`- **Target:** ${session.targetUrl ?? 'n/a'}`,
		`- **Test case:** ${session.testCaseId ?? 'not linked'}`,
		''
	];
	if (!findings.length) {
		lines.push('_No findings recorded on this run._');
		return lines.join('\n');
	}
	for (const finding of findings) {
		lines.push(
			`## ${finding.title ?? 'Finding'} (${finding.severity ?? 'unrated'} · ${finding.category ?? 'general'})`,
			'',
			`- **Expected:** ${finding.expected ?? 'n/a'}`,
			`- **Actual:** ${finding.actual ?? 'n/a'}`,
			`- **URL:** ${finding.url ?? session.targetUrl ?? 'n/a'}`
		);
		if (Array.isArray(finding.steps) && finding.steps.length) {
			lines.push('- **Steps:**', ...finding.steps.map((s, i) => `  ${i + 1}. ${s}`));
		}
		lines.push('');
	}
	return lines.join('\n').trim() + '\n';
}
