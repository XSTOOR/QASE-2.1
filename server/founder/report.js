/**
 * The Founder report, computed by the host from the recorded review.
 *
 * Scores: each business lens is scored by the agent (with cited evidence) or,
 * without a model, from the measured signals. Readiness (0–100) is the
 * weighted average of the scored lenses. Recommendations are ordered by
 * priority, then impact, then effort (quick wins first), get stable ids
 * (R1, R2…) and carry the fields the Drytis Studio handoff reads.
 */
import { LENSES, SIGNAL_KINDS, heuristicLensScore, lensName, verdictFor } from './catalog.js';

export const DISCLAIMER = 'An automated product review of the publicly observable product from a business perspective. Scores and recommendations are informed judgement, not market research or a guarantee of results; validate the biggest bets with real users.';
const ORDER = { priority: ['now', 'next', 'later'], impact: ['high', 'medium', 'low'], effort: ['small', 'medium', 'large'] };
const rank = item => ORDER.priority.indexOf(item.priority) * 100 + ORDER.impact.indexOf(item.impact) * 10 + ORDER.effort.indexOf(item.effort);
const HEAVY = new Set(['value_prop', 'conversion', 'onboarding', 'trust']);

/** Lens scores: the agent's, or measured. */
export function lensScores(state) {
	return LENSES.map(lens => {
		const scored = state.lenses?.[lens.id];
		const measured = heuristicLensScore(lens.id, state.signals ?? []);
		const score = scored?.score ?? measured;
		const signals = (state.signals ?? []).filter(signal => SIGNAL_KINDS[signal.kind]?.lens === lens.id);
		return {
			id: lens.id, name: lens.name, weight: lens.weight, question: lens.question,
			score: score === undefined ? null : score, scoredBy: scored ? 'agent' : measured !== undefined ? 'measured' : undefined,
			verdict: scored?.verdict ?? (measured === undefined ? 'Not assessed.' : `${signals.filter(item => item.status === 'good').length} of ${signals.filter(item => ['good', 'weak', 'missing'].includes(item.status)).length} measured signals are good.`),
			strengths: scored?.strengths ?? signals.filter(item => item.status === 'good').map(item => item.title),
			weaknesses: scored?.weaknesses ?? signals.filter(item => ['weak', 'missing'].includes(item.status)).map(item => `${item.title}: ${item.detail}`),
			evidence: scored?.evidence ?? signals.map(item => item.id)
		};
	});
}

export function readinessScore(lenses) {
	const scored = lenses.filter(lens => lens.score !== null);
	if (!scored.length) return null;
	const weight = scored.reduce((sum, lens) => sum + lens.weight, 0);
	return Math.round(scored.reduce((sum, lens) => sum + lens.score * lens.weight, 0) / weight * 10);
}

/** Recommendations written by the host from weak or missing signals (no model, or to fill gaps). */
export function fallbackRecommendations(state) {
	const covered = new Set((state.recommendations ?? []).flatMap(item => item.evidence ?? []));
	return (state.signals ?? []).filter(signal => ['weak', 'missing'].includes(signal.status) && !covered.has(signal.id)).map(signal => {
		const kind = SIGNAL_KINDS[signal.kind];
		const heavy = HEAVY.has(kind.lens);
		return {
			title: `${signal.status === 'missing' ? 'Fix' : 'Improve'}: ${kind.title.charAt(0).toLowerCase()}${kind.title.slice(1)}`,
			lens: kind.lens, kind: 'do', priority: signal.status === 'missing' && heavy ? 'now' : signal.status === 'missing' || heavy ? 'next' : 'later',
			impact: heavy ? 'high' : signal.status === 'missing' ? 'medium' : 'low', effort: /performance|mobile/.test(kind.lens) ? 'medium' : 'small',
			why: `Measured: ${signal.detail}`, how: [kind.fix], metric: '', acceptance: [`${kind.title}: rated good on the next review.`], evidence: [signal.id], source: 'measured'
		};
	});
}

/** Final, ordered recommendations with ids and Studio-handoff fields. */
export function orderedRecommendations(state) {
	const items = [...(state.recommendations ?? []), ...(state.recommendations?.length ? [] : fallbackRecommendations(state))];
	return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }, index) => ({
		id: `R${index + 1}`, ...item, lensName: lensName(item.lens),
		// Fields read by the Drytis Studio handoff (founderHandoff.js).
		priorityReason: `${item.priority === 'now' ? 'Do now' : item.priority === 'next' ? 'Do next' : 'Later'}: ${item.impact} impact, ${item.effort} effort.`,
		proposedFeature: item.how?.[0], opportunity: lensName(item.lens), whyItMatters: item.why, intendedOutcome: item.metric || undefined,
		actions: item.how, acceptanceCriteria: item.acceptance?.length ? item.acceptance : undefined, evidenceObservationIds: item.evidence
	}));
}

export function buildFounderReport(session) {
	const state = session.founder;
	const lenses = lensScores(state);
	const readiness = readinessScore(lenses);
	const verdict = verdictFor(readiness);
	const recommendations = orderedRecommendations(state);
	const journeys = state.journeys ?? [];
	const weakest = lenses.filter(lens => lens.score !== null).sort((a, b) => a.score - b.score).slice(0, 3);
	const ts = Date.now();
	const summary = state.summary ?? [
		`${state.business?.name ?? 'The product'} scores ${readiness ?? '—'}/100 for readiness: ${verdict.label.toLowerCase()}.`,
		weakest.length ? `The weakest areas are ${weakest.map(lens => `${lens.name.toLowerCase()} (${lens.score}/10)`).join(', ')}.` : '',
		recommendations.filter(item => item.priority === 'now').length ? `${recommendations.filter(item => item.priority === 'now').length} changes should be made now, before spending on acquisition.` : ''
	].filter(Boolean).join(' ');
	return {
		ts, engine: 'qase-founder', readiness, verdict: verdict.id, verdictLabel: verdict.label, verdictLine: verdict.line, summary,
		positioning: state.positioning, headlineOptions: state.headlineOptions ?? [],
		lenses, recommendations, keep: state.keep ?? [],
		priorities: recommendations.filter(item => item.priority === 'now').slice(0, 5).map(item => item.title),
		journeys: journeys.map(item => ({ id: item.id, name: item.name, outcome: item.outcome, friction: item.friction.length, summary: item.summary })),
		competitors: (state.market?.competitors ?? []).map(item => ({ id: item.id, name: item.name, url: item.url })),
		counts: { recommendations: recommendations.length, now: recommendations.filter(item => item.priority === 'now').length, avoid: recommendations.filter(item => item.kind === 'avoid').length, journeys: journeys.length, blocked: journeys.filter(item => item.outcome === 'blocked').length },
		notCovered: (state.limitations ?? []).map(item => item.message),
		recommendationSet: { setVersion: 1, generatedAt: new Date(ts).toISOString() },
		disclaimer: DISCLAIMER
	};
}

const SEVERITY = { high: 'high', medium: 'medium', low: 'low' };

/** "Do now" recommendations become findings, so the Findings tab and fix prompts work. */
export function founderFindings(session, report = session.founder.report) {
	const state = session.founder;
	return report.recommendations.filter(item => item.priority === 'now').map(item => {
		const evidence = (item.evidence ?? []).map(id => state.signals?.find(entry => entry.id === id) ?? state.journeys?.find(entry => entry.id === id) ?? state.market?.competitors?.find(entry => entry.id === id)).filter(Boolean);
		return {
			title: `${item.kind === 'avoid' ? 'Avoid' : 'Do now'}: ${item.title}`.slice(0, 240), severity: SEVERITY[item.impact] ?? 'medium', category: 'business',
			url: evidence.flatMap(entry => entry.urls ?? (entry.url ? [entry.url] : [])).find(url => String(url).startsWith(String(session.targetUrl).split('/').slice(0, 3).join('/'))) ?? session.targetUrl,
			steps: item.how, expected: item.acceptance?.join('; ') || item.metric || 'Done as described.', actual: item.why,
			evidence: evidence.map(entry => `${entry.id} ${entry.title ?? entry.name}: ${entry.detail ?? entry.summary ?? entry.positioning ?? ''}`).join('\n'),
			fix: item.how.join(' '), artifactId: evidence.find(entry => entry.artifactId)?.artifactId, recommendationId: item.id
		};
	});
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const LABEL = { now: 'Now', next: 'Next', later: 'Later' };

export function buildFounderMarkdown(session) {
	const state = session.founder;
	const report = state.report ?? buildFounderReport(session);
	const business = state.business;
	const lines = [`# Founder review — ${business?.name ?? session.targetUrl}`, '', `- **Product:** ${session.targetUrl}`, `- **Readiness:** ${report.readiness ?? '—'}/100 · ${report.verdictLabel}`, `- **Reviewed:** ${new Date(report.ts).toISOString().slice(0, 10)}`, ''];
	lines.push('## Summary', '', report.summary, '');
	if (report.positioning) lines.push(`**Suggested positioning:** ${report.positioning}`, '');
	if (report.headlineOptions?.length) lines.push('**Headline options:**', ...report.headlineOptions.map(item => `- ${item}`), '');
	if (report.priorities.length) lines.push('### Do now', '', ...report.priorities.map((item, index) => `${index + 1}. ${item}`), '');
	if (business) lines.push('## The business', '', `- **What it is:** ${business.oneLiner}`, `- **Promise to visitors:** ${business.valueProposition || '—'}`, `- **Target customer:** ${business.targetCustomer.stated || 'not stated'}${business.targetCustomer.inferred ? ` (realistically: ${business.targetCustomer.inferred})` : ''}`, `- **Business model:** ${business.businessModel.replace(/_/g, ' ')} · **Main goal:** ${business.primaryGoal.replace(/_/g, ' ')} · **Stage:** ${business.stage.replace(/_/g, ' ')}`, '');
	if (state.brief?.goals || state.brief?.audience) lines.push('_Owner brief:_ ' + [state.brief.goals, state.brief.audience ? `Customers: ${state.brief.audience}` : ''].filter(Boolean).join(' — '), '');
	lines.push('## Scorecard', '', '| Area | Score | Verdict |', '| --- | --- | --- |', ...report.lenses.map(lens => `| ${cell(lens.name)} | ${lens.score === null ? '—' : `${lens.score}/10`} | ${cell(lens.verdict)} |`), '');
	lines.push('## Recommendations', '');
	for (const item of report.recommendations) {
		lines.push(`### ${item.id} · ${item.kind === 'avoid' ? 'Avoid — ' : ''}${item.title}`, '', `- **When:** ${LABEL[item.priority]} · **Impact:** ${item.impact} · **Effort:** ${item.effort} · **Area:** ${item.lensName}`, `- **Why:** ${item.why}`, ...item.how.map(step => `  - ${step}`), ...(item.metric ? [`- **Metric to watch:** ${item.metric}`] : []), ...(item.acceptance?.length ? [`- **Done when:** ${item.acceptance.join('; ')}`] : []), ...(item.evidence?.length ? [`- **Evidence:** ${item.evidence.join(', ')}`] : []), '');
	}
	if (report.keep.length) lines.push('## Keep doing', '', ...report.keep.map(item => `- **${item.title}** — ${item.why}`), '');
	if (state.journeys?.length) {
		lines.push('## Journeys walked', '');
		for (const journey of state.journeys) lines.push(`### ${journey.id} · ${journey.name} — ${journey.outcome.replace(/_/g, ' ')}`, '', journey.summary, '', ...journey.friction.map(item => `- **${item.severity}** ${item.issue}${item.impact ? ` — ${item.impact}` : ''}`), ...(journey.delights.length ? ['', `_Worked well:_ ${journey.delights.join('; ')}`] : []), '');
	}
	if (state.market) {
		lines.push('## Market', '');
		if (state.market.competitors.length) lines.push('| Competitor | Positioning | Pricing |', '| --- | --- | --- |', ...state.market.competitors.map(item => `| [${cell(item.name)}](${item.url}) | ${cell(item.positioning)} | ${cell(item.pricing) || '—'} |`), '');
		if (state.market.expectations.length) lines.push('**What users expect in this category:**', ...state.market.expectations.map(item => `- ${item}`), '');
		if (state.market.differentiation.length) lines.push('**Ways to stand out:**', ...state.market.differentiation.map(item => `- ${item}`), '');
	}
	lines.push('## Measured signals', '', '| ID | Signal | Result | Detail |', '| --- | --- | --- | --- |', ...(state.signals ?? []).map(item => `| ${item.id} | ${cell(item.title)} | ${item.status} | ${cell(item.detail).slice(0, 300)} |`));
	if (report.notCovered?.length) lines.push('', '## Not covered', '', ...report.notCovered.map(item => `- ${item}`));
	if (state.sources?.length) lines.push('', '## Sources consulted', '', ...state.sources.slice(0, 30).map(item => `- [${cell(item.title || item.url)}](${item.url})`));
	lines.push('', '---', '', `_${report.disclaimer}_`, '');
	return lines.join('\n');
}

export function buildFounderHtml(session) {
	const state = session.founder;
	const report = state.report ?? buildFounderReport(session);
	const business = state.business;
	return `<h1>Founder review — ${escape(business?.name ?? session.targetUrl)}</h1>
<table class="meta"><tbody><tr><th>Product</th><td>${escape(session.targetUrl)}</td></tr><tr><th>Readiness</th><td><strong>${report.readiness ?? '—'}/100 · ${escape(report.verdictLabel)}</strong></td></tr>
${business ? `<tr><th>What it is</th><td>${escape(business.oneLiner)}</td></tr><tr><th>Target customer</th><td>${escape(business.targetCustomer.stated || business.targetCustomer.inferred || 'not stated')}</td></tr>` : ''}</tbody></table>
<h2>Summary</h2><p>${escape(report.summary)}</p>${report.positioning ? `<p><strong>Suggested positioning:</strong> ${escape(report.positioning)}</p>` : ''}
${report.priorities.length ? `<h3>Do now</h3><ol>${report.priorities.map(item => `<li>${escape(item)}</li>`).join('')}</ol>` : ''}
<h2>Scorecard</h2><table class="meta"><tbody>${report.lenses.map(lens => `<tr><td>${escape(lens.name)}</td><td>${lens.score === null ? '—' : `${lens.score}/10`}</td><td>${escape(lens.verdict)}</td></tr>`).join('')}</tbody></table>
<h2>Recommendations</h2>${report.recommendations.map(item => `<h3>${escape(item.id)} · ${item.kind === 'avoid' ? 'Avoid — ' : ''}${escape(item.title)}</h3><p><strong>${escape(LABEL[item.priority])}</strong> · ${escape(item.impact)} impact · ${escape(item.effort)} effort · ${escape(item.lensName)}</p><p>${escape(item.why)}</p><ul>${item.how.map(step => `<li>${escape(step)}</li>`).join('')}</ul>${item.metric ? `<p class="muted">Metric: ${escape(item.metric)}</p>` : ''}`).join('')}
${report.keep.length ? `<h2>Keep doing</h2><ul>${report.keep.map(item => `<li><strong>${escape(item.title)}</strong> — ${escape(item.why)}</li>`).join('')}</ul>` : ''}
${state.journeys?.length ? `<h2>Journeys walked</h2>${state.journeys.map(journey => `<h3>${escape(journey.id)} · ${escape(journey.name)} — ${escape(journey.outcome.replace(/_/g, ' '))}</h3><p>${escape(journey.summary)}</p>${journey.friction.length ? `<ul>${journey.friction.map(item => `<li><strong>${escape(item.severity)}</strong> ${escape(item.issue)}</li>`).join('')}</ul>` : ''}`).join('')}` : ''}
${state.market?.competitors?.length ? `<h2>Competitors</h2><table class="meta"><tbody>${state.market.competitors.map(item => `<tr><td>${escape(item.name)}</td><td>${escape(item.positioning)}</td><td>${escape(item.pricing || '—')}</td></tr>`).join('')}</tbody></table>` : ''}
${report.notCovered?.length ? `<h2>Not covered</h2><ul>${report.notCovered.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}
<p class="muted">${escape(report.disclaimer)}</p>`;
}
