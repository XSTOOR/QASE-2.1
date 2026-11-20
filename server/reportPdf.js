import { isSqaEngineSession } from './sqa/engine.js';
import { isFounderEngineSession } from './founder/engine.js';
import { buildFounderHtml } from './founder/report.js';
import { buildSqaHtml } from './sqa/report.js';
import { chromium } from 'playwright';
import { buildFindingFixPrompt } from './fixPromptBuilder.js';
import { getDeviceProfile } from './deviceProfiles.js';
import { QA_SCOPE_OPTIONS } from '../public/qaScopeCatalog.js';
import { formatFeedbackTimestamp } from './displayTime.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_COLOR = {
	critical: '#b91c1c',
	high: '#c2410c',
	medium: '#a16207',
	low: '#166534',
	info: '#334155'
};
const VERDICT_LABEL = {
	pass: 'Pass',
	pass_with_issues: 'Pass with issues',
	partial: 'Completed with gaps',
	fail: 'Fail',
	blocked: 'Blocked'
};

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, ch => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;'
	})[ch]);
}

function paragraphs(text) {
	if (!text) return '';
	return String(text)
		.split(/\n{2,}/)
		.map(block => '<p>' + escapeHtml(block).replace(/\n/g, '<br>') + '</p>')
		.join('');
}

function deviceLine(session) {
	const profile = getDeviceProfile(session.device);
	if (profile.kind === 'desktop') return 'Desktop (1440\u00d7900)';
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
	const label = parts.join(' \u00b7 ');
	// Phase 22: the execution label comes from RECORDED facts, never from the
	// catalog capability hint — a simulated run must never read "real device".
	const level = session.runtimeFacts?.executionLevel ?? session.executionLevel;
	const rawProvider = session.runtimeFacts?.provider ?? session.executionProviderActual;
	// D7: user-facing PDF text uses QASE-neutral provider labels.
	const provider = { browserstack: 'remote environment runtime', local: 'local runtime' }[rawProvider] ?? rawProvider;
	if (level === 'REAL_DEVICE') return `${label} \u2014 REAL DEVICE${provider ? ` (${provider})` : ''}`;
	if (level === 'VIRTUAL_DEVICE') return `${label} \u2014 VIRTUAL DEVICE${provider ? ` (${provider})` : ''}`;
	if (level === 'SIMULATED') return `${label} \u2014 SIMULATED${provider ? ` (${provider})` : ''}`;
	return provider ? `${label} \u2014 ${provider}` : label;
}

function headerBlock(session, title, verdictText) {
	const created = new Date(session.createdAt).toISOString();
	const finished = session.updatedAt ? new Date(session.updatedAt).toISOString() : '\u2014';
		const rows = [
			['Run ID', session.id],
			['Test case', session.testCaseSnapshot?.title
				? `${session.testCaseSnapshot.title}${session.testCaseSnapshot.caseNumber ? ` (${session.testCaseSnapshot.caseNumber})` : ''}`
				: (session.testCaseId ?? '\u2014')],
			['Target', session.targetUrl ?? '\u2014'],
			['Device', environmentLine(session) ?? deviceLine(session)],
			['Started', created],
			['Updated', finished]
		];
	// Phase 22: an explicit Execution row so every PDF states the level.
	const pdfLevel = session.runtimeFacts?.executionLevel ?? session.executionLevel;
	if (pdfLevel) {
		const rawPdfProvider = session.runtimeFacts?.provider ?? session.executionProviderActual;
		const pdfProvider = { browserstack: 'remote environment runtime', local: 'local runtime' }[rawPdfProvider] ?? rawPdfProvider;
		rows.push(['Execution', `${pdfLevel === 'REAL_DEVICE' ? 'REAL DEVICE' : pdfLevel}${pdfProvider ? ` (${pdfProvider})` : ''}`]);
	} else if (session.environmentSnapshot) {
		rows.push(['Execution', 'NOT AVAILABLE FOR REAL EXECUTION']);
	}
	if (verdictText) rows.push(['Verdict', verdictText]);
	if (session.tokenUsage && Number.isFinite(session.tokenUsage.totalTokens)) {
		const usage = session.tokenUsage;
		const fmt = value => (Number.isFinite(value) ? value.toLocaleString('en-US') : '—');
		rows.push(['Tokens', `${fmt(usage.inputTokens)} prompt / ${fmt(usage.outputTokens)} completion / ${fmt(usage.totalTokens)} total`
			+ (usage.estimated === true ? ' (estimated)' : '')]);
	}
	return '<table class="meta"><tbody>' + rows.map(([k, v]) =>
		'<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>'
	).join('') + '</tbody></table>';
}

function findingsSection(findings, session) {
	if (!Array.isArray(findings) || findings.length === 0) return '';
	const sorted = [...findings].sort((a, b) => {
		const s = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
		return s !== 0 ? s : String(a.title).localeCompare(String(b.title));
	});
	const rows = sorted.map((finding, index) => {
		const fixPrompt = buildFindingFixPrompt(finding, {
			targetUrl: session && session.targetUrl,
			mode: session && session.mode
		});
		const color = SEVERITY_COLOR[finding.severity] ?? '#334155';
		const steps = Array.isArray(finding.steps) && finding.steps.length > 0
			? '<ol>' + finding.steps.map(step => '<li>' + escapeHtml(step) + '</li>').join('') + '</ol>'
			: '<p class="muted">No steps recorded.</p>';
		const evidence = finding.evidence
			? '<pre class="evidence">' + escapeHtml(finding.evidence) + '</pre>'
			: '';
		return '<article class="finding">'
			+ '<header>'
			+ '<span class="severity" style="background:' + color + '">' + escapeHtml((finding.severity || 'info').toUpperCase()) + '</span>'
			+ '<h3>' + escapeHtml((index + 1) + '. ' + finding.title) + '</h3>'
			+ '</header>'
			+ '<dl class="finding-meta">'
			+ (finding.category ? '<dt>Area</dt><dd>' + escapeHtml(finding.category) + '</dd>' : '')
			+ (finding.url ? '<dt>URL</dt><dd>' + escapeHtml(finding.url) + '</dd>' : '')
			+ '</dl>'
			+ '<h4>Steps</h4>' + steps
			+ (finding.expected ? '<h4>Expected</h4><p>' + escapeHtml(finding.expected) + '</p>' : '')
			+ (finding.actual ? '<h4>Actual</h4><p>' + escapeHtml(finding.actual) + '</p>' : '')
			+ (evidence ? '<h4>Evidence</h4>' + evidence : '')
			+ '<h4>Fix prompt</h4><pre class="fix-prompt">' + escapeHtml(fixPrompt) + '</pre>'
			+ '</article>';
	}).join('');
	return '<section><h2>Findings (' + sorted.length + ')</h2>' + rows + '</section>';
}

function plainList(items, heading) {
	if (!Array.isArray(items) || items.length === 0) return '';
	return '<section><h2>' + escapeHtml(heading) + '</h2><ul>'
		+ items.map(item => '<li>' + escapeHtml(item) + '</li>').join('')
		+ '</ul></section>';
}

function values(items) {
	return Array.isArray(items) ? items.filter(item => item !== undefined && item !== null) : [];
}

function bulletList(items, { empty = '' } = {}) {
	const list = values(items);
	if (list.length === 0) return empty ? '<p class="muted">' + escapeHtml(empty) + '</p>' : '';
	return '<ul>' + list.map(item => '<li>' + escapeHtml(item) + '</li>').join('') + '</ul>';
}

function statusLabel(value) {
	return String(value ?? 'not recorded').replaceAll('_', ' ');
}

function statusPill(value) {
	const normalized = String(value ?? 'not_recorded').toLowerCase();
	const tone = ['pass', 'complete'].includes(normalized)
		? 'positive'
		: ['fail', 'critical', 'high'].includes(normalized)
			? 'negative'
			: ['blocked', 'medium', 'not_assessed'].includes(normalized)
				? 'warning'
				: 'neutral';
	return '<span class="status-pill status-' + tone + '">' + escapeHtml(statusLabel(normalized).toUpperCase()) + '</span>';
}

function metricGrid(items) {
	return '<div class="metric-grid">' + items.map(([label, value]) =>
		'<div class="metric"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>'
	).join('') + '</div>';
}

function traceabilityBlock(item = {}) {
	const evidenceIds = values(item.evidenceObservationIds ?? item.evidence_observation_ids);
	const assumptions = values(item.assumptions);
	if (evidenceIds.length === 0 && assumptions.length === 0) return '';
	return '<div class="traceability">'
		+ (evidenceIds.length > 0
			? '<div><strong>Evidence observations</strong>' + bulletList(evidenceIds) + '</div>'
			: '')
		+ (assumptions.length > 0
			? '<div><strong>Assumptions to validate</strong>' + bulletList(assumptions) + '</div>'
			: '')
		+ '</div>';
}

function titledList(title, items, empty = '') {
	const content = bulletList(items, { empty });
	return content ? '<h3>' + escapeHtml(title) + '</h3>' + content : '';
}

/**
 * "What was tested — selected coverage" section: the persisted scopeSelection
 * with per-option marks, so selected coverage is distinguishable from the
 * agent-executed Covered / Not covered lists above it.
 */
function coverageSelectionHtml(session) {
	const selected = Array.isArray(session?.scopeSelection) ? session.scopeSelection : null;
	if (!selected || selected.length === 0) return '';
	const blocks = [];
	for (const group of [{ key: 'uiux', label: 'UI &amp; User Experience' }, { key: 'other', label: 'Other supported coverage' }]) {
		const options = QA_SCOPE_OPTIONS.filter(option => option.group === group.key);
		if (options.length === 0 || !options.some(option => selected.includes(option.value))) continue;
		blocks.push('<h3>' + group.label + '</h3><ul class="coverage">'
			+ options.map(option => '<li data-on="' + (selected.includes(option.value) ? '1' : '0') + '">'
				+ '<span class="coverage-mark">' + (selected.includes(option.value) ? '\u2713' : '\u2717') + '</span>'
				+ escapeHtml(option.friendly) + '</li>').join('') + '</ul>');
	}
	if (blocks.length === 0) return '';
	return '<section><h2>What was tested \u2014 selected coverage</h2>' + blocks.join('') + '</section>';
}

function buildQaBody(session) {
	const report = session.report ?? {};
	const parts = [
		'<h1>QA report</h1>',
		headerBlock(session, 'QA', VERDICT_LABEL[report.verdict] ?? 'Run not finished')
	];
	if (report.summary) parts.push('<section><h2>Summary</h2>' + paragraphs(report.summary) + '</section>');
	if (Array.isArray(session.todos) && session.todos.length > 0) {
		parts.push('<section><h2>Test plan</h2><ul class="plan">'
			+ session.todos.map(todo => '<li data-status="' + escapeHtml(todo.status ?? '') + '">'
				+ '<span class="plan-status">' + escapeHtml(todo.status ?? '').replace('_', ' ') + '</span>'
				+ '<span class="plan-text">' + escapeHtml(todo.text ?? '') + '</span>'
			+ '</li>').join('') + '</ul></section>');
	}
	parts.push(plainList(report.covered, 'Covered'));
	parts.push(plainList(report.notCovered, 'Not covered'));
	parts.push(findingsSection(session.findings ?? [], session));
	parts.push(plainList(report.recommendations, 'Recommendations'));
	parts.push(feedbackSectionHtml(session));
	return parts.join('');
}

/**
 * User Feedback section for the PDF report. Rendered only when the run has
 * feedback attached (server injects it as session.userFeedback); content is
 * escaped, isolated per run by construction.
 */
function feedbackSectionHtml(session) {
	const feedback = session.userFeedback;
	if (!feedback || !Number.isFinite(feedback.rating)) return '';
	const stars = '\u2605'.repeat(feedback.rating) + '\u2606'.repeat(5 - feedback.rating);
	const submittedBy = escapeHtml(feedback.userName || 'User');
	const submittedOn = feedback.submittedAtFormatted
		? feedback.submittedAtFormatted
		: formatFeedbackTimestamp(feedback.submittedAt, undefined);
	const description = feedback.comments
		? '<p>' + paragraphs(String(feedback.comments)) + '</p>'
		: '';
	const improvement = feedback.improvement
		? '<p>' + paragraphs(String(feedback.improvement)) + '</p>'
		: '';
	return '<section><h2>User feedback</h2>'
		+ '<table class="meta"><tr><th>Rating</th><td>' + escapeHtml(stars) + ' ' + escapeHtml(feedback.rating) + '/5</td></tr>'
		+ (description ? '<tr><th>Description</th><td>' + description + '</td></tr>' : '')
		+ (improvement ? '<tr><th>What should we improve</th><td>' + improvement + '</td></tr>' : '')
		+ '<tr><th>Submitted by</th><td>' + submittedBy + '</td></tr>'
		+ '<tr><th>Submitted on</th><td>' + escapeHtml(submittedOn) + '</td></tr></table></section>';
}

function buildSqaBody(session) {
	// Assessments by the previous SQA engine have no compliance state; they render like a QA run.
	return isSqaEngineSession(session) ? buildSqaHtml(session) : buildQaBody(session);
}

function buildFounderBody(session) {
	// Reviews made by the previous Founder pipeline render like a QA run.
	return isFounderEngineSession(session) ? buildFounderHtml(session) + feedbackSectionHtml(session) : buildQaBody(session);
}

export function buildReportHtml(session) {
	const body = session.mode === 'sqa'
		? buildSqaBody(session)
		: session.mode === 'founder'
			? buildFounderBody(session)
			: buildQaBody(session);
	return '<!doctype html><html><head><meta charset="utf-8"><title>Qase report</title><style>'
		+ getStylesheet() + '</style></head><body>' + body + '</body></html>';
}

function getStylesheet() {
	return [
		'@page { size: A4; margin: 20mm 18mm 22mm 18mm; }',
		'body { font: 11pt/1.5 -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #0f172a; }',
		'h1 { font-size: 22pt; margin: 0 0 6pt; letter-spacing: -0.01em; }',
		'h2 { font-size: 14pt; margin: 18pt 0 6pt; border-bottom: 0.5pt solid #cbd5e1; padding-bottom: 4pt; }',
		'h3 { font-size: 12pt; margin: 12pt 0 4pt; }',
		'h4 { font-size: 10.5pt; margin: 8pt 0 2pt; color: #334155; }',
		'p { margin: 4pt 0; }',
		'table.meta { width: 100%; border-collapse: collapse; margin-top: 8pt; }',
		'table.meta th { text-align: left; width: 26%; padding: 3pt 6pt 3pt 0; font-weight: 600; color: #475569; vertical-align: top; }',
		'table.meta td { padding: 3pt 0; word-break: break-word; }',
		'.muted { color: #64748b; font-size: 10pt; }',
		'.code { color: #475569; font: 8.5pt/1.35 "SFMono-Regular", Menlo, Consolas, monospace; overflow-wrap: anywhere; }',
		'.outcome { border: 0.75pt solid #94a3b8; border-radius: 6pt; padding: 10pt 12pt; margin-top: 12pt; }',
		'.outcome h2 { margin-top: 0; }',
		'.outcome-line { display: flex; align-items: center; gap: 8pt; margin: 4pt 0 8pt; }',
		'.metric-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6pt; margin: 8pt 0; }',
		'.metric { border: 0.5pt solid #e2e8f0; border-radius: 4pt; padding: 6pt 8pt; }',
		'.metric span { display: block; color: #64748b; font-size: 8.5pt; }',
		'.metric strong { display: block; margin-top: 1pt; font-size: 12pt; }',
		'.status-pill { display: inline-block; border-radius: 999pt; padding: 2pt 6pt; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.04em; white-space: nowrap; }',
		'.status-positive { color: #166534; background: #dcfce7; }',
		'.status-negative { color: #991b1b; background: #fee2e2; }',
		'.status-warning { color: #92400e; background: #fef3c7; }',
		'.status-neutral { color: #334155; background: #e2e8f0; }',
		'.callout, .boundary { background: #f8fafc; border-left: 3pt solid #64748b; padding: 7pt 9pt; color: #334155; }',
		'.boundary { margin-top: 16pt; }',
		'.boundary h2 { margin-top: 0; }',
		'.card-list { display: grid; gap: 7pt; }',
		'.report-card { border: 0.5pt solid #cbd5e1; border-radius: 5pt; padding: 8pt 10pt; break-inside: avoid; }',
		'.sqa-evidence-card { break-inside: avoid; page-break-inside: avoid; margin-bottom: 10pt; }',
		'.sqa-evidence-card td { overflow-wrap: anywhere; word-break: break-word; }',
		'.report-card.compact { padding: 6pt 9pt; }',
		'.report-card h3, .report-card h4 { margin-top: 0; }',
		'.card-heading { display: flex; align-items: flex-start; gap: 7pt; }',
		'.card-heading h3 { margin: 0; flex: 1; }',
		'.rank { display: inline-flex; width: 18pt; height: 18pt; border-radius: 50%; align-items: center; justify-content: center; background: #0f172a; color: white; font-size: 8.5pt; font-weight: 700; }',
		'.traceability { margin-top: 6pt; padding: 6pt 8pt; background: #f8fafc; border-radius: 4pt; color: #475569; font-size: 9pt; }',
		'.traceability > div + div { margin-top: 4pt; }',
		'.traceability ul, .evidence-list { margin-top: 2pt; }',
		'.finding { border: 0.5pt solid #cbd5e1; border-radius: 4pt; padding: 10pt 12pt; margin: 8pt 0; page-break-inside: avoid; }',
		'.finding header { display: flex; align-items: center; gap: 8pt; margin-bottom: 6pt; }',
		'.finding header h3 { margin: 0; }',
		'.severity { color: white; font-size: 8pt; font-weight: 700; letter-spacing: 0.06em; padding: 2pt 6pt; border-radius: 999pt; }',
		'.finding-meta { display: grid; grid-template-columns: auto 1fr; column-gap: 8pt; row-gap: 2pt; margin: 4pt 0 6pt; font-size: 10pt; color: #334155; }',
		'.finding-meta dt { font-weight: 600; }',
		'.finding-meta dd { margin: 0; word-break: break-word; }',
		'.evidence { background: #f1f5f9; border-radius: 4pt; padding: 8pt; font: 9.5pt/1.45 "SFMono-Regular", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }',
		'.fix-prompt { background: #0f172a; color: #e2e8f0; border-radius: 4pt; padding: 8pt 10pt; font: 9pt/1.5 "SFMono-Regular", Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-word; }',
		'ul, ol { margin: 4pt 0 4pt 18pt; }',
		'ul.plan { list-style: none; margin-left: 0; padding: 0; }',
		'ul.plan li { display: grid; grid-template-columns: 90pt 1fr; column-gap: 8pt; padding: 2pt 0; border-bottom: 0.25pt solid #e2e8f0; }',
		'.plan-status { text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.06em; color: #475569; }',
		'ul.sqa-list { list-style: none; padding: 0; margin-left: 0; }',
		'ul.sqa-list li { padding: 4pt 0; border-bottom: 0.25pt solid #e2e8f0; }',
		'table.result-table { width: 100%; border-collapse: collapse; margin-top: 7pt; font-size: 9pt; }',
		'table.result-table thead { display: table-header-group; }',
		'table.result-table th { text-align: left; color: #475569; border-bottom: 1pt solid #94a3b8; padding: 4pt; }',
		'table.result-table td { vertical-align: top; border-bottom: 0.25pt solid #e2e8f0; padding: 4pt; }',
		'section { page-break-inside: auto; }'
	].join('\n');
}

export async function renderReportPdf(session) {
	const html = buildReportHtml(session);
	let browser;
	try {
		browser = await chromium.launch({ headless: true });
	} catch (error) {
		const message = 'PDF rendering requires the bundled Chromium. Run "npm run install-browser". (' + (error?.message ?? error) + ')';
		const enriched = new Error(message);
		enriched.code = 'QASE_PDF_BROWSER_UNAVAILABLE';
		throw enriched;
	}
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.setContent(html, { waitUntil: 'networkidle', timeout: 15_000 });
		return await page.pdf({
			format: 'A4',
			printBackground: true,
			margin: { top: '20mm', bottom: '22mm', left: '18mm', right: '18mm' },
			displayHeaderFooter: true,
			headerTemplate: '<div style="font-size:8pt; width:100%; padding:0 18mm; color:#64748b;"><span>Qase \u2014 ' + escapeHtml(session.mode === 'sqa' ? 'SQA' : session.mode === 'founder' ? 'Founder' : 'QA') + ' report</span></div>',
			footerTemplate: '<div style="font-size:8pt; width:100%; padding:0 18mm; color:#64748b; display:flex; justify-content:space-between;"><span>' + escapeHtml(session.targetUrl ?? '') + '</span><span class="pageNumber"></span></div>'
		});
	} finally {
		await browser.close().catch(() => undefined);
	}
}
