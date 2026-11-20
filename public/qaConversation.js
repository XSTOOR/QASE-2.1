/**
 * QA conversation cards.
 *
 * The QA engine talks in the run conversation: short step messages
 * (kind "qa-step"), one card per confirmed finding ("qa-finding", message id
 * "qaf-<findingId>") and a final report card ("qa-report"). This module turns
 * those messages into DOM; app.js owns the transcript and the actions.
 */
import { buildFindingFixPrompt } from './fixPromptBuilder.js';
import { isSqaComplianceRun, renderSqaReportCard } from './sqaComplianceView.js';

export const QA_MESSAGE_KINDS = new Set(['qa-step', 'qa-finding', 'qa-report', 'sqa-report']);

const SEVERITY_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };
const VERDICT = {
	fail: { label: 'Fail', tone: 'fail', line: 'Serious issues need fixing before release.' },
	pass_with_issues: { label: 'Pass with issues', tone: 'gap', line: 'Works, with issues worth fixing.' },
	partial: { label: 'Partly tested', tone: 'gap', line: 'Some areas could not be tested; see below.' },
	pass: { label: 'Pass', tone: 'pass', line: 'No verified defects.' },
	blocked: { label: 'Blocked', tone: 'fail', line: 'The site could not be tested.' }
};

/** True for QA and compliance engine messages this module renders. */
export function isQaConversationMessage(message, session) {
	const engineRun = session?.mode === 'qa' || isSqaComplianceRun(session);
	return engineRun && QA_MESSAGE_KINDS.has(message?.kind) && ['agent', 'assistant'].includes(message.role);
}

function el(doc, tag, className, text) {
	const node = doc.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function button(doc, label, onClick, className = 'btn btn-ghost btn-sm') {
	const node = el(doc, 'button', className, label);
	node.type = 'button';
	node.addEventListener('click', onClick);
	return node;
}

function pathOf(url) {
	try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url ?? ''; }
}

const artifactUrl = (session, id) => `/api/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(id)}`;

async function copy(text, target, label) {
	try {
		await navigator.clipboard.writeText(text);
		target.textContent = 'Copied ✓';
	} catch { target.textContent = 'Copy failed'; }
	setTimeout(() => { target.textContent = label; }, 1800);
}

/** A confirmed finding as a compact, scannable card. */
export function renderFindingCard(finding, session, { onOpen } = {}, doc = document) {
	const card = el(doc, 'article', 'qa-card qa-finding-card');
	card.dataset.severity = finding.severity;
	const head = el(doc, 'div', 'qa-card-head');
	head.append(el(doc, 'span', `qa-sev qa-sev-${finding.severity}`, SEVERITY_LABEL[finding.severity] ?? finding.severity), el(doc, 'span', 'qa-cat', finding.category ?? ''));
	card.append(head, el(doc, 'h4', 'qa-card-title', finding.title));
	const where = [pathOf(finding.url), finding.viewports?.length ? finding.viewports.join(', ') : ''].filter(Boolean).join(' · ');
	if (where) card.append(el(doc, 'p', 'qa-where', where));
	const body = el(doc, 'div', 'qa-card-body');
	const text = el(doc, 'p', 'qa-actual', finding.actual);
	body.append(text);
	if (finding.artifactId) {
		const link = el(doc, 'a', 'qa-shot');
		link.href = artifactUrl(session, finding.artifactId);
		link.target = '_blank';
		link.rel = 'noopener';
		link.setAttribute('aria-label', `Open the screenshot for ${finding.title}`);
		const image = el(doc, 'img');
		image.loading = 'lazy';
		image.alt = '';
		image.src = artifactUrl(session, finding.artifactId);
		link.append(image);
		body.append(link);
		card.classList.add('has-shot');
	}
	card.append(body);
	const actions = el(doc, 'div', 'qa-card-actions');
	const fixLabel = 'Copy fix prompt';
	const fix = button(doc, fixLabel, () => copy(buildFindingFixPrompt(finding, { targetUrl: session.targetUrl, mode: 'qa' }), fix, fixLabel), 'btn btn-primary btn-sm');
	actions.append(fix);
	if (onOpen) actions.append(button(doc, 'Details', () => onOpen(finding.id)));
	card.append(actions);
	return card;
}

/** The final report card: verdict, counts, summary and the next actions. */
export function renderReportCard(session, message, { onOpenReport, onDownloadPdf, onCopyAll } = {}, doc = document) {
	const report = session.report ?? {};
	const verdict = VERDICT[report.verdict] ?? VERDICT.partial;
	const card = el(doc, 'section', 'qa-card qa-report-card');
	card.dataset.verdict = report.verdict ?? 'partial';
	const head = el(doc, 'div', 'qa-report-head');
	const badge = el(doc, 'span', `qa-verdict qa-verdict-${verdict.tone}`, verdict.label);
	const titles = el(doc, 'div');
	titles.append(el(doc, 'h4', 'qa-card-title', 'Test complete'), el(doc, 'p', 'qa-where', verdict.line));
	head.append(badge, titles);
	card.append(head);
	const counts = report.bySeverity ?? {};
	const row = el(doc, 'div', 'qa-counts');
	for (const severity of ['critical', 'high', 'medium', 'low', 'info']) {
		const cell = el(doc, 'div', `qa-count qa-count-${severity}${counts[severity] ? '' : ' is-zero'}`);
		cell.append(el(doc, 'strong', '', String(counts[severity] ?? 0)), el(doc, 'span', '', SEVERITY_LABEL[severity]));
		row.append(cell);
	}
	card.append(row);
	card.append(el(doc, 'p', 'qa-summary', report.summary ?? message.text ?? ''));
	const gaps = report.notCovered ?? [];
	if (gaps.length) {
		const list = el(doc, 'details', 'qa-gaps');
		list.append(el(doc, 'summary', '', `Not tested (${gaps.length})`));
		const items = el(doc, 'ul');
		for (const gap of gaps.slice(0, 6)) items.append(el(doc, 'li', '', gap));
		list.append(items);
		card.append(list);
	}
	const actions = el(doc, 'div', 'qa-card-actions');
	if (onOpenReport) actions.append(button(doc, 'Open full report', onOpenReport, 'btn btn-primary btn-sm'));
	if (onDownloadPdf) actions.append(button(doc, 'Download PDF', onDownloadPdf));
	if (onCopyAll && (session.findings?.length ?? 0) > 0) {
		const label = 'Copy all fix prompts';
		const all = button(doc, label, () => onCopyAll(all, label));
		actions.append(all);
	}
	card.append(actions);
	return card;
}

/**
 * Renders the body of a QA engine message. `markdown` is the app's renderer.
 * Returns a node to place inside the message bubble.
 */
export function renderQaMessageBody(message, session, actions = {}, { markdown, doc = document } = {}) {
	if (message.kind === 'qa-finding') {
		const id = String(message.id ?? '').replace(/^qaf-/, '');
		const finding = session.findings?.find(item => item.id === id);
		if (finding) return renderFindingCard(finding, session, actions, doc);
	}
	if (message.kind === 'qa-report' && session.report) return renderReportCard(session, message, actions, doc);
	if (message.kind === 'sqa-report' && session.report) return renderSqaReportCard(session, message, actions, doc);
	const body = el(doc, 'div', 'msg-body md');
	body.innerHTML = markdown ? markdown(message.text ?? '') : '';
	if (!markdown) body.textContent = message.text ?? '';
	return body;
}
