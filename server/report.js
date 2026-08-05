const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

const VERDICT_LABELS = {
	pass: 'Pass',
	pass_with_issues: 'Pass with issues',
	fail: 'Fail',
	blocked: 'Blocked'
};

/** Renders the session as a QA report a human can file or paste into a ticket. */
export function buildReportMarkdown(session) {
	const report = session.report;
	const lines = [];

	lines.push(`# QA report — ${session.targetUrl ?? session.title}`);
	lines.push('');
	lines.push(`- **Run:** ${new Date(session.createdAt).toLocaleString()}`);
	lines.push(`- **Verdict:** ${report ? VERDICT_LABELS[report.verdict] ?? report.verdict : 'Run not finished'}`);
	lines.push(`- **Findings:** ${session.findings.length}`);
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

	return lines.join('\n');
}
