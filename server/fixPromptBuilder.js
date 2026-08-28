/**
 * Shared fix-prompt builder used by:
 *   - the dashboard (per-finding disclosure and bulk copy in the Report tab)
 *   - the PDF report renderer
 *   - the /api/sessions/:id/fix-prompts.md endpoint
 *
 * The prompts are designed to be pasted into an external coding agent
 * (Cursor, Copilot, Claude Code, Codex, etc.). They give the coding agent
 * everything it needs to reproduce, locate, and fix a single defect that
 * Qase observed from the browser side, and nothing else.
 *
 * These prompts are addressed to the *external* coding agent. Qase itself
 * never modifies source code.
 */

const SEVERITY_PREFACE = {
	critical: 'This defect blocks a real user path. Treat as P0.',
	high: 'This defect breaks an important user flow. Treat as P1.',
	medium: 'This defect degrades UX but does not block the core flow. Treat as P2.',
	low: 'Polish item. Fix opportunistically.',
	info: 'Observation worth investigating; ship only if root cause is understood.'
};

function normaliseSeverity(value) {
	const key = String(value ?? '').toLowerCase();
	return SEVERITY_PREFACE[key] ? key : 'medium';
}

function safeText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

export function buildFindingFixPrompt(finding, { targetUrl, mode } = {}) {
	if (!finding || typeof finding !== 'object') return '';
	const severity = normaliseSeverity(finding.severity);
	const category = safeText(finding.category) || 'general';
	const url = safeText(finding.url) || safeText(targetUrl) || '(target URL not recorded)';
	const title = safeText(finding.title) || 'Untitled defect';
	const expected = safeText(finding.expected) || '(not stated)';
	const actual = safeText(finding.actual) || '(not stated)';
	const evidence = safeText(finding.evidence);
	const stepsList = Array.isArray(finding.steps) ? finding.steps.map(safeText).filter(Boolean) : [];
	const steps = stepsList.length > 0
		? stepsList.map((step, index) => `  ${index + 1}. ${step}`).join('\n')
		: '  (no explicit steps recorded — reproduce from the description)';

	const modeLabel = mode === 'sqa' ? 'SQA assessment' : mode === 'founder' ? 'Founder review' : 'QA run';

	return [
		`# Fix request — [${severity.toUpperCase()}] ${title}`,
		'',
		`Context: found by Qase during a ${modeLabel} against ${url}. ${SEVERITY_PREFACE[severity]}`,
		'',
		`Area: ${category}`,
		`URL:  ${url}`,
		'',
		'## Reproduction (observed from the browser)',
		steps,
		'',
		`Expected: ${expected}`,
		`Actual:   ${actual}`,
		evidence ? `\nEvidence captured during the run:\n${evidence}` : '',
		'',
		'## What I need from you',
		'1. Reproduce the defect once locally in the same browser context (device, viewport, auth state) before touching code. Do not skip this step.',
		'2. Locate the responsible code: name the file(s), function/component, route handler or CSS/JS selector. Point to line numbers when possible. Do not guess.',
		'3. Propose the smallest correct fix. If more than one option exists, list them with trade-offs and pick one, explaining why.',
		'4. Implement the fix in a single focused change. Keep the diff minimal; no unrelated refactors, no new dependencies, no formatting churn.',
		'5. Add or update the closest existing test that would have caught this. If no such test exists, describe the manual verification steps and the expected result after the fix.',
		'6. Call out anything the fix touches indirectly: other pages/components that share the code path, accessibility (labels, focus, contrast, tap targets), mobile-only concerns, security, performance, i18n.',
		'',
		'## Constraints',
		'- Preserve current behaviour on paths not covered by the reproduction.',
		'- Do not change unrelated files.',
		'- Keep public API and props/exports stable unless the fix genuinely requires a change (call it out if so).',
		'- Prefer the framework/library idioms already used in this repo.',
		'',
		'Reply with: (a) the root cause in one paragraph, (b) the exact code change (diff or full new file contents for anything you touched), (c) the verification steps.'
	].filter(line => line !== '').join('\n');
}

export function buildAllFixPromptsMarkdown(session) {
	const findings = Array.isArray(session?.findings) ? session.findings : [];
	if (findings.length === 0) return '';
	const SEV = ['critical', 'high', 'medium', 'low', 'info'];
	const sorted = [...findings].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
	const header = [
		`# Fix prompts — ${sorted.length} finding${sorted.length === 1 ? '' : 's'}`,
		'',
		`Source: Qase ${session.mode === 'sqa' ? 'SQA' : session.mode === 'founder' ? 'Founder' : 'QA'} run against ${safeText(session.targetUrl) || '(target URL not recorded)'}`,
		`Run ID: ${session.id ?? '—'}`,
		`Generated: ${new Date().toISOString()}`,
		'',
		'Each section below is a self-contained prompt for a coding agent. Paste one at a time (or all at once) into Cursor, Claude Code, Copilot Chat, Codex, etc.',
		''
	].join('\n');
	const body = sorted.map((finding, index) => {
		const prompt = buildFindingFixPrompt(finding, { targetUrl: session.targetUrl, mode: session.mode });
		return `---\n\n## ${index + 1}. [${String(finding.severity ?? 'info').toUpperCase()}] ${safeText(finding.title) || 'Untitled defect'}\n\n${prompt}`;
	}).join('\n\n');
	return `${header}\n${body}\n`;
}
