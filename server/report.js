import { getDeviceProfile } from './deviceProfiles.js';
import { QA_SCOPE_OPTIONS } from '../public/qaScopeCatalog.js';
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

const VERDICT_LABELS = {
	pass: 'Pass',
	pass_with_issues: 'Pass with issues',
	fail: 'Fail',
	blocked: 'Blocked'
};

function deviceLine(session) {
	const profile = getDeviceProfile(session.device);
	const width = session.deviceLandscape ? profile.viewport.height : profile.viewport.width;
	const height = session.deviceLandscape ? profile.viewport.width : profile.viewport.height;
	const orientation = session.deviceLandscape ? 'landscape' : 'portrait';
	return profile.label + ' (' + orientation + ', ' + width + '\u00d7' + height + ', DPR ' + profile.deviceScaleFactor + ', touch)';
}

function environmentLine(session) {
	const snapshot = session.environmentSnapshot;
	if (!snapshot) return undefined;
	const parts = [
		snapshot.device ?? snapshot.deviceLabel,
		snapshot.osVersion,
		[snapshot.browser, snapshot.browserVersion].filter(Boolean).join(' ')
	].filter(Boolean);
	const label = parts.join(' · ');
	// Phase 22: the execution label comes from RECORDED facts, never from the
	// catalog capability hint — a simulated run must never read "real device".
	const level = session.runtimeFacts?.executionLevel ?? session.executionLevel;
	const rawProvider = session.runtimeFacts?.provider ?? session.executionProviderActual;
	// D7: user-facing report text uses QASE-neutral provider labels; the raw
	// provider key stays internal (API contract unchanged).
	const provider = { browserstack: 'remote environment runtime', local: 'local runtime' }[rawProvider] ?? rawProvider;
	if (level === 'REAL_DEVICE') return `${label} — REAL DEVICE${provider ? ` (${provider})` : ''}`;
	if (level === 'VIRTUAL_DEVICE') return `${label} — VIRTUAL DEVICE${provider ? ` (${provider})` : ''}`;
	if (level === 'SIMULATED') return `${label} — SIMULATED${provider ? ` (${provider})` : ''}`;
	return provider ? `${label} — ${provider}` : label;
}

/** A deterministic completion reply, grounded in the saved QA results. */
export function buildQaChatReport(session) {
	const report = session.report;
	const brief = (value, limit) => {
		const text = String(value ?? '').replace(/\s+/g, ' ').trim();
		return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
	};
	const findings = [...(session.findings ?? [])].sort((a, b) =>
		SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
	const lines = [`**QA report — ${VERDICT_LABELS[report.verdict] ?? report.verdict}**`];
	if (report.summary) lines.push(brief(report.summary, 350));
	if (report.covered?.length) {
		lines.push(`Tested: ${report.covered.slice(0, 4).map(item => brief(item, 60)).join(', ')}${report.covered.length > 4 ? ` (+${report.covered.length - 4} more areas)` : ''}.`);
	}
	if (findings.length) {
		lines.push(`**${findings.length} finding${findings.length === 1 ? '' : 's'}:**`, ...findings.slice(0, 5).map(finding =>
			`- **${String(finding.severity).toUpperCase()}:** ${brief(finding.title, 140)}${finding.actual ? ` — ${brief(finding.actual, 180)}` : ''}`));
		if (findings.length > 5) lines.push(`${findings.length - 5} more findings in the Findings tab.`);
	} else {
		lines.push(report.verdict === 'blocked'
			? 'No findings recorded; testing was blocked.'
			: 'No issues found in the checks performed.');
	}
	if (report.notCovered?.length) {
		lines.push(`Not covered: ${report.notCovered.slice(0, 3).map(item => brief(item, 120)).join('; ')}${report.notCovered.length > 3 ? ` (+${report.notCovered.length - 3} more; see Report)` : ''}.`);
	}
	if (report.recommendations?.length) lines.push(`Next: ${brief(report.recommendations[0], 180)}`);
	lines.push('Full details and reproduction steps are in the Report and Findings tabs.');
	return lines.join('\n\n').replace(/\n\n- /g, '\n- ');
}

/** Renders the session as a QA report a human can file or paste into a ticket. */
/** Selected-coverage block for the QA report: what the user asked to test. */
function coverageSelectionLines(session) {
	const selected = Array.isArray(session?.scopeSelection) ? session.scopeSelection : null;
	if (!selected || selected.length === 0) return [];
	const lines = ['', '## What was tested — selected coverage', ''];
	for (const group of [{ key: 'uiux', label: 'UI & User Experience' }, { key: 'other', label: 'Other supported coverage' }]) {
		const options = QA_SCOPE_OPTIONS.filter(option => option.group === group.key);
		if (options.length === 0 || !options.some(option => selected.includes(option.value))) continue;
		lines.push(`**${group.label}**`, '');
		for (const option of options) {
			lines.push(`- ${selected.includes(option.value) ? '✓' : '✗'} ${option.friendly}`);
		}
		lines.push('');
	}
	return lines;
}

export function buildReportMarkdown(session) {
	const report = session.report;
	const lines = [];

	lines.push(`# QA report — ${session.targetUrl ?? session.title}`);
	lines.push('');
	if (session.testCaseSnapshot?.title || session.testCaseId) {
		lines.push(`- **Test case:** ${session.testCaseSnapshot?.title ?? session.testCaseId}${session.testCaseSnapshot?.caseNumber ? ` (${session.testCaseSnapshot.caseNumber})` : ''}`);
	}
	lines.push(`- **Run:** ${new Date(session.createdAt).toLocaleString()}`);
	lines.push(`- **Verdict:** ${report ? VERDICT_LABELS[report.verdict] ?? report.verdict : 'Run not finished'}`);
	lines.push(`- **Findings:** ${session.findings.length}`);
	const environment = environmentLine(session) ?? deviceLine(session);
	if (environment) lines.push(`- **Environment:** ${environment}`);
	// Phase 22: execution level is always stated — from RECORDED facts, never
	// the requested level — so no simulated run can pass as real-device evidence.
	const execution = session.runtimeFacts?.executionLevel ?? session.executionLevel;
	if (execution) {
		const rawProvider = session.runtimeFacts?.provider ?? session.executionProviderActual;
		const provider = { browserstack: 'remote environment runtime', local: 'local runtime' }[rawProvider] ?? rawProvider;
		lines.push(`- **Execution:** ${execution === 'REAL_DEVICE' ? 'REAL DEVICE' : execution}${provider ? ` (${provider})` : ''}`);
		// R2 #14491: the runtime-authoritative browser identity — what the
		// runtime OBSERVED, never the catalog's claim.
		const identity = session.report?.runtimeIdentity;
		if (identity?.browserCode) {
			const observed = [identity.browserCode, identity.browserVersion].filter(Boolean).join(' ');
			const enginePart = identity.engine ? `, ${identity.engine} engine` : '';
			lines.push(`- **Runtime browser (observed):** ${observed}${enginePart}`);
		}
	} else if (session.environmentSnapshot) {
		lines.push('- **Execution:** NOT AVAILABLE FOR REAL EXECUTION');
	}
	if (session.tokenUsage && Number.isFinite(session.tokenUsage.totalTokens)) {
		const usage = session.tokenUsage;
		const fmt = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
		lines.push(`- **Tokens:** ${fmt(usage.inputTokens)} prompt / ${fmt(usage.outputTokens)} completion / ${fmt(usage.totalTokens)} total${usage.estimated === true ? ' (estimated)' : ''}`);
	}
	lines.push('');

	if (report?.summary) {
		lines.push('## Summary', '', report.summary, '');
	}

	if (session.todos.length > 0) {
		lines.push('## Test plan', '');
		for (const todo of session.todos) {
			const mark = todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '/' : ' ';
			lines.push(`- [${mark}] ${todo.text}`);
		}
		lines.push('');
	}

	if (report?.covered?.length) {
		lines.push('## Covered', '', ...report.covered.map(item => `- ${item}`), '');
	}
	if (report?.notCovered?.length) {
		lines.push('## Not covered', '', ...report.notCovered.map(item => `- ${item}`), '');
	}
	if (coverageSelectionLines(session).length > 0) {
		lines.push(...coverageSelectionLines(session));
	}

	if (session.findings.length > 0) {
		lines.push('## Findings', '');
		const sorted = [...session.findings].sort(
			(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
		);
		sorted.forEach((finding, index) => {
			lines.push(`### ${index + 1}. ${finding.title}`);
			lines.push('');
			lines.push(`**Severity:** ${finding.severity} · **Area:** ${finding.category}${finding.url ? ` · **URL:** ${finding.url}` : ''}`);
			lines.push('');
			if (finding.steps?.length) {
				lines.push('**Steps to reproduce**', '');
				finding.steps.forEach((step, stepIndex) => lines.push(`${stepIndex + 1}. ${step}`));
				lines.push('');
			}
			lines.push(`**Expected:** ${finding.expected}`);
			lines.push('');
			lines.push(`**Actual:** ${finding.actual}`);
			lines.push('');
			if (finding.evidence) {
				lines.push('**Evidence**', '', '```', finding.evidence, '```', '');
			}
		});
	} else {
		lines.push('## Findings', '', 'None recorded.', '');
	}

	if (report?.recommendations?.length) {
		lines.push('## Recommendations', '', ...report.recommendations.map(item => `- ${item}`), '');
	}

	const matrixSection = buildMatrixSectionMarkdown(session);
	if (matrixSection) lines.push(matrixSection);

	const feedback = buildFeedbackSectionMarkdown(session);
	if (feedback) lines.push(feedback);

	return lines.join('\n');
}

/**
 * Matrix coverage gap section (#14652 NI04 spec item 3). Rendered only for
 * sessions spawned by a matrix run — the caller injects session.matrixCoverage
 * (the computeMatrixCoverage output for that run) before report generation,
 * mirroring the userFeedback injection pattern above. Every figure comes from
 * the recorded item statuses; nothing is hardcoded.
 */
export function buildMatrixSectionMarkdown(session) {
	const matrix = session.matrixCoverage;
	if (!matrix || !matrix.execution) return '';
	const exec = matrix.execution;
	const lines = [];
	lines.push('## Matrix coverage', '');
	lines.push(`Profiles requested ${exec.profilesRequested} · executed ${exec.profilesExecuted} · passed ${exec.passed} · failed ${exec.failed} · not run ${exec.notRun} · unavailable ${exec.unavailable} · not supported ${exec.notSupported} · blocked ${exec.blocked} · error ${exec.error}`, '');
	// RT5 (#14757): distinct coverage-state breakdown — every state listed
	// separately; unexecuted environments never appear as Passed.
	if (Array.isArray(exec.stateCounts) && exec.stateCounts.length) {
		lines.push('**Coverage states**', '');
		for (const state of exec.stateCounts) {
			lines.push(`- ${state.label}: ${state.count}`);
		}
		lines.push('');
	}
	lines.push('**Devices**', '');
	for (const category of matrix.deviceCategories ?? []) {
		const mark = category.covered ? '✓' : '⚠';
		lines.push(`- ${mark} ${category.label} — ${category.executed}/${category.requested} executed`);
	}
	lines.push('', '**Browsers**', '');
	for (const browser of matrix.browsers ?? []) {
		const mark = browser.covered ? '✓' : '⚠';
		const reason = !browser.covered && browser.gapReason ? ` — ${browser.gapReason}` : '';
		lines.push(`- ${mark} ${browser.browser} — ${browser.executed}/${browser.requested} executed${reason}`);
	}
	lines.push('');

	// #14942 (Phase 4): per-configuration rows + totals for the whole QA matrix
	// run, straight from the recorded items. Same honesty rules as the UI board:
	// an unexecuted configuration can never appear as a pass, and every
	// non-terminal item surfaces as a coverage gap with its recorded reason.
	const items = session.matrixCoverage?.runItems ?? session.matrixItems ?? null;
	if (Array.isArray(items) && items.length) {
		const passed = items.filter((item) => item.status === 'PASSED' && (item.verdict || item.sessionId));
		const failed = items.filter((item) => item.status === 'FAILED');
		const blocked = items.filter((item) => item.status === 'BLOCKED');
		const skipped = items.filter((item) => item.status === 'SKIPPED');
		const cancelled = items.filter((item) => item.status === 'CANCELLED');
		const terminal = ['PASSED', 'FAILED', 'BLOCKED', 'SKIPPED', 'CANCELLED', 'NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'ERROR'];
		const gaps = items.filter((item) => !terminal.includes(item.status));

		lines.push('**Configurations**', '');
		const completedCount = items.filter((item) => terminal.includes(item.status)).length;
		lines.push(`Planned ${items.length} · completed ${completedCount} · passed ${passed.length} · failed ${failed.length} · blocked ${blocked.length} · skipped ${skipped.length} · cancelled ${cancelled.length} · coverage gaps ${gaps.length}`, '');
		for (const item of items) {
			const identity = [item.device, item.os, item.osVersion, item.browser ?? item.browserCode, item.browserVersion]
				.filter(Boolean).join(' · ');
			const facts = item.runtimeFacts ?? {};
			const actual = facts.launchedEngine || facts.engine
				? ` (engine: ${facts.launchedEngine ?? facts.engine}` +
					(facts.executionType || item.executionLevel ? `, execution: ${facts.executionType ?? item.executionLevel}` : '') + ')'
				: '';
			const reason = item.reason ? item.reason : '';
			const evidence = [
				Array.isArray(item.artifactRefs) && item.artifactRefs.length ? `📎 ${item.artifactRefs.length}` : null,
				Array.isArray(item.defects) && item.defects.length ? `🐞 ${item.defects.length}` : null
			].filter(Boolean).join(' ');
			const tail = [evidence, reason].filter(Boolean).join(' · ');
			lines.push(`- **${String(item.status ?? '')}** ${identity}${actual}${tail ? ` — ${tail}` : ''}`);
		}
		if (gaps.length) {
			lines.push('', '**Coverage gaps**', '');
			for (const item of gaps) {
				const identity = [item.device, item.os, item.browser ?? item.browserCode, item.browserVersion]
					.filter(Boolean).join(' · ');
				lines.push(`- ⚠ ${identity}: ${String(item.status ?? '').toLowerCase()}${item.reason ? ` — ${item.reason}` : ''}`);
			}
		}
		lines.push('');
	}
	return lines.join('\n');
}

/**
 * User Feedback section for downloaded reports. Rendered only when the run
 * has feedback attached (server injects it as session.userFeedback before
 * report generation); isolated per run by construction.
 */
export function buildFeedbackSectionMarkdown(session) {
	const feedback = session.userFeedback;
	if (!feedback || !Number.isFinite(feedback.rating)) return '';
	const stars = '★★★★★'.slice(0, feedback.rating) + '☆☆☆☆☆'.slice(0, 5 - feedback.rating);
	const lines = [];
	lines.push('## User feedback', '');
	lines.push(`- **Rating:** ${stars} ${feedback.rating}/5`);
	if (feedback.comments) {
		lines.push('', '>', ...String(feedback.comments).split('\n').map(line => `> ${line}`), '');
	}
	if (feedback.improvement) {
		lines.push('- **What should we improve:**', '', '> ', ...String(feedback.improvement).split('\n').map(line => `> ${line}`), '');
	}
	const submittedBy = feedback.userName || 'User';
	const submittedOn = feedback.submittedAt
		? new Date(feedback.submittedAt).toLocaleString()
		: '—';
	lines.push(`- **Submitted by:** ${submittedBy}`);
	lines.push(`- **Submitted on:** ${submittedOn}`);
	lines.push('');
	return lines.join('\n');
}
