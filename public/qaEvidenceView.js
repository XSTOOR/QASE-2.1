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

function present(root, session, evidence, { live, preview, error, retry, onFinding, onFindings, onActivity }) {
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

	if (live && preview) workspace.append(preview);

	// Phases.
	const phases = create('section', 'qe-card');
	phases.append(create('h3', '', 'Test phases'));
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

/** Live-updating workspace; checkpoints coalesce into one fetch per interval. */
export function createQaEvidenceWorkspace({ api, plan, report, ...actions }) {
	let session, evidence, error, timer, inFlight, pending, signature, frame, connection, preview;

	function createPreview() {
		const doc = plan.ownerDocument;
		const panel = doc.createElement('section');
		panel.className = 'qe-card qe-preview';
		const heading = doc.createElement('h3');
		heading.textContent = 'Browser preview';
		const description = doc.createElement('p');
		description.setAttribute('role', 'status');
		const image = doc.createElement('img');
		image.hidden = true;
		image.alt = 'Live browser preview';
		panel.append(heading, description, image);
		return { panel, description, image };
	}

	function renderPreview() {
		if (!session || !preview) return;
		const active = session.status === 'running';
		const src = frame ? `data:${frame.mimeType};base64,${frame.base64}` : null;
		preview.description.textContent = src ? `${active && connection === 'live' ? 'Live browser preview' : 'Last received browser frame'}${frame.url ? ` · ${frame.url}` : ''}`
			: active ? 'The preview appears when QASE captures a browser frame.' : 'The live preview is available while a run is in progress.';
		if (src && preview.image.getAttribute('src') !== src) preview.image.src = src;
		preview.image.hidden = !src;
	}

	function render() {
		if (!session) return;
		const snapshot = JSON.stringify([session.id, session.status, session.statusDetail, session.report?.ts, session.findings?.length, session.hybrid?.phases, session.hybrid?.coverage, session.hybrid?.limitations, evidence?.dismissed?.length, error]);
		if (snapshot === signature) return;
		signature = snapshot;
		const options = { ...actions, error, retry: () => schedule(0) };
		present(plan, session, evidence, { ...options, live: true, preview: preview.panel });
		present(report, session, evidence, { ...options, live: false });
		renderPreview();
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
			timer = inFlight = evidence = signature = frame = connection = undefined;
			preview = engineRun ? createPreview() : undefined;
			error = pending = false;
			plan.replaceChildren();
			report.replaceChildren();
		}
		session = engineRun;
		plan.hidden = report.hidden = !engineRun;
		render();
		if (changed || refresh) schedule(changed ? 0 : undefined);
	}

	function updatePreview(id, { nextFrame, streamConnection } = {}) {
		if (session?.id !== id) return;
		connection = streamConnection;
		if (nextFrame?.base64 && /^image\/(?:png|jpeg|webp)$/.test(nextFrame.mimeType) && !(nextFrame.ts && frame?.ts && nextFrame.ts < frame.ts)) frame = nextFrame;
		renderPreview();
	}

	return { update, updatePreview };
}
