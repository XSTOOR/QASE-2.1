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
	getProjectState,
	onToggleSelection,
	onSelectAll,
	onClearSelection,
	onSendToStudio,
	onExportHandoff,
	elements,
	apiText,
	downloadReportPdf,
	toast,
	fail,
	exportError = fail,
	humanizeId
}) {
		const doc = documentRef;
		let handoff;

		function setHandoff(next) {
			handoff = next;
			render();
		}

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
		// Phase 4: a finalized report's own recommendations are selectable too —
		// the founder most often reopens exactly this view. Selections persist
		// through the same project state as the restored view (the project-level
		// save is consulted via getProjectState, scoped to this closure).
		const saved = getProjectState?.();
		const selections = new Set(saved?.selections ?? []);
		const section = founderSection('What to build next', `${recommendations.length} recommendations ordered by impact, effort, and confidence. Each includes the reason it matters.`);		const listNode = doc.createElement('div');
		listNode.className = 'founder-priority-list';
		for (const [index, item] of recommendations.entries()) {
			const row = doc.createElement('article');
			row.className = 'founder-priority founder-selectable';
			if (item.id !== undefined) {
				const select = doc.createElement('label');
				select.className = 'founder-select';
				const box = doc.createElement('input');
				box.type = 'checkbox';
				box.checked = selections.has(item.id);
				box.dataset.recommendationId = item.id;
				box.onchange = () => onToggleSelection?.(item.id, box.checked);
				const hint = doc.createElement('span');
				hint.textContent = 'Select to send';
				hint.className = 'founder-select-hint';
				select.append(box, hint);
				row.append(select);
			}
			const rank = doc.createElement('span');
			rank.className = 'founder-rank';
			rank.textContent = String(index + 1).padStart(2, '0');
			const content = doc.createElement('div');
			const title = doc.createElement('strong');
			title.textContent = item.title ?? 'Untitled recommendation';
			const rationale = doc.createElement('p');
			rationale.textContent = item.rationale ?? '';
			content.append(title, rationale);
			if (item.proposedFeature) {
				const proposed = doc.createElement('p');
				proposed.className = 'founder-detail';
				proposed.textContent = `Build: ${item.proposedFeature}`;
				content.append(proposed);
			}
			if (item.intendedOutcome) {
				const outcome = doc.createElement('p');
				outcome.className = 'founder-detail';
				outcome.textContent = `Outcome: ${item.intendedOutcome}`;
				content.append(outcome);
			}
			content.append(founderList(item.actions, 'No actions supplied.'));
			if (Array.isArray(item.acceptanceCriteria) && item.acceptanceCriteria.length > 0) {
				const criteria = doc.createElement('details');
				criteria.className = 'founder-detail';
				const summary = doc.createElement('summary');
				summary.textContent = `Acceptance criteria (${item.acceptanceCriteria.length})`;
				criteria.append(summary);
				criteria.append(founderList(item.acceptanceCriteria, 'No criteria supplied.'));
				content.append(criteria);
			}
			content.append(founderTrace(item));
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
		if (!listNode.childElementCount) {
			// Distinct "no supported recommendations" state — not an error. The
			// evidence collected did not support three or more specific,
			// non-overlapping recommendations, so Founder Mode published none
			// rather than padding with generic advice.
			const empty = founderSection('No supported recommendations yet',
				'The evidence collected in this review did not support a specific, prioritized recommendation set.');
			const copy = doc.createElement('p');
			copy.className = 'founder-copy';
			copy.textContent = 'Founder Mode only recommends what the observed evidence supports. Re-run the review with more product surface covered (for example by authorizing authenticated areas or adding your target URL) to unlock actionable recommendations.';
			empty.body.append(copy);
			section.body.append(empty.node);
		} else {
			section.body.append(listNode);
			// Select-and-send surface (Phase 4) on the live report itself.
			if (recommendations.some(item => item.id !== undefined)) {
				section.body.append(renderSelectionControls(recommendations.filter(item => item.id !== undefined), selections));
				const status = renderHandoffStatus();
				if (status) section.body.append(status);
			}
		}
		return section.node;
	}

	function renderFounderQuickWins(report) {
		const items = resolveFounderQuickWins(report);
		const section = founderSection('What to do first', 'Low-friction moves selected from the ordered recommendations.');
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
				exportError(error);
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
				exportError(error);
			}
		};

		const pdf = doc.createElement('button');
		pdf.className = 'btn btn-primary btn-sm';
		pdf.type = 'button';
		pdf.textContent = 'Download PDF';
		pdf.onclick = async () => {
			try { await downloadReportPdf('qase-founder-review.pdf'); }
			catch (error) { exportError(error); }
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
			renderFounderObservations(observations.productFindings, 'What to improve', 'Product and experience issues observed directly on the reviewed surface.'),
			renderFounderPriorities(report),
			renderFounderQuickWins(report),
			renderFounderIcpPositioning(report),
			renderFounderSales(report),
			renderFounderMarketing(report),
			renderFounderMonetization(report),
			renderFounderRoadmap(report),
			renderFounderRisks(report),
			renderFounderMetrics(report),
			renderFounderBoundary(report)
		);
	}

	/** Saved project state card: restored recommendations with selection UI. */
	function renderSavedProjectState(saved) {
		const section = founderSection('Saved from a previous review',
			`Last saved ${saved.updatedAt ?? 'earlier'} · recommendation set v${saved.recommendationSet.setVersion ?? 1} · ${saved.recommendationSet.recommendations.length} recommendations restored for this project.`);
		const listNode = doc.createElement('div');
		listNode.className = 'founder-priority-list';
		const selections = new Set(saved.selections ?? []);
		for (const [index, item] of saved.recommendationSet.recommendations.entries()) {
			const row = doc.createElement('article');
			row.className = 'founder-priority founder-selectable';
			const label = doc.createElement('label');
			label.className = 'founder-select';
			const box = doc.createElement('input');
			box.type = 'checkbox';
			box.checked = selections.has(item.id);
			box.dataset.recommendationId = item.id;
			box.onchange = () => onToggleSelection?.(item.id, box.checked);
			const title = doc.createElement('span');
			title.textContent = `${index + 1}. ${item.title ?? item.id}`;
			label.append(box, title);
			row.append(label);
			listNode.append(row);
		}
		section.body.append(listNode);
		section.body.append(renderSelectionControls(saved.recommendationSet.recommendations, selections));
		const status = renderHandoffStatus();
		if (status) section.body.append(status);
		return section.node;
	}

	/** Selection controls shared by restored and live reports (Phase 4 base). */
	function renderSelectionControls(recommendations, selections) {
		const bar = doc.createElement('div');
		bar.className = 'founder-selection-bar';
		const all = doc.createElement('button');
		all.type = 'button';
		all.className = 'btn-secondary';
		all.textContent = 'Select all';
		all.onclick = () => onSelectAll?.(recommendations.map(item => item.id));
		const clear = doc.createElement('button');
		clear.type = 'button';
		clear.className = 'btn-secondary';
		clear.textContent = 'Clear selection';
		clear.onclick = () => onClearSelection?.();
		const count = doc.createElement('span');
		count.className = 'founder-selection-count';
		count.textContent = `${selections.size} of ${recommendations.length} selected`;
		count.dataset.role = 'selection-count';
		const send = doc.createElement('button');
		send.type = 'button';
		send.className = 'btn-primary';
		send.textContent = 'Send to Studio';
		send.dataset.role = 'send-to-studio';
		// Nothing selected or a handoff already in flight → send is disabled.
		// Selection alone never triggers a delivery; only this button does.
		const pending = handoff?.status === 'pending';
		send.disabled = selections.size === 0 || pending;
		send.title = pending ? 'A handoff is already in progress.'
			: selections.size === 0 ? 'Select at least one recommendation.'
				: 'Send the selected recommendations to Studio.';
		send.onclick = () => onSendToStudio?.([...selections]);
		bar.append(all, clear, count, send);
		return bar;
	}

	/** Handoff status line: honest pending / succeeded / failed / unavailable. */
	function renderHandoffStatus() {
		if (!handoff) return undefined;
		const node = doc.createElement('p');
		node.className = `founder-handoff-status founder-handoff-${handoff.status}`;
		node.dataset.role = 'handoff-status';
		if (handoff.status === 'pending') {
			node.textContent = 'Sending to Studio… your selections are locked while the handoff is in progress.';
		} else if (handoff.status === 'succeeded') {
			const reference = handoff.reference ? ` Reference: ${handoff.reference}.` : '';
			node.textContent = `Sent to Studio ✓ ${handoff.selectedRecommendationIds?.length ?? 0} recommendation(s) delivered.${reference}`;
		} else if (handoff.status === 'failed') {
			node.textContent = handoff.message ?? 'The Studio handoff did not complete. Your selections were kept — try sending again.';
			const retry = doc.createElement('button');
			retry.type = 'button';
			retry.className = 'btn-secondary';
			retry.textContent = 'Retry';
			retry.onclick = () => onSendToStudio?.(handoff.selectedRecommendationIds ?? []);
			node.append(' ', retry);
		} else if (handoff.status === 'unavailable') {
			node.textContent = handoff.message ?? 'Drytis Studio delivery is not configured on this instance.';
			const copy = doc.createElement('button');
			copy.type = 'button';
			copy.className = 'btn-secondary';
			copy.textContent = 'Copy handoff payload';
			copy.dataset.role = 'copy-handoff-payload';
			copy.onclick = () => onExportHandoff?.('copy');
			const download = doc.createElement('button');
			download.type = 'button';
			download.className = 'btn-secondary';
			download.textContent = 'Download payload';
			download.onclick = () => onExportHandoff?.('download');
			node.append(' ', copy, ' ', download);
		}
		return node;
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
			// Project-level restore (Phase 3): a previously saved recommendation
			// set for this project is shown even when THIS run has not finalized,
			// so reopening Founder Mode restores the last good state.
			const saved = getProjectState?.();
			handoff = saved?.handoff;
			if (saved?.recommendationSet?.recommendations?.length) {
				elements.founderView.append(renderSavedProjectState(saved));
			}
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
		// Phase 4: the completed report carries its own selection controls;
		// sync handoff state from the saved project state each render.
		handoff = getProjectState?.()?.handoff;
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
		handoff = getProjectState?.()?.handoff;
	}

	return Object.freeze({ render, renderReportTab, setHandoff });
}
