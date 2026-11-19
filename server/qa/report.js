/**
 * Report building. The verdict is computed deterministically from the
 * promoted findings and the coverage the run achieved; models only help with
 * wording (summary) and sharper fix guidance, and both are optional.
 */
import { SEVERITIES, severityRank } from './findings.js';

export function verdictFor({ findings, loaded, coverageGaps }) {
	if (!loaded) return 'blocked';
	if (findings.some(item => ['critical', 'high'].includes(item.severity))) return 'fail';
	if (findings.length) return coverageGaps ? 'partial' : 'pass_with_issues';
	return coverageGaps ? 'partial' : 'pass';
}

export function bySeverity(findings) {
	return Object.fromEntries(SEVERITIES.map(severity => [severity, findings.filter(item => item.severity === severity).length]));
}

function deterministicSummary({ target, findings, coverage, verdict }) {
	const counts = bySeverity(findings);
	const parts = SEVERITIES.filter(severity => counts[severity]).map(severity => `${counts[severity]} ${severity}`);
	const top = findings.slice(0, 3).map(item => item.title).join('; ');
	const scope = `${coverage.pages} page${coverage.pages === 1 ? '' : 's'} across ${coverage.viewports.length} viewport${coverage.viewports.length === 1 ? '' : 's'}, ${coverage.interactions} interactive controls, ${coverage.forms} forms and ${coverage.securityChecks} security checks`;
	if (verdict === 'blocked') return `QASE could not load ${target}, so no testing was possible. See the limitations for the exact error.`;
	if (!findings.length) return `QASE tested ${scope} on ${target} and found no defects that passed verification.`;
	return `QASE tested ${scope} on ${target} and confirmed ${findings.length} defect${findings.length === 1 ? '' : 's'} (${parts.join(', ')}). Most important: ${top}.`;
}

/** Optional: let the reasoner write the summary and sharpen fix guidance. */
export async function refineWithReasoner({ models, target, findings, coverage, signal }) {
	if (!models.reasonerAvailable() || !findings.length) return {};
	const list = findings.slice(0, 30).map((item, index) => `${index}. [${item.severity}] ${item.title} — ${item.actual.slice(0, 300)}${item.selector ? ` (element ${item.selector})` : ''}${item.fix ? `\n   Current guidance: ${item.fix.slice(0, 300)}` : ''}`).join('\n');
	const result = await models.json([
		{ role: 'system', content: 'You write the conclusion of a website QA report and precise fix guidance for developers. Answer JSON only: {"summary":"3-5 sentence executive summary for a product owner","recommendations":["top priorities, most important first, max 6"],"fixes":[{"index":0,"fix":"specific, actionable fix guidance (2-5 sentences): likely root cause, what to change, how to verify"}]}' },
		{ role: 'user', content: `Site: ${target}\nCoverage: ${JSON.stringify(coverage)}\nConfirmed findings:\n${list}` }
	], { maxTokens: 4000, signal, purpose: 'report' });
	if (!result || typeof result !== 'object') return {};
	const fixes = new Map((Array.isArray(result.fixes) ? result.fixes : []).filter(item => Number.isInteger(item?.index) && typeof item.fix === 'string').map(item => [item.index, item.fix.slice(0, 2500)]));
	return {
		summary: typeof result.summary === 'string' ? result.summary.slice(0, 3000) : undefined,
		recommendations: Array.isArray(result.recommendations) ? result.recommendations.filter(item => typeof item === 'string').slice(0, 6).map(item => item.slice(0, 500)) : undefined,
		fixes
	};
}

export function buildReport({ session, findings, dismissed, coverage, limitations, models, triageStats, loaded, refined = {}, runtime }) {
	const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	const coverageGaps = limitations.some(item => item.affectsCoverage);
	const verdict = verdictFor({ findings: sorted, loaded, coverageGaps });
	const covered = [
		`${coverage.pages} page${coverage.pages === 1 ? '' : 's'} crawled and audited (${coverage.viewports.join(', ')})`,
		'Layout: overlapping text, obscured controls, clipped text, horizontal overflow, broken/distorted images',
		`Interactions and animation: ${coverage.interactions} toggles, menus, dialogs and accordions${coverage.hoverMenus ? `, ${coverage.hoverMenus} hover submenus` : ''}; reduced-motion behaviour`,
		`Forms: ${coverage.forms} form${coverage.forms === 1 ? '' : 's'} (empty and malformed input, never submitted)`,
		'Accessibility: names, labels, contrast, language, zoom, touch targets, focus and Escape handling',
		'Console errors, failed requests, broken links, performance (LCP, CLS, long tasks, page weight)',
		`Security (non-destructive): headers, cookies, CORS, exposed files, XSS/redirect/SQL-error probes on ${coverage.injectionUrls} URL${coverage.injectionUrls === 1 ? '' : 's'}, client-side secrets, vulnerable libraries`,
		coverage.exploration ? `AI exploratory testing: ${coverage.exploration} steps${coverage.explorationSummary ? ` — ${coverage.explorationSummary.slice(0, 300)}` : ''}` : '',
		coverage.visualReviews ? `AI visual review of ${coverage.visualReviews} screenshot/animation sets` : ''
	].filter(Boolean);
	return {
		ts: Date.now(),
		verdict,
		summary: refined.summary || deterministicSummary({ target: session.targetUrl, findings: sorted, coverage, verdict }),
		covered,
		notCovered: limitations.map(item => item.message),
		recommendations: refined.recommendations?.length ? refined.recommendations : sorted.slice(0, 6).map(item => `[${item.severity}] ${item.title}`),
		targetUrl: session.targetUrl,
		findings: sorted.length,
		bySeverity: bySeverity(sorted),
		runtimeIdentity: runtime,
		qaEngine: {
			version: 2,
			coverage,
			models: {
				reasoner: { model: models.state.reasoner.model, used: models.state.reasoner.calls > 0, calls: models.state.reasoner.calls, failures: models.state.reasoner.failures, tokens: models.state.reasoner.inputTokens + models.state.reasoner.outputTokens, enabled: models.state.reasoner.enabled, lastError: models.state.reasoner.lastError },
				jev: { model: models.state.jev.model, used: models.state.jev.calls > 0, calls: models.state.jev.calls, failures: models.state.jev.failures, tokens: models.state.jev.inputTokens + models.state.jev.outputTokens, enabled: models.state.jev.enabled, lastError: models.state.jev.lastError }
			},
			triage: triageStats,
			dismissed: dismissed.slice(0, 40).map(item => ({ title: item.title, category: item.category, severity: item.severity, url: item.url, score: item.score, source: item.source, reason: item.verification?.reason }))
		}
	};
}
