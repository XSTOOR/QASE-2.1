/**
 * Founder review view.
 *
 * The Founder engine (server/founder/) keeps its state in `session.founder`
 * (version 2): the business profile, the owner's brief, competitors, measured
 * signals, walked journeys, lens scores and recommendations. The host-computed
 * `founder.report` adds the readiness score, verdict and ordered
 * recommendations (R1, R2…). This module turns it into the Founder tab, the
 * report tab and the conversation cards. Everything is built with DOM APIs:
 * page text and model output are untrusted and never reach innerHTML.
 */
export const FOUNDER_ENGINE_VERSION = 2;

export const FOUNDER_STAGES = [
	['open', 'Read the product'], ['brief', 'Your goals'], ['signin', 'Sign in (when needed)'], ['understand', 'Understand the business'],
	['market', 'Research competitors'], ['measure', 'Measure first impression'], ['journeys', 'Walk key journeys'], ['evaluate', 'Score 10 areas'],
	['recommend', 'Decide what to do'], ['report', 'Publish the review']
];

const VERDICT_TONE = { ready: 'pass', polish: 'gap', not_ready: 'fail', major_gaps: 'fail', not_assessed: 'muted' };
const SIGNAL_META = { good: { label: 'Good', tone: 'pass' }, weak: { label: 'Weak', tone: 'gap' }, missing: { label: 'Missing', tone: 'fail' }, unknown: { label: 'Not measured', tone: 'muted' }, not_applicable: { label: 'N/A', tone: 'muted' } };
const OUTCOME_META = { completed: { label: 'Completed', tone: 'pass' }, partial: { label: 'Partly', tone: 'gap' }, blocked: { label: 'Blocked', tone: 'fail' }, not_attempted: { label: 'Not walked', tone: 'muted' } };
const PRIORITY_META = { now: { label: 'Do now', hint: 'Before spending on acquisition' }, next: { label: 'Next', hint: 'This quarter' }, later: { label: 'Later', hint: 'Nice to have' } };

/** True for runs of the Founder engine (older reviews keep a read-only notice). */
export function isFounderReviewRun(session) {
	return session?.mode === 'founder' && session.founder?.version === FOUNDER_ENGINE_VERSION;
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
	if (typeof value === 'string' && /^\/(?!\/)/.test(value)) return value;
	try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function link(doc, label, href, className) {
	const target = safeHref(href);
	if (!target) return node(doc, 'span', className, label);
	const anchor = node(doc, 'a', className, label);
	anchor.href = target; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
	return anchor;
}
const pill = (doc, meta, extra = '') => node(doc, 'span', `cmp-pill cmp-pill-${meta.tone}${extra ? ` ${extra}` : ''}`, meta.label);
function section(doc, title, subtitle) {
	const wrap = node(doc, 'section', 'cmp-section fdr-section');
	const head = node(doc, 'header', 'cmp-section-head');
	head.append(node(doc, 'h3', 'cmp-section-title', title));
	if (subtitle) head.append(node(doc, 'p', 'cmp-section-sub', subtitle));
	wrap.append(head);
	return wrap;
}
const hostOf = url => { try { return new URL(url).host; } catch { return String(url ?? ''); } };
const scoreTone = score => score === null || score === undefined ? '' : score >= 8 ? ' is-good' : score >= 5 ? ' is-mid' : ' is-low';

/** Short text for the Founder tab badge: the readiness score, or the do-now count while running. */
export function founderBadge(session) {
	if (!isFounderReviewRun(session)) return '';
	const report = session.founder.report;
	if (report?.readiness !== undefined && report.readiness !== null) return String(report.readiness);
	return '';
}

function renderStages(session, doc) {
	const phases = session.founder?.phases ?? {};
	const list = node(doc, 'ol', 'cmp-stages fdr-stages');
	list.setAttribute('aria-label', 'Founder review progress');
	for (const [id, label] of FOUNDER_STAGES) {
		const status = phases[id]?.status ?? 'pending';
		const item = node(doc, 'li', `cmp-stage is-${status}`);
		item.dataset.stage = id;
		item.append(node(doc, 'span', 'cmp-stage-mark', status === 'done' ? '✓' : status === 'skipped' ? '–' : status === 'failed' ? '!' : ''));
		const text = node(doc, 'span', 'cmp-stage-text');
		text.append(node(doc, 'strong', '', label));
		if (phases[id]?.detail) text.append(node(doc, 'small', '', phases[id].detail));
		item.append(text);
		if (status === 'running') item.setAttribute('aria-current', 'step');
		list.append(item);
	}
	return list;
}

function renderHero(session, doc, actions) {
	const founder = session.founder;
	const report = founder.report;
	const card = node(doc, 'section', 'cmp-hero fdr-hero');
	const head = node(doc, 'div', 'fdr-hero-head');
	if (report) {
		const ring = node(doc, 'div', `fdr-score${scoreTone(report.readiness === null ? null : report.readiness / 10)}`);
		ring.setAttribute('role', 'img');
		ring.setAttribute('aria-label', report.readiness === null ? 'Not scored' : `Readiness ${report.readiness} out of 100`);
		ring.style.setProperty?.('--fdr-score', String(report.readiness ?? 0));
		ring.append(node(doc, 'strong', '', report.readiness ?? '—'), node(doc, 'span', '', '/100'));
		const scoreBox = node(doc, 'div', 'fdr-score-box');
		scoreBox.append(ring, node(doc, 'span', 'fdr-score-label', 'Readiness'));
		head.append(scoreBox);
	}
	const titles = node(doc, 'div', 'cmp-hero-titles');
	titles.append(node(doc, 'h2', 'cmp-hero-title', founder.business?.name || founder.scope?.target?.name || hostOf(session.targetUrl) || 'Founder review'));
	const status = session.status;
	titles.append(node(doc, 'p', 'cmp-hero-line', report ? report.verdictLine : status === 'running' ? 'Reviewing the product the way a customer and an investor would. Results fill in as they are found.' : status === 'awaiting_input' ? 'Qase is waiting for your answer in the conversation.' : 'Send the product URL to start.'));
	head.append(titles);
	head.append(pill(doc, report ? { label: report.verdictLabel, tone: VERDICT_TONE[report.verdict] ?? 'muted' } : status === 'running' ? { label: 'Reviewing', tone: 'info' } : status === 'awaiting_input' ? { label: 'Waiting for you', tone: 'gap' } : status === 'error' ? { label: 'Stopped', tone: 'fail' } : { label: 'Not started', tone: 'muted' }, 'cmp-verdict'));
	card.append(head);
	if (report?.summary) card.append(node(doc, 'p', 'cmp-summary', report.summary));
	if (report?.positioning) {
		const box = node(doc, 'div', 'fdr-positioning');
		box.append(node(doc, 'strong', '', 'Suggested positioning'), node(doc, 'p', '', report.positioning));
		if (report.headlineOptions?.length) {
			box.append(node(doc, 'strong', '', 'Headline options'));
			const list = node(doc, 'ul');
			for (const option of report.headlineOptions) list.append(node(doc, 'li', '', option));
			box.append(list);
		}
		card.append(box);
	}
	if (report?.priorities?.length) {
		const box = node(doc, 'div', 'cmp-priorities');
		box.append(node(doc, 'strong', '', 'Do now'));
		const list = node(doc, 'ol');
		for (const item of report.priorities) list.append(node(doc, 'li', '', item));
		box.append(list);
		card.append(box);
	}
	if (report && (actions.onDownloadPdf || actions.onDownloadMarkdown || actions.onCopyFixes)) {
		const bar = node(doc, 'div', 'cmp-actions');
		if (actions.onDownloadPdf) bar.append(button(doc, 'Download PDF', actions.onDownloadPdf, 'btn btn-primary btn-sm'));
		if (actions.onDownloadMarkdown) bar.append(button(doc, 'Download .md', actions.onDownloadMarkdown));
		if (actions.onCopyFixes && (session.findings?.length ?? 0) > 0) bar.append(button(doc, 'Copy do-now prompts', actions.onCopyFixes));
		if (actions.onProvideFeedback) {
			const feedback = button(doc, actions.feedbackRated ? 'View Feedback' : 'Provide Feedback', actions.onProvideFeedback);
			feedback.title = actions.feedbackRated ? 'View your submitted feedback for this review.' : 'Rate this Founder review and tell us how it went.';
			bar.append(feedback);
		}
		card.append(bar);
	}
	return card;
}

function renderBusiness(session, doc) {
	const founder = session.founder;
	const business = founder.business;
	const wrap = section(doc, 'The business', 'What the reviewer concluded the product is, for whom, and how it intends to win.');
	if (!business) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Understanding the product…' : 'Not profiled.')); return wrap; }
	const grid = node(doc, 'dl', 'cmp-facts');
	const fact = (term, value) => { if (!value) return; grid.append(node(doc, 'dt', '', term), node(doc, 'dd', '', value)); };
	fact('What it is', business.oneLiner);
	fact('Promise on the site', business.valueProposition ? `“${business.valueProposition}”` : 'No clear promise on the first screen');
	fact('Target customer', [business.targetCustomer?.stated || 'Not stated on the site', business.targetCustomer?.inferred && business.targetCustomer.inferred !== business.targetCustomer.stated ? `realistically: ${business.targetCustomer.inferred}` : ''].filter(Boolean).join(' — '));
	fact('Business model', business.businessModel?.replace(/_/g, ' '));
	fact('Main goal', business.primaryGoal?.replace(/_/g, ' '));
	fact('Stage', business.stage && business.stage !== 'unknown' ? business.stage.replace(/_/g, ' ') : undefined);
	const brief = founder.brief ?? {};
	const owner = [brief.goals, brief.audience ? `Customers: ${brief.audience}` : ''].filter(Boolean).join(' · ');
	fact('Your brief', owner || undefined);
	wrap.append(grid);
	return wrap;
}

function renderScorecard(session, doc) {
	const report = session.founder.report;
	const lenses = report?.lenses ?? [];
	const wrap = section(doc, 'Scorecard', 'Ten business areas, scored 0–10 against what customers in this category expect.');
	if (!lenses.length) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Scores appear once the product has been measured and walked.' : 'Not scored.')); return wrap; }
	const list = node(doc, 'div', 'fdr-lenses');
	for (const lens of lenses) {
		const row = node(doc, 'details', 'fdr-lens');
		row.dataset.lens = lens.id;
		const summary = node(doc, 'summary', 'fdr-lens-summary');
		summary.append(node(doc, 'span', 'fdr-lens-name', lens.name));
		const bar = node(doc, 'span', 'cmp-score-bar fdr-lens-bar');
		const fill = node(doc, 'span', `cmp-score-fill${scoreTone(lens.score)}`);
		if (fill.style) fill.style.width = `${(lens.score ?? 0) * 10}%`;
		bar.append(fill);
		summary.append(bar, node(doc, 'span', 'cmp-score-value', lens.score === null ? '—' : `${lens.score}`));
		row.append(summary);
		const body = node(doc, 'div', 'fdr-lens-body');
		body.append(node(doc, 'p', 'fdr-lens-verdict', lens.verdict));
		if (lens.strengths?.length) { body.append(node(doc, 'strong', '', 'Working')); const items = node(doc, 'ul'); for (const item of lens.strengths.slice(0, 5)) items.append(node(doc, 'li', '', item)); body.append(items); }
		if (lens.weaknesses?.length) { body.append(node(doc, 'strong', '', 'Holding it back')); const items = node(doc, 'ul'); for (const item of lens.weaknesses.slice(0, 5)) items.append(node(doc, 'li', '', item)); body.append(items); }
		if (lens.scoredBy === 'measured') body.append(node(doc, 'small', 'fdr-muted', 'Scored from the measured signals.'));
		row.append(body);
		list.append(row);
	}
	wrap.append(list);
	return wrap;
}

function renderRecommendation(item, doc, select) {
	const card = node(doc, 'article', `fdr-rec is-${item.kind} is-${item.priority}`);
	card.dataset.recommendation = item.id;
	const head = node(doc, 'div', 'fdr-rec-head');
	if (select) {
		const box = node(doc, 'input', 'fdr-rec-select');
		box.type = 'checkbox';
		box.checked = select.selected.has(item.id);
		box.disabled = select.disabled;
		box.setAttribute('aria-label', `Select ${item.title} for Drytis Studio`);
		box.addEventListener('change', () => select.onToggle(item.id, box.checked));
		head.append(box);
	}
	head.append(node(doc, 'span', 'fdr-rec-id', item.id));
	head.append(node(doc, 'span', `fdr-kind fdr-kind-${item.kind}`, item.kind === 'avoid' ? 'Avoid' : 'Do'));
	head.append(node(doc, 'h4', 'fdr-rec-title', item.title));
	card.append(head);
	const meta = node(doc, 'p', 'fdr-rec-meta', `${item.lensName} · ${item.impact} impact · ${item.effort} effort${item.metric ? ` · watch: ${item.metric}` : ''}`);
	card.append(meta);
	card.append(node(doc, 'p', 'fdr-rec-why', item.why));
	if (item.how?.length) { const steps = node(doc, 'ol', 'fdr-rec-how'); for (const step of item.how) steps.append(node(doc, 'li', '', step)); card.append(steps); }
	if (item.acceptance?.length) card.append(node(doc, 'p', 'fdr-rec-done', `Done when: ${item.acceptance.join('; ')}`));
	if (item.evidence?.length) card.append(node(doc, 'p', 'fdr-muted fdr-rec-evidence', `Evidence: ${item.evidence.join(', ')}`));
	return card;
}

function renderStudioBar(doc, handoff, report) {
	const bar = node(doc, 'div', 'fdr-studio');
	const state = handoff?.status?.state;
	const selected = state?.selections ?? [];
	bar.append(node(doc, 'strong', '', 'Build with Drytis Studio'));
	const status = handoff?.status;
	const sent = state?.handoff?.status;
	bar.append(node(doc, 'span', 'fdr-muted', sent === 'succeeded' ? 'Sent to Studio as build tasks.' : sent === 'pending' ? 'Sending to Studio…' : sent === 'failed' ? 'The last send failed; you can retry.' : state?.automaticHandoff ? 'The do-now items are sent to Studio automatically.' : `${selected.length} selected — tick recommendations to turn them into build tasks.`));
	const actions = node(doc, 'div', 'fdr-studio-actions');
	const busy = status?.loading || status?.saving || status?.sending || status?.exporting;
	if (!state?.automaticHandoff) {
		actions.append(button(doc, 'Select do-now', () => handoff.onSelect(report.recommendations.filter(item => item.priority === 'now').map(item => item.id))));
		const send = button(doc, sent === 'failed' ? 'Retry send' : 'Send to Studio', () => handoff.onSend(), 'btn btn-primary btn-sm');
		send.disabled = Boolean(busy) || !selected.length || !status?.bound;
		actions.append(send);
		const exportButton = button(doc, 'Copy requirements', () => handoff.onExport('copy'));
		exportButton.disabled = Boolean(busy) || !selected.length || !status?.bound;
		actions.append(exportButton);
	}
	bar.append(actions);
	if (status?.error) bar.append(node(doc, 'p', 'fdr-error', status.error));
	return bar;
}

function renderRecommendations(session, doc, actions) {
	const report = session.founder.report;
	const wrap = section(doc, 'What to do', 'Changes to make, things to avoid, and what to keep — most valuable first.');
	if (!report) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Recommendations come at the end of the review.' : 'No recommendations.')); return wrap; }
	const handoff = actions.handoff;
	const selected = new Set(handoff?.status?.state?.selections ?? []);
	const select = handoff && !handoff.status?.state?.automaticHandoff ? { selected, disabled: !handoff.status?.bound || Boolean(handoff.status?.saving || handoff.status?.sending), onToggle: handoff.onToggle } : undefined;
	if (handoff) wrap.append(renderStudioBar(doc, handoff, report));
	for (const priority of ['now', 'next', 'later']) {
		const items = report.recommendations.filter(item => item.priority === priority);
		if (!items.length) continue;
		const group = node(doc, 'div', `fdr-rec-group is-${priority}`);
		const title = node(doc, 'h4', 'fdr-rec-group-title', PRIORITY_META[priority].label);
		title.append(node(doc, 'small', '', ` ${PRIORITY_META[priority].hint} · ${items.length}`));
		group.append(title);
		for (const item of items) group.append(renderRecommendation(item, doc, select));
		wrap.append(group);
	}
	if (report.keep?.length) {
		const keep = node(doc, 'div', 'fdr-keep');
		keep.append(node(doc, 'h4', 'fdr-rec-group-title', 'Keep doing'));
		const list = node(doc, 'ul');
		for (const item of report.keep) { const line = node(doc, 'li'); line.append(node(doc, 'strong', '', item.title), node(doc, 'span', '', ` — ${item.why}`)); list.append(line); }
		keep.append(list);
		wrap.append(keep);
	}
	return wrap;
}

function renderJourneys(session, doc) {
	const founder = session.founder;
	const journeys = founder.journeys?.length ? founder.journeys : founder.journeyPlan ?? [];
	const wrap = section(doc, 'Journeys walked', 'Each key journey, walked as a first-time customer.');
	if (!journeys.length) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Journeys are planned once the business is understood.' : 'No journeys.')); return wrap; }
	for (const journey of journeys) {
		const item = node(doc, 'details', `fdr-journey is-${journey.outcome ?? 'planned'}`);
		const summary = node(doc, 'summary', 'fdr-journey-summary');
		summary.append(node(doc, 'span', 'fdr-rec-id', journey.id), node(doc, 'span', 'fdr-journey-name', journey.name));
		if (journey.requestedBy === 'owner') summary.append(node(doc, 'span', 'cmp-chip', 'your request'));
		summary.append(pill(doc, OUTCOME_META[journey.outcome] ?? { label: 'Planned', tone: 'muted' }));
		item.append(summary);
		const body = node(doc, 'div', 'fdr-journey-body');
		if (journey.summary) body.append(node(doc, 'p', '', journey.summary));
		if (journey.friction?.length) { const list = node(doc, 'ul', 'fdr-friction'); for (const entry of journey.friction) { const line = node(doc, 'li'); line.append(node(doc, 'span', `cmp-sev cmp-sev-${entry.severity}`, entry.severity), node(doc, 'span', '', ` ${entry.issue}${entry.impact ? ` — ${entry.impact}` : ''}`)); list.append(line); } body.append(list); }
		if (journey.delights?.length) body.append(node(doc, 'p', 'fdr-delight', `Worked well: ${journey.delights.join('; ')}`));
		if (journey.steps?.length) { const steps = node(doc, 'details', 'cmp-more'); steps.append(node(doc, 'summary', '', `Steps (${journey.steps.length})`)); const list = node(doc, 'ol'); for (const step of journey.steps) list.append(node(doc, 'li', '', step)); steps.append(list); body.append(steps); }
		item.append(body);
		wrap.append(item);
	}
	return wrap;
}

function renderMarket(session, doc) {
	const market = session.founder.market;
	const wrap = section(doc, 'Market', 'Competitors found in this review and what customers in this category expect.');
	if (!market) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Researching competitors…' : 'Competitors were not researched.')); return wrap; }
	if (market.competitors.length) {
		const list = node(doc, 'div', 'fdr-competitors');
		for (const item of market.competitors) {
			const card = node(doc, 'article', 'fdr-competitor');
			const head = node(doc, 'div', 'fdr-competitor-head');
			head.append(node(doc, 'span', 'fdr-rec-id', item.id), link(doc, item.name, item.url, 'fdr-competitor-name'));
			card.append(head, node(doc, 'p', '', item.positioning));
			if (item.pricing) card.append(node(doc, 'p', 'fdr-muted', `Pricing: ${item.pricing}`));
			if (item.strengths?.length) card.append(node(doc, 'p', 'fdr-muted', `Strengths: ${item.strengths.join(', ')}`));
			list.append(card);
		}
		wrap.append(list);
	} else if (market.noneFound) wrap.append(node(doc, 'p', 'cmp-empty', market.noneFound));
	const bullets = (title, items) => { if (!items?.length) return; wrap.append(node(doc, 'strong', 'fdr-subhead', title)); const list = node(doc, 'ul', 'fdr-bullets'); for (const item of items) list.append(node(doc, 'li', '', item)); wrap.append(list); };
	bullets('What customers expect', market.expectations);
	bullets('Ways to stand out', market.differentiation);
	return wrap;
}

function renderSignals(session, doc, actions) {
	const founder = session.founder;
	const wrap = section(doc, 'First impression and measured signals', 'What a first-time visitor sees, measured by Qase on desktop and on a phone.');
	if (founder.screenshots?.length && actions.artifactUrl) {
		const shots = node(doc, 'div', 'fdr-shots');
		for (const shot of founder.screenshots) {
			const figure = node(doc, 'figure', 'fdr-shot');
			const img = node(doc, 'img');
			img.src = actions.artifactUrl(shot.id);
			img.alt = shot.label;
			img.loading = 'lazy';
			figure.append(img, node(doc, 'figcaption', '', shot.label));
			shots.append(figure);
		}
		wrap.append(shots);
	}
	if (!founder.signals?.length) { wrap.append(node(doc, 'p', 'cmp-empty', session.status === 'running' ? 'Measuring after the business is understood.' : 'Not measured.')); return wrap; }
	const list = node(doc, 'ul', 'cmp-evidence');
	for (const signal of founder.signals) {
		const item = node(doc, 'li', `cmp-evidence-item is-${signal.status === 'missing' ? 'issue' : signal.status}`);
		item.append(pill(doc, SIGNAL_META[signal.status] ?? SIGNAL_META.unknown));
		const text = node(doc, 'div', 'cmp-evidence-text');
		text.append(node(doc, 'strong', '', `${signal.id} · ${signal.title}`), node(doc, 'p', '', signal.detail));
		item.append(text);
		list.append(item);
	}
	wrap.append(list);
	return wrap;
}

function renderFootnotes(session, doc) {
	const founder = session.founder;
	const out = [];
	if (founder.limitations?.length) { const wrap = section(doc, 'Not covered', 'What the review could not do; the advice above is limited accordingly.'); const list = node(doc, 'ul', 'cmp-limitations'); for (const item of founder.limitations) list.append(node(doc, 'li', '', item.message)); wrap.append(list); out.push(wrap); }
	if (founder.sources?.length) {
		const wrap = section(doc, 'Research sources', `Pages found or read while researching (${founder.sources.length}).`);
		const more = node(doc, 'details', 'cmp-more'); more.append(node(doc, 'summary', '', 'Show sources'));
		const list = node(doc, 'ul', 'cmp-sources');
		for (const source of founder.sources.slice(0, 60)) { const item = node(doc, 'li'); item.append(link(doc, source.title || source.url, source.url), node(doc, 'small', '', ` ${hostOf(source.url)}`)); list.append(item); }
		more.append(list); wrap.append(more); out.push(wrap);
	}
	out.push(node(doc, 'p', 'cmp-disclaimer', founder.report?.disclaimer ?? 'An automated business review of the publicly observable product. Scores and advice are informed judgement; validate the biggest bets with real users.'));
	return out;
}

/** The Founder tab and report tab. */
export function renderFounderReview(session, actions = {}, doc = document) {
	const root = node(doc, 'div', 'cmp-compliance fdr-review');
	if (!isFounderReviewRun(session)) { root.append(renderLegacyFounderNotice(session, doc)); return root; }
	root.append(renderHero(session, doc, actions));
	if (!session.founder.report) root.append(renderStages(session, doc));
	root.append(renderRecommendations(session, doc, actions), renderScorecard(session, doc), renderBusiness(session, doc), renderJourneys(session, doc), renderMarket(session, doc), renderSignals(session, doc, actions), ...renderFootnotes(session, doc));
	return root;
}

/** Reviews made by the previous Founder pipeline stay listed and readable. */
export function renderLegacyFounderNotice(session, doc = document) {
	const box = node(doc, 'aside', 'cmp-legacy');
	box.append(node(doc, 'strong', '', 'Earlier Founder review'));
	box.append(node(doc, 'p', '', 'This review was made by the previous Founder pipeline, which has been replaced. Its conversation remains available; start a new Founder review for a business scorecard and recommendations.'));
	return box;
}

/** The report card posted in the conversation when a review finishes. */
export function renderFounderReportCard(session, message, actions = {}, doc = document) {
	const report = session.founder?.report ?? {};
	const card = node(doc, 'section', 'qa-card qa-report-card fdr-report-card');
	card.dataset.verdict = report.verdict ?? 'not_assessed';
	const head = node(doc, 'div', 'qa-report-head');
	const score = node(doc, 'span', `fdr-score fdr-score-sm${scoreTone(report.readiness === null || report.readiness === undefined ? null : report.readiness / 10)}`);
	score.append(node(doc, 'strong', '', report.readiness ?? '—'), node(doc, 'span', '', '/100'));
	const titles = node(doc, 'div');
	titles.append(node(doc, 'h4', 'qa-card-title', `Founder review complete · ${report.verdictLabel ?? ''}`), node(doc, 'p', 'qa-where', report.verdictLine ?? ''));
	head.append(score, titles);
	card.append(head);
	const weakest = (report.lenses ?? []).filter(lens => lens.score !== null).sort((a, b) => a.score - b.score).slice(0, 3);
	if (weakest.length) {
		const list = node(doc, 'ul', 'cmp-card-frameworks');
		for (const lens of weakest) { const item = node(doc, 'li'); item.append(node(doc, 'span', 'cmp-card-fw-name', lens.name), node(doc, 'span', `cmp-card-fw-score${scoreTone(lens.score)}`, `${lens.score}/10`)); list.append(item); }
		card.append(list);
	}
	const counts = report.counts ?? {};
	card.append(node(doc, 'p', 'cmp-card-counts', `${counts.recommendations ?? 0} recommendations · ${counts.now ?? 0} to do now · ${counts.avoid ?? 0} to avoid · ${counts.journeys ?? 0} journeys walked`));
	card.append(node(doc, 'p', 'qa-summary', report.summary ?? message?.text ?? ''));
	const bar = node(doc, 'div', 'qa-card-actions');
	if (actions.onOpenReport) bar.append(button(doc, 'Open the review', actions.onOpenReport, 'btn btn-primary btn-sm'));
	if (actions.onDownloadPdf) bar.append(button(doc, 'Download PDF', actions.onDownloadPdf));
	card.append(bar);
	return card;
}

/** A "do now" recommendation posted in the conversation. */
export function renderFounderRecCard(session, message, actions = {}, doc = document) {
	const id = String(message?.id ?? '').split('-').pop();
	const item = session.founder?.report?.recommendations?.find(entry => entry.id === id);
	const card = node(doc, 'div', `qa-card fdr-rec-card is-${item?.kind ?? 'do'}`);
	card.append(node(doc, 'span', `fdr-kind fdr-kind-${item?.kind ?? 'do'}`, item?.kind === 'avoid' ? 'Avoid' : 'Do now'));
	card.append(node(doc, 'strong', 'fdr-rec-card-title', item?.title ?? String(message?.text ?? '').replace(/^\*\*[^*]+\*\*\s*·\s*/, '')));
	if (item?.why) card.append(node(doc, 'p', 'fdr-muted', item.why));
	if (item && actions.onOpenReport) card.append(button(doc, 'See how', actions.onOpenReport));
	return card;
}
