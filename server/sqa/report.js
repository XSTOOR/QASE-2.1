/**
 * Compliance report: deterministic scoring from recorded results, plus the
 * Markdown and HTML (PDF) renderings. The model wrote the summary; every
 * number and the verdict come from the requirement results.
 */
const STATUS_LABEL = { pass: 'Pass', fail: 'Fail', partial: 'Partial', needs_documents: 'Needs documents', not_applicable: 'Not applicable', untested: 'Not tested' };
const VERDICT_LABEL = {
	non_compliant: 'Serious compliance gaps',
	gaps_found: 'Compliance gaps found',
	no_gaps_found: 'No gaps found in the tested requirements',
	not_assessed: 'Not assessed'
};
export const DISCLAIMER = 'This is an automated compliance-readiness assessment of the publicly observable product. It is not legal advice, an audit opinion or a certification. Requirements marked "needs documents" can only be confirmed with internal evidence. Have a qualified professional confirm which laws apply before relying on this report.';

export function frameworkScores(state) {
	return state.frameworks.map(framework => {
		const items = state.requirements.filter(item => item.frameworkId === framework.id);
		const count = status => items.filter(item => item.status === status).length;
		const pass = count('pass'), fail = count('fail'), partial = count('partial');
		const tested = pass + fail + partial;
		return {
			...framework, total: items.length, pass, fail, partial, needsDocuments: count('needs_documents'), notApplicable: count('not_applicable'), untested: count('untested'),
			score: tested ? Math.round(100 * (pass + 0.5 * partial) / tested) : null,
			status: !tested ? 'not_assessed' : fail || partial ? 'gaps' : 'compliant'
		};
	});
}

export function verdictFor(state) {
	const tested = state.requirements.filter(item => ['pass', 'fail', 'partial'].includes(item.status));
	if (!tested.length) return 'not_assessed';
	const mandatory = new Set(state.frameworks.filter(item => item.mandatory).map(item => item.id));
	if (tested.some(item => item.status === 'fail' && ['critical', 'high'].includes(item.severity) && mandatory.has(item.frameworkId))) return 'non_compliant';
	if (tested.some(item => ['fail', 'partial'].includes(item.status))) return 'gaps_found';
	return 'no_gaps_found';
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

export function buildSqaReport(session) {
	const state = session.sqa;
	const scores = frameworkScores(state);
	const verdict = verdictFor(state);
	const gaps = state.requirements.filter(item => ['fail', 'partial'].includes(item.status))
		.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
	const counts = Object.fromEntries(Object.keys(STATUS_LABEL).map(status => [status, state.requirements.filter(item => item.status === status).length]));
	const fallbackSummary = `${state.product?.name ?? session.targetUrl} was assessed against ${scores.length} framework${scores.length === 1 ? '' : 's'} (${scores.map(item => item.name).join(', ')}). Of ${state.requirements.length} requirements, ${counts.pass} passed, ${counts.fail} failed, ${counts.partial} were partly met and ${counts.needs_documents} need internal documents.${gaps.length ? ` Most serious: ${gaps.slice(0, 3).map(item => item.title).join('; ')}.` : ''}`;
	return {
		ts: Date.now(), verdict, verdictLabel: VERDICT_LABEL[verdict],
		summary: state.summary?.text || fallbackSummary,
		priorities: state.summary?.priorities?.length ? state.summary.priorities : gaps.slice(0, 6).map(item => `${item.title}${item.fix ? ` — ${item.fix}` : ''}`),
		frameworks: scores, counts, gaps: gaps.map(item => item.id),
		notCovered: state.limitations.map(item => item.message),
		disclaimer: DISCLAIMER, targetUrl: session.targetUrl
	};
}

/** Failed and partial requirements as findings, so the Findings tab and fix prompts work. */
export function requirementFindings(session) {
	const state = session.sqa;
	return state.requirements.filter(item => ['fail', 'partial'].includes(item.status)).map(item => {
		const framework = state.frameworks.find(entry => entry.id === item.frameworkId);
		const evidence = item.evidenceIds?.map(id => state.evidence.find(entry => entry.id === id)).filter(Boolean) ?? [];
		return {
			title: `${framework?.name ?? 'Compliance'} ${item.clause}: ${item.title}`.slice(0, 240),
			severity: item.status === 'partial' && item.severity === 'critical' ? 'high' : item.severity,
			category: 'compliance', url: item.url || evidence.flatMap(entry => entry.urls)[0] || session.targetUrl,
			steps: [`Open ${item.url || session.targetUrl}`, `Check: ${item.check}`],
			expected: item.check, actual: item.observed || evidence.map(entry => entry.detail).join(' | ') || 'Not met.',
			evidence: [framework ? `Framework: ${framework.name}${framework.url ? ` (${framework.url})` : ''}` : '', ...evidence.map(entry => `${entry.id} ${entry.title}: ${entry.detail}`)].filter(Boolean).join('\n'),
			fix: item.fix, artifactId: evidence.find(entry => entry.artifactId)?.artifactId, requirementId: item.id
		};
	});
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function buildSqaMarkdown(session) {
	const state = session.sqa;
	const report = session.report ?? buildSqaReport(session);
	const lines = [`# Compliance assessment — ${state.product?.name ?? session.targetUrl}`, '', `- **Target:** ${session.targetUrl}`, `- **Verdict:** ${report.verdictLabel}`, `- **Assessed:** ${new Date(report.ts).toISOString().slice(0, 10)}`, ''];
	lines.push('## Summary', '', report.summary, '');
	if (report.priorities?.length) lines.push('### Priorities', '', ...report.priorities.map((item, index) => `${index + 1}. ${item}`), '');
	if (state.product) {
		const product = state.product;
		lines.push('## Product', '', `- **Type:** ${product.subcategory || product.category} (${product.category})`, `- **What it does:** ${product.summary}`, `- **Audience:** ${product.audience.description}${product.audience.children ? ' — includes children' : ''}`, `- **Regions:** ${product.regions.join(', ') || 'not identified'}`, `- **Data handled:** ${product.dataHandled.join(', ') || 'not identified'}`, '', '_Evidence:_', ...product.evidence.map(item => `- ${item}`), '');
	}
	lines.push('## Frameworks assessed', '', '| Framework | Why it applies | Required | Score | Pass | Fail | Partial | Needs docs |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const item of report.frameworks) lines.push(`| [${cell(item.name)}](${item.url})${item.baseline ? ' (baseline)' : ''} | ${cell(item.applicability)} | ${item.mandatory ? 'Yes' : 'Recommended'} | ${item.score === null ? '—' : `${item.score}%`} | ${item.pass} | ${item.fail} | ${item.partial} | ${item.needsDocuments} |`);
	lines.push('');
	const gaps = state.requirements.filter(item => ['fail', 'partial'].includes(item.status)).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
	if (gaps.length) {
		lines.push('## Gaps to fix', '');
		for (const item of gaps) {
			const framework = state.frameworks.find(entry => entry.id === item.frameworkId);
			lines.push(`### ${item.id} · ${framework?.name ?? ''} ${item.clause} — ${item.title}`, '', `- **Result:** ${STATUS_LABEL[item.status]} (${item.severity})`, `- **Requirement:** ${item.check}`, `- **Observed:** ${item.observed || '—'}`, ...(item.url ? [`- **Page:** ${item.url}`] : []), ...(item.fix ? [`- **Fix:** ${item.fix}`] : []), '');
		}
	}
	lines.push('## All requirements', '', '| ID | Framework | Clause | Requirement | Method | Result |', '| --- | --- | --- | --- | --- | --- |');
	for (const item of state.requirements) lines.push(`| ${item.id} | ${cell(state.frameworks.find(entry => entry.id === item.frameworkId)?.name)} | ${cell(item.clause)} | ${cell(item.title)} | ${item.method} | ${STATUS_LABEL[item.status] ?? item.status} |`);
	lines.push('', '## Measured evidence', '', '| ID | Check | Result | Detail |', '| --- | --- | --- | --- |');
	for (const item of state.evidence) lines.push(`| ${item.id} | ${cell(item.title)} | ${item.status} | ${cell(item.detail).slice(0, 300)} |`);
	const needsDocs = state.requirements.filter(item => item.status === 'needs_documents');
	if (needsDocs.length) lines.push('', '## Needs internal documents', '', ...needsDocs.map(item => `- ${item.id} ${item.title}: ${item.observed || item.check}`));
	if (report.notCovered?.length) lines.push('', '## Not covered', '', ...report.notCovered.map(item => `- ${item}`));
	if (state.sources?.length) lines.push('', '## Sources consulted', '', ...state.sources.slice(0, 40).map(item => `- [${cell(item.title || item.url)}](${item.url})`));
	lines.push('', '---', '', `_${report.disclaimer}_`, '');
	return lines.join('\n');
}

export function buildSqaHtml(session) {
	const state = session.sqa;
	const report = session.report ?? buildSqaReport(session);
	const rows = (items, columns) => items.map(item => `<tr>${columns.map(column => `<td>${column(item)}</td>`).join('')}</tr>`).join('');
	const gaps = state.requirements.filter(item => ['fail', 'partial'].includes(item.status)).sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
	const name = id => escape(state.frameworks.find(entry => entry.id === id)?.name);
	return `<h1>Compliance assessment — ${escape(state.product?.name ?? session.targetUrl)}</h1>
<table class="meta"><tbody><tr><th>Target</th><td>${escape(session.targetUrl)}</td></tr><tr><th>Verdict</th><td><strong>${escape(report.verdictLabel)}</strong></td></tr>
${state.product ? `<tr><th>Product type</th><td>${escape(state.product.subcategory || state.product.category)}</td></tr><tr><th>Audience</th><td>${escape(state.product.audience.description)}${state.product.audience.children ? ' (includes children)' : ''}</td></tr><tr><th>Regions</th><td>${escape(state.product.regions.join(', ') || 'not identified')}</td></tr>` : ''}
</tbody></table>
<h2>Summary</h2><p>${escape(report.summary)}</p>${report.priorities?.length ? `<ol>${report.priorities.map(item => `<li>${escape(item)}</li>`).join('')}</ol>` : ''}
<h2>Frameworks</h2><table class="meta"><thead><tr><th>Framework</th><th>Score</th><th>Pass / Fail / Partial / Docs</th></tr></thead><tbody>${rows(report.frameworks, [item => `${escape(item.name)}${item.baseline ? ' (baseline)' : ''}<br><span class="muted">${escape(item.applicability)}</span>`, item => item.score === null ? '—' : `${item.score}%`, item => `${item.pass} / ${item.fail} / ${item.partial} / ${item.needsDocuments}`])}</tbody></table>
${gaps.length ? `<h2>Gaps to fix</h2>${gaps.map(item => `<h3>${escape(item.id)} · ${name(item.frameworkId)} ${escape(item.clause)} — ${escape(item.title)}</h3><p><strong>${escape(STATUS_LABEL[item.status])}</strong> (${escape(item.severity)}). ${escape(item.check)}</p><p>Observed: ${escape(item.observed)}</p>${item.fix ? `<p>Fix: ${escape(item.fix)}</p>` : ''}`).join('')}` : ''}
<h2>All requirements</h2><table class="meta"><tbody>${rows(state.requirements, [item => escape(item.id), item => `${name(item.frameworkId)} ${escape(item.clause)}`, item => escape(item.title), item => escape(STATUS_LABEL[item.status] ?? item.status)])}</tbody></table>
${report.notCovered?.length ? `<h2>Not covered</h2><ul>${report.notCovered.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
<p class="muted">${escape(report.disclaimer)}</p>`;
}
