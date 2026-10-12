import { QA_SCOPE_OPTIONS } from '../public/qaScopeCatalog.js';
import { formatFeedbackTimestamp } from './displayTime.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

const VERDICT_LABELS = {
	pass: 'Pass',
	pass_with_issues: 'Pass with issues',
	fail: 'Fail',
	blocked: 'Blocked'
};

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
	lines.push(`- **Run:** ${new Date(session.createdAt).toLocaleString()}`);
	lines.push(`- **Verdict:** ${report ? VERDICT_LABELS[report.verdict] ?? report.verdict : 'Run not finished'}`);
	lines.push(`- **Findings:** ${session.findings.length}`);
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

	const feedback = buildFeedbackSectionMarkdown(session);
	if (feedback) lines.push(feedback);

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
	const submittedOn = feedback.submittedAtFormatted
		? feedback.submittedAtFormatted
		: formatFeedbackTimestamp(feedback.submittedAt, undefined);
	lines.push(`- **Submitted by:** ${submittedBy}`);
	lines.push(`- **Submitted on:** ${submittedOn}`);
	lines.push('');
	return lines.join('\n');
}
