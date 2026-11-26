/**
 * Report building. The verdict is computed deterministically from the
 * promoted findings and the coverage the run achieved; models only help with
 * wording (summary) and sharper fix guidance, and both are optional.
 */
import { SEVERITIES, severityRank } from './findings.js';
import { CAPABILITY_COUNT } from './capabilities.js';
import { plannedSaveGap } from './formOutcome.js';

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
export async function refineWithReasoner({ models, target, findings, coverage, limitations = [], signal }) {
	if (!models.reasonerAvailable() || !findings.length) return {};
	const list = findings.slice(0, 30).map((item, index) => `${index}. [${item.severity}] ${item.title} — ${item.actual.slice(0, 300)}${item.selector ? ` (element ${item.selector})` : ''}${item.fix ? `\n   Current guidance: ${item.fix.slice(0, 300)}` : ''}`).join('\n');
	const result = await models.json([
		{ role: 'system', content: 'You write the conclusion of a website QA report and precise fix guidance for developers. Only describe the confirmed findings listed; mention what could not be tested. Answer JSON only: {"summary":"3-5 sentence executive summary for a product owner","recommendations":["top priorities, most important first, max 6"],"fixes":[{"index":0,"fix":"specific, actionable fix guidance (2-4 sentences): likely root cause, what to change, how to verify"}]}' },
		{ role: 'user', content: `Site: ${target}\nCoverage: ${JSON.stringify(coverage)}\nNot covered: ${limitations.map(item => item.message).join(' | ') || 'nothing'}\nConfirmed findings:\n${list}` }
	], { maxTokens: 9000, signal, purpose: 'report' });
	if (!result || typeof result !== 'object') return {};
	const fixes = new Map((Array.isArray(result.fixes) ? result.fixes : []).filter(item => Number.isInteger(item?.index) && typeof item.fix === 'string').map(item => [item.index, item.fix.slice(0, 2500)]));
	return {
		summary: typeof result.summary === 'string' ? result.summary.slice(0, 3000) : undefined,
		recommendations: Array.isArray(result.recommendations) ? result.recommendations.filter(item => typeof item === 'string').slice(0, 6).map(item => item.slice(0, 500)) : undefined,
		fixes
	};
}

export function buildReport({ session, findings, dismissed, coverage, limitations, models, triageStats, loaded, refined = {}, runtime, adaptive }) {
	const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
	// The completion gate overrides a clean verdict: an incomplete run is never a "pass".
	const formSaveGaps = (session.hybrid?.plan?.scenarios ?? []).map(plannedSaveGap).filter(Boolean);
	const coverageGaps = formSaveGaps.length > 0 || limitations.some(item => item.affectsCoverage) || (adaptive && adaptive.gate.status !== 'complete');
	const verdict = adaptive?.gate.status === 'blocked' ? 'blocked' : verdictFor({ findings: sorted, loaded, coverageGaps });
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
		notCovered: [...new Set([...limitations.map(item => item.message), ...formSaveGaps])],
		recommendations: refined.recommendations?.length ? refined.recommendations : sorted.slice(0, 6).map(item => `[${item.severity}] ${item.title}`),
		targetUrl: session.targetUrl,
		findings: sorted.length,
		bySeverity: bySeverity(sorted),
		runtimeIdentity: runtime,
		qaEngine: {
			version: 2,
			formOutcomes: (session.hybrid?.plan?.scenarios ?? []).flatMap(item => item.formOutcomes ?? []),
			formSaveGaps,
			formValidation: session.hybrid?.pageReview?.formValidation ?? [],
			coverage,
			models: {
				reasoner: { model: models.state.reasoner.model, used: models.state.reasoner.calls > 0, calls: models.state.reasoner.calls, failures: models.state.reasoner.failures, tokens: models.state.reasoner.inputTokens + models.state.reasoner.outputTokens, enabled: models.state.reasoner.enabled, lastError: models.state.reasoner.lastError },
				jev: { model: models.state.jev.model, used: models.state.jev.calls > 0, calls: models.state.jev.calls, failures: models.state.jev.failures, tokens: models.state.jev.inputTokens + models.state.jev.outputTokens, enabled: models.state.jev.enabled, lastError: models.state.jev.lastError }
			},
			triage: triageStats,
			...(adaptive ? adaptiveReport({ session, findings: sorted, dismissed, coverage, limitations, models, triageStats, verdict, adaptive, recommendations: refined.recommendations }) : {}),
			dismissed: dismissed.slice(0, 40).map(item => ({ title: item.title, category: item.category, severity: item.severity, url: item.url, score: item.score, source: item.source, reason: item.verification?.reason }))
		}
	};
}

const STATE_LABEL = { passed: 'Passed', failed: 'Failed', blocked: 'Blocked', inconclusive: 'Inconclusive', not_applicable: 'Not applicable', unsupported: 'Unsupported', not_executed: 'Not executed' };
const pathOf = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url; } };
const GROUP_LABEL = { functional: 'Functional', auth: 'Authentication & authorization', layout: 'Layout & visual', motion: 'Motion, animation & DOM', a11y: 'Accessibility', performance: 'Performance', security: 'Security', network: 'Network & API', state: 'State & data', content: 'Content, SEO & platform' };

/**
 * The extended (25-section) report for the adaptive engine. Every section is
 * built from recorded state: plan, graph, coverage rows, gate, routing log.
 */
export function adaptiveReport({ session, findings, dismissed, coverage, limitations, models, triageStats, verdict, adaptive, recommendations }) {
	const { gate, plan, graph, observation, coverageRows, routing, routingSummary, authEvents = [], signedIn, blocked } = adaptive;
	const counts = Object.fromEntries(Object.keys(STATE_LABEL).map(state => [state, coverageRows.filter(row => row.state === state).length]));
	const scenarios = plan.scenarios.map(item => ({ id: item.id, title: item.title, unit: item.unit, state: item.state, reason: item.reason, ...(item.saveTarget ? { saveTarget: item.saveTarget, sideEffects: true } : {}), origin: item.origin, revision: item.revision, tested: item.tested ?? 0, findings: item.findings ?? 0, evidence: item.evidence ?? [] }));
	const byGroup = group => findings.filter(item => coverageRows.some(row => row.group === group && row.findingIds?.includes(item.id)));
	const findingLine = item => `[${item.severity}] ${item.title} — ${pathOf(item.url)}`;
	const pageRows = Object.entries(graph.pages).slice(0, 80).map(([url, page]) => ({ url: pathOf(url), title: page.heading || page.title || '', auth: page.auth ?? 'public', status: page.status ?? 200, discoveredBy: page.discoveredBy, findings: findings.filter(item => item.url === url).length, features: Object.entries(page.features ?? {}).filter(([key, value]) => typeof value === 'number' && value > 0 && !['links', 'controls', 'headings'].includes(key)).map(([key]) => key) }));
	const reasoner = models.state.reasoner; const jev = models.state.jev;
	const tokens = { reasoner: { calls: reasoner.calls, input: reasoner.inputTokens, output: reasoner.outputTokens }, jev: { calls: jev.calls, input: jev.inputTokens, output: jev.outputTokens }, byTask: routing.tokens, total: reasoner.inputTokens + reasoner.outputTokens + jev.inputTokens + jev.outputTokens };
	const section = (id, title, items) => ({ id, title, items: items.filter(item => item !== undefined && item !== '').map(item => typeof item === 'string' ? item.slice(0, 600) : item) });
	const sections = [
		section('summary', '1. Executive summary', [`Verdict: ${verdict}. Completion gate: ${gate.status}.`, `${findings.length} confirmed finding(s); ${counts.passed} of ${coverageRows.length} categories passed, ${counts.failed} failed.`]),
		section('gate', '2. Completion gate', gate.checks.map(check => `${check.ok ? '✓' : '✗'} ${check.id}: ${check.detail}`)),
		section('environment', '3. Target and environment', [`Target: ${session.targetUrl}`, `Browser: ${coverage.engine ?? 'unknown'}; viewports: ${(coverage.viewports ?? []).join(', ')}`, `Writes: ${blocked?.writes ? `${blocked.writes} blocked` : 'none attempted'}; off-site navigations blocked: ${blocked?.offsite ?? 0}`]),
		section('observation', '4. First observation (before planning)', observation ? [`${pathOf(observation.url)} answered HTTP ${observation.status}: "${observation.heading || observation.title}"`, `${observation.controls} controls, ${observation.links} same-site links, accessibility snapshot ${observation.ariaLines} lines, ${observation.console} console messages, ${observation.failedRequests} failed requests`, `Features seen: ${Object.keys(observation.features ?? {}).join(', ') || 'none'}`] : ['No observation recorded.']),
		section('graph', '5. Application map', [`${pageRows.length} page(s), ${pageRows.filter(row => row.auth === 'protected').length} confirmed signed-in only, ${graph.transitions.length} transitions; roles: ${graph.roles.join(', ')}`, ...pageRows.slice(0, 30).map(row => `${row.url} — ${row.title} [${row.auth}${row.status >= 400 ? `, HTTP ${row.status}` : ''}]${row.features.length ? ` {${row.features.join(', ')}}` : ''}`)]),
		section('auth', '6. Authentication', [graph.auth.detected ? `Sign-in detected (${[graph.auth.passwordForm ? 'password form' : '', graph.auth.identifierStep ? 'two-step' : '', graph.auth.loginLinks?.length ? 'sign-in link' : '', graph.auth.sso?.length ? `SSO: ${graph.auth.sso.join(', ')}` : ''].filter(Boolean).join(', ') || 'entry point'}).` : 'No authentication detected.', signedIn ? `Signed in and verified: ${graph.auth.verifiedBy ?? 'session check'}${graph.auth.steps?.length ? `; steps: ${graph.auth.steps.join(' → ')}` : ''}.` : graph.auth.blockedReason ? `Not signed in: ${graph.auth.blockedReason}` : '', graph.auth.reauthentications ? `Session expired and was re-authenticated ${graph.auth.reauthentications} time(s).` : '', ...authEvents.slice(0, 12).map(event => `${new Date(event.ts).toISOString().slice(11, 19)} ${event.kind}${event.url ? ` at ${event.url}` : ''}${event.ok !== undefined ? ` → ${event.ok ? 'ok' : 'failed'}` : ''}${event.steps ? ` (${event.steps.join(' → ')})` : ''}`), 'Credentials were read from the run vault only; they never appear in prompts, logs, screenshots or this report.']),
		section('plan', '7. Test plan and revisions', [`${plan.scenarios.length} scenarios in ${plan.revisions.length} revision(s).`, ...plan.revisions.map(item => `Revision ${item.revision} — ${item.trigger}: +${item.added.length}`)]),
		section('scenarios', '8. Scenario results', scenarios.map(item => `${STATE_LABEL[item.state] ?? item.state} · ${item.title}${item.reason ? ` — ${item.reason}` : ''}`)),
		section('capabilities', `9. Capability matrix (${CAPABILITY_COUNT} categories)`, [`${Object.entries(counts).map(([state, n]) => `${STATE_LABEL[state]} ${n}`).join(' · ')}`]),
		section('severity', '10. Findings by severity', SEVERITIES.map(severity => `${severity}: ${findings.filter(item => item.severity === severity).length}`)),
		section('findings', '11. Findings', findings.slice(0, 40).map(findingLine)),
		section('evidence', '12. Evidence index', findings.slice(0, 40).map(item => `${item.title}: ${item.artifactId ? `screenshot ${item.artifactId}; ` : ''}${(item.steps ?? []).length} step(s); ${String(item.evidence ?? '').split('\n')[0].slice(0, 160)}`)),
		// DOM integrity is reported with motion and interaction: both come from watching the page change.
		...['functional', 'layout', 'motion', 'a11y', 'performance', 'security'].map((group, index) => {
			const groups = group === 'motion' ? ['motion', 'dom'] : [group];
			const rows = coverageRows.filter(row => groups.includes(row.group));
			return section(group, `${13 + index}. ${GROUP_LABEL[group]}`, [
				`${rows.filter(row => row.state === 'passed').length} passed, ${rows.filter(row => row.state === 'failed').length} failed of ${rows.length} categories.`,
				...[...new Set(groups.flatMap(byGroup))].slice(0, 12).map(findingLine)
			]);
		}),
		section('responsive', '19. Responsive coverage', (coverage.viewports ?? []).map(viewport => `${viewport}: tested`)),
		section('pages', '20. Coverage by page', pageRows.slice(0, 40).map(row => `${row.url}: ${row.findings} finding(s), discovered by ${row.discoveredBy}`)),
		section('roles', '21. Coverage by role', graph.roles.map(role => `${role}: ${role === 'public' ? 'public pages crawled signed out' : role === 'signed-in' ? (signedIn ? 'signed-in area crawled and tested' : 'not tested') : 'restriction observed'}`)),
		section('gaps', '22. Blocked, unsupported and not executed', coverageRows.filter(row => ['blocked', 'unsupported', 'not_executed', 'inconclusive'].includes(row.state)).map(row => `${STATE_LABEL[row.state]} · ${row.name}: ${row.reason}`)),
		section('routing', '23. Hybrid routing decisions', [`${routingSummary.decisions} decision(s): ${Object.entries(routingSummary.byModel).map(([model, n]) => `${model} ${n}`).join(', ')}; ${routingSummary.escalations} escalation(s); ${routingSummary.fallbacks} fallback(s).`, ...routing.decisions.slice(-25).map(item => `${item.task} → ${item.model}${item.reason ? ` (${item.reason})` : ''}${item.outcome ? `: ${item.outcome}` : ''}`)]),
		section('tokens', '24. Token and cost metrics', [`Reasoner ${tokens.reasoner.calls} call(s), ${tokens.reasoner.input} in / ${tokens.reasoner.output} out tokens; JEV ${tokens.jev.calls} call(s), ${tokens.jev.input} in / ${tokens.jev.output} out.`, ...Object.entries(tokens.byTask ?? {}).map(([task, entry]) => `${task}: reasoner ${entry.reasonerTokens} tokens (${entry.reasonerCalls} calls), JEV ${entry.jevTokens} tokens (${entry.jevCalls} calls)`), `Triage: ${triageStats?.merged ?? 0} merged candidates, ${triageStats?.escalated ?? 0} escalated.`]),
		section('next', '25. Recommendations, limitations and next steps', [...(recommendations?.length ? recommendations : findings.slice(0, 5).map(item => `Fix: ${item.title}`)), ...limitations.slice(0, 12).map(item => `Limitation: ${item.message}`), ...coverageRows.filter(row => row.state === 'unsupported').slice(0, 6).map(row => `To cover "${row.name}": ${row.reason}`)])
	];
	return {
		architecture: 'adaptive',
		completion: gate,
		capabilityMatrix: coverageRows,
		capabilitySummary: { total: coverageRows.length, ...counts },
		plan: { revisions: plan.revisions, scenarios },
		applicationGraph: { pages: pageRows, transitions: graph.transitions.length, roles: graph.roles, features: Object.fromEntries(Object.entries(graph.features).filter(([, n]) => n > 0)), auth: { detected: graph.auth.detected, signedIn, identifierStep: graph.auth.identifierStep, reauthentications: graph.auth.reauthentications ?? 0, blockedReason: graph.auth.blockedReason, verifiedBy: graph.auth.verifiedBy } },
		observation,
		routing: { summary: routingSummary, decisions: routing.decisions.slice(-120) },
		tokens,
		sections
	};
}
