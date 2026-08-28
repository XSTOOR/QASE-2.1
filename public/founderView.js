import {
	collectFounderAssumptions,
	describeFounderLifecycle,
	founderEvidenceSummary,
	groupFounderObservations,
	resolveFounderQuickWins
} from './founderPresentation.js';

/**
 * Create the Founder Mode presentation surface.
 *
 * The controller supplies state and side effects explicitly. This module owns
 * only DOM construction, so moving it out of app.js cannot alter run state,
 * event handling, API routing, or the Founder evaluation itself.
 */
export function createFounderView({
	documentRef = globalThis.document,
	NodeCtor = globalThis.Node,
	getSession,
	getCatalog,
	getSessionId,
	elements,
	apiText,
	downloadReportPdf,
	toast,
	fail,
	humanizeId
}) {
	const doc = documentRef;

	function founderValues(value) {
		return Array.isArray(value) ? value.filter(item => item !== undefined && item !== null) : [];
	}

	function founderCategoryLabel(id) {
		const category = founderValues(getCatalog()?.categories).find(item => item?.id === id);
		return category?.label ?? humanizeId(id);
	}

	function founderSection(titleText, subtitleText = '') {
		const node = doc.createElement('section');
		node.className = 'founder-section';
		const head = doc.createElement('header');
		const title = doc.createElement('h3');
		title.textContent = titleText;
		head.append(title);
		if (subtitleText) {
			const subtitle = doc.createElement('p');
			subtitle.textContent = subtitleText;
			head.append(subtitle);
		}
		const body = doc.createElement('div');
		body.className = 'founder-section-body';
		node.append(head, body);
		return { node, body };
	}

	function founderList(items, emptyText = 'No items recorded.') {
		const values = founderValues(items).map(item => String(item).trim()).filter(Boolean);
		if (!values.length) {
			const empty = doc.createElement('p');
			empty.className = 'founder-empty';
			empty.textContent = emptyText;
			return empty;
		}
		const listNode = doc.createElement('ul');
		listNode.className = 'founder-list';
		for (const value of values) {
			const item = doc.createElement('li');
			item.textContent = value;
			listNode.append(item);
		}
		return listNode;
	}

	function founderCard(titleText, content, { meta = '', trace } = {}) {
		const card = doc.createElement('article');
		card.className = 'founder-card';
		const title = doc.createElement('strong');
		title.textContent = titleText;
		card.append(title);
		if (meta) {
			const metadata = doc.createElement('span');
			metadata.className = 'founder-card-meta';
			metadata.textContent = meta;
			card.append(metadata);
		}
		if (Array.isArray(content)) card.append(founderList(content));
		else if (NodeCtor && content instanceof NodeCtor) card.append(content);
		else {
			const copy = doc.createElement('p');
			copy.textContent = String(content ?? 'Not stated.');
			card.append(copy);
		}
		if (trace) card.append(founderTrace(trace));
		return card;
	}

	function founderTrace(item = {}) {
		const trace = doc.createElement('div');
		trace.className = 'founder-trace';
		const evidenceIds = founderValues(item.evidenceObservationIds);
		const assumptions = founderValues(item.assumptions);
		if (evidenceIds.length) {
			const evidence = doc.createElement('span');
			evidence.textContent = `${evidenceIds.length} evidence link${evidenceIds.length === 1 ? '' : 's'}`;
			evidence.title = evidenceIds.join(', ');
			trace.append(evidence);
		}
		if (assumptions.length) {
			const hypothesis = doc.createElement('span');
			hypothesis.dataset.kind = 'assumption';
			hypothesis.textContent = `${assumptions.length} assumption${assumptions.length === 1 ? '' : 's'}`;
			hypothesis.title = assumptions.join(' · ');
			trace.append(hypothesis);
		}
		if (!trace.childElementCount) {
			const boundary = doc.createElement('span');
			boundary.textContent = 'No trace supplied';
			trace.append(boundary);
		}
		return trace;
	}

	function founderScopeItem(labelText, value) {
		const item = doc.createElement('div');
		const label = doc.createElement('span');
		label.textContent = labelText;
		const detail = doc.createElement('strong');
		detail.textContent = String(value || 'Not provided');
		detail.title = detail.textContent;
		item.append(label, detail);
		return item;
	}

	function renderFounderHero(scope, lifecycle) {
		const target = scope.target ?? {};
		const node = doc.createElement('section');
		node.className = 'founder-hero';
		const eyebrow = doc.createElement('span');
		eyebrow.className = 'founder-eyebrow';
		eyebrow.textContent = 'Founder Mode // evidence-led product review';
		const title = doc.createElement('h2');
		title.textContent = target.name ?? getSession()?.title ?? 'Founder review';
		const detail = doc.createElement('p');
		detail.textContent = lifecycle.detail;
		const status = doc.createElement('span');
		status.className = 'founder-status';
		status.dataset.status = lifecycle.status;
		status.textContent = lifecycle.label;
		node.append(eyebrow, title, detail, status);
		return node;
	}

	function renderFounderScope(scope) {
		const target = scope.target ?? {};
		const context = scope.productContext ?? {};
		const node = doc.createElement('section');
		node.className = 'founder-scope';
		node.setAttribute('aria-label', 'Founder review scope');
		for (const [label, value] of [
			['Release / environment', [target.release, target.environment].filter(Boolean).join(' · ')],
			['Business stage', context.stage],
			['Business model', context.businessModel],
			['Target customer', context.targetCustomer],
			['Primary goal', context.primaryGoal],
			['Review lenses', `${scope.categories?.length ?? 0} categories`]
		]) node.append(founderScopeItem(label, value));
		return node;
	}

	function renderFounderObservationCard(observation) {
		const meta = [
			founderCategoryLabel(observation.category),
			humanizeId(observation.type),
			`${humanizeId(observation.confidence)} confidence`,
			`${observation.evidence?.length ?? 0} evidence artifact${observation.evidence?.length === 1 ? '' : 's'}`
		].join(' · ');
		return founderCard(observation.title ?? 'Untitled observation', observation.summary ?? '', { meta });
	}

	function renderFounderObservations(observations, titleText, subtitleText) {
		const section = founderSection(titleText, subtitleText);
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		for (const observation of founderValues(observations)) grid.append(renderFounderObservationCard(observation));
		if (!grid.childElementCount) section.body.append(founderList([], 'No matching browser-backed observations were recorded.'));
		else section.body.append(grid);
		return section.node;
	}

	function renderFounderEvidence(founder, report) {
		const fallback = founderEvidenceSummary(founder);
		const declared = report?.evidenceConfidence;
		const confidence = declared?.observationConfidence ?? fallback.confidence;
		const reviewed = report?.coverage?.categoriesReviewed?.length ?? fallback.reviewed;
		const total = report?.coverage?.totalCategories ?? fallback.total;
		const ratio = Number(declared?.categoryCoverageRatio);
		const coverage = Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : (total ? `${Math.round((reviewed / total) * 100)}%` : '—');
		const section = founderSection('Evidence confidence', 'A transparent view of browser evidence, category coverage, and model confidence.');
		const metrics = doc.createElement('dl');
		metrics.className = 'founder-evidence-grid';
		for (const [label, value] of [
			['Overall rating', humanizeId(declared?.rating ?? (confidence.low > 0 ? 'low' : 'provisional'))],
			['Observations', report?.coverage?.evidenceBackedObservations ?? fallback.observations],
			['Category coverage', coverage],
			['Browser activities', declared?.uniqueBrowserActivities ?? fallback.activities],
			['High confidence', confidence.high ?? 0],
			['Medium / low', `${confidence.medium ?? 0} / ${confidence.low ?? 0}`],
			['Explicit assumptions', declared?.assumptionCount ?? collectFounderAssumptions(report ?? {}).length]
		]) {
			const item = doc.createElement('div');
			const term = doc.createElement('dt');
			term.textContent = label;
			const detail = doc.createElement('dd');
			detail.textContent = String(value);
			item.append(term, detail);
			metrics.append(item);
		}
		section.body.append(metrics);
		const note = doc.createElement('p');
		note.className = 'founder-evidence-note';
		note.textContent = declared?.limitation
			?? 'Confidence describes the evidence behind this brief; strategic recommendations remain hypotheses to validate with customers and market data.';
		section.body.append(note);
		return section.node;
	}

	function renderFounderIcpPositioning(report) {
		const section = founderSection('ICP & positioning', 'Who this is for, the job it wins, and the clearest market frame.');
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		const icp = report.icp ?? {};
		const positioning = report.positioning ?? {};
		grid.append(
			founderCard('Primary ICP', icp.primary, { trace: icp }),
			founderCard('Market category', positioning.category, { trace: positioning }),
			founderCard('Users', icp.users),
			founderCard('Buyers', icp.buyers),
			founderCard('Jobs to be done', icp.jobs),
			founderCard('Customer pains', icp.pains),
			founderCard('One-line positioning', positioning.oneLiner),
			founderCard('Value proposition', positioning.valueProposition),
			founderCard('Differentiators', positioning.differentiators),
			founderCard('Alternatives', positioning.alternatives)
		);
		section.body.append(grid);
		return section.node;
	}

	function renderFounderMonetization(report) {
		const section = founderSection('Monetization & pricing', 'Packaging, value metric, pricing communication, and the next hypotheses to test.');
		const monetization = report.monetization;
		if (monetization) {
			const grid = doc.createElement('div');
			grid.className = 'founder-card-grid';
			grid.append(
				founderCard('Monetization model', monetization.model, { trace: monetization }),
				founderCard('Value metric', monetization.valueMetric),
				founderCard('Packages', monetization.packages),
				founderCard('Pricing presentation', monetization.pricingPresentation),
				founderCard('Next pricing tests', monetization.nextTests)
			);
			section.body.append(grid);
			return section.node;
		}
		const fallback = founderValues(report.recommendations).filter(item => item.category === 'monetization_pricing');
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		for (const item of fallback) grid.append(founderCard(item.title, item.rationale, { trace: item }));
		if (!grid.childElementCount) section.body.append(founderList([], 'No pricing recommendation was returned for this review.'));
		else section.body.append(grid);
		return section.node;
	}

	function renderFounderSales(report) {
		const sales = report.sales ?? {};
		const section = founderSection('Sales & GTM', 'The recommended commercial motion, qualification path, proof, and objection handling.');
		const motion = doc.createElement('p');
		motion.className = 'founder-copy';
		motion.textContent = sales.motion ?? 'No sales motion was returned.';
		section.body.append(motion, founderTrace(sales));
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		grid.append(
			founderCard('Qualification questions', sales.qualificationQuestions),
			founderCard('Sales assets', sales.salesAssets)
		);
		for (const item of founderValues(sales.objectionResponses)) {
			grid.append(founderCard(`Objection: ${item.objection ?? 'Unspecified'}`, item.response));
		}
		section.body.append(grid);
		return section.node;
	}

	function renderFounderMarketing(report) {
		const marketing = report.marketing ?? {};
		const section = founderSection('Marketing & growth', 'Evidence-linked distribution bets, launch motions, content, and growth loops.');
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		for (const channel of founderValues(marketing.channels)) {
			const content = doc.createElement('div');
			const rationale = doc.createElement('p');
			rationale.textContent = channel.rationale ?? '';
			const test = doc.createElement('p');
			test.className = 'founder-next-test';
			test.textContent = `First test: ${channel.firstTest ?? 'Not stated'}`;
			content.append(rationale, test);
			grid.append(founderCard(channel.channel ?? 'Channel', content, {
				meta: `${humanizeId(channel.confidence)} confidence`, trace: channel
			}));
		}
		grid.append(
			founderCard('Content angles', marketing.contentAngles),
			founderCard('Launch motions', marketing.launchMotions),
			founderCard('Growth loops', marketing.growthLoops)
		);
		section.body.append(grid);
		return section.node;
	}

	function renderFounderPriorities(report) {
		const recommendations = founderValues(report.recommendations);
		const section = founderSection('Prioritized opportunities', `${recommendations.length} sequenced product and growth decisions.`);
		const listNode = doc.createElement('div');
		listNode.className = 'founder-priority-list';
		for (const [index, item] of recommendations.entries()) {
			const row = doc.createElement('article');
			row.className = 'founder-priority';
			const rank = doc.createElement('span');
			rank.className = 'founder-rank';
			rank.textContent = String(index + 1).padStart(2, '0');
			const content = doc.createElement('div');
			const title = doc.createElement('strong');
			title.textContent = item.title ?? 'Untitled recommendation';
			const rationale = doc.createElement('p');
			rationale.textContent = item.rationale ?? '';
			content.append(title, rationale, founderList(item.actions, 'No actions supplied.'), founderTrace(item));
			const scores = doc.createElement('div');
			scores.className = 'founder-scores';
			for (const [label, value] of [['Impact', item.impact], ['Effort', item.effort], ['Confidence', item.confidence]]) {
				const score = doc.createElement('span');
				score.className = label === 'Confidence' ? 'founder-confidence' : 'founder-score';
				score.textContent = `${label} ${humanizeId(value)}`;
				scores.append(score);
			}
			row.append(rank, content, scores);
			listNode.append(row);
		}
		if (!listNode.childElementCount) section.body.append(founderList([], 'No prioritized recommendations were returned.'));
		else section.body.append(listNode);
		return section.node;
	}

	function renderFounderQuickWins(report) {
		const items = resolveFounderQuickWins(report);
		const section = founderSection('Quick wins', 'Low-friction moves selected from the prioritized recommendation set.');
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		for (const item of items) grid.append(founderCard(item.title, item.actions, { trace: item }));
		if (!grid.childElementCount) section.body.append(founderList([], 'No quick wins were selected.'));
		else section.body.append(grid);
		return section.node;
	}

	function renderFounderRoadmap(report) {
		const section = founderSection('30 / 60 / 90 roadmap', 'A staged sequence for validation, execution, and learning.');
		const roadmap = doc.createElement('div');
		roadmap.className = 'founder-roadmap';
		for (const [label, items] of [
			['First 30 days', report.plan?.days30],
			['Days 31–60', report.plan?.days60],
			['Days 61–90', report.plan?.days90]
		]) {
			const card = doc.createElement('article');
			card.className = 'founder-roadmap-item';
			const period = doc.createElement('span');
			period.textContent = label;
			card.append(period, founderList(items));
			roadmap.append(card);
		}
		section.body.append(roadmap);
		return section.node;
	}

	function renderFounderRisks(report) {
		const assumptions = collectFounderAssumptions(report);
		const section = founderSection('Risks & assumptions', `${report.risks?.length ?? 0} explicit risks · ${assumptions.length} hypotheses requiring validation.`);
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		for (const risk of founderValues(report.risks)) {
			grid.append(founderCard(risk.title ?? 'Risk', risk.mitigation, {
				meta: `Likelihood ${humanizeId(risk.likelihood)} · Impact ${humanizeId(risk.impact)}`,
				trace: risk
			}));
		}
		section.body.append(grid);
		if (assumptions.length) {
			const listNode = doc.createElement('ul');
			listNode.className = 'founder-assumption-list';
			for (const item of assumptions) {
				const row = doc.createElement('li');
				const source = doc.createElement('strong');
				source.textContent = item.source;
				row.append(source, doc.createTextNode(` — ${item.text}`));
				listNode.append(row);
			}
			section.body.append(listNode);
		}
		return section.node;
	}

	function renderFounderMetrics(report) {
		const metrics = report.metrics ?? {};
		const section = founderSection('Metrics & experiments', 'Decision metrics, learning loops, guardrails, and falsifiable next tests.');
		const grid = doc.createElement('div');
		grid.className = 'founder-card-grid';
		if (metrics.northStar) {
			grid.append(founderCard(`North star: ${metrics.northStar.name ?? 'Unnamed'}`, metrics.northStar.definition, {
				meta: metrics.northStar.why, trace: metrics.northStar
			}));
		}
		for (const item of founderValues(metrics.candidates)) {
			grid.append(founderCard(`Candidate: ${item.name ?? 'Unnamed'}`, item.definition, { trace: item }));
		}
		for (const [index, item] of founderValues(metrics.experiments).entries()) {
			const detail = doc.createElement('div');
			const change = doc.createElement('p');
			change.textContent = `Change: ${item.change ?? 'Not stated'}`;
			const outcome = doc.createElement('p');
			outcome.textContent = `Success: ${item.successMetric ?? 'Not stated'} · ${item.timebox ?? 'No timebox'}`;
			const guardrail = doc.createElement('p');
			guardrail.textContent = `Guardrail: ${item.guardrail ?? 'Not stated'}`;
			detail.append(change, outcome, guardrail);
			grid.append(founderCard(`Experiment ${index + 1}: ${item.hypothesis ?? 'Untitled hypothesis'}`, detail, { trace: item }));
		}
		section.body.append(grid);
		return section.node;
	}

	function renderFounderBoundary(report) {
		const node = doc.createElement('aside');
		node.className = 'founder-boundary';
		const title = doc.createElement('strong');
		title.textContent = 'Decision boundary';
		const copy = doc.createElement('p');
		copy.textContent = report?.caveat ?? getCatalog()?.caveat
			?? 'Founder Mode provides evidence-informed product guidance. Validate recommendations with customers and market data before committing resources.';
		node.append(title, copy);
		return node;
	}

	function renderFounderReportActions() {
		const actions = doc.createElement('div');
		actions.className = 'report-actions founder-report-actions';
		actions.setAttribute('role', 'group');
		actions.setAttribute('aria-label', 'Founder report actions');

		const download = doc.createElement('button');
		download.className = 'btn btn-ghost btn-sm';
		download.type = 'button';
		download.textContent = 'Download .md';
		download.onclick = async () => {
			try {
				const markdownText = await apiText(`/sessions/${getSessionId()}/report.md`);
				const url = URL.createObjectURL(new Blob([markdownText], { type: 'text/markdown;charset=utf-8' }));
				const save = doc.createElement('a');
				save.href = url;
				save.download = 'qase-founder-review.md';
				doc.body.append(save);
				save.click();
				save.remove();
				globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
			} catch (error) {
				fail(error);
			}
		};

		const copy = doc.createElement('button');
		copy.className = 'btn btn-ghost btn-sm';
		copy.type = 'button';
		copy.textContent = 'Copy report';
		copy.onclick = async () => {
			try {
				const markdownText = await apiText(`/sessions/${getSessionId()}/report.md`);
				await navigator.clipboard.writeText(markdownText);
				toast('Founder report copied to the clipboard.', 'good');
			} catch (error) {
				fail(error);
			}
		};

		const pdf = doc.createElement('button');
		pdf.className = 'btn btn-primary btn-sm';
		pdf.type = 'button';
		pdf.textContent = 'Download PDF';
		pdf.onclick = async () => {
			try { await downloadReportPdf('qase-founder-review.pdf'); }
			catch (error) { fail(error); }
		};
		actions.append(download, copy, pdf);
		return actions;
	}

	function appendFounderCompletedReport(container, founder, report) {
		const observations = groupFounderObservations(founder.observations);
		container.append(renderFounderReportActions(), renderFounderEvidence(founder, report));
		const thesis = founderSection('Executive thesis', 'The concise product, market, and execution diagnosis.');
		const thesisCopy = doc.createElement('p');
		thesisCopy.className = 'founder-copy founder-copy--lead';
		thesisCopy.textContent = report.executiveSummary ?? 'No executive summary was returned.';
		thesis.body.append(thesisCopy);
		container.append(
			thesis.node,
			renderFounderObservations(observations.productFindings, 'UI, UX & product findings', 'Evidence observed directly on the product surface.'),
			renderFounderIcpPositioning(report),
			renderFounderSales(report),
			renderFounderMarketing(report),
			renderFounderMonetization(report),
			renderFounderPriorities(report),
			renderFounderQuickWins(report),
			renderFounderRoadmap(report),
			renderFounderRisks(report),
			renderFounderMetrics(report),
			renderFounderBoundary(report)
		);
	}

	function render() {
		const session = getSession();
		elements.founderView.replaceChildren();
		if (session?.mode !== 'founder') {
			elements.countFounder.textContent = '';
			return;
		}
		const founder = session.founder ?? {};
		const scope = founder.scope ?? {};
		const report = founder.report;
		const lifecycle = describeFounderLifecycle(founder, session.status, session.activities?.length ?? 0);
		elements.countFounder.textContent = lifecycle.badge;
		elements.founderView.append(renderFounderHero(scope, lifecycle), renderFounderScope(scope));

		if (!report) {
			if (founder.observations?.length) {
				elements.founderView.append(renderFounderObservations(
					founder.observations,
					'Live evidence log',
					'Browser-backed strengths, frictions, opportunities, and risks captured during this review.'
				));
			}
			const pending = doc.createElement('div');
			pending.className = 'founder-pending';
			pending.textContent = lifecycle.message;
			elements.founderView.append(pending, renderFounderBoundary());
			return;
		}

		appendFounderCompletedReport(elements.founderView, founder, report);
	}

	function renderReportTab() {
		const session = getSession();
		const founder = session?.founder ?? {};
		const report = founder.report;
		const lifecycle = describeFounderLifecycle(founder, session?.status, session?.activities?.length ?? 0);
		if (!founder.finalizedAt || !report) {
			const pending = doc.createElement('div');
			pending.className = 'feed-empty';
			pending.textContent = lifecycle.message || 'The Founder report is available after the review is finalized.';
			elements.reportView.append(pending);
			return;
		}

		elements.reportView.append(renderFounderHero(founder.scope ?? {}, lifecycle), renderFounderScope(founder.scope ?? {}));
		appendFounderCompletedReport(elements.reportView, founder, report);
	}

	return Object.freeze({ render, renderReportTab });
}
