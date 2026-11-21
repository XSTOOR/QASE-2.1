/**
 * QA run workspace for QA-engine runs (session.hybrid.version === 2).
 *
 * Shows, live and after completion: phase progress, coverage, model usage,
 * findings with their screenshots and copyable fix prompts, limitations and
 * the candidates triage dismissed. Data comes from the session (pushed over
 * SSE) plus GET /api/sessions/:id/qa-evidence for the finding index.
 */
import { runPresentationLabel } from './runPresentation.js';
import { buildFindingFixPrompt } from './fixPromptBuilder.js';

export const isQaEvidenceRun = session => session?.mode === 'qa' && session.hybrid?.version === 2;

const PHASE_TONE = { done: 'pass', running: 'active', failed: 'fail', skipped: 'gap', pending: 'neutral' };
const PHASE_LABEL = { done: 'Done', running: 'In progress', failed: 'Did not complete', skipped: 'Skipped', pending: 'Waiting' };
const SEVERITY_TONE = { critical: 'fail', high: 'fail', medium: 'gap', low: 'neutral', info: 'neutral' };
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

function browserLabel(session) {
	const env = session.environmentSnapshot;
	const facts = session.runtimeFacts;
	const engine = facts?.launchedEngineId || session.engine;
	const engineLabel = ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' })[engine] || engine || 'Browser';
	return [env?.device ? `${env.device} · ${[env.browser, env.browserVersion].filter(Boolean).join(' ')}` : 'Desktop, tablet and mobile viewports',
		[engineLabel, facts?.browserVersion].filter(Boolean).join(' ')];
}

function present(root, session, evidence, { live, error, retry, onFinding, onFindings, onActivity }) {
	const doc = root.ownerDocument;
	const create = (tag, className, text) => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	};
	const button = (text, action) => {
		const node = create('button', 'qe-link', text);
		node.type = 'button';
		node.onclick = action;
		return node;
	};
	const badge = (label, tone) => {
		const node = create('span', 'qe-badge', label);
		node.dataset.tone = tone;
		return node;
	};
	const details = label => {
		const node = create('details', 'qe-details');
		node.append(create('summary', '', label));
		return node;
	};
	const state = session.hybrid ?? {};
	const coverage = state.coverage ?? {};
	const findings = session.findings ?? [];
	const status = runPresentationLabel(session);
	const workspace = create('section', 'qe-workspace');
	const title = live ? 'Test progress' : 'QA results';
	workspace.setAttribute('aria-label', title);

	// Header: status, browser, current phase.
	const hero = create('header', 'qe-hero');
	const heading = create('div', 'qe-hero-heading');
	heading.append(create('h2', '', title));
	const tone = session.report?.verdict === 'fail' ? 'fail' : session.status === 'running' ? 'active' : ['error', 'interrupted'].includes(session.status) ? 'gap' : session.report?.verdict === 'pass' ? 'pass' : 'neutral';
	heading.append(badge(status, tone));
	hero.append(heading);
	const current = (state.phases ?? []).find(phase => phase.status === 'running');
	if (session.status === 'running' && current) hero.append(create('p', '', `${current.label}…`));
	else if (session.report?.summary) hero.append(create('p', '', session.report.summary));
	const [device, engine] = browserLabel(session);
	const environment = create('div', 'qe-browser');
	environment.append(create('strong', '', device), create('span', '', engine));
	hero.append(environment);
	workspace.append(hero);
	if (error) {
		const notice = create('p', 'qe-notice', 'Live results could not be refreshed. ');
		notice.append(button('Retry', retry));
		workspace.append(notice);
	}

	// Metrics.
	const metrics = create('div', 'qe-metrics');
	const metric = (value, label) => { const node = create('div', 'qe-metric'); node.append(create('span', '', label), create('strong', '', String(value ?? 0))); metrics.append(node); };
	metric(findings.length, findings.length === 1 ? 'finding' : 'findings');
	metric(coverage.pages, 'pages audited');
	metric((coverage.viewports ?? []).length, 'viewports');
	metric(coverage.interactions, 'controls & animations tested');
	metric(coverage.forms, 'forms tested');
	metric(coverage.securityChecks, 'security checks');
	if (coverage.exploration) metric(coverage.exploration, 'AI exploration steps');
	workspace.append(metrics);


	// Coverage and the dynamic plan replace the old fixed phase list.
	const coverageView = coverageCard(create, session);
	if (coverageView) workspace.append(coverageView);
	const scenarioView = scenarioCard(create, session, { live });
	if (scenarioView) workspace.append(scenarioView);
	const phases = create('section', 'qe-card qx-stages');
	phases.append(create('h3', '', 'Stages'));
	const phaseList = create('ol', 'qe-list qe-phases');
	for (const phase of state.phases ?? []) {
		const item = create('li', 'qe-phase');
		item.dataset.status = phase.status;
		item.append(badge(PHASE_LABEL[phase.status] ?? phase.status, PHASE_TONE[phase.status] ?? 'neutral'), create('span', '', ` ${phase.label}`));
		if (phase.detail) item.append(create('small', '', ` — ${phase.detail}`));
		phaseList.append(item);
	}
	phases.append(phaseList);
	workspace.append(phases);

	// Findings grouped by severity.
	const findingCard = create('section', 'qe-card');
	const findingHead = create('div', 'qe-section-head');
	findingHead.append(create('h3', '', `Findings (${findings.length})`));
	if (findings.length && onFindings) findingHead.append(button('Open findings', onFindings));
	findingCard.append(findingHead);
	if (!findings.length) findingCard.append(create('p', '', session.status === 'running' ? 'Findings appear here once candidates are verified at the end of the run.' : 'No verified defects were found.'));
	for (const severity of SEVERITIES) {
		const group = findings.filter(finding => finding.severity === severity);
		if (!group.length) continue;
		const section = create('div', 'qe-finding-group');
		section.append(create('h4', '', `${severity[0].toUpperCase()}${severity.slice(1)} (${group.length})`));
		for (const finding of group) {
			const row = create('article', 'qe-finding');
			row.dataset.findingId = finding.id;
			const head = create('div', 'qe-finding-head');
			head.append(badge(finding.category ?? 'general', SEVERITY_TONE[severity]), create('strong', '', ` ${finding.title}`));
			row.append(head);
			const where = [finding.url, finding.viewports?.length ? finding.viewports.join(', ') : '', finding.selector].filter(Boolean).join(' · ');
			if (where) row.append(create('small', 'qe-path', where));
			row.append(create('p', '', finding.actual));
			const actions = create('div', 'qe-finding-actions');
			if (onFinding) actions.append(button('Details', () => onFinding(finding.id)));
			actions.append(button('Copy fix prompt', async event => {
				try {
					await navigator.clipboard.writeText(buildFindingFixPrompt(finding, { targetUrl: session.targetUrl, mode: 'qa' }));
					event.target.textContent = 'Copied';
				} catch { event.target.textContent = 'Copy failed'; }
			}));
			if (finding.artifactId) {
				const link = create('a', 'qe-link', 'Screenshot');
				link.href = `/api/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(finding.artifactId)}`;
				link.target = '_blank';
				link.rel = 'noopener';
				actions.append(link);
			}
			row.append(actions);
			if (!live && finding.artifactId) {
				const image = create('img', 'qe-finding-shot');
				image.loading = 'lazy';
				image.alt = `Screenshot: ${finding.title}`;
				image.src = `/api/sessions/${encodeURIComponent(session.id)}/artifacts/${encodeURIComponent(finding.artifactId)}`;
				row.append(image);
			}
			section.append(row);
		}
		findingCard.append(section);
	}
	workspace.append(findingCard);

	// Limitations: everything that was not tested, and why.
	const limitations = session.report?.notCovered?.length ? session.report.notCovered : (state.limitations ?? []).map(item => item.message);
	if (limitations.length) {
		const card = create('section', 'qe-card');
		card.append(create('h3', '', 'Limitations'));
		const list = create('ul', 'qe-list');
		for (const item of limitations) list.append(create('li', '', item));
		card.append(list);
		workspace.append(card);
	}

	// Models.
	const models = session.report?.qaEngine?.models ?? state.models;
	if (models) {
		const card = details('Models used');
		const list = create('ul', 'qe-list');
		const reasoner = models.reasoner ?? {}, jev = models.jev ?? {};
		list.append(create('li', '', `Reasoning model ${reasoner.model ?? ''}: ${reasoner.enabled === false ? 'not configured' : `${reasoner.calls ?? 0} calls${reasoner.failures ? `, ${reasoner.failures} failed` : ''}`}`));
		list.append(create('li', '', `JEV ${jev.model ?? ''}: ${jev.enabled === false ? 'not configured' : `${jev.calls ?? 0} verification calls${jev.failures ? `, ${jev.failures} failed` : ''}`}`));
		card.append(list);
		workspace.append(card);
	}

	// Candidates triage dismissed (transparency).
	const dismissed = evidence?.dismissed ?? session.report?.qaEngine?.dismissed ?? [];
	if (dismissed.length) {
		const card = details(`Dismissed candidates (${dismissed.length})`);
		card.append(create('p', '', 'Automated observations that verification judged unlikely to be real defects. Review them if a result looks missing.'));
		const list = create('ul', 'qe-list');
		for (const item of dismissed) list.append(create('li', '', `${item.title} — ${item.category}, score ${item.score ?? 'n/a'}${item.reason ? ` (${item.reason})` : ''}`));
		card.append(list);
		workspace.append(card);
	}
	if (onActivity) {
		const footer = create('p', '');
		footer.append(button('Open the activity log', onActivity));
		workspace.append(footer);
	}
	root.replaceChildren(workspace);
}


const STEP_STATE = {
	done: { label: 'Done', icon: '✓' },
	running: { label: 'In progress', icon: '' },
	failed: { label: 'Did not finish', icon: '!' },
	skipped: { label: 'Skipped', icon: '–' },
	pending: { label: 'Up next', icon: '' }
};

function duration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return '';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return url ?? ''; }
}

/**
 * The Plan tab: a clean, scannable test plan. Progress and the current step
 * at the top, what has been covered so far, then every step with its status,
 * outcome and duration. The live browser is shown above the tabs, so it is not
 * repeated here.
 */
function presentPlan(root, session, { error, retry, onFindings }) {
	const doc = root.ownerDocument;
	const create = (tag, className, text) => {
		const node = doc.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = text;
		return node;
	};
	const state = session.hybrid ?? {};
	const coverage = state.coverage ?? {};
	const phases = state.phases ?? [];
	const findings = session.findings ?? [];
	const finished = phases.filter(phase => ['done', 'skipped', 'failed'].includes(phase.status)).length;
	const percent = phases.length ? Math.round(finished / phases.length * 100) : 0;
	const current = phases.find(phase => phase.status === 'running');
	const running = ['running', 'awaiting_input'].includes(session.status);

	const plan = create('section', 'qp');
	plan.setAttribute('aria-label', 'Test plan');

	// Overview: what is happening now and how far along the run is.
	const overview = create('header', 'qp-overview');
	const top = create('div', 'qp-overview-top');
	const titles = create('div', 'qp-titles');
	titles.append(create('p', 'qp-eyebrow', `Test plan · ${hostOf(session.targetUrl)}`));
	const headline = session.status === 'awaiting_input' ? 'Waiting for your answer in the conversation'
		: running ? (current ? current.label : 'Preparing the next step')
			: session.report ? 'Testing complete' : 'Run stopped';
	titles.append(create('h2', 'qp-headline', headline));
	const sub = running && current?.detail ? current.detail : running ? `Step ${Math.min(finished + 1, phases.length)} of ${phases.length}` : session.report?.summary ?? '';
	if (sub) titles.append(create('p', 'qp-sub', sub));
	const pill = create('span', `qp-pill qp-pill-${session.status === 'awaiting_input' ? 'wait' : running ? 'live' : session.report?.verdict === 'fail' ? 'fail' : session.report ? 'done' : 'gap'}`,
		session.status === 'awaiting_input' ? 'Needs you' : running ? 'Running' : runPresentationLabel(session));
	top.append(titles, pill);
	overview.append(top);
	const progress = create('div', 'qp-progress');
	const bar = create('div', 'qp-bar');
	bar.setAttribute('role', 'progressbar');
	bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', String(phases.length)); bar.setAttribute('aria-valuenow', String(finished));
	bar.setAttribute('aria-label', 'Steps completed');
	const fill = create('span', 'qp-bar-fill');
	fill.style.width = `${percent}%`;
	bar.append(fill);
	progress.append(bar, create('span', 'qp-progress-label', `${finished} of ${phases.length} steps · ${percent}%`));
	overview.append(progress);
	const [, engine] = browserLabel(session);
	const meta = create('ul', 'qp-meta');
	const models = state.models ?? {};
	const viewports = coverage.viewports ?? [];
	for (const [label, value] of [
		['Viewports', viewports.length ? `${viewports[0]}${viewports.length > 1 ? ` + ${viewports.length - 1} more` : ''}` : 'Desktop, then tablet and mobile'], ['Browser', engine],
		['Signed in', state.signedIn ? 'Yes, read-only' : state.loginWall ? 'No (public pages)' : 'Not needed'],
		['AI', [models.reasoner?.enabled ? 'Reasoning model' : '', models.jev?.enabled ? 'JEV verification' : ''].filter(Boolean).join(' + ') || 'Automated checks only']
	]) {
		const item = create('li');
		item.append(create('span', 'qp-meta-label', label), create('span', 'qp-meta-value', value));
		meta.append(item);
	}
	overview.append(meta);
	plan.append(overview);
	if (error) {
		const notice = create('p', 'qe-notice', 'Live progress could not be refreshed. ');
		const again = create('button', 'qe-link', 'Retry');
		again.type = 'button'; again.onclick = retry;
		notice.append(again);
		plan.append(notice);
	}

	// Coverage so far.
	const stats = create('div', 'qp-stats');
	const stat = (value, label, action) => {
		const node = create(action ? 'button' : 'div', 'qp-stat');
		if (action) { node.type = 'button'; node.onclick = action; }
		node.append(create('strong', '', String(value ?? 0)), create('span', '', label));
		stats.append(node);
	};
	stat(findings.length, findings.length === 1 ? 'Finding' : 'Findings', findings.length && onFindings ? onFindings : undefined);
	stat(coverage.pages, coverage.pages === 1 ? 'Page' : 'Pages');
	stat((coverage.viewports ?? []).length, 'Viewports');
	stat(coverage.interactions, 'Controls');
	stat(coverage.forms, 'Forms');
	stat(coverage.securityChecks, 'Security checks');
	if (!findings.length && state.candidates) stat(state.candidates, 'To verify');
	plan.append(stats);

	// Every step, in order.
	const card = create('section', 'qp-card');
	const head = create('div', 'qp-card-head');
	head.append(create('h3', '', 'Steps'), create('span', 'qp-card-note', running ? 'Updates live' : `Took ${duration((state.updatedAt ?? Date.now()) - (state.startedAt ?? Date.now()))}`));
	card.append(head);
	const list = create('ol', 'qp-steps');
	phases.forEach((phase, index) => {
		const info = STEP_STATE[phase.status] ?? STEP_STATE.pending;
		const item = create('li', 'qp-step');
		item.dataset.status = phase.status;
		if (phase.status === 'running') item.setAttribute('aria-current', 'step');
		const marker = create('span', 'qp-marker', info.icon || String(index + 1));
		marker.setAttribute('aria-hidden', 'true');
		const body = create('div', 'qp-step-body');
		body.append(create('span', 'qp-step-title', phase.label));
		if (phase.detail) body.append(create('span', 'qp-step-detail', phase.detail));
		const side = create('div', 'qp-step-side');
		side.append(create('span', 'qp-step-state', info.label));
		const took = phase.status !== 'skipped' && phase.startedAt && phase.endedAt ? (phase.endedAt - phase.startedAt < 1000 ? '<1s' : duration(phase.endedAt - phase.startedAt)) : '';
		if (took) side.append(create('span', 'qp-step-time', took));
		item.append(marker, body, side);
		list.append(item);
	});
	card.append(list);
	plan.append(card);
	const scenarioView = scenarioCard(create, session, { live: running });
	if (scenarioView) plan.append(scenarioView);
	const coverageView = coverageCard(create, session);
	if (coverageView) plan.append(coverageView);

	// What could not be covered, as soon as it is known.
	const gaps = (session.report?.notCovered?.length ? session.report.notCovered : (state.limitations ?? []).map(item => item.message));
	if (gaps.length) {
		const callout = create('section', 'qp-gaps');
		callout.append(create('h3', '', `Not covered (${gaps.length})`));
		const items = create('ul');
		for (const gap of gaps.slice(0, 6)) items.append(create('li', '', gap));
		callout.append(items);
		plan.append(callout);
	}
	root.replaceChildren(plan);
}

const COVERAGE_ORDER = [['passed', 'Passed'], ['failed', 'Failed'], ['blocked', 'Blocked'], ['inconclusive', 'Inconclusive'], ['not_executed', 'Not run'], ['not_applicable', 'N/A'], ['unsupported', 'Unsupported']];
const SCENARIO_LABEL = { pending: 'Queued', running: 'Running', passed: 'Passed', failed: 'Issues', blocked: 'Blocked', inconclusive: 'Inconclusive', not_applicable: 'N/A', unsupported: 'Unsupported', not_executed: 'Not run' };

/** The dynamic plan: scenarios as they are planned, revised and executed. */
function scenarioCard(create, session, { live } = {}) {
	const state = session.hybrid ?? {};
	const scenarios = state.plan?.scenarios ?? session.report?.qaEngine?.plan?.scenarios ?? [];
	if (!scenarios.length) return undefined;
	const revisions = state.plan?.revisions ?? session.report?.qaEngine?.plan?.revisions ?? [];
	const card = create('section', 'qp-card qx-scenarios');
	const head = create('div', 'qp-card-head');
	head.append(create('h3', '', 'Test plan'), create('span', 'qp-card-note', `${scenarios.length} scenarios · ${revisions.length > 1 ? `revised ${revisions.length - 1}×` : 'from observation'}${live ? ' · live' : ''}`));
	card.append(head);
	const counts = {};
	for (const item of scenarios) counts[item.state] = (counts[item.state] ?? 0) + 1;
	const chips = create('div', 'qx-chips');
	for (const [key, text] of Object.entries(SCENARIO_LABEL)) if (counts[key]) { const chip = create('span', `qx-chip qx-${key}`, `${counts[key]} ${text}`); chips.append(chip); }
	card.append(chips);
	const list = create('ol', 'qx-list');
	const order = { running: 0, failed: 1, blocked: 2, inconclusive: 3, pending: 4, passed: 5, not_executed: 6, not_applicable: 7, unsupported: 8 };
	for (const item of [...scenarios].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9)).slice(0, 40)) {
		const row = create('li', 'qx-row');
		row.dataset.state = item.state;
		const dot = create('span', 'qx-dot');
		dot.setAttribute('aria-hidden', 'true');
		const body = create('div', 'qx-row-body');
		body.append(create('span', 'qx-row-title', item.title));
		if (item.reason && item.state !== 'passed') body.append(create('span', 'qx-row-reason', item.reason));
		const tag = create('span', 'qx-row-state', SCENARIO_LABEL[item.state] ?? item.state);
		if (item.revision > 1) body.append(create('span', 'qx-row-new', `added in revision ${item.revision}`));
		row.append(dot, body, tag);
		list.append(row);
	}
	card.append(list);
	if (scenarios.length > 40) card.append(create('p', 'qp-card-note', `…and ${scenarios.length - 40} more in the report.`));
	return card;
}

/** 140 categories as one stacked bar, plus the completion gate. */
function coverageCard(create, session) {
	const state = session.hybrid ?? {};
	const summary = state.capabilities ?? state.capabilitySummary ?? session.report?.qaEngine?.capabilitySummary;
	if (!summary?.total) return undefined;
	const gate = state.gate ?? session.report?.qaEngine?.completion;
	const card = create('section', 'qp-card qx-coverage');
	const head = create('div', 'qp-card-head');
	head.append(create('h3', '', 'Coverage'), create('span', `qx-gate qx-gate-${gate?.status ?? 'partial'}`, gate ? `Gate: ${gate.status}` : ''));
	card.append(head);
	const bar = create('div', 'qx-bar');
	bar.setAttribute('role', 'img');
	bar.setAttribute('aria-label', COVERAGE_ORDER.map(([key, text]) => `${summary[key] ?? 0} ${text}`).join(', '));
	const legend = create('ul', 'qx-legend');
	for (const [key, text] of COVERAGE_ORDER) {
		const value = summary[key] ?? 0;
		if (!value) continue;
		const segment = create('span', `qx-seg qx-${key}`);
		segment.style.flexGrow = String(value);
		segment.title = `${value} ${text}`;
		bar.append(segment);
		const item = create('li', `qx-key qx-${key}`);
		item.append(create('strong', '', String(value)), create('span', '', text));
		legend.append(item);
	}
	card.append(create('p', 'qx-total', `${summary.total} test categories`), bar, legend);
	if (gate?.failed?.length) card.append(create('p', 'qp-card-note', `Open gate checks: ${gate.failed.join(', ').replace(/_/g, ' ')}`));
	return card;
}

/** Live-updating workspace; checkpoints coalesce into one fetch per interval. */
export function createQaEvidenceWorkspace({ api, plan, report, ...actions }) {
	let session, evidence, error, timer, inFlight, pending, signature;

	function render() {
		if (!session) return;
		const snapshot = JSON.stringify([session.id, session.status, session.statusDetail, session.report?.ts, session.findings?.length, session.hybrid?.phases, session.hybrid?.coverage, session.hybrid?.plan?.summary, (session.hybrid?.plan?.scenarios ?? []).map(item => item.state[0]).join(''), session.hybrid?.capabilities, session.hybrid?.gate, session.hybrid?.limitations, session.hybrid?.signedIn, session.hybrid?.candidates, evidence?.dismissed?.length, error]);
		if (snapshot === signature) return;
		signature = snapshot;
		const options = { ...actions, error, retry: () => schedule(0) };
		presentPlan(plan, session, options);
		present(report, session, evidence, { ...options, live: false });
	}

	function schedule(delay = 1500) {
		if (!session) return;
		pending = true;
		if (timer || inFlight) return;
		timer = setTimeout(async () => {
			timer = undefined;
			const id = session?.id;
			if (!id) return;
			pending = false;
			const request = api(`/sessions/${encodeURIComponent(id)}/qa-evidence`);
			inFlight = request;
			try {
				const result = await request;
				if (inFlight === request) { evidence = result; error = false; }
			} catch {
				if (inFlight === request) error = true;
			} finally {
				if (inFlight === request) {
					inFlight = undefined;
					render();
					if (pending) schedule();
				}
			}
		}, delay);
	}

	function update(next, refresh = false) {
		const engineRun = isQaEvidenceRun(next) ? next : undefined;
		const changed = session?.id !== engineRun?.id;
		if (changed) {
			clearTimeout(timer);
			timer = inFlight = evidence = signature = undefined;
			error = pending = false;
			plan.replaceChildren();
			report.replaceChildren();
		}
		session = engineRun;
		plan.hidden = report.hidden = !engineRun;
		render();
		if (changed || refresh) schedule(changed ? 0 : undefined);
	}

	return { update };
}
