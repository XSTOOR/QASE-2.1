import { describeSqaLifecycle, groupSqaUnresolvedResults } from './sqaPresentation.js';
import { buildFindingFixPrompt, buildAllFixPromptsMarkdown } from './fixPromptBuilder.js';
import { createFounderView } from './founderView.js';
import { hostOf, list, markdown, paragraph, relativeTime, section, truncate } from './uiPrimitives.js';

/**
 * Qase dashboard.
 *
 * Three panels over one SSE stream. The server owns all state; this file
 * renders it and sends back the two things the user can contribute — an
 * instruction, and an answer to a blocking question.
 */

const $ = id => document.getElementById(id);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const el = {
	runList: $('run-list'),
	deviceSelect: $('device-select'),
	deviceLandscape: $('device-landscape'),
	newRun: $('new-run'),
	newSqa: $('new-sqa'),
	newFounder: $('new-founder'),
	connDot: $('conn-dot'),
	connLabel: $('conn-label'),
	modelBadge: $('model-badge'),
	signOut: $('sign-out'),

	chatTitle: $('chat-title'),
	chatTarget: $('chat-target'),
	statusChip: $('status-chip'),
	stopRun: $('stop-run'),
	thinkingStrip: $('thinking-strip'),
	thinkingHead: $('thinking-head'),
	thinkingLabel: $('thinking-label'),
	thinkingPeek: $('thinking-peek'),
	thinkingCaret: $('thinking-caret'),
	thinkingBody: $('thinking-body'),
	transcript: $('transcript'),
	chatEmpty: $('chat-empty'),
	questionSlot: $('question-slot'),
	composer: $('composer'),
	composerInput: $('composer-input'),
	sendBtn: $('send-btn'),

	browserUrl: $('browser-url'),
	browserTitle: $('browser-title'),
	browserDot: $('browser-dot'),
	stage: $('stage'),
	frame: $('frame'),
	stageInner: $('stage-inner'),
	stageEmpty: $('stage-empty'),
	cursor: $('cursor'),
	cursorLabel: $('cursor-label'),
	ripple: $('ripple'),
	targetBox: $('target-box'),

	activityFeed: $('activity-feed'),
	planList: $('plan-list'),
	findingsList: $('findings-list'),
	reportView: $('report-view'),
	activityTab: $('tab-activity'),
	sqaTab: $('tab-sqa'),
	sqaView: $('sqa-view'),
	founderTab: $('tab-founder'),
	founderView: $('founder-view'),
	countPlan: $('count-plan'),
	countFindings: $('count-findings'),
	countSqa: $('count-sqa'),
	countFounder: $('count-founder'),
	toasts: $('toasts'),
	authGate: $('auth-gate'),
	authForm: $('auth-form'),
	authEmail: $('auth-email'),
	authPassword: $('auth-password'),
	authDisplay: $('auth-display'),
	authDisplayLabel: $('auth-display-label'),
	authTitle: $('auth-title'),
	authCopy: $('auth-copy'),
	authSubmit: $('auth-submit'),
	authSwitch: $('auth-switch'),
	authError: $('auth-error')
};

const state = {
	sessionId: undefined,
	session: undefined,
	config: undefined,
	stream: undefined,
	/** Message id -> the nodes streamed text is appended to. */
	bubbles: new Map(),
	viewport: { width: 1440, height: 900 },
	cursorTimer: undefined,
	sqaCatalog: undefined,
	sqaCatalogPromise: undefined,
	founderCatalog: undefined,
	founderCatalogPromise: undefined,
	/** Live reasoning for the current turn. Never kept once the agent replies. */
	thinking: { text: '', action: '' },
	user: undefined
};

/* ── Helpers ─────────────────────────────────────────────────────── */

async function apiResponse(path, options = {}) {
	const method = String(options.method ?? 'GET').toUpperCase();
	const csrf = document.cookie.match(/(?:^|; )qase_csrf=([^;]+)/)?.[1];
	const headers = { 'Content-Type': 'application/json', ...(csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'X-CSRF-Token': decodeURIComponent(csrf) } : {}), ...(options.headers ?? {}) };
	const response = await fetch(`/api${path}`, {
		...options,
		method,
		headers,
		credentials: 'same-origin'
	});
	if (response.status === 401 && state.user && !path.startsWith('/auth/')) { window.location.reload(); throw new Error('Your session has expired. Sign in again.'); }
	if (!response.ok) {
		const text = await response.text();
		let message;
		try {
			message = JSON.parse(text).error;
		} catch {
			message = text;
		}
		const error = new Error(message || `Request failed (${response.status})`);
		error.status = response.status;
		throw error;
	}
	return response;
}

async function api(path, options = {}) {
	const response = await apiResponse(path, options);
	return response.status === 204 ? undefined : response.json();
}

async function apiText(path, options = {}) {
	return (await apiResponse(path, options)).text();
}

function toast(message, kind = '') {
	const node = document.createElement('div');
	node.className = `toast ${kind}`;
	node.setAttribute('role', kind === 'bad' ? 'alert' : 'status');
	node.textContent = message;
	el.toasts.append(node);
	setTimeout(() => {
		node.classList.add('is-leaving');
		node.addEventListener('animationend', () => node.remove(), { once: true });
	}, kind === 'bad' ? 6000 : 3600);
}

const fail = error => toast(error instanceof Error ? error.message : String(error), 'bad');

async function downloadReportPdf(filename) {
	const response = await apiResponse(`/sessions/${state.sessionId}/report.pdf`);
	const blob = await response.blob();
	const url = URL.createObjectURL(blob);
	const save = document.createElement('a');
	save.href = url;
	save.download = filename;
	document.body.append(save);
	save.click();
	save.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const founderView = createFounderView({
	getSession: () => state.session,
	getCatalog: () => state.founderCatalog,
	getSessionId: () => state.sessionId,
	elements: {
		founderView: el.founderView,
		countFounder: el.countFounder,
		reportView: el.reportView
	},
	apiText,
	downloadReportPdf,
	toast,
	fail,
	humanizeId: humanizeSqaId
});
const renderFounder = founderView.render;
const renderFounderReportTab = founderView.renderReportTab;

/* ── Runs (left panel) ───────────────────────────────────────────── */

async function refreshRuns() {
	const runs = await api('/sessions').catch(() => []);
	if (runs.length === 0) {
		el.runList.innerHTML = '<div class="feed-empty">No runs yet</div>';
		return;
	}
	el.runList.replaceChildren(...runs.map(renderRun));
}

function renderRun(run) {
	const row = document.createElement('div');
	row.className = 'run-row';
	row.setAttribute('role', 'listitem');

	const node = document.createElement('button');
	node.className = `run${run.id === state.sessionId ? ' is-active' : ''}`;
	node.type = 'button';
	node.setAttribute('aria-current', run.id === state.sessionId ? 'true' : 'false');
	node.onclick = () => selectSession(run.id);

	const title = document.createElement('div');
	title.className = 'run-title';
	title.textContent = run.targetUrl ? hostOf(run.targetUrl) : run.title;

	const meta = document.createElement('div');
	meta.className = 'run-meta';
	const dot = document.createElement('span');
	dot.className = `dot${run.status === 'running' ? ' is-busy' : run.status === 'done' ? ' is-live' : ''}`;
	dot.setAttribute('aria-hidden', 'true');
	meta.append(dot, document.createTextNode(relativeTime(run.updatedAt)));
	if (run.mode === 'sqa') {
		const mode = document.createElement('span');
		mode.className = 'run-mode-badge';
		mode.textContent = 'SQA';
		mode.title = 'Software quality assurance assessment';
		meta.append(mode);
	}
	if (run.mode === 'founder') {
		const mode = document.createElement('span');
		mode.className = 'run-mode-badge run-mode-badge--founder';
		mode.textContent = 'Founder';
		mode.title = 'Founder Mode product and growth review';
		meta.append(mode);
	}
	if (run.findingCount > 0) {
		const badge = document.createElement('span');
		badge.className = 'run-badge';
		badge.textContent = `${run.findingCount}`;
		meta.append(badge);
	}
	if (run.device && run.device !== 'desktop') {
		const profile = deviceState.list.find(p => p.id === run.device);
		const pill = document.createElement('span');
		pill.className = 'run-device-pill';
		pill.dataset.deviceKind = profile?.kind ?? 'mobile';
		const short = (profile?.label ?? run.device).replace(/\s*\(.*\)$/, '');
		pill.textContent = short + (run.deviceLandscape ? ' – L' : '');
		pill.title = (profile?.label ?? run.device) + (run.deviceLandscape ? ' (landscape)' : '');
		meta.append(pill);
	}

	const remove = document.createElement('button');
	remove.className = 'run-del';
	remove.type = 'button';
	remove.textContent = '×';
	remove.title = 'Delete this run';
	remove.setAttribute('aria-label', `Delete run ${title.textContent}`);
	remove.onclick = async event => {
		event.stopPropagation();
		await api(`/sessions/${run.id}`, { method: 'DELETE' }).catch(fail);
		if (run.id === state.sessionId) {
			const remaining = await api('/sessions');
			await (remaining[0] ? selectSession(remaining[0].id) : startRun());
		} else {
			await refreshRuns();
		}
	};

	node.append(title, meta);
	row.append(node, remove);
	return row;
}

/* ── Session loading ─────────────────────────────────────────────── */

// ── Device emulation ─────────────────────────────────────────────
// We keep a single, persisted "device for the next run" preference. It flows
// into the QA quick-start, SQA modal, and Founder modal payloads, and the live
// preview picks up the current session's device from session.device so it can
// paint a phone/tablet bezel over the JPEG stream. No stream/DOM of the site
// under test is ever touched by this — the real emulation lives in
// server/deviceProfiles.js via Playwright newContext options.
const DEVICE_PREF_KEY = 'qase.device';
const deviceState = { list: [], defaultId: 'desktop' };

async function loadDevices() {
	try {
		const catalog = await api('/devices');
		deviceState.list = Array.isArray(catalog?.devices) ? catalog.devices : [];
		deviceState.defaultId = catalog?.default ?? 'desktop';
	} catch {
		deviceState.list = [{ id: 'desktop', label: 'Desktop', kind: 'desktop' }];
		deviceState.defaultId = 'desktop';
	}
	if (!el.deviceSelect) return;
	el.deviceSelect.innerHTML = '';
	for (const profile of deviceState.list) {
		const option = document.createElement('option');
		option.value = profile.id;
		option.textContent = profile.label;
		el.deviceSelect.append(option);
	}
	const saved = localStorage.getItem(DEVICE_PREF_KEY);
	el.deviceSelect.value = deviceState.list.some(p => p.id === saved) ? saved : deviceState.defaultId;
	el.deviceSelect.addEventListener('change', () => {
		localStorage.setItem(DEVICE_PREF_KEY, el.deviceSelect.value);
	});
	if (el.deviceLandscape) {
		el.deviceLandscape.checked = localStorage.getItem(DEVICE_LANDSCAPE_KEY) === '1';
		el.deviceLandscape.addEventListener('change', () => {
			localStorage.setItem(DEVICE_LANDSCAPE_KEY, el.deviceLandscape.checked ? '1' : '0');
		});
	}
}

function pendingDeviceId() {
	return (el.deviceSelect && el.deviceSelect.value) || localStorage.getItem(DEVICE_PREF_KEY) || deviceState.defaultId;
}

const DEVICE_LANDSCAPE_KEY = 'qase.deviceLandscape';
function pendingLandscape() {
	if (el.deviceLandscape) return Boolean(el.deviceLandscape.checked);
	return localStorage.getItem(DEVICE_LANDSCAPE_KEY) === '1';
}
function populateDeviceSelect(select, initialId) {
	if (!select) return;
	select.innerHTML = '';
	for (const profile of deviceState.list) {
		const option = document.createElement('option');
		option.value = profile.id;
		option.textContent = profile.label;
		select.append(option);
	}
	if (initialId && deviceState.list.some(p => p.id === initialId)) select.value = initialId;
}

function applyStageDevice(session) {
	if (!el.stage) return;
	const id = session?.device ?? 'desktop';
	const profile = deviceState.list.find(p => p.id === id);
	const kind = profile?.kind ?? 'desktop';
	if (kind === 'desktop') {
		el.stage.removeAttribute('data-device-kind');
		el.stage.removeAttribute('data-device-label');
	} else {
		el.stage.setAttribute('data-device-kind', kind);
		el.stage.setAttribute('data-device-label', profile?.label ?? id);
	}
}


async function selectSession(id) {
	state.sessionId = id;
	state.bubbles.clear();
	localStorage.setItem('qase.session', id);

	const session = await api(`/sessions/${id}`);
	if (state.sessionId !== id) return;
	applySessionSnapshot(session);
	await connect(id);
	await refreshRuns();
}

function applySessionSnapshot(session) {
	state.bubbles.clear();
	state.session = session;
	applyStageDevice(session);

	renderHeader();
	renderTranscript();
	resetThinking();
	renderQuestion();
	renderActivities();
	renderTodos();
	renderFindings();
	renderReport();
	syncSqaDetailMode();
	renderSqa();
	renderFounder();

	if (session.frame) {
		applyFrame(session.frame);
	} else {
		el.frame.removeAttribute('src');
		el.stageInner.hidden = true;
		el.stageEmpty.hidden = false;
		el.browserUrl.textContent = session.targetUrl ?? 'about:blank';
		el.browserTitle.textContent = '';
	}

}

async function startRun() { openQaStart(); }

async function createQaRun({ targetUrl, device, deviceLandscape }) {
	const session = await api('/sessions', { method: 'POST', body: JSON.stringify({ device, deviceLandscape }) });
	await selectSession(session.id);
	if (targetUrl) {
		await api(`/sessions/${session.id}/message`, { method: 'POST', body: JSON.stringify({ text: targetUrl }) }).catch(fail);
	}
	el.composerInput.focus();
	return session;
}

function renderHeader() {
	const session = state.session;
	if (session.mode === 'founder') {
		const target = session.founder?.scope?.target ?? session.founder?.report?.target ?? {};
		const context = session.founder?.scope?.productContext ?? {};
		el.chatTitle.textContent = target.name ?? session.title ?? 'Founder review';
		el.chatTarget.textContent = [context.stage, context.businessModel, target.environment].filter(Boolean).join(' · ')
			|| 'Evidence-informed product and go-to-market review';
		setStatus(session.status);
		return;
	}
	if (session.mode === 'sqa') {
		const target = session.sqa?.scope?.target ?? session.sqa?.assessment?.target ?? {};
		el.chatTitle.textContent = target.name ?? session.title ?? 'SQA assessment';
		el.chatTarget.textContent = [target.release, target.environment].filter(Boolean).join(' · ')
			|| 'Standards-informed software quality assessment';
		setStatus(session.status);
		return;
	}
	el.chatTitle.textContent = session.targetUrl ? hostOf(session.targetUrl) : session.title;
	el.chatTarget.textContent = session.targetUrl ?? 'Send a URL to begin';
	setStatus(session.status);
}

function setStatus(status) {
	el.statusChip.dataset.status = status;
	el.statusChip.textContent = status === 'awaiting_input' ? 'waiting for you' : status;
	const running = status === 'running';
	el.stopRun.hidden = !running;
	el.sendBtn.disabled = running;
	el.browserDot.className = `dot${running ? ' is-busy' : state.session?.targetUrl ? ' is-live' : ''}`;
	if (state.session) {
		state.session.status = status;
	}
	// A question raised while the tab is in the background should be noticeable.
	document.title = status === 'awaiting_input'
		? 'Qase — waiting for you'
		: 'Qase — autonomous QA agent';
	updateThinkingStrip();
}

/* ── Transcript ──────────────────────────────────────────────────── */

function renderTranscript() {
	el.transcript.replaceChildren();
	const messages = state.session.messages ?? [];
	if (messages.length === 0) {
		el.transcript.append(el.chatEmpty);
		el.chatEmpty.hidden = false;
		return;
	}
	el.chatEmpty.hidden = true;
	// Reasoning is live-only; anything stored by an earlier version is dropped.
	for (const message of messages.filter(entry => entry.role !== 'thinking')) {
		el.transcript.append(renderMessage(message));
	}
	requestAnimationFrame(() => {
		el.transcript.scrollTop = el.transcript.scrollHeight;
	});
}

function renderMessage(message) {
	const node = document.createElement('div');
	node.className = `msg ${message.role}${message.kind ? ` ${message.kind}` : ''}`;
	node.dataset.id = message.id;

	const role = document.createElement('div');
	role.className = 'msg-role';
	role.textContent = message.role === 'agent' ? 'Qase' : message.role === 'user' ? 'You' : 'System';

	const body = document.createElement('div');
	body.className = message.role === 'agent' ? 'msg-body md' : 'msg-body';
	if (message.role === 'agent') {
		body.innerHTML = markdown(message.text);
	} else {
		body.textContent = message.text;
	}

	node.append(role, body);
	state.bubbles.set(message.id, { node, body, text: message.text });
	return node;
}

/* ── Thinking strip ──────────────────────────────────────────────── */

/**
 * Shows what the agent is doing right now, directly above the composer, and
 * gets out of the way as soon as it has something to say. Reasoning text is
 * shown when the provider streams any; otherwise the current action stands in,
 * so the strip is never a spinner with nothing behind it.
 */
function updateThinkingStrip() {
	const running = state.session?.status === 'running';
	const { text, action } = state.thinking;

	if (!running) {
		el.thinkingStrip.hidden = true;
		el.thinkingStrip.classList.remove('is-open', 'has-detail');
		el.thinkingHead.setAttribute('aria-expanded', 'false');
		return;
	}

	el.thinkingStrip.hidden = false;
	el.thinkingLabel.textContent = text ? 'Thinking' : 'Working';
	el.thinkingPeek.textContent = text ? tailOf(text) : action;

	// Only reasoning is worth expanding; a one-line action is already complete.
	const hasDetail = Boolean(text);
	el.thinkingStrip.classList.toggle('has-detail', hasDetail);
	el.thinkingCaret.hidden = !hasDetail;
	if (hasDetail) {
		el.thinkingBody.textContent = text;
		if (el.thinkingStrip.classList.contains('is-open')) {
			el.thinkingBody.scrollTop = el.thinkingBody.scrollHeight;
		}
	} else {
		el.thinkingStrip.classList.remove('is-open');
	}
	el.thinkingHead.setAttribute('aria-expanded', String(el.thinkingStrip.classList.contains('is-open')));
}

/** Clears the live reasoning — called when the agent speaks or the turn ends. */
function resetThinking() {
	state.thinking = { text: '', action: '' };
	updateThinkingStrip();
}

/** The last readable fragment of a thought, for the collapsed one-line peek. */
function tailOf(text) {
	const clean = text.replace(/\s+/g, ' ').trim();
	return clean.length > 110 ? `…${clean.slice(-110)}` : clean;
}

/**
 * Routes a streamed chunk. Reasoning feeds the strip above the composer;
 * anything the agent actually says goes into its bubble and retires the strip.
 */
function appendDelta(id, content, role) {
	if (role === 'thinking') {
		state.thinking.text += content;
		updateThinkingStrip();
		return;
	}

	let bubble = state.bubbles.get(id);
	if (!bubble) {
		// The delta arrived before the message event; build the shell now.
		el.chatEmpty.hidden = true;
		el.transcript.append(renderMessage({ id, role: 'agent', text: '' }));
		bubble = state.bubbles.get(id);
	}

	bubble.text += content;
	bubble.body.innerHTML = markdown(bubble.text);
	resetThinking();
	scrollTranscript();
}

function scrollTranscript() {
	const nearBottom = el.transcript.scrollHeight - el.transcript.scrollTop - el.transcript.clientHeight < 160;
	if (nearBottom) {
		el.transcript.scrollTop = el.transcript.scrollHeight;
	}
}

/* ── Blocking question ───────────────────────────────────────────── */

function renderQuestion() {
	const question = state.session?.pendingQuestion;
	el.questionSlot.replaceChildren();
	if (!question) {
		return;
	}

	const card = document.createElement('div');
	card.className = 'question';

	const tag = document.createElement('span');
	tag.className = 'question-tag';
	tag.textContent = question.credentialLike ? 'Credentials needed' : 'Decision needed';

	const text = document.createElement('div');
	text.className = 'question-text';
	text.textContent = question.question;

	card.append(tag, text);

	if (question.summary) {
		const summary = document.createElement('div');
		summary.className = 'question-summary';
		summary.textContent = question.summary;
		card.append(summary);
	}

	card.append(question.credentialLike ? credentialForm() : optionForm(question));
	el.questionSlot.append(card);
	card.querySelector('input')?.focus();
}

function optionForm(question) {
	const wrap = document.createDocumentFragment();

	if (question.options.length > 0) {
		const options = document.createElement('div');
		options.className = 'question-options';
		for (const option of question.options) {
			const button = document.createElement('button');
			button.className = 'opt';
			button.type = 'button';
			button.textContent = option.label;
			if (option.description) {
				const small = document.createElement('small');
				small.textContent = option.description;
				button.append(small);
			}
			button.onclick = () => sendAnswer(option.label);
			options.append(button);
		}
		wrap.append(options);
	}

	if (question.allowCustom) {
		const form = document.createElement('form');
		form.className = 'cred-row';
			const input = document.createElement('input');
			input.placeholder = question.placeholder ?? 'Type your own answer';
			input.setAttribute('aria-label', question.placeholder ?? 'Type your own answer');
		const submit = document.createElement('button');
		submit.className = 'btn btn-primary btn-sm';
		submit.textContent = question.customLabel ?? 'Reply';
		form.append(input, submit);
		form.onsubmit = event => {
			event.preventDefault();
			if (input.value.trim()) {
				sendAnswer(input.value.trim());
			}
		};
		wrap.append(form);
	}

	return wrap;
}

/**
 * Credentials go straight to the vault, not into the answer text. The model is
 * told the placeholder names; the values never enter its context.
 */
function credentialForm() {
	const form = document.createElement('form');
	form.className = 'cred-form';

	const row = document.createElement('div');
	row.className = 'cred-row';
	const username = document.createElement('input');
	username.placeholder = 'Username or email';
	username.setAttribute('aria-label', 'Username or email');
	username.autocomplete = 'off';
	const password = document.createElement('input');
	password.type = 'password';
	password.placeholder = 'Password';
	password.setAttribute('aria-label', 'Password');
	password.autocomplete = 'off';
	row.append(username, password);

	const extra = document.createElement('input');
	extra.placeholder = 'One-time code or extra field (optional)';
	extra.setAttribute('aria-label', 'One-time code or extra field');
	extra.autocomplete = 'off';

	const note = document.createElement('div');
	note.className = 'cred-note';
	note.innerHTML = 'Held in this server\'s memory only — never written to disk, never sent to the model. ' +
		'The agent fills the form with <code>{{QA_USERNAME}}</code> and <code>{{QA_PASSWORD}}</code>; the real values are swapped in at the keyboard.';

	const actions = document.createElement('div');
	actions.className = 'cred-actions';
	const skip = document.createElement('button');
	skip.type = 'button';
	skip.className = 'btn btn-ghost btn-sm';
	skip.textContent = 'Skip login';
	skip.onclick = () => sendAnswer('Continue with a public-only review. No credentials are available. Treat authenticated surfaces as not observed, do not attempt login, and do not ask for credentials again during this review.');
	const submit = document.createElement('button');
	submit.type = 'submit';
	submit.className = 'btn btn-primary btn-sm';
	submit.textContent = 'Store and continue';
	actions.append(skip, submit);

	form.append(row, extra, note, actions);
	form.onsubmit = async event => {
		event.preventDefault();
		const fields = {};
		if (username.value) fields.QA_USERNAME = username.value;
		if (password.value) fields.QA_PASSWORD = password.value;
		if (extra.value) fields.QA_OTP = extra.value;
		if (Object.keys(fields).length === 0) {
			toast('Enter a username or password first.', 'bad');
			return;
		}
		el.questionSlot.replaceChildren();
		state.session.pendingQuestion = undefined;
		try {
			await api(`/sessions/${state.sessionId}/credentials`, { method: 'POST', body: JSON.stringify({ fields }) });
			toast('Credentials stored locally. The model only sees placeholders.', 'good');
		} catch (error) {
			fail(error);
		}
	};

	return form;
}

async function sendAnswer(answer) {
	el.questionSlot.replaceChildren();
	state.session.pendingQuestion = undefined;
	await api(`/sessions/${state.sessionId}/answer`, {
		method: 'POST',
		body: JSON.stringify({ answer })
	}).catch(fail);
}

/* ── Live browser view ───────────────────────────────────────────── */

/** Keeps the screenshot and its cursor overlay on the exact same aspect box. */
function fitStageFrame() {
	const { width, height } = state.viewport;
	if (!width || !height || !el.stage.clientWidth || !el.stage.clientHeight) return;

	const styles = getComputedStyle(el.stage);
	const availableWidth = el.stage.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight);
	const availableHeight = el.stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom);
	const ratio = width / height;
	let frameWidth = availableWidth;
	let frameHeight = frameWidth / ratio;
	if (frameHeight > availableHeight) {
		frameHeight = availableHeight;
		frameWidth = frameHeight * ratio;
	}

	el.stageInner.style.width = `${Math.max(1, frameWidth)}px`;
	el.stageInner.style.height = `${Math.max(1, frameHeight)}px`;
}

function applyFrame(frame) {
	el.frame.src = `data:${frame.mimeType};base64,${frame.base64}`;
	el.stageEmpty.hidden = true;
	el.stageInner.hidden = false;
	if (frame.viewport) {
		state.viewport = frame.viewport;
	}
	if (frame.url) {
		el.browserUrl.textContent = frame.url;
	}
	el.browserTitle.textContent = truncate(frame.title ?? '', 40);
	requestAnimationFrame(fitStageFrame);
}

/**
 * Places the cursor over the frame. Coordinates arrive in the page's viewport
 * space, so they are scaled to however large the image is actually drawn.
 */
function applyCursor(cursor) {
	if (cursor.viewport) {
		state.viewport = cursor.viewport;
	}
	const rect = el.frame.getBoundingClientRect();
	if (!rect.width || cursor.x === undefined) {
		return;
	}
	const scale = rect.width / state.viewport.width;

	el.cursor.style.left = `${cursor.x * scale}px`;
	el.cursor.style.top = `${cursor.y * scale}px`;
	el.cursor.classList.add('is-visible');
	el.cursorLabel.textContent = cursor.label ? truncate(String(cursor.label), 34) : '';

	if (cursor.box) {
		el.targetBox.style.left = `${cursor.box.x * scale}px`;
		el.targetBox.style.top = `${cursor.box.y * scale}px`;
		el.targetBox.style.width = `${cursor.box.width * scale}px`;
		el.targetBox.style.height = `${cursor.box.height * scale}px`;
		el.targetBox.classList.add('is-visible');
	} else {
		el.targetBox.classList.remove('is-visible');
	}

	// A completed pointer action flashes, then everything fades out.
	if (cursor.verb.endsWith(':done')) {
		el.ripple.classList.remove('is-firing');
		void el.ripple.offsetWidth;
		el.ripple.classList.add('is-firing');
		clearTimeout(state.cursorTimer);
		state.cursorTimer = setTimeout(() => {
			el.cursor.classList.remove('is-visible');
			el.targetBox.classList.remove('is-visible');
		}, 1500);
	}
}

/* ── Activity, plan, findings, report ────────────────────────────── */

function renderActivities() {
	const activities = state.session.activities ?? [];
	el.activityFeed.replaceChildren();
	if (activities.length === 0) {
		el.activityFeed.innerHTML = '<div class="feed-empty">Nothing yet</div>';
		return;
	}
	for (const activity of activities) {
		el.activityFeed.append(renderActivity(activity));
	}
	scrollFeed(el.activityFeed);
}

function renderActivity(activity) {
	const node = document.createElement('div');
	node.className = `act ${activity.status}`;
	node.setAttribute('role', 'listitem');
	node.dataset.id = activity.id;

	const icon = document.createElement('span');
	icon.className = 'act-icon';
	icon.setAttribute('aria-hidden', 'true');
	icon.textContent = activity.status === 'running' ? '◉' : activity.status === 'failed' ? '✕' : '●';

	const main = document.createElement('div');
	main.className = 'act-main';
	const label = document.createElement('div');
	label.className = 'act-label';
	label.textContent = activity.label;
	main.append(label);

	const detail = activity.error ?? activity.summary ?? activity.detail;
	if (detail) {
		const line = document.createElement('div');
		line.className = 'act-detail';
		line.textContent = detail;
		line.title = detail;
		main.append(line);
	}

	const time = document.createElement('span');
	time.className = 'act-time';
	time.textContent = new Date(activity.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

	node.append(icon, main, time);
	return node;
}

function scrollFeed(feed) {
	const pane = feed.parentElement;
	requestAnimationFrame(() => {
		pane.scrollTop = pane.scrollHeight;
	});
}

function upsertActivity(activity) {
	const existing = el.activityFeed.querySelector(`[data-id="${activity.id}"]`);
	const node = renderActivity(activity);
	if (existing) {
		existing.replaceWith(node);
		return;
	}
	if (el.activityFeed.querySelector('.feed-empty')) {
		el.activityFeed.replaceChildren();
	}
	el.activityFeed.append(node);
	scrollFeed(el.activityFeed);
}

function renderTodos() {
	const todos = state.session.todos ?? [];
	const done = todos.filter(todo => todo.status === 'completed').length;
	el.countPlan.textContent = todos.length > 0 ? `${done}/${todos.length}` : '';
	el.planList.replaceChildren();
	if (todos.length === 0) {
		el.planList.innerHTML = '<div class="feed-empty">The agent has not written a test plan yet</div>';
		return;
	}
	for (const todo of todos) {
		const node = document.createElement('div');
		node.className = `todo ${todo.status}`;
		node.setAttribute('role', 'listitem');
		const mark = document.createElement('span');
		mark.className = 'todo-mark';
		mark.textContent = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○';
		const text = document.createElement('span');
		text.className = 'todo-text';
		text.textContent = todo.text;
		node.append(mark, text);
		el.planList.append(node);
	}
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
let findingDisclosureSerial = 0;

function renderFindings() {
	const findings = state.session.findings ?? [];
	findingDisclosureSerial = 0;
	el.countFindings.textContent = findings.length > 0 ? `${findings.length}` : '';
	el.countFindings.classList.toggle('is-alert', findings.some(finding => finding.severity === 'critical'));

	el.findingsList.replaceChildren();
	if (findings.length === 0) {
		el.findingsList.innerHTML = '<div class="feed-empty">No findings filed yet</div>';
		return;
	}
	const sorted = [...findings].sort(
		(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
	);
	for (const finding of sorted) {
		el.findingsList.append(renderFinding(finding));
	}
}

function renderFinding(finding) {
	const node = document.createElement('article');
	node.className = 'finding';
	node.dataset.sev = finding.severity;
	node.setAttribute('role', 'listitem');

	const head = document.createElement('button');
	head.className = 'finding-head';
	head.type = 'button';
	head.setAttribute('aria-expanded', 'false');
	const disclosureId = `finding-body-${++findingDisclosureSerial}`;
	head.setAttribute('aria-controls', disclosureId);
	const title = document.createElement('span');
	title.className = 'finding-title';
	title.textContent = finding.title;
	const sev = document.createElement('span');
	sev.className = 'sev';
	sev.textContent = finding.severity;
	const chevron = document.createElement('span');
	chevron.className = 'finding-chevron';
	chevron.setAttribute('aria-hidden', 'true');
	chevron.textContent = '›';
	head.append(title, sev, chevron);
	head.onclick = () => {
		const open = node.classList.toggle('is-open');
		head.setAttribute('aria-expanded', String(open));
	};

	const body = document.createElement('div');
	body.className = 'finding-body';
	body.id = disclosureId;

	const meta = document.createElement('div');
	meta.className = 'finding-meta';
	meta.textContent = [finding.category, finding.url].filter(Boolean).join(' · ');
	body.append(meta);

	if (finding.steps?.length) {
		const steps = document.createElement('ol');
		for (const step of finding.steps) {
			const item = document.createElement('li');
			item.textContent = step;
			steps.append(item);
		}
		body.append(steps);
	}

	const list = document.createElement('dl');
	for (const [term, value] of [['Expected', finding.expected], ['Actual', finding.actual]]) {
		const dt = document.createElement('dt');
		dt.textContent = term;
		const dd = document.createElement('dd');
		dd.textContent = value;
		list.append(dt, dd);
	}
	body.append(list);

	if (finding.evidence) {
		const pre = document.createElement('pre');
		pre.textContent = finding.evidence;
		body.append(pre);
	}

	const fixPrompt = buildFindingFixPrompt(finding, {
		targetUrl: state.session?.targetUrl,
		mode: state.session?.mode
	});
	const fixWrap = document.createElement('section');
	fixWrap.className = 'finding-fix-prompt';
	const fixHead = document.createElement('div');
	fixHead.className = 'finding-fix-prompt-head';
	const fixTitle = document.createElement('h4');
	fixTitle.textContent = 'Fix prompt';
	const fixHint = document.createElement('span');
	fixHint.className = 'finding-fix-prompt-hint';
	fixHint.textContent = 'Paste into your coding agent (Cursor / Claude Code / Copilot / Codex).';
	fixHead.append(fixTitle, fixHint);
	const fixText = document.createElement('pre');
	fixText.className = 'finding-fix-prompt-body';
	fixText.textContent = fixPrompt;
	fixWrap.append(fixHead, fixText);
	body.append(fixWrap);

	const actions = document.createElement('div');
	actions.className = 'finding-actions';
	const copy = document.createElement('button');
	copy.className = 'btn btn-ghost btn-sm';
	copy.type = 'button';
	copy.textContent = 'Copy as ticket';
	copy.onclick = async () => {
		try { await navigator.clipboard.writeText(findingAsTicket(finding)); toast('Finding copied to the clipboard.', 'good'); }
		catch { toast('Clipboard is blocked in this browser.', 'bad'); }
	};
	const copyPrompt = document.createElement('button');
	copyPrompt.className = 'btn btn-primary btn-sm finding-fix';
	copyPrompt.type = 'button';
	copyPrompt.textContent = 'Copy fix prompt';
	copyPrompt.title = 'Copies the diagnose-and-fix prompt above for one coding agent.';
	copyPrompt.onclick = async () => {
		try { await navigator.clipboard.writeText(fixPrompt); toast('Fix prompt copied.', 'good'); }
		catch { toast('Clipboard is blocked in this browser.', 'bad'); }
	};
	actions.append(copy, copyPrompt);
	body.append(actions);

	node.append(head, body);
	return node;
}

function findingAsTicket(finding) {
	return [
		`[${finding.severity.toUpperCase()}] ${finding.title}`,
		'',
		finding.url && `URL: ${finding.url}`,
		finding.category && `Area: ${finding.category}`,
		'',
		finding.steps?.length && `Steps to reproduce:\n${finding.steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
		'',
		`Expected: ${finding.expected}`,
		`Actual: ${finding.actual}`,
		finding.evidence && `\nEvidence:\n${finding.evidence}`
	].filter(Boolean).join('\n');
}

const VERDICTS = {
	pass: { mark: '✓', label: 'Pass', tone: 'ok' },
	pass_with_issues: { mark: '!', label: 'Pass with issues', tone: 'warn' },
	fail: { mark: '✕', label: 'Fail', tone: 'bad' },
	blocked: { mark: '—', label: 'Blocked', tone: 'dim' }
};

function renderReport() {
	el.reportView.replaceChildren();
	if (state.session?.mode === 'sqa') {
		renderSqaReportTab();
		return;
	}
	if (state.session?.mode === 'founder') {
		renderFounderReportTab();
		return;
	}

	const report = state.session.report;
	if (!report) {
		el.reportView.innerHTML = '<div class="feed-empty">The report is published when the run finishes</div>';
		return;
	}

	const verdict = VERDICTS[report.verdict] ?? { mark: '•', label: report.verdict, tone: 'dim' };
	const banner = document.createElement('div');
	banner.className = 'verdict';
	const mark = document.createElement('span');
	mark.className = `verdict-mark is-${verdict.tone}`;
	mark.textContent = verdict.mark;
	const text = document.createElement('div');
	const label = document.createElement('div');
	label.className = 'verdict-label';
	label.textContent = verdict.label;
	const sub = document.createElement('div');
	sub.className = 'verdict-sub';
	sub.textContent = `${report.findings} finding${report.findings === 1 ? '' : 's'} · ${new Date(report.ts).toLocaleString()}`;
	text.append(label, sub);
	banner.append(mark, text);
	el.reportView.append(banner);

	const stats = document.createElement('div');
	stats.className = 'sev-grid';
	for (const severity of SEVERITY_ORDER) {
		const count = report.bySeverity?.[severity] ?? 0;
		const stat = document.createElement('div');
		stat.className = `sev-stat${count === 0 ? ' is-zero' : ''}`;
		const value = document.createElement('b');
		value.textContent = count;
		const name = document.createElement('span');
		name.textContent = severity;
		stat.append(value, name);
		stats.append(stat);
	}
	el.reportView.append(stats);

	el.reportView.append(section('Summary', paragraph(report.summary)));
	if (report.covered?.length) el.reportView.append(section('Covered', list(report.covered)));
	if (report.notCovered?.length) el.reportView.append(section('Not covered', list(report.notCovered)));
	if (report.recommendations?.length) el.reportView.append(section('Recommendations', list(report.recommendations)));

	const actions = document.createElement('div');
	actions.className = 'report-actions';
	const download = document.createElement('button');
	download.className = 'btn btn-ghost btn-sm';
	download.type = 'button';
	download.textContent = 'Download .md';
	download.onclick = async () => {
		try {
			const markdownText = await apiText(`/sessions/${state.sessionId}/report.md`);
			const url = URL.createObjectURL(new Blob([markdownText], { type: 'text/markdown;charset=utf-8' }));
			const save = document.createElement('a');
			save.href = url;
			save.download = 'qase-report.md';
			document.body.append(save);
			save.click();
			save.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (error) {
			fail(error);
		}
	};
	const copy = document.createElement('button');
	copy.className = 'btn btn-ghost btn-sm';
	copy.type = 'button';
	copy.textContent = 'Copy report';
	copy.onclick = async () => {
		try {
			const markdownText = await apiText(`/sessions/${state.sessionId}/report.md`);
			await navigator.clipboard.writeText(markdownText);
			toast('Report copied to the clipboard.', 'good');
		} catch (error) {
			fail(error);
		}
	};
	const pdf = document.createElement('button');
	pdf.className = 'btn btn-primary btn-sm';
	pdf.type = 'button';
	pdf.textContent = 'Download PDF';
	pdf.onclick = async () => { try { await downloadReportPdf('qase-qa-report.pdf'); } catch (error) { fail(error); } };

	const findings = Array.isArray(state.session?.findings) ? state.session.findings : [];
	const copyFixes = document.createElement('button');
	copyFixes.className = 'btn btn-ghost btn-sm';
	copyFixes.type = 'button';
	copyFixes.textContent = 'Copy all fix prompts';
	copyFixes.disabled = findings.length === 0;
	copyFixes.title = findings.length === 0
		? 'No findings to generate fix prompts for.'
		: 'Copies one long markdown block containing a fix prompt for every finding.';
	copyFixes.onclick = async () => {
		const markdown = buildAllFixPromptsMarkdown(state.session);
		if (!markdown) { toast('No findings to build fix prompts from.', 'bad'); return; }
		try { await navigator.clipboard.writeText(markdown); toast('All fix prompts copied.', 'good'); }
		catch { toast('Clipboard is blocked in this browser.', 'bad'); }
	};
	const downloadFixes = document.createElement('button');
	downloadFixes.className = 'btn btn-ghost btn-sm';
	downloadFixes.type = 'button';
	downloadFixes.textContent = 'Download fix prompts (.md)';
	downloadFixes.disabled = findings.length === 0;
	downloadFixes.onclick = () => {
		const markdown = buildAllFixPromptsMarkdown(state.session);
		if (!markdown) { toast('No findings to build fix prompts from.', 'bad'); return; }
		const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
		const save = document.createElement('a');
		save.href = url;
		save.download = 'qase-fix-prompts.md';
		document.body.append(save);
		save.click();
		save.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
	};

	actions.append(download, copy, copyFixes, downloadFixes, pdf);
	el.reportView.append(actions);
}

function renderSqaReportTab() {
	const sqa = state.session?.sqa ?? {};
	const assessment = sqa.assessment;
	const lifecycle = describeSqaLifecycle(sqa, state.session?.status, state.session?.activities?.length ?? 0);
	if (!lifecycle.finalized || !assessment) {
		const pending = document.createElement('div');
		pending.className = 'feed-empty';
		pending.textContent = lifecycle.detail || 'The SQA report is available after the assessment is finalized.';
		el.reportView.append(pending);
		return;
	}

	const notice = document.createElement('aside');
	notice.className = 'sqa-notice';
	const noticeTitle = document.createElement('strong');
	noticeTitle.textContent = 'SQA assessment report';
	const noticeText = document.createElement('p');
	noticeText.textContent = assessment.disclaimer
		?? 'This scoped engineering assessment is not legal advice, regulatory approval, accreditation, an audit opinion, or certification.';
	notice.append(noticeTitle, noticeText);

	el.reportView.append(notice, renderSqaVerdict(assessment, lifecycle), renderSqaScope(sqa.scope ?? {}, assessment));
	if (assessment.technicalSummary) el.reportView.append(renderSqaTechnicalSummary(assessment.technicalSummary));
	el.reportView.append(
		renderSqaCoverage(assessment),
		renderSqaUnresolved(assessment),
		renderSqaControls(assessment.results ?? []),
		renderSqaSources(assessment.frameworkCoverage ?? []),
		renderSqaReportActions()
	);
}

/* ── Event stream ────────────────────────────────────────────────── */

/* ── Software quality assurance ─────────────────────────────────────────── */

const SQA_RESULT_META = Object.freeze({
	pass: { label: 'Pass', mark: '✓' },
	fail: { label: 'Fail', mark: '×' },
	blocked: { label: 'Blocked', mark: '!' },
	not_assessed: { label: 'Not assessed', mark: '—' },
	not_applicable: { label: 'Not applicable', mark: '—' }
});

function humanizeSqaId(value) {
	return String(value ?? '')
		.replaceAll('_', ' ')
		.replace(/\b\w/g, character => character.toUpperCase());
}

function sqaValues(value) {
	if (Array.isArray(value)) return value;
	if (value && typeof value === 'object') return Object.values(value);
	return [];
}

function syncSqaDetailMode() {
	const isSqa = state.session?.mode === 'sqa';
	const isFounder = state.session?.mode === 'founder';
	el.sqaTab.hidden = !isSqa;
	el.founderTab.hidden = !isFounder;
	if (isSqa && !el.sqaTab.classList.contains('is-active')) {
		activateDetailTab(el.sqaTab);
	} else if (isFounder && !el.founderTab.classList.contains('is-active')) {
		activateDetailTab(el.founderTab);
	} else if ((!isSqa && el.sqaTab.classList.contains('is-active'))
		|| (!isFounder && el.founderTab.classList.contains('is-active'))) {
		activateDetailTab(el.activityTab);
	}
	syncFeatureDock();
}

function syncFeatureDock() {
	const activeMode = state.session?.mode === 'sqa' || state.session?.mode === 'founder'
		? state.session.mode
		: 'qa';
	for (const action of document.querySelectorAll('.feature-action')) {
		const active = action.dataset.feature === activeMode;
		action.classList.toggle('is-active', active);
		if (active) action.setAttribute('aria-current', 'page');
		else action.removeAttribute('aria-current');
	}
}

function renderSqa() {
	el.sqaView.replaceChildren();
	if (state.session?.mode !== 'sqa') {
		el.countSqa.textContent = '';
		return;
	}

	const sqa = state.session.sqa ?? {};
	const scope = sqa.scope ?? {};
	const assessment = sqa.assessment;
	const lifecycle = describeSqaLifecycle(sqa, state.session.status, state.session.activities?.length ?? 0);
	el.countSqa.textContent = lifecycle.badge;

	const notice = document.createElement('aside');
	notice.className = 'sqa-notice';
	const noticeTitle = document.createElement('strong');
	noticeTitle.textContent = 'Assessment boundary';
	const noticeText = document.createElement('p');
	noticeText.textContent = assessment?.disclaimer ?? scope.disclaimer
		?? 'This scoped engineering assessment is not legal advice, regulatory approval, accreditation, an audit opinion, or certification.';
	notice.append(noticeTitle, noticeText);
	el.sqaView.append(notice);

	el.sqaView.append(renderSqaVerdict(assessment, lifecycle));
	el.sqaView.append(renderSqaScope(scope, assessment));
	if (lifecycle.finalized && assessment) el.sqaView.append(renderSqaReportActions());

	if (!lifecycle.finalized && lifecycle.phase === 'ready') {
		const pending = document.createElement('div');
		pending.className = 'sqa-pending';
		const label = document.createElement('strong');
		label.textContent = 'Ready to begin';
		const text = document.createElement('p');
		text.textContent = 'Paste the target URL in the command line below and press Send. A final pass, fail, or blocked verdict appears only after the agent completes the assessment.';
		pending.append(label, text);
		el.sqaView.append(pending);
		return;
	}
	if (!assessment) return;

	if (assessment.technicalSummary) el.sqaView.append(renderSqaTechnicalSummary(assessment.technicalSummary));
	el.sqaView.append(renderSqaCoverage(assessment));
	el.sqaView.append(renderSqaUnresolved(assessment));
	el.sqaView.append(renderSqaControls(assessment.results ?? []));
	el.sqaView.append(renderSqaSources(assessment.frameworkCoverage ?? []));
}

function renderSqaReportActions() {
	const actions = document.createElement('div');
	actions.className = 'report-actions sqa-report-actions';
	actions.setAttribute('aria-label', 'SQA assessment report actions');

	const download = document.createElement('button');
	download.className = 'btn btn-ghost btn-sm';
	download.type = 'button';
	download.textContent = 'Download .md';
	download.onclick = async () => {
		try {
			const markdownText = await apiText(`/sessions/${state.sessionId}/report.md`);
			const url = URL.createObjectURL(new Blob([markdownText], { type: 'text/markdown;charset=utf-8' }));
			const save = document.createElement('a');
			save.href = url;
			save.download = 'qase-sqa-assessment.md';
			document.body.append(save);
			save.click();
			save.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
		} catch (error) {
			fail(error);
		}
	};

	const copy = document.createElement('button');
	copy.className = 'btn btn-ghost btn-sm';
	copy.type = 'button';
	copy.textContent = 'Copy report';
	copy.onclick = async () => {
		try {
			const markdownText = await apiText(`/sessions/${state.sessionId}/report.md`);
			await navigator.clipboard.writeText(markdownText);
			toast('SQA assessment copied to the clipboard.', 'good');
		} catch (error) {
			fail(error);
		}
	};

	const pdf = document.createElement('button');
	pdf.className = 'btn btn-primary btn-sm';
	pdf.type = 'button';
	pdf.textContent = 'Download PDF';
	pdf.onclick = async () => {
		try { await downloadReportPdf('qase-sqa-assessment.pdf'); }
		catch (error) { fail(error); }
	};
	actions.append(download, copy, pdf);
	return actions;
}

function renderSqaVerdict(assessment, lifecycle) {
	const node = document.createElement('section');
	node.className = 'sqa-verdict';
	node.dataset.status = lifecycle.status;

	const mark = document.createElement('span');
	mark.className = 'sqa-verdict-mark';
	mark.setAttribute('aria-hidden', 'true');
	mark.textContent = lifecycle.mark;

	const body = document.createElement('div');
	const eyebrow = document.createElement('span');
	eyebrow.className = 'sqa-eyebrow';
	eyebrow.textContent = lifecycle.eyebrow;
	const title = document.createElement('strong');
	title.textContent = lifecycle.label;
	const detail = document.createElement('p');
	if (lifecycle.finalized && assessment) {
		if (lifecycle.evidenceIncomplete) {
			detail.textContent = `Deterministic verdict: Blocked. No control failures were recorded; ${lifecycle.evidenceGapCount} reviewer or mixed-evidence control${lifecycle.evidenceGapCount === 1 ? '' : 's'} remain incomplete.`;
		} else {
			const gates = assessment.gates ?? [];
			const passed = gates.filter(gate => gate.status === 'pass').length;
			const risk = assessment.risk?.level ? ` Residual risk: ${humanizeSqaId(assessment.risk.level)}.` : '';
			detail.textContent = `${passed}/${gates.length} decision gates passed.${risk}`;
		}
	} else if (lifecycle.phase === 'ready') {
		detail.textContent = 'The scope is saved. Testing has not started and no final verdict exists yet.';
	} else if (lifecycle.phase === 'waiting') {
		detail.textContent = 'Answer the agent\'s question to continue collecting assessment evidence.';
	} else {
		detail.textContent = 'Evidence collection is underway. Current control results remain provisional.';
	}
	body.append(eyebrow, title, detail);

	const id = document.createElement('code');
	id.className = 'sqa-assessment-id';
	id.textContent = lifecycle.finalized ? (assessment?.assessmentId ?? 'result-unavailable') : 'draft-assessment';
	node.append(mark, body, id);
	return node;
}

function renderSqaTechnicalSummary(summary) {
	const applicable = Number(summary?.applicableControls) || 0;
	const verdict = summary?.verdict ?? 'not_applicable';
	const meta = SQA_RESULT_META[verdict] ?? { label: humanizeSqaId(verdict), mark: '•' };
	const node = sqaSection(
		'Automated web checks',
		applicable ? `${applicable} controlled-browser check${applicable === 1 ? '' : 's'} evaluated separately from reviewer evidence.` : 'No automated web checks applied to this scope.'
	);
	node.classList.add('sqa-technical');

	const summaryRow = document.createElement('div');
	summaryRow.className = 'sqa-technical-summary';
	summaryRow.dataset.status = verdict;
	const status = document.createElement('span');
	status.className = 'sqa-status';
	status.textContent = meta.label;
	const copy = document.createElement('p');
	copy.textContent = verdict === 'pass'
		? 'All applicable browser checks completed successfully.'
		: verdict === 'fail'
			? 'At least one automated browser check produced an evidence-backed failure.'
			: verdict === 'blocked'
				? 'At least one automated browser check could not complete or lacks technical evidence.'
				: 'This assessment scope contains no automated web controls.';
	summaryRow.append(status, copy);
	node.append(summaryRow);

	const counts = document.createElement('dl');
	counts.className = 'sqa-technical-counts';
	for (const [label, key] of [['Passed', 'pass'], ['Failed', 'fail'], ['Blocked', 'blocked'], ['Not run', 'not_assessed']]) {
		const item = document.createElement('div');
		const value = document.createElement('dd');
		value.textContent = String(Number(summary?.[key]) || 0);
		const term = document.createElement('dt');
		term.textContent = label;
		item.append(value, term);
		counts.append(item);
	}
	node.append(counts);
	return node;
}

function renderSqaScope(scope, assessment) {
	const target = assessment?.target ?? scope.target ?? {};
	const profiles = assessment?.profiles ?? scope.profiles ?? [];
	const attributes = assessment?.attributes ?? scope.attributes ?? [];
	const node = sqaSection('Assessment scope', 'Target, release, and declared applicability inputs.');
	const grid = document.createElement('dl');
	grid.className = 'sqa-scope-grid';
	appendSqaDefinition(grid, 'Target', target.name ?? state.session.title ?? 'Not provided');
	appendSqaDefinition(grid, 'Release', target.release ?? 'Not provided');
	appendSqaDefinition(grid, 'Environment', target.environment ?? 'Not provided');
	appendSqaDefinition(grid, 'Catalog', assessment?.catalogVersion ?? scope.catalogVersion ?? 'Current server catalog');
	appendSqaDefinition(grid, 'Profiles', profiles.length ? profiles.map(humanizeSqaId).join(', ') : 'Universal core');
	appendSqaDefinition(grid, 'Attributes', attributes.length ? attributes.map(humanizeSqaId).join(', ') : 'None declared');
	node.append(grid);

	const notesText = assessment?.scopeNotes ?? scope.scopeNotes;
	if (notesText) {
		const notes = document.createElement('p');
		notes.className = 'sqa-scope-notes';
		notes.textContent = notesText;
		node.append(notes);
	}
	return node;
}

function appendSqaDefinition(listNode, term, value) {
	const dt = document.createElement('dt');
	dt.textContent = term;
	const dd = document.createElement('dd');
	dd.textContent = String(value);
	listNode.append(dt, dd);
}

function renderSqaCoverage(assessment) {
	const node = sqaSection('Coverage and decision gates', 'Conclusive results require pass or fail; blocked and not assessed remain unresolved.');
	const metrics = document.createElement('div');
	metrics.className = 'sqa-metric-grid';
	for (const [label, value] of [
		['Observed controls', assessment.coverage?.observed],
		['Conclusive controls', assessment.coverage?.conclusive],
		['Mandatory passed', assessment.coverage?.mandatoryPassed],
		['Evidence satisfied', assessment.coverage?.evidence]
	]) {
		metrics.append(renderSqaMetric(label, value));
	}
	node.append(metrics);

	const gates = document.createElement('div');
	gates.className = 'sqa-gates';
	for (const gate of assessment.gates ?? []) {
		const row = document.createElement('div');
		row.className = 'sqa-gate';
		row.dataset.status = gate.status;
		const status = document.createElement('span');
		status.className = 'sqa-status';
		status.textContent = SQA_RESULT_META[gate.status]?.label ?? humanizeSqaId(gate.status);
		const content = document.createElement('div');
		const title = document.createElement('strong');
		title.textContent = gate.title;
		const detail = document.createElement('p');
		detail.textContent = gate.detail ?? '';
		content.append(title, detail);
		row.append(status, content);
		gates.append(row);
	}
	node.append(gates);
	return node;
}

function renderSqaMetric(label, value) {
	const numeric = Number(value);
	const percent = Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
	const card = document.createElement('div');
	card.className = 'sqa-metric';
	const head = document.createElement('div');
	const name = document.createElement('span');
	name.textContent = label;
	const amount = document.createElement('strong');
	amount.textContent = Number.isFinite(numeric) ? `${numeric}%` : '—';
	head.append(name, amount);
	const track = document.createElement('span');
	track.className = 'sqa-meter';
	const fill = document.createElement('i');
	fill.style.width = `${percent}%`;
	track.append(fill);
	card.append(head, track);
	return card;
}

function renderSqaUnresolved(assessment) {
	const unresolved = (assessment.results ?? []).filter(result => result.status !== 'pass');
	const groups = groupSqaUnresolvedResults(assessment.results);
	const evidenceGaps = groups.reviewer.length + groups.mixed.length;
	const node = sqaSection('Failures and evidence gaps', `${groups.failures.length} failed · ${evidenceGaps} reviewer/mixed evidence gaps · ${groups.automated.length} automated incomplete`);

	if (unresolved.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'sqa-section-empty';
		empty.textContent = 'No unresolved controls in this assessment.';
		node.append(empty);
		return node;
	}

	const list = document.createElement('div');
	list.className = 'sqa-unresolved-groups';
	for (const group of [
		{ title: 'Confirmed failures', description: 'Evidence-backed control failures that affect the product verdict.', results: groups.failures, kind: 'failures' },
		{ title: 'Reviewer evidence required', description: 'Documents, approvals, records, or independent review must be supplied by an authorized reviewer.', results: groups.reviewer, kind: 'reviewer' },
		{ title: 'Mixed evidence incomplete', description: 'This control combines browser-observable checks with external reviewer artifacts.', results: groups.mixed, kind: 'mixed' },
		{ title: 'Automated check blocked / not run', description: 'The controlled browser check did not complete or lacks agent-capable technical evidence.', results: groups.automated, kind: 'automated' }
	]) {
		if (!group.results.length) continue;
		const section = document.createElement('section');
		section.className = 'sqa-unresolved-group';
		section.dataset.kind = group.kind;
		const heading = document.createElement('h4');
		heading.textContent = `${group.title} (${group.results.length})`;
		const description = document.createElement('p');
		description.className = 'sqa-unresolved-group-description';
		description.textContent = group.description;
		const rows = document.createElement('div');
		rows.className = 'sqa-unresolved-list';
		for (const result of group.results) rows.append(renderSqaUnresolvedRow(result));
		section.append(heading, description, rows);
		list.append(section);
	}
	node.append(list);
	return node;
}

function renderSqaUnresolvedRow(result) {
	const row = document.createElement('div');
	row.className = 'sqa-unresolved';
	row.dataset.status = result.status;
	const status = document.createElement('span');
	status.className = 'sqa-status';
	status.textContent = SQA_RESULT_META[result.status]?.label ?? humanizeSqaId(result.status);
	const body = document.createElement('div');
	const title = document.createElement('strong');
	title.textContent = `${result.controlId} · ${result.title}`;
	const reason = document.createElement('p');
	const missing = result.evidenceCoverage?.missing ?? [];
	reason.textContent = result.decisionNotes?.[0] ?? result.rationale
		?? (missing.length ? `Missing evidence: ${missing.join(', ')}.` : 'A conclusive evidence-backed result is not available.');
	body.append(title, reason);
	row.append(status, body);
	return row;
}

function renderSqaControls(results) {
	const node = sqaSection('Control results', `${results.length} applicable control${results.length === 1 ? '' : 's'}`);
	const list = document.createElement('div');
	list.className = 'sqa-control-list';
	for (const result of results) list.append(renderSqaControl(result));
	if (!results.length) {
		const empty = document.createElement('p');
		empty.className = 'sqa-section-empty';
		empty.textContent = 'No control results were returned.';
		list.append(empty);
	}
	node.append(list);
	return node;
}

function renderSqaControl(result) {
	const item = document.createElement('details');
	item.className = 'sqa-control';
	item.dataset.status = result.status;
	const summary = document.createElement('summary');
	const id = document.createElement('code');
	id.textContent = result.controlId;
	const title = document.createElement('span');
	title.textContent = result.title;
	const status = document.createElement('span');
	status.className = 'sqa-status';
	status.textContent = SQA_RESULT_META[result.status]?.label ?? humanizeSqaId(result.status);
	summary.append(id, title, status);

	const body = document.createElement('div');
	body.className = 'sqa-control-body';
	const meta = document.createElement('p');
	meta.className = 'sqa-control-meta';
	meta.textContent = `${humanizeSqaId(result.domain)} · ${humanizeSqaId(result.severity)} severity · ${humanizeSqaId(result.automationLevel)}${result.mandatory ? ' · Mandatory' : ''}`;
	body.append(meta);
	if (result.rationale) body.append(sqaLabeledText('Rationale', result.rationale));
	for (const note of result.decisionNotes ?? []) body.append(sqaLabeledText('Decision note', note));

	const evidenceTitle = document.createElement('h4');
	evidenceTitle.textContent = `Evidence (${result.evidenceCoverage?.satisfied ?? 0}/${result.evidenceCoverage?.required ?? 0} requirements)`;
	body.append(evidenceTitle);
	const evidence = result.evidence ?? [];
	if (!evidence.length) {
		const none = document.createElement('p');
		none.className = 'sqa-section-empty';
		none.textContent = 'No evidence artifact was attached.';
		body.append(none);
	} else {
		const evidenceList = document.createElement('ul');
		evidenceList.className = 'sqa-evidence-list';
		for (const artifact of evidence) {
			const entry = document.createElement('li');
			const type = document.createElement('strong');
			type.textContent = humanizeSqaId(artifact.type);
			const reference = safeSqaLink(artifact.reference, artifact.reference);
			entry.append(type, reference);
			if (artifact.summary) {
				const description = document.createElement('span');
				description.textContent = artifact.summary;
				entry.append(description);
			}
			evidenceList.append(entry);
		}
		body.append(evidenceList);
	}

	const requirements = result.evidenceCoverage?.requirements ?? [];
	if (requirements.length) {
		const requirementsList = document.createElement('ul');
		requirementsList.className = 'sqa-requirement-list';
		for (const requirement of requirements) {
			const entry = document.createElement('li');
			entry.dataset.satisfied = String(Boolean(requirement.satisfied));
			entry.textContent = `${requirement.satisfied ? '✓' : '○'} ${requirement.description}`;
			requirementsList.append(entry);
		}
		body.append(requirementsList);
	}

	if (result.sources?.length) {
		const sources = document.createElement('div');
		sources.className = 'sqa-source-tags';
		for (const source of result.sources) {
			const tag = document.createElement('code');
			tag.textContent = source;
			sources.append(tag);
		}
		body.append(sources);
	}
	item.append(summary, body);
	return item;
}

function renderSqaSources(frameworks) {
	const node = sqaSection('Source coverage', 'Control crosswalk coverage; source publications remain authoritative.');
	const grid = document.createElement('div');
	grid.className = 'sqa-source-grid';
	for (const framework of frameworks) {
		const card = document.createElement('article');
		card.className = 'sqa-source-card';
		card.dataset.status = framework.status;
		const title = safeSqaLink(framework.title ?? framework.sourceId, framework.url);
		title.classList.add('sqa-source-title');
		const meta = document.createElement('p');
		meta.textContent = `${framework.controls ?? 0} mapped controls · ${framework.coverage ?? 0}% conclusive`;
		const status = document.createElement('span');
		status.className = 'sqa-status';
		status.textContent = SQA_RESULT_META[framework.status]?.label ?? humanizeSqaId(framework.status);
		card.append(title, meta, status);
		grid.append(card);
	}
	if (!frameworks.length) {
		const empty = document.createElement('p');
		empty.className = 'sqa-section-empty';
		empty.textContent = 'No source crosswalk was returned.';
		grid.append(empty);
	}
	node.append(grid);
	return node;
}

function sqaSection(titleText, subtitleText) {
	const node = document.createElement('section');
	node.className = 'sqa-section';
	const head = document.createElement('header');
	const title = document.createElement('h3');
	title.textContent = titleText;
	const subtitle = document.createElement('p');
	subtitle.textContent = subtitleText;
	head.append(title, subtitle);
	node.append(head);
	return node;
}

function sqaLabeledText(labelText, text) {
	const node = document.createElement('p');
	const label = document.createElement('strong');
	label.textContent = `${labelText}: `;
	node.append(label, document.createTextNode(text));
	return node;
}

function safeSqaLink(label, href) {
	let safeUrl;
	try {
		const candidate = new URL(String(href ?? ''));
		if (['http:', 'https:'].includes(candidate.protocol)) safeUrl = candidate.href;
	} catch {
		// Render untrusted references as text rather than active links.
	}
	const node = document.createElement(safeUrl ? 'a' : 'span');
	node.textContent = String(label ?? href ?? 'Reference');
	if (safeUrl) {
		node.href = safeUrl;
		node.target = '_blank';
		node.rel = 'noreferrer noopener';
	}
	return node;
}

function connect(id) {
	state.stream?.close();
	const stream = new EventSource(`/api/sessions/${id}/events`);
	state.stream = stream;
	let finishReady;
	const ready = new Promise(resolve => { finishReady = resolve; });
	// An unavailable stream must not lock the workspace; EventSource will keep
	// reconnecting. Healthy launchers wait for subscription before starting work.
	const timer = setTimeout(finishReady, 5000);
	const connected = () => { clearTimeout(timer); finishReady(); };
	let eventRevision = 0;
	let resyncTimer;
	const resync = async () => {
		if (state.stream !== stream || state.sessionId !== id) return;
		const revision = eventRevision;
		try {
			const snapshot = await api(`/sessions/${id}`);
			if (state.stream !== stream || state.sessionId !== id) return;
			// Never overwrite events that arrived while the snapshot was in flight.
			// Retry after a quiet interval; EventSource keeps applying live updates.
			if (revision !== eventRevision) {
				resyncTimer = setTimeout(resync, 250);
				return;
			}
			applySessionSnapshot(snapshot);
		} catch {
			if (state.stream === stream) resyncTimer = setTimeout(resync, 1000);
		} finally {
			connected();
		}
	};

	stream.onopen = () => {
		if (state.stream !== stream) return;
		el.connDot.className = 'dot is-live';
		el.connLabel.textContent = 'connected';
		clearTimeout(resyncTimer);
		void resync();
	};
	stream.onerror = () => {
		connected();
		clearTimeout(resyncTimer);
		if (state.stream !== stream) return;
		el.connDot.className = 'dot';
		el.connLabel.textContent = 'reconnecting…';
	};
	stream.onmessage = event => {
		if (state.stream !== stream) return;
		const data = JSON.parse(event.data);
		if (data.sessionId === state.sessionId) {
			eventRevision += 1;
			handleEvent(data);
		}
	};
	return ready;
}

function handleEvent(event) {
	const session = state.session;
	switch (event.type) {
		case 'frame':
			applyFrame(event.frame);
			break;

		case 'cursor':
			applyCursor(event.cursor);
			break;

		case 'message':
			// Thinking is live state, not transcript: it never becomes a bubble.
			if (event.message.role === 'thinking') {
				break;
			}
			session.messages.push(event.message);
			el.chatEmpty.hidden = true;
			el.transcript.append(renderMessage(event.message));
			if (event.message.role === 'agent') {
				resetThinking();
			}
			scrollTranscript();
			break;

		case 'message_delta':
			appendDelta(event.id, event.content, event.role);
			break;

		case 'message_done':
			if (event.message) {
				const index = session.messages.findIndex(message => message.id === event.message.id);
				if (index < 0) session.messages.push(event.message);
				else session.messages[index] = event.message;
				renderTranscript();
			}
			break;

		case 'activity': {
			const index = session.activities.findIndex(item => item.id === event.activity.id);
			if (index === -1) {
				session.activities.push(event.activity);
			} else {
				session.activities[index] = event.activity;
			}
			upsertActivity(event.activity);
			// The action doubles as the strip's caption when no reasoning streams.
			if (event.activity.status === 'running') {
				state.thinking.action = [event.activity.label, event.activity.detail]
					.filter(Boolean).join(' — ');
				updateThinkingStrip();
			}
			if (session.mode === 'founder') renderFounder();
			break;
		}

		case 'todos':
			session.todos = event.todos;
			renderTodos();
			break;

		case 'finding':
			session.findings.push(event.finding);
			renderFindings();
			if (event.finding.severity === 'critical' || event.finding.severity === 'high') {
				toast(`${event.finding.severity.toUpperCase()}: ${event.finding.title}`, 'bad');
			}
			break;

		case 'report':
			session.report = event.report;
			renderReport();
			toast('Report published.', 'good');
			break;

		case 'sqa':
			session.mode = 'sqa';
			session.sqa ??= { scope: {} };
			session.sqa.assessment = event.assessment;
			if (event.final) session.sqa.finalizedAt = new Date(event.ts ?? Date.now()).toISOString();
			else delete session.sqa.finalizedAt;
			syncSqaDetailMode();
			renderHeader();
			renderSqa();
			renderReport();
			void refreshRuns();
			if (event.final) toast('SQA assessment published.', 'good');
			break;

		case 'founder.created':
			session.mode = 'founder';
			session.founder ??= { scope: {} };
			if (event.schemaVersion) session.founder.schemaVersion = event.schemaVersion;
			if (event.categories) session.founder.scope.categories = event.categories;
			syncSqaDetailMode();
			renderHeader();
			renderFounder();
			renderReport();
			void refreshRuns();
			break;

		case 'founder.target_bound':
			session.mode = 'founder';
			session.targetUrl = event.targetUrl;
			session.title = event.title;
			session.founder ??= { scope: { target: {} }, observations: [] };
			session.founder.scope ??= { target: {} };
			session.founder.scope.target ??= {};
			session.founder.scope.target.url = event.authorizedTargetUrl ?? event.targetUrl;
			syncSqaDetailMode();
			renderHeader();
			renderFounder();
			void refreshRuns();
			break;

		case 'founder.observation': {
			session.mode = 'founder';
			session.founder ??= { scope: {}, observations: [] };
			session.founder.observations ??= [];
			const index = session.founder.observations.findIndex(item => item.id === event.observation?.id);
			if (event.observation && index === -1) session.founder.observations.push(event.observation);
			else if (event.observation) session.founder.observations[index] = event.observation;
			syncSqaDetailMode();
			renderHeader();
			renderFounder();
			break;
		}

		case 'founder.finalized':
			session.mode = 'founder';
			session.founder ??= { scope: {}, observations: [] };
			session.founder.report = event.report;
			session.founder.finalizedAt = event.report?.generatedAt ?? new Date(event.ts ?? Date.now()).toISOString();
			syncSqaDetailMode();
			renderHeader();
			renderFounder();
			renderReport();
			void refreshRuns();
			toast('Founder brief published.', 'good');
			break;

		case 'question':
			session.pendingQuestion = event.question;
			renderQuestion();
			break;

		case 'status':
			setStatus(event.status);
			if (session.mode === 'sqa') {
				renderSqa();
				renderReport();
			}
			if (session.mode === 'founder') {
				renderFounder();
				renderReport();
			}
			if (event.status !== 'running') {
				void refreshRuns();
			}
			if (event.detail && event.status === 'error') {
				toast(event.detail, 'bad');
			}
			break;

		case 'browser':
			if (event.browser?.url) {
				el.browserUrl.textContent = event.browser.url;
			}
			break;

		case 'session':
			if (event.targetUrl) {
				session.targetUrl = event.targetUrl;
				session.title = event.title;
				if (session.mode === 'founder' && session.founder?.scope?.target) {
					session.founder.scope.target.url = event.targetUrl;
				}
				renderHeader();
				if (session.mode === 'founder') renderFounder();
				void refreshRuns();
			}
			break;

		default:
			break;
	}
}

/* ── QA start dialog ─────────────────────────────────────────────── */

const qaUi = {
	dialog: $('qa-start'),
	form: $('qa-form'),
	close: $('qa-close'),
	cancel: $('qa-cancel'),
	submit: $('qa-submit'),
	targetUrl: $('qa-target-url'),
	deviceSelect: $('qa-device-select'),
	deviceLandscape: $('qa-device-landscape'),
	error: $('qa-form-error')
};

function setQaFormError(message = '') {
	if (!qaUi.error) return;
	qaUi.error.className = `test-result${message ? ' bad' : ''}`;
	qaUi.error.textContent = message;
}

function openQaStart() {
	if (!qaUi.dialog) return;
	setQaFormError();
	qaUi.form.reset();
	populateDeviceSelect(qaUi.deviceSelect, pendingDeviceId());
	if (qaUi.deviceLandscape) qaUi.deviceLandscape.checked = pendingLandscape();
	qaUi.submit.dataset.busy = 'false';
	qaUi.submit.disabled = false;
	qaUi.submit.textContent = 'Start QA run';
	if (!qaUi.dialog.open) qaUi.dialog.showModal();
	setTimeout(() => qaUi.targetUrl?.focus(), 0);
}

function closeQaStart() {
	if (qaUi.dialog?.open) qaUi.dialog.close();
}

if (qaUi.dialog) {
	qaUi.close.onclick = closeQaStart;
	qaUi.cancel.onclick = closeQaStart;

	qaUi.form.onsubmit = async event => {
		event.preventDefault();
		setQaFormError();
		if (!qaUi.form.reportValidity()) return;
		let targetUrl;
		try {
			const parsed = new URL(qaUi.targetUrl.value.trim());
			if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError();
			targetUrl = parsed.toString();
		} catch {
			setQaFormError('Enter a valid http(s) URL.');
			qaUi.targetUrl.focus();
			return;
		}
		const device = (qaUi.deviceSelect?.value) || pendingDeviceId();
		const deviceLandscape = (qaUi.deviceLandscape?.checked) === true;
		qaUi.submit.dataset.busy = 'true';
		qaUi.submit.disabled = true;
		qaUi.submit.textContent = 'Starting run…';
		try {
			await createQaRun({ targetUrl, device, deviceLandscape });
			closeQaStart();
		} catch (error) {
			setQaFormError(error instanceof Error ? error.message : String(error));
		} finally {
			qaUi.submit.dataset.busy = 'false';
			qaUi.submit.disabled = false;
			qaUi.submit.textContent = 'Start QA run';
		}
	};
}

/* ── Settings ────────────────────────────────────────────────────── */

const sqaUi = {
	dialog: $('sqa-start'),
	form: $('sqa-form'),
	close: $('sqa-close'),
	cancel: $('sqa-cancel'),
	submit: $('sqa-submit'),
	catalogState: $('sqa-catalog-state'),
	catalogVersion: $('sqa-catalog-version'),
	disclaimer: $('sqa-catalog-disclaimer'),
	deviceSelect: $('sqa-device-select'),
	deviceLandscape: $('sqa-device-landscape'),
	profilesFieldset: $('sqa-profiles-fieldset'),
	attributesFieldset: $('sqa-attributes-fieldset'),
	profileOptions: $('sqa-profile-options'),
	attributeOptions: $('sqa-attribute-options'),
	targetName: $('sqa-target-name'),
	targetUrl: $('sqa-target-url'),
	targetRelease: $('sqa-target-release'),
	targetEnvironment: $('sqa-target-environment'),
	scopeNotes: $('sqa-scope-notes'),
	authorization: $('sqa-authorization'),
	error: $('sqa-form-error')
};

function setSqaFormError(message = '') {
	sqaUi.error.className = `test-result${message ? ' bad' : ''}`;
	sqaUi.error.textContent = message;
}

async function loadSqaCatalog() {
	if (state.sqaCatalog) return state.sqaCatalog;
	if (!state.sqaCatalogPromise) {
		state.sqaCatalogPromise = api('/sqa/catalog')
			.then(catalog => {
				if (!catalog || typeof catalog !== 'object' || !catalog.catalogVersion) {
					throw new Error('The SQA catalog response is invalid.');
				}
				state.sqaCatalog = catalog;
				return catalog;
			})
			.finally(() => {
				state.sqaCatalogPromise = undefined;
			});
	}
	return state.sqaCatalogPromise;
}

function paintSqaCatalog(catalog) {
	const profiles = sqaValues(catalog.profiles);
	const attributes = sqaValues(catalog.attributes);
	const sources = sqaValues(catalog.sources);
	const controls = sqaValues(catalog.controls);
	sqaUi.disclaimer.textContent = catalog.disclaimer
		?? 'This is a scoped engineering assessment and does not represent regulatory approval, an audit opinion, or certification.';
	sqaUi.catalogVersion.textContent = `catalog ${catalog.catalogVersion} · ${controls.length} controls · ${sources.length} sources`;

	sqaUi.profileOptions.replaceChildren(...profiles.map(profile => {
		const id = typeof profile === 'string' ? profile : profile.id;
		const title = typeof profile === 'string' ? humanizeSqaId(profile) : (profile.title ?? humanizeSqaId(id));
		const description = typeof profile === 'string' ? '' : (profile.description ?? '');
		const isCore = id === 'core';
		const count = controls.filter(control => control.applicability?.profiles?.includes(id)).length;
		return sqaCatalogOption({
			name: 'sqa-profile', value: id, title, description,
			meta: `${count} mapped control${count === 1 ? '' : 's'}${isCore ? ' · required' : ''}`,
			checked: isCore, disabled: isCore
		});
	}));

	sqaUi.attributeOptions.replaceChildren(...attributes.map(attribute => {
		const id = typeof attribute === 'string' ? attribute : attribute.id;
		const title = typeof attribute === 'string' ? humanizeSqaId(attribute) : (attribute.title ?? humanizeSqaId(id));
		return sqaCatalogOption({ name: 'sqa-attribute', value: id, title });
	}));
	sqaUi.profilesFieldset.disabled = false;
	sqaUi.attributesFieldset.disabled = false;
	sqaUi.catalogState.hidden = true;
	syncSqaSubmitState();
}

function sqaCatalogOption({ name, value, title, description = '', meta = '', checked = false, disabled = false }) {
	const label = document.createElement('label');
	label.className = `sqa-option${disabled ? ' is-required' : ''}`;
	const input = document.createElement('input');
	input.type = 'checkbox';
	input.name = name;
	input.value = value;
	input.checked = checked;
	input.defaultChecked = checked;
	input.disabled = disabled;

	const copy = document.createElement('span');
	const heading = document.createElement('strong');
	heading.textContent = title;
	copy.append(heading);
	if (description) {
		const text = document.createElement('small');
		text.textContent = description;
		copy.append(text);
	}
	if (meta) {
		const metadata = document.createElement('em');
		metadata.textContent = meta;
		copy.append(metadata);
	}
	label.append(input, copy);
	return label;
}

function syncSqaSubmitState() {
	sqaUi.submit.disabled = !state.sqaCatalog || !sqaUi.authorization.checked || sqaUi.submit.dataset.busy === 'true';
}

async function openSqaStart() {
	setSqaFormError();
	sqaUi.form.reset();
	populateDeviceSelect(sqaUi.deviceSelect, pendingDeviceId());
	if (sqaUi.deviceLandscape) sqaUi.deviceLandscape.checked = pendingLandscape();
	sqaUi.profilesFieldset.disabled = true;
	sqaUi.attributesFieldset.disabled = true;
	sqaUi.catalogState.hidden = false;
	sqaUi.catalogState.textContent = 'Loading assessment catalog…';
	sqaUi.submit.dataset.busy = 'false';
	syncSqaSubmitState();
	if (!sqaUi.dialog.open) sqaUi.dialog.showModal();

	try {
		paintSqaCatalog(await loadSqaCatalog());
	} catch (error) {
		sqaUi.catalogState.hidden = false;
		sqaUi.catalogState.textContent = 'The assessment catalog could not be loaded.';
		setSqaFormError(error instanceof Error ? error.message : String(error));
	}
}

function closeSqaStart() {
	if (sqaUi.dialog.open) sqaUi.dialog.close();
}

sqaUi.close.onclick = closeSqaStart;
sqaUi.cancel.onclick = closeSqaStart;
sqaUi.authorization.onchange = syncSqaSubmitState;

sqaUi.form.onsubmit = async event => {
	event.preventDefault();
	setSqaFormError();
	if (!sqaUi.form.reportValidity()) return;
	const target = {
		name: sqaUi.targetName.value.trim(),
		release: sqaUi.targetRelease.value.trim(),
		environment: sqaUi.targetEnvironment.value.trim()
	};
	let targetUrl;
	try {
		targetUrl = new URL(sqaUi.targetUrl.value.trim());
		if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new TypeError();
		targetUrl = targetUrl.href;
	} catch {
		setSqaFormError('Enter a complete HTTP or HTTPS target URL.');
		sqaUi.targetUrl.focus();
		return;
	}
	const emptyTarget = Object.entries(target).find(([, value]) => !value);
	if (emptyTarget) {
		setSqaFormError('Product, release, and environment must contain visible text.');
		sqaUi.targetName.focus();
		return;
	}
	if (!sqaUi.authorization.checked) {
		setSqaFormError('Confirm testing authorization and the non-destructive boundary first.');
		sqaUi.authorization.focus();
		return;
	}

	const profiles = [...sqaUi.profileOptions.querySelectorAll('input:checked')].map(input => input.value);
	if (!profiles.includes('core')) profiles.unshift('core');
	const attributes = [...sqaUi.attributeOptions.querySelectorAll('input:checked')].map(input => input.value);
	sqaUi.submit.dataset.busy = 'true';
	sqaUi.submit.textContent = 'Creating assessment…';
	syncSqaSubmitState();
	try {
		const result = await api('/sqa/sessions', {
			method: 'POST',
			body: JSON.stringify({
				profiles,
				attributes,
				target,
				scopeNotes: sqaUi.scopeNotes.value.trim(),
				authorizationConfirmed: true,
				device: (sqaUi.deviceSelect?.value) || pendingDeviceId(),
				deviceLandscape: (sqaUi.deviceLandscape?.checked) === true
			})
		});
		const session = result?.session ?? result;
		if (!session?.id) throw new Error('The server did not return the new assessment session.');
		closeSqaStart();
		await selectSession(session.id);
		const startError = await api(`/sessions/${session.id}/message`, {
			method: 'POST',
			body: JSON.stringify({ text: targetUrl })
		}).then(() => undefined, error => error);
		if (startError) {
			fail(new Error(`The assessment scope was created, but the test could not start: ${startError.message}`));
			el.composerInput.value = targetUrl;
			el.composerInput.focus();
		}
	} catch (error) {
		setSqaFormError(error instanceof Error ? error.message : String(error));
	} finally {
		sqaUi.submit.dataset.busy = 'false';
		sqaUi.submit.textContent = 'Start assessment';
		syncSqaSubmitState();
	}
};

const founderUi = {
	dialog: $('founder-start'),
	form: $('founder-form'),
	close: $('founder-close'),
	cancel: $('founder-cancel'),
	submit: $('founder-submit'),
	catalogMeta: $('founder-catalog-meta'),
	deviceSelect: $('founder-device-select'),
	deviceLandscape: $('founder-device-landscape'),
	targetName: $('founder-target-name'),
	targetUrl: $('founder-target-url'),
	targetRelease: $('founder-target-release'),
	targetEnvironment: $('founder-target-environment'),
	stage: $('founder-stage'),
	businessModel: $('founder-business-model'),
	targetCustomer: $('founder-target-customer'),
	primaryGoal: $('founder-primary-goal'),
	constraints: $('founder-constraints'),
	competitors: $('founder-competitors'),
	authorization: $('founder-authorization'),
	error: $('founder-form-error')
};

function setFounderFormError(message = '') {
	founderUi.error.className = `test-result${message ? ' bad' : ''}`;
	founderUi.error.textContent = message;
}

async function loadFounderCatalog() {
	if (state.founderCatalog) return state.founderCatalog;
	if (!state.founderCatalogPromise) {
		state.founderCatalogPromise = api('/founder/catalog')
			.then(catalog => {
				if (!catalog || typeof catalog !== 'object' || !catalog.schemaVersion || !Array.isArray(catalog.categories)) {
					throw new Error('The Founder review catalog response is invalid.');
				}
				state.founderCatalog = catalog;
				return catalog;
			})
			.finally(() => {
				state.founderCatalogPromise = undefined;
			});
	}
	return state.founderCatalogPromise;
}

function paintFounderCatalog(catalog) {
	founderUi.catalogMeta.textContent = `${catalog.schemaVersion} · ${catalog.categories.length} review lenses · browser evidence required`;
	syncFounderSubmitState();
	if (state.session?.mode === 'founder') renderFounder();
}

function syncFounderSubmitState() {
	founderUi.submit.disabled = !state.founderCatalog
		|| !founderUi.authorization.checked
		|| founderUi.submit.dataset.busy === 'true';
}

async function openFounderStart() {
	setFounderFormError();
	founderUi.form.reset();
	populateDeviceSelect(founderUi.deviceSelect, pendingDeviceId());
	if (founderUi.deviceLandscape) founderUi.deviceLandscape.checked = pendingLandscape();
	founderUi.submit.dataset.busy = 'false';
	founderUi.catalogMeta.textContent = 'Loading review catalog…';
	syncFounderSubmitState();
	if (!founderUi.dialog.open) founderUi.dialog.showModal();
	try {
		paintFounderCatalog(await loadFounderCatalog());
	} catch (error) {
		founderUi.catalogMeta.textContent = 'Review catalog unavailable.';
		setFounderFormError(error instanceof Error ? error.message : String(error));
	}
}

function closeFounderStart() {
	if (founderUi.dialog.open) founderUi.dialog.close();
}

function founderOptional(value) {
	const text = String(value ?? '').trim();
	return text || undefined;
}

function readFounderCompetitors() {
	const lines = founderUi.competitors.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
	if (lines.length > 20) throw new TypeError('Enter no more than 20 competitors.');
	if (lines.some(value => value.length > 500)) throw new TypeError('Each competitor must be 500 characters or fewer.');
	const seen = new Set();
	const unique = [];
	for (const value of lines) {
		const key = value.toLocaleLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(value);
	}
	return unique;
}

founderUi.close.onclick = closeFounderStart;
founderUi.cancel.onclick = closeFounderStart;
founderUi.authorization.onchange = syncFounderSubmitState;

founderUi.form.onsubmit = async event => {
	event.preventDefault();
	setFounderFormError();
	if (!founderUi.form.reportValidity()) return;
	let targetUrl;
	try {
		targetUrl = new URL(founderUi.targetUrl.value.trim());
		if (!['http:', 'https:'].includes(targetUrl.protocol)) throw new TypeError();
		targetUrl = targetUrl.href;
	} catch {
		setFounderFormError('Enter a complete HTTP or HTTPS target URL.');
		founderUi.targetUrl.focus();
		return;
	}
	if (!founderUi.targetName.value.trim()) {
		setFounderFormError('Enter the product or project name.');
		founderUi.targetName.focus();
		return;
	}
	if (!founderUi.authorization.checked) {
		setFounderFormError('Confirm review authorization and the non-destructive boundary first.');
		founderUi.authorization.focus();
		return;
	}

	let competitors;
	try {
		competitors = readFounderCompetitors();
	} catch (error) {
		setFounderFormError(error instanceof Error ? error.message : String(error));
		founderUi.competitors.focus();
		return;
	}
	const target = {
		name: founderUi.targetName.value.trim(),
		url: targetUrl,
		...(founderOptional(founderUi.targetRelease.value) ? { release: founderUi.targetRelease.value.trim() } : {}),
		...(founderOptional(founderUi.targetEnvironment.value) ? { environment: founderUi.targetEnvironment.value.trim() } : {})
	};
	const productContext = {
		...(founderOptional(founderUi.stage.value) ? { stage: founderUi.stage.value.trim() } : {}),
		...(founderOptional(founderUi.businessModel.value) ? { businessModel: founderUi.businessModel.value.trim() } : {}),
		...(founderOptional(founderUi.targetCustomer.value) ? { targetCustomer: founderUi.targetCustomer.value.trim() } : {}),
		...(founderOptional(founderUi.primaryGoal.value) ? { primaryGoal: founderUi.primaryGoal.value.trim() } : {}),
		...(founderOptional(founderUi.constraints.value) ? { constraints: founderUi.constraints.value.trim() } : {}),
		...(competitors.length ? { competitors } : {})
	};

	founderUi.submit.dataset.busy = 'true';
	founderUi.submit.textContent = 'Creating review…';
	founderUi.form.setAttribute('aria-busy', 'true');
	syncFounderSubmitState();
	try {
		const result = await api('/founder/sessions', {
			method: 'POST',
			body: JSON.stringify({
				authorizationConfirmed: true,
				target,
				device: (founderUi.deviceSelect?.value) || pendingDeviceId(),
				deviceLandscape: (founderUi.deviceLandscape?.checked) === true,
				...(Object.keys(productContext).length ? { productContext } : {})
			})
		});
		const session = result?.session ?? result;
		if (!session?.id) throw new Error('The server did not return the new Founder review session.');
		closeFounderStart();
		await selectSession(session.id);
		const startError = await api(`/sessions/${session.id}/message`, {
			method: 'POST',
			body: JSON.stringify({ text: `Review ${targetUrl}` })
		}).then(() => undefined, error => error);
		if (startError) {
			fail(new Error(`The review scope was created, but evidence collection could not start: ${startError.message}`));
			el.composerInput.value = `Review ${targetUrl}`;
			el.composerInput.focus();
		}
	} catch (error) {
		setFounderFormError(error instanceof Error ? error.message : String(error));
	} finally {
		founderUi.submit.dataset.busy = 'false';
		founderUi.submit.textContent = 'Start founder review';
		founderUi.form.removeAttribute('aria-busy');
		syncFounderSubmitState();
	}
};

const cfg = {
	dialog: $('settings'),
	provider: $('cfg-provider'),
	providerNote: $('cfg-provider-note'),
	key: $('cfg-key'),
	keyNote: $('cfg-key-note'),
	baseUrlField: $('cfg-baseurl-field'),
	baseUrl: $('cfg-baseurl'),
	model: $('cfg-model'),
	modelCustom: $('cfg-model-custom'),
	reasoning: $('cfg-reasoning'),
	maxTurns: $('cfg-maxturns'),
	headless: $('cfg-headless'),
	test: $('cfg-test'),
	testBtn: $('cfg-test-btn'),
	saveBtn: $('cfg-save')
};

/** Providers whose endpoint the user supplies themselves. */
const BASE_URL_REQUIRED = new Set(['custom', 'azureOpenAI']);
const BASE_URL_OPTIONAL = new Set(['openai', 'openrouter', 'nvidia', 'grok']);
const CUSTOM_MODEL_VALUE = '__qase_custom_model__';

function selectedModelId() {
	return (cfg.model.value === CUSTOM_MODEL_VALUE ? cfg.modelCustom.value : cfg.model.value).trim();
}

function syncCustomModelField() {
	const custom = cfg.model.value === CUSTOM_MODEL_VALUE;
	cfg.modelCustom.hidden = !custom;
	cfg.modelCustom.required = custom;
	if (custom) cfg.modelCustom.focus();
}

function fillModelOptions(models = [], selected = '') {
	const uniqueModels = [...new Set(models.filter(model => typeof model === 'string' && model.trim()).map(model => model.trim()))];
	const selectedIsListed = uniqueModels.includes(selected);
	const options = uniqueModels.map(id => {
		const option = document.createElement('option');
		option.value = id;
		option.textContent = id;
		return option;
	});
	const customOption = document.createElement('option');
	customOption.value = CUSTOM_MODEL_VALUE;
	customOption.textContent = 'Custom model ID…';
	options.push(customOption);
	cfg.model.replaceChildren(...options);
	if (selected && !selectedIsListed) {
		cfg.model.value = CUSTOM_MODEL_VALUE;
		cfg.modelCustom.value = selected;
	} else {
		cfg.model.value = selectedIsListed ? selected : (uniqueModels[0] ?? CUSTOM_MODEL_VALUE);
		if (selectedIsListed) cfg.modelCustom.value = '';
	}
	syncCustomModelField();
}

function paintConfig(config) {
	state.config = config;
	el.modelBadge.textContent = config.ready ? config.model : (config.problem ?? 'not configured');
	el.modelBadge.style.color = config.ready ? '' : 'var(--danger)';
	el.modelBadge.title = config.ready
		? `${config.provider}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`
		: 'Open settings to finish configuring';
}

function fillSettings(config) {
	cfg.provider.replaceChildren(...config.providers.map(name => {
		const option = document.createElement('option');
		option.value = name;
		option.textContent = name === 'custom' ? 'custom (OpenAI-compatible endpoint)' : name;
		return option;
	}));
	cfg.provider.value = config.provider;
	cfg.baseUrl.value = config.baseUrl ?? '';
	fillModelOptions([], config.model ?? '');
	cfg.reasoning.value = config.reasoning ?? 'medium';
	cfg.maxTurns.value = config.maxTurns ?? 120;
	cfg.headless.checked = config.headless !== false;

	// The stored key is never sent to the browser; leaving the box empty keeps it.
	cfg.key.value = '';
	cfg.key.placeholder = config.hasApiKey ? `${config.apiKeyHint} — leave blank to keep` : 'sk-…';
	cfg.keyNote.textContent = config.hasApiKey
		? (config.apiKeyFromEnv ? 'Currently coming from .env. Saving one here overrides it.' : 'Stored on this machine, in .qase/config.json.')
		: 'Stored on this machine, in .qase/config.json. Sent only to your endpoint.';

	cfg.test.className = 'test-result';
	cfg.test.textContent = '';
	syncProviderFields();
}

function syncProviderFields() {
	const provider = cfg.provider.value;
	const required = BASE_URL_REQUIRED.has(provider);
	cfg.baseUrlField.hidden = !required && !BASE_URL_OPTIONAL.has(provider);
	cfg.providerNote.textContent = required
		? 'Any OpenAI-compatible API: key, base URL, model name.'
		: BASE_URL_OPTIONAL.has(provider)
			? 'Base URL is optional — leave it blank to use the provider default.'
			: 'This provider uses its own endpoint.';
}

function readSettings() {
	const patch = {
		provider: cfg.provider.value,
		baseUrl: cfg.baseUrl.value.trim(),
		model: selectedModelId(),
		reasoning: cfg.reasoning.value,
		maxTurns: Number(cfg.maxTurns.value),
		headless: cfg.headless.checked
	};
	if (cfg.key.value.trim()) {
		patch.apiKey = cfg.key.value.trim();
	}
	return patch;
}

cfg.provider.onchange = syncProviderFields;
cfg.model.onchange = syncCustomModelField;

async function probeModelEndpoint({ announce = true } = {}) {
	if (announce) {
		cfg.test.className = 'test-result busy';
		cfg.test.textContent = 'Probing the endpoint…';
	}
	const requestedModel = selectedModelId();
	const result = await api('/config/test', {
		method: 'POST',
		body: JSON.stringify(readSettings())
	}).catch(error => ({ ok: false, error: error.message }));

	if (!result.ok) {
		if (announce) {
			cfg.test.className = 'test-result bad';
			cfg.test.textContent = result.error;
		}
		return result;
	}
	fillModelOptions(result.models ?? [], requestedModel);
	cfg.test.className = 'test-result ok';
	cfg.test.textContent = result.matched === false
		? `${result.message} But "${requestedModel}" is not in the list — choose another model or keep it as a custom ID.`
		: result.message;
	return result;
}

async function openSettings() {
	const config = await api('/config');
	fillSettings(config);
	cfg.dialog.showModal();
	if (config.ready) void probeModelEndpoint({ announce: false });
}

let authRegisterMode = false;
let workspaceBooted = false;

function renderAuthMode() {
	if (!el.authGate) return;
	const register = authRegisterMode;
	if (el.authTitle) el.authTitle.textContent = register ? 'Create your workspace' : 'Sign in to your workspace';
	if (el.authCopy) el.authCopy.textContent = register
		? 'Your runs, profile, and saved memory are isolated to this account.'
		: 'Your runs, profile, and saved memory stay isolated to your account.';
	if (el.authDisplay) { el.authDisplay.hidden = !register; el.authDisplay.required = register; }
	if (el.authDisplayLabel) el.authDisplayLabel.hidden = !register;
	if (el.authPassword) { el.authPassword.autocomplete = register ? 'new-password' : 'current-password'; el.authPassword.minLength = register ? 12 : 1; }
	if (el.authSubmit) el.authSubmit.textContent = register ? 'Create account' : 'Sign in';
	if (el.authSwitch) el.authSwitch.textContent = register ? 'I already have an account' : 'Create an account';
}

function showAuthGate() {
	if (!el.authGate) return;
	el.authGate.hidden = false;
	document.querySelector('.app').inert = true;
	document.querySelector('.app').setAttribute('aria-hidden', 'true');
	renderAuthMode();
	el.authEmail?.focus();
}

function hideAuthGate() {
	if (el.authGate) el.authGate.hidden = true;
	for (const node of document.querySelectorAll('.app, .skip-link, #settings, #toasts')) { node.inert = false; node.removeAttribute('aria-hidden'); }
}

el.authSwitch?.addEventListener('click', () => {
	authRegisterMode = !authRegisterMode;
	if (el.authError) el.authError.hidden = true;
	renderAuthMode();
	el.authPassword?.focus();
});

el.authForm?.addEventListener('submit', async event => {
	event.preventDefault();
	if (!el.authEmail || !el.authPassword || !el.authSubmit) return;
	if (el.authError) el.authError.hidden = true;
	el.authSubmit.disabled = true;
	el.authSwitch.disabled = true;
	el.authForm.setAttribute('aria-busy', 'true');
	try {
		state.user = await api(authRegisterMode ? '/auth/register' : '/auth/login', {
			method: 'POST',
			body: JSON.stringify({
				email: el.authEmail.value.trim(),
				password: el.authPassword.value,
				displayName: el.authDisplay?.value.trim()
			})
		});
		el.authPassword.value = '';
		hideAuthGate();
		await bootWorkspace();
	} catch (error) {
		if (el.authError) {
			el.authError.textContent = error instanceof Error ? error.message : String(error);
			el.authError.hidden = false;
		}
	} finally {
		el.authSubmit.disabled = false;
		el.authSwitch.disabled = false;
		el.authForm.removeAttribute('aria-busy');
	}
});

$('open-settings').onclick = openSettings;
el.modelBadge.onclick = openSettings;

cfg.testBtn.onclick = async () => {
	await probeModelEndpoint();
};

cfg.saveBtn.onclick = async () => {
	try {
		const config = await api('/config', { method: 'PUT', body: JSON.stringify(readSettings()) });
		paintConfig(config);
		if (config.problem) {
			cfg.test.className = 'test-result bad';
			cfg.test.textContent = config.problem;
			return;
		}
		cfg.dialog.close();
		toast(config.runsKeepingOldSettings > 0
			? `Saved. ${config.runsKeepingOldSettings} run(s) already going keep the old settings.`
			: 'Settings saved.', 'good');
	} catch (error) {
		cfg.test.className = 'test-result bad';
		cfg.test.textContent = error instanceof Error ? error.message : String(error);
	}
};

/* ── Wiring ──────────────────────────────────────────────────────── */

el.composer.onsubmit = async event => {
	event.preventDefault();
	const text = el.composerInput.value.trim();
	if (!text || !state.sessionId) {
		return;
	}
	if (!state.config?.ready) {
		toast('Set up the model endpoint first.', 'bad');
		void openSettings();
		return;
	}
	el.composerInput.value = '';
	el.composerInput.style.height = 'auto';
	el.composerInput.style.overflowY = 'hidden';
	el.questionSlot.replaceChildren();
	await api(`/sessions/${state.sessionId}/message`, {
		method: 'POST',
		body: JSON.stringify({ text })
	}).catch(fail);
};

el.composerInput.addEventListener('input', () => {
	el.composerInput.style.height = 'auto';
	el.composerInput.style.height = `${Math.min(el.composerInput.scrollHeight, 170)}px`;
	el.composerInput.style.overflowY = el.composerInput.scrollHeight > 170 ? 'auto' : 'hidden';
});

el.composerInput.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		el.composer.requestSubmit();
	}
});

window.addEventListener('resize', fitStageFrame, { passive: true });

el.newRun.onclick = openQaStart;
el.newSqa.onclick = openSqaStart;
el.newFounder.onclick = openFounderStart;
el.stopRun.onclick = () => api(`/sessions/${state.sessionId}/stop`, { method: 'POST' }).catch(fail);
el.signOut?.addEventListener('click', async () => {
  el.signOut.disabled = true;
  try {
    await api('/auth/logout', { method: 'POST' });
    state.stream?.close();
    localStorage.removeItem('qase.session');
    window.location.reload();
  } catch (error) { fail(error); el.signOut.disabled = false; }
});

el.thinkingHead.onclick = () => {
	if (el.thinkingStrip.classList.contains('has-detail')) {
		el.thinkingStrip.classList.toggle('is-open');
		updateThinkingStrip();
	}
};

document.addEventListener('keydown', event => {
	if (!el.authGate.hidden) return;
	if ((event.metaKey || event.ctrlKey) && event.key === 'n') {
		event.preventDefault();
		void startRun();
	}
	if ((event.metaKey || event.ctrlKey) && event.key === ',') {
		event.preventDefault();
		void openSettings();
	}
});

const detailTabs = [...document.querySelectorAll('.tab')];

function activateDetailTab(tab, moveFocus = false) {
	for (const other of detailTabs) {
		const active = other === tab;
		other.classList.toggle('is-active', active);
		other.setAttribute('aria-selected', String(active));
		other.tabIndex = active ? 0 : -1;
	}
	for (const pane of document.querySelectorAll('.tab-pane')) {
		pane.classList.toggle('is-active', pane.dataset.pane === tab.dataset.tab);
	}
	if (moveFocus) tab.focus();
}

for (const tab of detailTabs) {
	tab.onclick = () => activateDetailTab(tab);
	tab.onkeydown = event => {
		const availableTabs = detailTabs.filter(candidate => !candidate.hidden);
		const index = availableTabs.indexOf(tab);
		let next = index;
		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % availableTabs.length;
		else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + availableTabs.length) % availableTabs.length;
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = availableTabs.length - 1;
		else return;
		event.preventDefault();
		activateDetailTab(availableTabs[next], true);
	};
}

/* ── Boot ────────────────────────────────────────────────────────── */

async function bootWorkspace() {
	if (workspaceBooted) return;
	workspaceBooted = true;
	hideAuthGate();
	await window.qaseEntryReady;

	const config = await api('/config').catch(() => undefined);
	if (config) {
		paintConfig(config);
	}

	await loadDevices();

	const runs = await api('/sessions').catch(() => []);
	const launchParameters = new URLSearchParams(window.location.search);
	const requestedRunId = launchParameters.get('run');
	if (requestedRunId && RUN_ID_PATTERN.test(requestedRunId)) {
		try {
			await selectSession(requestedRunId.toLowerCase());
			launchParameters.delete('run');
			const query = launchParameters.toString();
			window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
			el.composerInput.focus();
			return;
		} catch {
			// A stale or cross-project launch handle cannot select a run. Fall back
			// to the user's own latest visible run without leaking whether it exists.
			launchParameters.delete('run');
			const query = launchParameters.toString();
			window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
		}
	}
	const remembered = localStorage.getItem('qase.session');
	const target = runs.find(run => run.id === remembered) ?? runs[0];

	if (target) {
		await selectSession(target.id);
	} else {
		await startRun();
	}
	el.composerInput.focus();
}

(async function boot() {
	await window.qaseEntryReady;
	try {
		state.user = await api('/auth/me');
	} catch (error) {
		if (error?.status === 401) {
			showAuthGate();
			return;
		}
		// Older embedded hosts can omit the first-party auth adapter. Keep the
		// dashboard usable there while production instances always expose it.
		if (error?.status !== 404) {
			showAuthGate();
			return;
		}
	}
	await bootWorkspace();
})();

$('auth-show-password').onchange = event => { el.authPassword.type = event.target.checked ? 'text' : 'password'; };
const profileDialog = $('profile-dialog');
$('profile-close').onclick = () => profileDialog.close();
profileDialog.addEventListener('close', () => { $('password-form').reset(); });
async function refreshMemory() {
  const entries = await api('/memory');
  $('profile-memory').replaceChildren();
  if (!entries.length) $('profile-memory').textContent = 'No saved memory yet.';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.textContent = entry.key + ': ' + entry.value + ' ';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost'; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete memory ' + entry.key);
    remove.onclick = () => accountAction(remove, async () => { await api('/memory/' + entry.id, { method:'DELETE' }); await refreshMemory(); });
    item.append(remove); $('profile-memory').append(item);
  }
}
async function accountAction(button, work) {
  button.disabled = true; $('profile-message').textContent = '';
  try { await work(); } catch(error) { $('profile-message').textContent = error.message; }
  finally { button.disabled = false; }
}
$('open-profile').onclick = () => accountAction($('open-profile'), async () => {
  const user = await api('/profile');
  $('profile-name').value = user.displayName; $('profile-timezone').value = user.profile.timezone; $('profile-email').textContent = user.email;
  profileDialog.showModal(); await refreshMemory();
});
$('profile-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  state.user = await api('/profile', { method:'PUT', body:JSON.stringify({displayName:$('profile-name').value,profile:{timezone:$('profile-timezone').value}}) });
  $('profile-message').textContent = 'Profile saved.';
}); };
$('password-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  await api('/auth/password', { method:'POST', body:JSON.stringify({currentPassword:$('current-password').value,password:$('new-password').value}) });
  state.stream?.close(); window.location.reload();
}); };
$('memory-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  await api('/memory', { method:'PUT', body:JSON.stringify({key:$('memory-key').value,value:$('memory-value').value}) });
  $('memory-form').reset(); await refreshMemory(); $('profile-message').textContent = 'Memory saved.';
}); };
