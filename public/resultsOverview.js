import { runPresentationStatus } from './runPresentation.js';

export function resultsOverviewModel(session) {
	const report = session?.report || {};
	const findings = Array.isArray(session?.findings) ? session.findings : [];
	const severity = Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map(level => {
		const recorded = report.bySeverity?.[level];
		return [level, Number.isFinite(recorded) ? recorded : findings.filter(finding => String(finding.severity).toLowerCase() === level).length];
	}));
	const status = runPresentationStatus(session);
	const total = findings.length || (Number.isFinite(report.findings) ? report.findings : 0);
	const tone = status === 'blocked' ? 'blocked' : severity.critical + severity.high > 0 || ['fail', 'failed'].includes(report.verdict) ? 'attention' : report.verdict === 'pass' ? 'passed' : 'neutral';
	return {
		status, tone, severity, total,
		title: status === 'blocked' ? 'Testing needs a prerequisite' : ['fail', 'failed'].includes(report.verdict) ? 'Issues need your attention' : status === 'partial' ? 'Testing completed with coverage gaps' : total ? 'Review the findings before release' : 'Your test report is ready',
		summary: report.summary || 'Review the recorded findings and evidence from this execution.',
		gaps: Array.isArray(report.notCovered) ? report.notCovered : [],
		next: Array.isArray(report.recommendations) ? report.recommendations : [],
		date: report.ts || session?.completedAt || session?.updatedAt
	};
}

export function renderResultsOverview(session, { document, onFindings, onWorkspace }) {
	const model = resultsOverviewModel(session);
	const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
	const root = el('section', 'results-overview'); root.dataset.status = model.status; root.dataset.tone = model.tone;
	root.setAttribute('aria-label', 'Execution overview');
	const hero = el('div', 'ro-outcome');
	const icon = el('span', 'ro-outcome-icon', model.tone === 'passed' ? '✓' : model.tone === 'neutral' ? 'i' : '!'); icon.setAttribute('aria-hidden', 'true');
	const text = el('div', 'ro-outcome-text'); text.append(el('p', 'ro-eyebrow', 'EXECUTION OUTCOME'), el('h2', '', model.title), el('p', 'ro-summary', model.summary));
	hero.append(icon, text); root.append(hero);
	const metrics = el('dl', 'ro-metrics');
	for (const [label, count, detail] of [
		['Findings recorded', model.total, 'From this execution'],
		['High-priority findings', model.severity.critical + model.severity.high, 'Critical and high severity'],
		['Coverage gaps', model.gaps.length, model.gaps.length ? 'Areas not fully tested' : 'None reported']
	]) { const metric = el('div'); metric.append(el('dt', '', label), el('dd', '', String(count)), el('small', '', detail)); metrics.append(metric); }
	root.append(metrics);
	const content = el('div', 'ro-content');
	const assessment = el('section', 'ro-assessment'); assessment.append(el('h3', '', 'Finding severity'));
	const severity = el('div', 'ro-severity');
	for (const [level, count] of Object.entries(model.severity)) {
		const item = el('div', 'ro-severity-item'); item.dataset.severity = level;
		item.append(el('span', 'ro-severity-dot'), el('span', '', level[0].toUpperCase() + level.slice(1)), el('strong', '', String(count))); severity.append(item);
	}
	assessment.append(severity);
	const findings = el('button', 'btn btn-ghost ro-review-findings', `Review ${model.total === 1 ? 'finding' : 'findings'} →`); findings.type = 'button'; findings.disabled = !model.total; findings.addEventListener('click', onFindings); assessment.append(findings);
	const next = el('aside', 'ro-next'); next.append(el('p', 'ro-eyebrow', model.status === 'blocked' ? 'TO CONTINUE TESTING' : 'RECOMMENDED NEXT STEP'));
	const steps = model.next.length ? model.next : [model.status === 'blocked' ? 'Review the missing prerequisite in the coverage details, then return to the run to provide it.' : model.total ? 'Review the findings and supporting evidence, then prioritize fixes.' : 'Review the coverage details before deciding whether to run additional checks.'];
	const list = el('ul'); for (const step of steps) list.append(el('li', '', step)); next.append(list);
	const back = el('button', 'btn btn-primary', 'Return to run →'); back.type = 'button'; back.addEventListener('click', onWorkspace); next.append(back);
	content.append(assessment, next); root.append(content);
	return root;
}
