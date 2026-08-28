import { chromium } from 'playwright';
import { buildFindingFixPrompt } from './fixPromptBuilder.js';
import { getDeviceProfile } from './deviceProfiles.js';

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

function headerBlock(session, title, verdictText) {
	const created = new Date(session.createdAt).toISOString();
	const finished = session.updatedAt ? new Date(session.updatedAt).toISOString() : '\u2014';
	const rows = [
		['Run ID', session.id],
		['Target', session.targetUrl ?? '\u2014'],
		['Device', deviceLine(session)],
		['Started', created],
		['Updated', finished]
	];
	if (verdictText) rows.push(['Verdict', verdictText]);
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
	return parts.join('');
}

function buildSqaBody(session) {
	const sqa = session.sqa ?? {};
	const assessment = sqa.assessment ?? {};
	const verdict = assessment.verdict ?? sqa.verdict ?? '\u2014';
	const parts = ['<h1>SQA assessment</h1>', headerBlock(session, 'SQA', String(verdict).toUpperCase())];
	parts.push('<section class="outcome"><h2>Assessment outcome</h2>'
		+ '<div class="outcome-line">' + statusPill(verdict)
		+ '<strong>Residual risk: ' + escapeHtml(statusLabel(assessment.risk?.level)) + '</strong></div>'
		+ metricGrid([
			['Applicable controls', assessment.summary?.applicableControls ?? 0],
			['Pass', assessment.summary?.pass ?? 0],
			['Fail', assessment.summary?.fail ?? 0],
			['Blocked', assessment.summary?.blocked ?? 0],
			['Not assessed', assessment.summary?.not_assessed ?? 0],
			['Risk score', assessment.risk?.score === undefined ? 'not recorded' : assessment.risk.score + '%']
		])
		+ (assessment.risk?.method ? '<p class="muted">' + escapeHtml(assessment.risk.method) + '</p>' : '')
		+ '</section>');
	if (sqa.scope || assessment.target) {
		const scope = sqa.scope ?? {};
		const target = assessment.target ?? scope.target ?? {};
		const meta = [
			['Assessment ID', assessment.assessmentId],
			['Assessment digest', assessment.assessmentSha256 ? 'sha256:' + assessment.assessmentSha256 : undefined],
			['Assessment target', target.name],
			['Release', target.release],
			['Environment', target.environment],
			['Assessed at', assessment.assessedAt],
			['Profiles', (assessment.profiles ?? scope.profiles ?? []).join(', ')],
			['Attributes', (assessment.attributes ?? scope.attributes ?? []).join(', ') || 'none'],
			['Catalog version', assessment.catalogVersion ?? scope.catalogVersion]
		].filter(([, value]) => value).map(([k, v]) => '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>');
		parts.push('<section><h2>Scope</h2><table class="meta"><tbody>' + meta.join('') + '</tbody></table>'
			+ ((assessment.scopeNotes ?? scope.scopeNotes) ? '<h3>Scope notes</h3>' + paragraphs(assessment.scopeNotes ?? scope.scopeNotes) : '')
			+ '</section>');
	}
	if (assessment.coverage) {
		parts.push('<section><h2>Coverage & evidence completeness</h2>'
			+ metricGrid([
				['Observed', (assessment.coverage.observed ?? 0) + '%'],
				['Conclusive', (assessment.coverage.conclusive ?? 0) + '%'],
				['Mandatory passed', (assessment.coverage.mandatoryPassed ?? 0) + '%'],
				['Evidence satisfied', (assessment.coverage.evidence ?? 0) + '%']
			])
			+ '<p class="muted">Evidence artifacts satisfied: '
			+ escapeHtml(assessment.coverage.satisfiedEvidence ?? 0) + ' / '
			+ escapeHtml(assessment.coverage.requiredEvidence ?? 0) + ' required.</p></section>');
	}
	if (assessment.technicalSummary) {
		const technical = assessment.technicalSummary;
		parts.push('<section><h2>Bounded technical smoke sample</h2>'
			+ '<div class="outcome-line">' + statusPill(technical.verdict) + '</div>'
			+ metricGrid([
				['Applicable controls', technical.applicableControls ?? 0],
				['Pass', technical.pass ?? 0],
				['Fail', technical.fail ?? 0],
				['Blocked', technical.blocked ?? 0],
				['Not assessed', technical.not_assessed ?? 0]
			])
			+ '<p class="callout">This sampled browser result does not establish whole-product compliance and does not override the broad assurance verdict.</p></section>');
	}
	if (values(assessment.gates).length > 0) {
		parts.push('<section><h2>Decision gates</h2><div class="card-list">'
			+ assessment.gates.map(gate => '<article class="report-card compact"><div class="card-heading">'
				+ statusPill(gate.status) + '<h3>' + escapeHtml(gate.title) + '</h3></div>'
				+ '<p>' + escapeHtml(gate.detail ?? '') + '</p></article>').join('')
			+ '</div></section>');
	}
	if (Array.isArray(assessment.results) && assessment.results.length > 0) {
		const ordered = ['fail', 'blocked', 'not_assessed', 'pass'];
		const rows = [...assessment.results]
			.sort((a, b) => ordered.indexOf(a.status) - ordered.indexOf(b.status)
				|| String(a.controlId).localeCompare(String(b.controlId)))
			.map(result => '<tr><td><strong>' + escapeHtml(result.controlId) + '</strong><br><span class="muted">'
				+ escapeHtml(result.title ?? '') + '</span></td><td>' + escapeHtml(result.domain ?? '\u2014')
				+ '</td><td>' + escapeHtml(result.severity ?? '\u2014') + '</td><td>' + statusPill(result.status)
				+ '</td><td>' + escapeHtml(result.evidenceCoverage?.satisfied ?? 0) + '/'
				+ escapeHtml(result.evidenceCoverage?.required ?? 0) + '</td></tr>').join('');
		parts.push('<section><h2>Control results</h2><table class="result-table"><thead><tr>'
			+ '<th>Control</th><th>Domain</th><th>Severity</th><th>Status</th><th>Evidence</th>'
			+ '</tr></thead><tbody>' + rows + '</tbody></table></section>');

		const unresolved = assessment.results.filter(result => result.status !== 'pass');
		if (unresolved.length > 0) {
			parts.push('<section><h2>Unresolved controls</h2><div class="card-list">'
				+ unresolved.map(result => {
					const requirements = values(result.evidenceCoverage?.requirements);
					const evidence = values(result.evidence);
					return '<article class="report-card"><div class="card-heading">' + statusPill(result.status)
						+ '<h3>' + escapeHtml(result.controlId) + ' \u2014 ' + escapeHtml(result.title ?? '') + '</h3></div>'
						+ '<p><strong>Severity:</strong> ' + escapeHtml(result.severity ?? 'not recorded')
						+ ' \u00b7 <strong>Automation:</strong> ' + escapeHtml(statusLabel(result.automationLevel)) + '</p>'
						+ (result.rationale ? '<h4>Rationale</h4>' + paragraphs(result.rationale) : '')
						+ titledList('Decision notes', result.decisionNotes)
						+ (requirements.length > 0 ? '<h4>Evidence contract</h4><ul>' + requirements.map(requirement =>
							'<li>' + (requirement.satisfied ? '<strong>Met:</strong> ' : '<strong>Missing:</strong> ')
							+ escapeHtml(requirement.description ?? requirement.id ?? requirement.type)
							+ ' <span class="muted">(' + escapeHtml(requirement.actual ?? 0) + '/'
							+ escapeHtml(requirement.minimum ?? 0) + ' ' + escapeHtml(requirement.type ?? '') + ')</span></li>'
						).join('') + '</ul>' : '')
						+ (evidence.length > 0 ? '<h4>Referenced evidence</h4><ul>' + evidence.map(item =>
							'<li><strong>' + escapeHtml(statusLabel(item.type)) + ':</strong> '
							+ escapeHtml(item.summary ?? 'Evidence artifact') + '<br><span class="code">'
							+ escapeHtml(item.reference) + '</span>'
							+ (item.digest ? '<br><span class="muted">' + escapeHtml(item.digest) + '</span>' : '') + '</li>'
						).join('') + '</ul>' : '<p class="muted">No evidence artifact was attached.</p>')
						+ '</article>';
				}).join('') + '</div></section>');
		}
	}
	if (values(assessment.frameworkCoverage).length > 0) {
		parts.push('<section><h2>Framework crosswalk</h2><table class="result-table"><thead><tr>'
			+ '<th>Reference</th><th>Mapped controls</th><th>Status</th><th>Conclusive</th></tr></thead><tbody>'
			+ assessment.frameworkCoverage.map(item => '<tr><td><strong>' + escapeHtml(item.title) + '</strong><br><span class="code">'
				+ escapeHtml(item.url) + '</span></td><td>' + escapeHtml(item.controls) + '</td><td>'
				+ statusPill(item.status) + '</td><td>' + escapeHtml(item.coverage) + '%</td></tr>').join('')
			+ '</tbody></table></section>');
	}
	if (values(assessment.outOfScope).length > 0) {
		parts.push('<section><h2>Not applicable in the declared scope</h2><ul>'
			+ assessment.outOfScope.map(item => '<li><strong>' + escapeHtml(item.controlId)
				+ ':</strong> ' + escapeHtml(item.reason) + '</li>').join('') + '</ul></section>');
	}
	parts.push(findingsSection(session.findings ?? [], session));
	if (assessment.disclaimer) {
		parts.push('<section class="boundary"><h2>Assessment boundary</h2>' + paragraphs(assessment.disclaimer) + '</section>');
	}
	return parts.join('');
}

function buildFounderBody(session) {
	const founder = session.founder ?? {};
	const scope = founder.scope ?? {};
	const report = founder.report ?? {};
	const parts = ['<h1>Founder review</h1>', headerBlock(session, 'Founder', 'Complete')];
	const ctx = scope.productContext ?? {};
	const target = report.target ?? scope.target ?? {};
	const ctxRows = [
		['Report schema', report.schemaVersion],
		['Generated at', report.generatedAt],
		['Product', target.name],
		['Target URL', target.url],
		['Release', target.release],
		['Environment', target.environment],
		['Stage', ctx.stage],
		['Business model', ctx.businessModel],
		['Target customer', ctx.targetCustomer],
		['Primary goal', ctx.primaryGoal],
		['Constraints', ctx.constraints],
		['Named alternatives', (ctx.competitors ?? []).join(', ')]
	].filter(([, value]) => value).map(([k, v]) => '<tr><th>' + escapeHtml(k) + '</th><td>' + escapeHtml(v) + '</td></tr>');
	if (ctxRows.length > 0) {
		parts.push('<section><h2>Context</h2><table class="meta"><tbody>' + ctxRows.join('') + '</tbody></table></section>');
	}
	if (report.executiveSummary) {
		parts.push('<section class="outcome"><h2>Executive summary</h2>' + paragraphs(report.executiveSummary) + '</section>');
	} else if (report.strategy) {
		// Compatibility for Founder reports finalized before the structured schema.
		parts.push('<section class="outcome"><h2>Executive summary</h2>' + paragraphs(report.strategy) + '</section>');
	}
	if (report.coverage || report.evidenceConfidence) {
		const coverage = report.coverage ?? {};
		const confidence = report.evidenceConfidence ?? {};
		parts.push('<section><h2>Evidence confidence</h2><div class="outcome-line">'
			+ statusPill(confidence.rating ?? 'not recorded') + '<strong>Browser-backed review evidence</strong></div>'
			+ metricGrid([
				['Areas reviewed', (coverage.categoriesReviewed?.length ?? 0) + '/' + (coverage.totalCategories ?? 0)],
				['Observations', coverage.evidenceBackedObservations ?? 0],
				['Browser activities', confidence.uniqueBrowserActivities ?? 0],
				['Explicit assumptions', confidence.assumptionCount ?? 0]
			])
			+ (confidence.limitation ? '<p class="callout">' + escapeHtml(confidence.limitation) + '</p>' : '')
			+ titledList('Reviewed areas', coverage.categoriesReviewed)
			+ '</section>');
	}
	if (Array.isArray(founder.observations) && founder.observations.length > 0) {
		const byCat = new Map();
		for (const obs of founder.observations) {
			if (!byCat.has(obs.category)) byCat.set(obs.category, []);
			byCat.get(obs.category).push(obs);
		}
		const cats = [...byCat.entries()].map(([category, items]) =>
			'<h3>' + escapeHtml(category) + '</h3><ul>'
			+ items.map(obs => '<li><strong>' + escapeHtml(obs.id) + '</strong> [' + escapeHtml(obs.type) + '] '
				+ escapeHtml(obs.title) + ((obs.summary ?? obs.detail) ? '<div>' + escapeHtml(obs.summary ?? obs.detail) + '</div>' : '')
				+ '<div class="muted">Confidence: ' + escapeHtml(obs.confidence ?? 'not recorded') + '</div>'
				+ (values(obs.evidence).length > 0 ? '<ul class="evidence-list">' + obs.evidence.map(item =>
					'<li>' + escapeHtml(item.summary ?? 'Browser evidence') + '<br><span class="code">'
					+ escapeHtml(item.reference) + '</span>'
					+ (item.digest ? '<br><span class="muted">' + escapeHtml(item.digest) + '</span>' : '') + '</li>'
				).join('') + '</ul>' : '')
			+ '</li>').join('')
			+ '</ul>').join('');
		parts.push('<section><h2>Observation evidence registry</h2>' + cats + '</section>');
	}
	if (report.icp) {
		parts.push('<section><h2>Ideal customer profile</h2><p><strong>Primary:</strong> '
			+ escapeHtml(report.icp.primary) + '</p>'
			+ titledList('Users', report.icp.users)
			+ titledList('Buyers', report.icp.buyers)
			+ titledList('Jobs to be done', report.icp.jobs)
			+ titledList('Pains', report.icp.pains)
			+ traceabilityBlock(report.icp) + '</section>');
	}
	if (report.positioning) {
		parts.push('<section><h2>Positioning</h2>'
			+ '<p><strong>Market category:</strong> ' + escapeHtml(report.positioning.category) + '</p>'
			+ '<p><strong>One-liner:</strong> ' + escapeHtml(report.positioning.oneLiner) + '</p>'
			+ '<p><strong>Value proposition:</strong> ' + escapeHtml(report.positioning.valueProposition) + '</p>'
			+ titledList('Differentiators', report.positioning.differentiators)
			+ titledList('Alternatives', report.positioning.alternatives)
			+ traceabilityBlock(report.positioning) + '</section>');
	}
	if (report.monetization) {
		parts.push('<section><h2>Monetization & pricing</h2>'
			+ '<p><strong>Model:</strong> ' + escapeHtml(report.monetization.model) + '</p>'
			+ '<p><strong>Value metric:</strong> ' + escapeHtml(report.monetization.valueMetric) + '</p>'
			+ '<p><strong>Pricing presentation:</strong> ' + escapeHtml(report.monetization.pricingPresentation) + '</p>'
			+ titledList('Packages', report.monetization.packages)
			+ titledList('Pricing tests', report.monetization.nextTests)
			+ traceabilityBlock(report.monetization) + '</section>');
	}
	if (Array.isArray(report.recommendations) && report.recommendations.length > 0) {
		parts.push('<section><h2>Prioritized recommendations</h2><div class="card-list">'
			+ report.recommendations.map((rec, index) => '<article class="report-card"><div class="card-heading"><span class="rank">'
				+ escapeHtml(index + 1) + '</span><h3>' + escapeHtml(rec.title ?? rec.recommendation ?? 'Recommendation') + '</h3></div>'
				+ '<p class="muted">' + escapeHtml(rec.category ?? 'uncategorized') + ' \u00b7 Impact '
				+ escapeHtml(rec.impact ?? 'not recorded') + ' \u00b7 Effort ' + escapeHtml(rec.effort ?? 'not recorded')
				+ ' \u00b7 Confidence ' + escapeHtml(rec.confidence ?? 'not recorded') + '</p>'
				+ paragraphs(rec.rationale ?? rec.detail ?? '')
				+ titledList('Actions', rec.actions)
				+ traceabilityBlock(rec) + '</article>').join('')
			+ '</div></section>');
	}
	if (values(report.quickWins).length > 0) {
		const byId = new Map(values(report.recommendations).map(item => [item.id, item]));
		parts.push('<section><h2>Quick wins</h2><ol>' + report.quickWins.map(id => {
			const item = byId.get(id);
			return '<li><strong>' + escapeHtml(item?.title ?? id) + '</strong>'
				+ (item?.actions?.length ? bulletList(item.actions) : '') + '</li>';
		}).join('') + '</ol></section>');
	}
	if (report.marketing) {
		parts.push('<section><h2>Marketing & growth</h2>'
			+ values(report.marketing.channels).map(item => '<article class="report-card compact"><h3>'
				+ escapeHtml(item.channel) + '</h3><p><strong>Rationale:</strong> ' + escapeHtml(item.rationale)
				+ '</p><p><strong>First test:</strong> ' + escapeHtml(item.firstTest) + '</p><p class="muted">Confidence: '
				+ escapeHtml(item.confidence) + '</p>' + traceabilityBlock(item) + '</article>').join('')
			+ titledList('Content angles', report.marketing.contentAngles)
			+ titledList('Launch motions', report.marketing.launchMotions)
			+ titledList('Growth loops', report.marketing.growthLoops)
			+ titledList('Marketing assumptions', report.marketing.assumptions)
			+ '</section>');
	}
	if (report.sales) {
		parts.push('<section><h2>Sales & go-to-market</h2><p><strong>Motion:</strong> '
			+ escapeHtml(report.sales.motion) + '</p>'
			+ titledList('Qualification questions', report.sales.qualificationQuestions)
			+ (values(report.sales.objectionResponses).length > 0 ? '<h3>Objection responses</h3><ul>'
				+ report.sales.objectionResponses.map(item => '<li><strong>' + escapeHtml(item.objection)
					+ ':</strong> ' + escapeHtml(item.response) + '</li>').join('') + '</ul>' : '')
			+ titledList('Sales assets', report.sales.salesAssets)
			+ traceabilityBlock(report.sales) + '</section>');
	}
	if (values(report.risks).length > 0) {
		parts.push('<section><h2>Key risks</h2><div class="card-list">' + report.risks.map(risk =>
			'<article class="report-card compact"><div class="card-heading">' + statusPill(risk.impact)
			+ '<h3>' + escapeHtml(risk.title) + '</h3></div><p class="muted">Likelihood: '
			+ escapeHtml(risk.likelihood) + ' \u00b7 Impact: ' + escapeHtml(risk.impact) + '</p><p><strong>Mitigation:</strong> '
			+ escapeHtml(risk.mitigation) + '</p>' + traceabilityBlock(risk) + '</article>'
		).join('') + '</div></section>');
	}
	if (report.plan) {
		parts.push('<section><h2>30 / 60 / 90-day plan</h2>'
			+ titledList('First 30 days', report.plan.days30)
			+ titledList('Days 31\u201360', report.plan.days60)
			+ titledList('Days 61\u201390', report.plan.days90)
			+ '</section>');
	}
	if (report.metrics) {
		const northStar = report.metrics.northStar ?? {};
		parts.push('<section><h2>Metrics & experiments</h2><article class="report-card"><h3>North-star metric: '
			+ escapeHtml(northStar.name ?? 'not recorded') + '</h3><p><strong>Definition:</strong> '
			+ escapeHtml(northStar.definition ?? '') + '</p><p><strong>Why:</strong> ' + escapeHtml(northStar.why ?? '')
			+ '</p>' + traceabilityBlock(northStar) + '</article>'
			+ (values(report.metrics.candidates).length > 0 ? '<h3>Metric candidates</h3><ul>'
				+ report.metrics.candidates.map(item => '<li><strong>' + escapeHtml(item.name) + ':</strong> '
					+ escapeHtml(item.definition) + traceabilityBlock(item) + '</li>').join('') + '</ul>' : '')
			+ (values(report.metrics.experiments).length > 0 ? '<h3>Experiments</h3><div class="card-list">'
				+ report.metrics.experiments.map((item, index) => '<article class="report-card compact"><h4>Experiment '
					+ escapeHtml(index + 1) + '</h4><p><strong>Hypothesis:</strong> ' + escapeHtml(item.hypothesis)
					+ '</p><p><strong>Change:</strong> ' + escapeHtml(item.change) + '</p><p><strong>Success metric:</strong> '
					+ escapeHtml(item.successMetric) + '</p><p><strong>Timebox:</strong> ' + escapeHtml(item.timebox)
					+ ' \u00b7 <strong>Guardrail:</strong> ' + escapeHtml(item.guardrail) + '</p>'
					+ traceabilityBlock(item) + '</article>').join('') + '</div>' : '')
			+ '</section>');
	}
	if (report.caveat) {
		parts.push('<section class="boundary"><h2>Important boundary</h2>' + paragraphs(report.caveat) + '</section>');
	}
	return parts.join('');
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
