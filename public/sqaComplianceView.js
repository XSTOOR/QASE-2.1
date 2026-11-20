/**
 * Compliance (SQA) view.
 *
 * The compliance engine (server/sqa/) keeps its whole state in `session.sqa`
 * (version 3): the product profile, the researched frameworks, their testable
 * requirements, the measured evidence and the sources it consulted. The final
 * `session.report` holds the host-computed scores and verdict. This module turns
 * that state into the SQA tab, the report tab and the report card in the
 * conversation. Everything is built with DOM APIs: page text and model output
 * are untrusted and never reach innerHTML.
 */
export const SQA_ENGINE_VERSION = 3;

export const SQA_STAGES = [
	['open', 'Read the product'],
	['signin', 'Sign in (when needed)'],
	['identify', 'Identify the product'],
	['research', 'Research applicable standards'],
	['requirements', 'Define testable requirements'],
	['evidence', 'Measure evidence'],
	['test', 'Test in the browser'],
	['report', 'Score and report']
];

export const CATEGORY_LABEL = {
	education: 'Education / e-learning', healthcare: 'Healthcare', finance: 'Finance / payments', ecommerce: 'E-commerce',
	saas: 'Business software (SaaS)', ai: 'AI product', media: 'Media / content', social: 'Social / community',
	government: 'Public sector', travel: 'Travel / booking', other: 'General website'
};

export const STATUS_META = {
	pass: { label: 'Pass', tone: 'pass' },
	fail: { label: 'Fail', tone: 'fail' },
	partial: { label: 'Partial', tone: 'gap' },
	needs_documents: { label: 'Needs documents', tone: 'info' },
	not_applicable: { label: 'Not applicable', tone: 'muted' },
	untested: { label: 'Not tested', tone: 'muted' }
};

const EVIDENCE_META = {
	ok: { label: 'OK', tone: 'pass' },
	issue: { label: 'Issue', tone: 'fail' },
	not_applicable: { label: 'N/A', tone: 'muted' },
	unknown: { label: 'Unknown', tone: 'muted' }
};

export const VERDICT_META = {
	non_compliant: { label: 'Serious gaps', tone: 'fail', line: 'Mandatory requirements with high impact are not met.' },
	gaps_found: { label: 'Gaps found', tone: 'gap', line: 'Some requirements are not, or only partly, met.' },
	no_gaps_found: { label: 'No gaps found', tone: 'pass', line: 'Every tested requirement was met.' },
	not_assessed: { label: 'Not assessed', tone: 'muted', line: 'No requirement could be tested.' }
};

const DATA_LABEL = {
	accounts: 'Accounts', personal_data: 'Personal data', payments: 'Payments', health: 'Health data', children: "Children's data",
	education_records: 'Education records', location: 'Location', biometrics: 'Biometrics', user_content: 'User content',
	ai_inputs: 'AI inputs', financial: 'Financial data'
};

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
const METHOD_LABEL = { automated: 'Measured', browser: 'Browser test', document: 'Documents' };

/** True for runs of the compliance engine (older SQA runs keep a read-only notice). */
export function isSqaComplianceRun(session) {
	return session?.mode === 'sqa' && session.sqa?.version === SQA_ENGINE_VERSION;
}

function node(doc, tag, className, text) {
	const item = doc.createElement(tag);
	if (className) item.className = className;
	if (text !== undefined && text !== null) item.textContent = String(text);
	return item;
}

function button(doc, label, onClick, className = 'btn btn-ghost btn-sm') {
	const item = node(doc, 'button', className, label);
	item.type = 'button';
	item.addEventListener('click', event => onClick(event, item));
	return item;
}

function safeHref(value) {
	// Same-origin paths (artifact screenshots) and http(s) URLs only.
	if (typeof value === 'string' && /^\/(?!\/)/.test(value)) return value;
	try {
		const url = new URL(String(value));
		return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
	} catch { return undefined; }
}

function link(doc, label, href, className) {
	const target = safeHref(href);
	if (!target) return node(doc, 'span', className, label);
	const anchor = node(doc, 'a', className, label);
	anchor.href = target;
	anchor.target = '_blank';
	anchor.rel = 'noopener noreferrer';
	return anchor;
}

function pill(doc, meta, extra = '') {
	return node(doc, 'span', `cmp-pill cmp-pill-${meta.tone}${extra ? ` ${extra}` : ''}`, meta.label);
}

function section(doc, title, subtitle) {
	const wrap = node(doc, 'section', 'cmp-section');
	const head = node(doc, 'header', 'cmp-section-head');
	head.append(node(doc, 'h3', 'cmp-section-title', title));
	if (subtitle) head.append(node(doc, 'p', 'cmp-section-sub', subtitle));
	wrap.append(head);
	return wrap;
}

function chips(doc, values, className = 'cmp-chip') {
	const row = node(doc, 'div', 'cmp-chips');
	for (const value of values) row.append(node(doc, 'span', className, value));
	return row;
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return String(url ?? ''); }
}

/** Live counts used by the tab badge and the progress header. */
export function complianceCounts(sqa = {}) {
	const requirements = sqa.requirements ?? [];
	const count = status => requirements.filter(item => item.status === status).length;
	return {
		total: requirements.length, pass: count('pass'), fail: count('fail'), partial: count('partial'),
		needsDocuments: count('needs_documents'), notApplicable: count('not_applicable'), untested: count('untested')
	};
}

/** Short text for the SQA tab badge. */
export function complianceBadge(session) {
	if (!isSqaComplianceRun(session)) return '';
	// Numbers only (the tab badge is a counter): open gaps, or ✓ when a finished run found none.
	const counts = complianceCounts(session.sqa);
	if (counts.fail + counts.partial) return String(counts.fail + counts.partial);
	return session.report?.verdict === 'no_gaps_found' ? '✓' : '';
}

function stageState(sqa, id) {
	const phase = sqa.phases?.[id];
	if (phase?.status) return phase.status;
	return 'pending';
}

function renderProgress(session, doc) {
	const sqa = session.sqa ?? {};
	const list = node(doc, 'ol', 'cmp-stages');
	list.setAttribute('aria-label', 'Compliance test progress');
	for (const [id, label] of SQA_STAGES) {
		const status = stageState(sqa, id);
		const item = node(doc, 'li', `cmp-stage is-${status}`);
		item.dataset.stage = id;
		item.append(node(doc, 'span', 'cmp-stage-mark', status === 'done' ? '✓' : status === 'running' ? '•' : status === 'skipped' ? '–' : status === 'failed' ? '!' : ''));
		const text = node(doc, 'span', 'cmp-stage-text');
		text.append(node(doc, 'strong', '', label));
		const detail = sqa.phases?.[id]?.detail;
		if (detail) text.append(node(doc, 'small', '', detail));
		item.append(text);
		if (status === 'running') item.setAttribute('aria-current', 'step');
		list.append(item);
	}
	return list;
}

function renderHeaderCard(session, doc, actions) {
	const sqa = session.sqa ?? {};
	const report = session.report;
	const card = node(doc, 'section', 'cmp-hero');
	const head = node(doc, 'div', 'cmp-hero-head');
	const verdict = report?.verdict ? VERDICT_META[report.verdict] ?? VERDICT_META.not_assessed : undefined;
	const status = session.status;
	const badge = verdict ? pill(doc, verdict, 'cmp-verdict')
		: pill(doc, status === 'running' ? { label: 'Testing', tone: 'info' } : status === 'awaiting_input' ? { label: 'Waiting for you', tone: 'gap' } : status === 'error' ? { label: 'Stopped', tone: 'fail' } : { label: 'Not started', tone: 'muted' }, 'cmp-verdict');
	const titles = node(doc, 'div', 'cmp-hero-titles');
	titles.append(node(doc, 'h2', 'cmp-hero-title', sqa.product?.name || hostOf(session.targetUrl) || 'Compliance test'));
	titles.append(node(doc, 'p', 'cmp-hero-line', verdict ? verdict.line : status === 'running'
		? 'Qase is identifying the product, researching what applies and testing it. Results fill in as they are found.'
		: status === 'awaiting_input' ? 'Qase needs your answer in the conversation to continue.'
			: 'Send the product URL to start.'));
	head.append(badge, titles);
	card.append(head);

	const counts = complianceCounts(sqa);
	if (counts.total) {
		const row = node(doc, 'div', 'cmp-counts');
		for (const [key, label, tone] of [['pass', 'Pass', 'pass'], ['fail', 'Fail', 'fail'], ['partial', 'Partial', 'gap'], ['needsDocuments', 'Needs documents', 'info'], ['untested', 'Not tested', 'muted']]) {
			const cell = node(doc, 'div', `cmp-count cmp-count-${tone}${counts[key] ? '' : ' is-zero'}`);
			cell.append(node(doc, 'strong', '', counts[key]), node(doc, 'span', '', label));
			row.append(cell);
		}
		card.append(row);
	}
	if (report?.summary) card.append(node(doc, 'p', 'cmp-summary', report.summary));
	if (report?.priorities?.length) {
		const box = node(doc, 'div', 'cmp-priorities');
		box.append(node(doc, 'strong', '', 'Fix first'));
		const items = node(doc, 'ol');
		for (const priority of report.priorities.slice(0, 6)) items.append(node(doc, 'li', '', priority));
		box.append(items);
		card.append(box);
	}
	if (report && (actions.onDownloadMarkdown || actions.onDownloadPdf || actions.onCopyFixes)) {
		const bar = node(doc, 'div', 'cmp-actions');
		if (actions.onDownloadPdf) bar.append(button(doc, 'Download PDF', actions.onDownloadPdf, 'btn btn-primary btn-sm'));
		if (actions.onDownloadMarkdown) bar.append(button(doc, 'Download .md', actions.onDownloadMarkdown));
		if (actions.onCopyFixes && (session.findings?.length ?? 0) > 0) bar.append(button(doc, 'Copy all fix prompts', actions.onCopyFixes));
		card.append(bar);
	}
	return card;
}

function renderProduct(session, doc) {
	const product = session.sqa?.product;
	const wrap = section(doc, 'Product profile', 'What the agent concluded this product is. The standards below follow from it.');
	if (!product) {
		wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Identifying the product…' : 'The product was not identified.'));
		return wrap;
	}
	const grid = node(doc, 'dl', 'cmp-facts');
	const fact = (term, value) => {
		if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return;
		grid.append(node(doc, 'dt', '', term));
		const detail = node(doc, 'dd');
		if (Array.isArray(value)) detail.append(chips(doc, value)); else detail.textContent = value;
		grid.append(detail);
	};
	fact('Type', [CATEGORY_LABEL[product.category] ?? product.category, product.subcategory].filter(Boolean).join(' — '));
	fact('What it does', product.summary);
	const audience = [product.audience?.description, product.audience?.children ? 'children' : '', product.audience?.students ? 'students' : '', product.audience?.businesses ? 'businesses' : ''].filter(Boolean);
	fact('Audience', audience.length > 1 ? `${audience[0]} (${audience.slice(1).join(', ')})` : audience[0]);
	fact('Regions', product.regions?.length ? product.regions : session.sqa.regionsHint ? [session.sqa.regionsHint] : []);
	fact('Data handled', (product.dataHandled ?? []).map(item => DATA_LABEL[item] ?? item));
	fact('Features', product.features ?? []);
	wrap.append(grid);
	if (product.evidence?.length) {
		const more = node(doc, 'details', 'cmp-more');
		more.append(node(doc, 'summary', '', `Why (${product.evidence.length} observation${product.evidence.length === 1 ? '' : 's'})`));
		const items = node(doc, 'ul');
		for (const item of product.evidence) items.append(node(doc, 'li', '', item));
		more.append(items);
		wrap.append(more);
	}
	return wrap;
}

function frameworkScore(sqa, framework, report) {
	const scored = report?.frameworks?.find(item => item.id === framework.id);
	if (scored) return scored;
	const items = (sqa.requirements ?? []).filter(item => item.frameworkId === framework.id);
	const count = status => items.filter(item => item.status === status).length;
	const pass = count('pass'), fail = count('fail'), partial = count('partial');
	const tested = pass + fail + partial;
	return { ...framework, total: items.length, pass, fail, partial, needsDocuments: count('needs_documents'), untested: count('untested'), score: tested ? Math.round(100 * (pass + 0.5 * partial) / tested) : null };
}

function renderFrameworks(session, doc) {
	const sqa = session.sqa ?? {};
	const wrap = section(doc, 'Applicable standards', 'Researched on the web for this product. Each links to its official source.');
	if (!sqa.frameworks?.length) {
		wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Researching which standards and laws apply…' : 'No standard was selected.'));
		return wrap;
	}
	const list = node(doc, 'div', 'cmp-frameworks');
	for (const framework of sqa.frameworks) {
		const score = frameworkScore(sqa, framework, session.report);
		const card = node(doc, 'article', 'cmp-framework');
		card.dataset.framework = framework.id;
		const head = node(doc, 'div', 'cmp-framework-head');
		const name = node(doc, 'div', 'cmp-framework-name');
		name.append(node(doc, 'strong', '', framework.name));
		const meta = [framework.jurisdiction, framework.version, framework.publisher].filter(Boolean).join(' · ');
		if (meta) name.append(node(doc, 'small', '', meta));
		head.append(name, pill(doc, framework.mandatory ? { label: 'Legally required', tone: 'fail' } : { label: 'Recommended', tone: 'info' }));
		if (framework.baseline) head.append(pill(doc, { label: 'Baseline', tone: 'muted' }));
		card.append(head);
		if (framework.applicability) card.append(node(doc, 'p', 'cmp-framework-why', framework.applicability));
		if (score.total) {
			const bar = node(doc, 'div', 'cmp-score');
			const meter = node(doc, 'div', 'cmp-score-bar');
			meter.setAttribute('role', 'img');
			const value = score.score;
			meter.setAttribute('aria-label', value === null ? 'Not scored yet' : `${value}% of tested requirements met`);
			const fill = node(doc, 'span', `cmp-score-fill${value === null ? '' : value >= 90 ? ' is-good' : value >= 60 ? ' is-mid' : ' is-low'}`);
			fill.style.width = `${value ?? 0}%`;
			meter.append(fill);
			bar.append(meter, node(doc, 'span', 'cmp-score-value', value === null ? '—' : `${value}%`));
			card.append(bar);
			card.append(node(doc, 'p', 'cmp-framework-counts', [`${score.total} requirements`, score.pass ? `${score.pass} pass` : '', score.fail ? `${score.fail} fail` : '', score.partial ? `${score.partial} partial` : '', score.needsDocuments ? `${score.needsDocuments} need documents` : '', score.untested ? `${score.untested} not tested` : ''].filter(Boolean).join(' · ')));
		}
		if (framework.url) card.append(link(doc, `Source: ${hostOf(framework.url)}`, framework.url, 'cmp-source-link'));
		list.append(card);
	}
	wrap.append(list);
	return wrap;
}

function renderRequirement(sqa, requirement, doc, actions) {
	const item = node(doc, 'details', `cmp-req is-${requirement.status ?? 'untested'}`);
	item.dataset.requirement = requirement.id;
	if (['fail', 'partial'].includes(requirement.status)) item.open = false;
	const summary = node(doc, 'summary', 'cmp-req-summary');
	summary.append(node(doc, 'span', 'cmp-req-id', requirement.clause || requirement.id));
	summary.append(node(doc, 'span', 'cmp-req-title', requirement.title));
	summary.append(node(doc, 'span', `cmp-sev cmp-sev-${requirement.severity}`, requirement.severity));
	summary.append(pill(doc, STATUS_META[requirement.status] ?? STATUS_META.untested));
	item.append(summary);
	const body = node(doc, 'div', 'cmp-req-body');
	const facts = node(doc, 'dl', 'cmp-facts cmp-facts-tight');
	const fact = (term, value) => { if (!value) return; facts.append(node(doc, 'dt', '', term), node(doc, 'dd', '', value)); };
	fact('Requirement', requirement.check);
	fact('Checked by', `${METHOD_LABEL[requirement.method] ?? requirement.method}${requirement.decidedBy === 'measured' ? ' — decided by measured evidence' : requirement.decidedBy === 'agent' ? ' — verified by the agent' : ''}`);
	fact('Observed', requirement.observed);
	fact('Fix', requirement.fix);
	body.append(facts);
	const evidence = (requirement.evidenceIds ?? []).map(id => sqa.evidence?.find(entry => entry.id === id)).filter(Boolean);
	if (evidence.length) {
		const list = node(doc, 'ul', 'cmp-req-evidence');
		for (const entry of evidence) {
			const line = node(doc, 'li');
			line.append(node(doc, 'strong', '', `${entry.id} ${entry.title}: `), node(doc, 'span', '', entry.detail ?? ''));
			if (entry.artifactId && actions.artifactUrl) line.append(' ', link(doc, 'Screenshot', actions.artifactUrl(entry.artifactId)));
			list.append(line);
		}
		body.append(list);
	}
	const where = /^https?:/i.test(requirement.url ?? '') ? safeHref(requirement.url) : undefined;
	if (where) body.append(link(doc, `Checked on ${hostOf(where)}${new URL(where).pathname}`, where, 'cmp-source-link'));
	if (actions.onOpenFinding && ['fail', 'partial'].includes(requirement.status)) {
		const finding = actions.findingFor?.(requirement.id);
		if (finding) body.append(button(doc, 'Open finding and fix prompt', () => actions.onOpenFinding(finding)));
	}
	item.append(body);
	return item;
}

function renderRequirements(session, doc, actions) {
	const sqa = session.sqa ?? {};
	const wrap = section(doc, 'Requirements and results', 'Every requirement, how it was checked and what was found. Gaps are listed first.');
	if (!sqa.requirements?.length) {
		wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Requirements appear once the standards are researched.' : 'No requirement was defined.'));
		return wrap;
	}
	const rank = item => (['fail', 'partial'].includes(item.status) ? 0 : item.status === 'untested' ? 1 : item.status === 'needs_documents' ? 2 : 3) * 10 + Math.max(0, SEVERITY_ORDER.indexOf(item.severity));
	for (const framework of sqa.frameworks ?? []) {
		const items = sqa.requirements.filter(item => item.frameworkId === framework.id).sort((a, b) => rank(a) - rank(b));
		if (!items.length) continue;
		const group = node(doc, 'div', 'cmp-req-group');
		group.append(node(doc, 'h4', 'cmp-req-group-title', framework.name));
		for (const requirement of items) group.append(renderRequirement(sqa, requirement, doc, actions));
		wrap.append(group);
	}
	return wrap;
}

function renderEvidence(session, doc, actions) {
	const evidence = session.sqa?.evidence ?? [];
	const wrap = section(doc, 'Measured evidence', 'Checks Qase ran itself: accessibility, privacy and security signals on the pages it visited.');
	if (!evidence.length) {
		wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Measurements run after the requirements are defined.' : 'No evidence was measured.'));
		return wrap;
	}
	const list = node(doc, 'ul', 'cmp-evidence');
	for (const entry of evidence) {
		const item = node(doc, 'li', `cmp-evidence-item is-${entry.status}`);
		item.append(pill(doc, EVIDENCE_META[entry.status] ?? EVIDENCE_META.unknown));
		const text = node(doc, 'div', 'cmp-evidence-text');
		text.append(node(doc, 'strong', '', `${entry.id} · ${entry.title}`), node(doc, 'p', '', entry.detail ?? ''));
		if (entry.artifactId && actions.artifactUrl) text.append(link(doc, 'Screenshot', actions.artifactUrl(entry.artifactId), 'cmp-source-link'));
		item.append(text);
		list.append(item);
	}
	wrap.append(list);
	return wrap;
}

function renderSources(session, doc) {
	const sources = session.sqa?.sources ?? [];
	const wrap = section(doc, 'Research sources', `Pages the agent found or read while researching (${sources.length}).`);
	if (!sources.length) {
		wrap.append(node(doc, 'p', 'cmp-empty', 'No web research recorded.'));
		return wrap;
	}
	const more = node(doc, 'details', 'cmp-more');
	more.append(node(doc, 'summary', '', 'Show sources'));
	const list = node(doc, 'ul', 'cmp-sources');
	for (const source of sources.slice(0, 80)) {
		const item = node(doc, 'li');
		item.append(link(doc, source.title || source.url, source.url), node(doc, 'small', '', ` ${hostOf(source.url)}${source.via === 'fetch' ? ' · read' : ''}`));
		list.append(item);
	}
	more.append(list);
	wrap.append(more);
	return wrap;
}

function renderLimitations(session, doc) {
	const limitations = session.sqa?.limitations ?? [];
	if (!limitations.length) return undefined;
	const wrap = section(doc, 'Not covered', 'What the test could not do. Results above are limited accordingly.');
	const list = node(doc, 'ul', 'cmp-limitations');
	for (const item of limitations) list.append(node(doc, 'li', '', item.message));
	wrap.append(list);
	return wrap;
}

/** The whole SQA tab (also used for the report tab once the run is finished). */
export function renderComplianceView(session, actions = {}, doc = document) {
	const root = node(doc, 'div', 'cmp-compliance');
	if (!isSqaComplianceRun(session)) {
		root.append(renderLegacySqaNotice(session, doc));
		return root;
	}
	root.append(renderHeaderCard(session, doc, actions));
	// Progress matters while testing; a finished report leads with its results.
	if (!session.report) root.append(renderProgress(session, doc));
	root.append(renderProduct(session, doc), renderFrameworks(session, doc), renderRequirements(session, doc, actions), renderEvidence(session, doc, actions));
	const limitations = renderLimitations(session, doc);
	if (limitations) root.append(limitations);
	root.append(renderSources(session, doc));
	root.append(node(doc, 'p', 'cmp-disclaimer', session.report?.disclaimer ?? 'An automated compliance-readiness assessment of the publicly observable product. It is not legal advice, an audit opinion or a certification.'));
	return root;
}

/** Runs made by the retired SQA workflow stay listed and readable as plain transcripts. */
export function renderLegacySqaNotice(session, doc = document) {
	const box = node(doc, 'aside', 'cmp-legacy');
	box.append(node(doc, 'strong', '', 'Earlier quality review'));
	box.append(node(doc, 'p', '', 'This run was made by the previous quality-review workflow, which has been replaced by compliance testing. Its conversation and any findings remain available; start a new compliance test to assess the product against the standards that apply to it.'));
	if (session?.findings?.length) box.append(node(doc, 'p', '', `${session.findings.length} finding${session.findings.length === 1 ? '' : 's'} from this run are in the Findings tab.`));
	return box;
}

/** The report card posted in the conversation when a compliance run finishes. */
export function renderSqaReportCard(session, message, actions = {}, doc = document) {
	const report = session.report ?? {};
	const verdict = VERDICT_META[report.verdict] ?? VERDICT_META.not_assessed;
	const card = node(doc, 'section', 'qa-card qa-report-card cmp-report-card');
	card.dataset.verdict = report.verdict ?? 'not_assessed';
	const head = node(doc, 'div', 'qa-report-head');
	const titles = node(doc, 'div');
	titles.append(node(doc, 'h4', 'qa-card-title', 'Compliance test complete'), node(doc, 'p', 'qa-where', verdict.line));
	head.append(node(doc, 'span', `qa-verdict qa-verdict-${verdict.tone === 'muted' ? 'gap' : verdict.tone}`, verdict.label), titles);
	card.append(head);
	const frameworks = report.frameworks ?? [];
	if (frameworks.length) {
		const list = node(doc, 'ul', 'cmp-card-frameworks');
		for (const framework of frameworks) {
			const item = node(doc, 'li');
			item.append(node(doc, 'span', 'cmp-card-fw-name', framework.name));
			item.append(node(doc, 'span', `cmp-card-fw-score${framework.score === null ? '' : framework.score >= 90 ? ' is-good' : framework.score >= 60 ? ' is-mid' : ' is-low'}`, framework.score === null ? 'not scored' : `${framework.score}%`));
			list.append(item);
		}
		card.append(list);
	}
	const counts = report.counts ?? {};
	card.append(node(doc, 'p', 'cmp-card-counts', [`${counts.pass ?? 0} pass`, `${counts.fail ?? 0} fail`, `${counts.partial ?? 0} partial`, `${counts.needs_documents ?? 0} need documents`].join(' · ')));
	card.append(node(doc, 'p', 'qa-summary', report.summary ?? message?.text ?? ''));
	const bar = node(doc, 'div', 'qa-card-actions');
	if (actions.onOpenReport) bar.append(button(doc, 'Open compliance report', actions.onOpenReport, 'btn btn-primary btn-sm'));
	if (actions.onDownloadPdf) bar.append(button(doc, 'Download PDF', actions.onDownloadPdf));
	if (actions.onCopyAll && (session.findings?.length ?? 0) > 0) {
		const label = 'Copy all fix prompts';
		const all = button(doc, label, () => actions.onCopyAll(all, label));
		bar.append(all);
	}
	card.append(bar);
	return card;
}
