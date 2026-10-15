import { describeSqaLifecycle, groupSqaUnresolvedResults } from './sqaPresentation.js';
import { previewCollapsed } from './previewLayout.js';
import { renderProbeIds, hasInteractiveSurface } from './renderHealth.js';
import { renderMatrixPicker } from './matrixPicker.js';
import { normalizeSingleSelection, singleSelection, preferredConfiguration } from './singleRunSelection.js';
import { preferredResultTab } from './runPresentation.js';
import { runCardDetails } from './runCard.js';
import { renderResultsOverview, resultsOverviewModel } from './resultsOverview.js';
import { isCredentialQuestion } from './questionPresentation.js';
import { buildFindingFixPrompt, buildAllFixPromptsMarkdown } from './fixPromptBuilder.js';
import { createFounderView } from './founderView.js';
import { followUpSuggestions, buildFollowUpMessage } from './followUp.js';
import { createBugsView } from './bugsView.js';
import { QA_SCOPE_OPTIONS, buildQaKickoffMessage } from './qaKickoff.js';
import {
	sanitizeSelection,
	isSelectable,
	isValidTargetUrl,
	fetchQaConfigurations,
	fetchConfigurationIndex,
	createSelectionState,
	computeExplicitSelection,
	createSelectionStore
} from './qaConfigMatrix.js';
import { createDeviceMatrixView } from './deviceMatrixView.js';
import { createTestCaseView } from './testCaseView.js';
import { createBulkRunView } from './bulkRunView.js';
import { createAnalyticsView } from './analyticsView.js';
import { createDeviceDrawer, chipLabel, RUNTIME_PROFILES } from './deviceDrawer.js';
import { createQaMatrixResultsView } from './qaMatrixResultsView.js';
import { firstMatrixSessionId } from './matrixLaunch.js';
import { createRunStartupView } from './runStartupView.js';
import { createBugView } from './bugView.js';
import { createActiveTestEnvironmentStore } from './activeTestEnvironment.js';
import { createThemeStore, applyThemeToDocument } from './themePreference.js';
import { createDevicePicker, createDeviceChipList, executionTypeText } from './devicePicker.js';
import { createFavoritesStore, createRecentsStore, resolvePickerFocus, buildBrowserColumns, selectionDisplayString } from './deviceBrowserMatrix.js';
import { createMatrixSidebar } from './matrixSidebar.js';
import { createMatrixColumns } from './matrixColumns.js';
import { brandIcon } from './brandIcons.js';
import { channelFor as channelForClient } from './browserChannels.js';
import { fallbackOptionsFor, availabilityMeta, describeQueue } from './deviceRuntimeUi.js';
import { resolveActiveRuntimeEnvironment, viewForSelection } from './activeRuntimeEnvironment.js';
import { chromeViewModel } from './browserChrome.js';
import {
	lastRunByCase, caseStatus, platformsOf, caseEnvLines,
	filterCasesForWizard, resolveRunPairs
} from './qaWorkflows.js';
import {
	loadBatches, recordBatch, aggregateBatch,
	createBatchTracker, activeBatchRunId
} from './bulkProgress.js';
import { formatTokens, hostOf, list, markdown, miniSummaryText, paragraph, relativeTime, section, tokenSummaryText, truncate } from './uiPrimitives.js';
import { createPageRouter, routeHash } from './pageRouter.js';
import { blockedRunReason, runPresentationLabel, runPresentationStatus } from './runPresentation.js';
import { createQaJourney, normalizeWebsite } from './qaJourney.js';
import { workflowStatus } from './workflowStatus.js';

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
	// legacy device select removed (DX Phase 3 + Phase 5 audit) — no #device-select exists.
	deviceLandscape: $('device-landscape'),
	newRun: $('new-run'),
	newSqa: $('new-sqa'),
	newFounder: $('new-founder'),
	openBugs: $('open-bugs'),
	bugsView: $('bugs-view'),

	chatTitle: $('chat-title'),
	chatTarget: $('chat-target'),
	runSummary: $('run-summary'),
	tokenSummary: $('token-summary'),
	tokenText: $('token-text'),
	livePill: $('live-pill'),
	runSummaryToggle: $('run-summary-toggle'),
	runSummaryDetail: $('run-summary-detail'),
	runSummaryMini: $('run-summary-mini'),
	miniTokens: $('mini-tokens'),
	miniStatus: $('mini-status'),
	miniProgress: $('mini-progress'),
	miniFindings: $('mini-findings'),
	statusChip: $('status-chip'),
	timerChip: $('timer-chip'),
	tokenChip: $('token-chip'),
	resumeRun: $('resume-run'),
	progressSteps: $('progress-steps'),
	progressPct: $('progress-pct'),
	progressFindings: $('progress-findings'),
	progressBar: $('progress-bar'),
	currentActivity: $('current-activity'),
	currentActivityState: $('current-activity-state'),
	runTimer: $('run-timer'),
	runTimerLabel: $('run-timer-label'),
	runTimerClock: $('run-timer-clock'),
	feedbackModal: $('feedback-modal'),
	feedbackForm: $('feedback-form'),
	feedbackClose: $('feedback-close'),
	feedbackCancel: $('feedback-cancel'),
	feedbackSubmit: $('feedback-submit'),
	feedbackEdit: $('feedback-edit'),
	feedbackStars: $('feedback-star-row'),
	feedbackCategory: $('feedback-category'),
	feedbackComments: $('feedback-comments'),
	feedbackImprovement: $('feedback-improvement'),
	feedbackError: $('feedback-error'),
	feedbackSuccess: $('feedback-success'),
	feedbackRunMeta: $('feedback-run-meta'),
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
	composerHint: $('composer-running-hint'),
	sendBtn: $('send-btn'),

	browserUrl: $('browser-url'),
	browserTitle: $('browser-title'),
	browserDot: $('browser-dot'),
	stage: $('stage'),
	stageToggle: $('stage-toggle'),
	stageNote: $('stage-note'),
	viewer: document.querySelector('.viewer'),
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
	bugsList: $('bugs-list'),
	countBugs: $('count-bugs'),
	bugViewHost: $('pane-bugs'),
	reportView: $('report-view'),
	reportTab: $('tab-report'),
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
	authError: $('auth-error'),
	authForgotSwitch: $('auth-forgot-switch'),
	forgotPanel: $('forgot-panel'),
	forgotForm: $('forgot-form'),
	forgotEmail: $('forgot-email'),
	forgotError: $('forgot-error'),
	forgotNotice: $('forgot-notice'),
	forgotSubmit: $('forgot-submit'),
	forgotBack: $('forgot-back'),
	otpPanel: $('otp-panel'),
	otpForm: $('otp-form'),
	otpInput: $('otp-input'),
	otpError: $('otp-error'),
	otpNotice: $('otp-notice'),
	otpSubmit: $('otp-submit'),
	otpResend: $('otp-resend'),
	otpBack: $('otp-back'),
	resetPanel: $('reset-panel'),
	resetForm: $('reset-form'),
	resetPassword: $('reset-password'),
	resetConfirm: $('reset-confirm'),
	resetError: $('reset-error'),
	resetNotice: $('reset-notice'),
	resetSubmit: $('reset-submit'),
	resetBack: $('reset-back'),
	recoverPanel: $('recover-panel'),
	recoverForm: $('recover-form'),
	recoverEmail: $('recover-email'),
	recoverCode: $('recover-code'),
	recoverError: $('recover-error'),
	recoverNotice: $('recover-notice'),
	recoverSubmit: $('recover-submit'),
	recoverBack: $('recover-back'),
	forgotRecoverLink: $('forgot-recover-link')
};

const state = {
	sessionId: undefined,
	session: undefined,
	config: undefined,
	stream: undefined,
	/** Run IDs with a cancellation request in flight. */
	stopRequests: new Set(),
	openFindings: new Set(),
	openFixInstructions: new Set(),
	/** Run id -> selected and previously seen finding ids. */
	findingSelections: new Map(),
	bugsViewOpen: false,
	/** Message id -> the nodes streamed text is appended to. */
	bubbles: new Map(),
	viewport: { width: 1440, height: 900 },
	cursorTimer: undefined,
	sqaCatalog: undefined,
	sqaCatalogPromise: undefined,
	founderCatalog: undefined,
	founderProjectState: null,
	founderHandoffPayload: null,
	founderCatalogPromise: undefined,
	qaTestCatalog: undefined,
	qaTestCatalogPromise: undefined,
	/** Live reasoning for the current turn. Never kept once the agent replies. */
	thinking: { text: '', action: '' },
	runTimer: { interval: undefined, startedAt: undefined, endedAt: undefined },
	/** Per-session expand preference after the post-run auto-collapse. */
	stageCollapsePreferences: new Map(),
	/** Run whose completed QA results were automatically revealed. */
	shownQaResults: undefined,
	/** Run whose live Plan was revealed once without overriding later tab choices. */
	shownRunningPlan: undefined,
	/** Instance is in pilot mode (invite-only registration, beta notice). */
	pilotMode: false,
	user: undefined,
	/**
	 * Test Execution Timer state. Server-authoritative: elapsed time is always
	 * computed from server timestamps (startedAt/completedAt) corrected by the
	 * latest serverNow sample, never from a frontend start event — so browser
	 * refresh, tab switches and reconnects can never reset or skew it.
	 */
	timer: {
		interval: undefined,
		/** serverNow − clientNow (ms) from the latest snapshot/event. */
		skew: 0,
		/** run id -> live duration node in the runs list. */
		runLiveTimers: new Map()
	},
	/**
	 * Post-run feedback UI state. `existing` is the submitter's record for the
	 * current run (null = not submitted yet); `rating` mirrors the star row;
	 * `submitting` guards duplicate submissions while a request is in flight.
	 */
	feedback: { runId: undefined, existing: undefined, existingLoadedFor: undefined, rating: 0, submitting: false, editing: false, notified: '' },
	/** run id -> the current user's own feedback record (run-list badges). */
	runRatings: new Map(),
	/**
	 * Single source of truth for the live view: the currently executing
	 * device/browser context, resolved by activeRuntimeEnvironment.js.
	 * Every live-view component reads this — never its own fallback chain.
	 */
	activeRuntimeEnvironment: undefined,
	/**
	 * Post-run feedback UI state. `existing` is the submitter's record for the
	 * current run (null = not submitted yet); `rating` mirrors the star row;
	 * `submitting` guards duplicate submissions while a request is in flight.
	 */
	feedback: { runId: undefined, existing: undefined, existingLoadedFor: undefined, rating: 0, submitting: false, editing: false },
	/** run id -> the current user's own feedback record (run-list badges). */
	runRatings: new Map(),
	/**
	 * Single source of truth for the live view: the currently executing
	 * device/browser context, resolved by activeRuntimeEnvironment.js.
	 * Every live-view component reads this — never its own fallback chain.
	 */
	activeRuntimeEnvironment: undefined
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

/**
 * Boot-critical fetch with a bounded deadline (#16228). A server that hangs
 * (not fails) must degrade the boot into the runs list rather than leaving a
 * permanently blank workspace behind the hidden auth gate.
 */
async function apiWithTimeout(path, timeoutMs, options = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new DOMException('Signal timed out.', 'TimeoutError')), timeoutMs);
	try {
		return await api(path, { ...options, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
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

/**
 * Friendly export failure: a 409 from a pending report means "not finalized
 * yet", which deserves a clear next step instead of the raw server message.
 */
function exportError(error, fallback) {
	if (error?.status === 409) {
		toast('The report is still being finalized — try again once the run completes.', 'bad');
		return;
	}
	fail(error ?? new Error(fallback ?? 'The export failed.'));
}

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
	getProjectState: () => state.founderProjectState,
	onToggleSelection: founderToggleSelection,
	onSelectAll: ids => founderSaveSelections(ids),
	onClearSelection: () => founderSaveSelections([]),
	onSendToStudio: founderSendToStudio,
	onExportHandoff: founderExportHandoff,
	elements: {
		founderView: el.founderView,
		countFounder: el.countFounder,
		reportView: el.reportView
	},
	apiText,
	downloadReportPdf,
	toast,
	fail,
	exportError,
	humanizeId: humanizeSqaId
});

/** Founder project-state persistence (Phase 3): load once per founder view,
 *  selections are saved immediately and restore on reopen. */
async function founderLoadProjectState() {
	try {
		const result = await api('/founder/state');
		state.founderProjectState = result?.state ?? null;
	} catch {
		state.founderProjectState = null;
	}
}

function founderToggleSelection(id, checked) {
	const saved = state.founderProjectState;
	if (!saved?.recommendationSet?.recommendations) return;
	const current = new Set(saved.selections ?? []);
	if (checked) current.add(id); else current.delete(id);
	founderSaveSelections([...current]);
}

async function founderSaveSelections(ids) {
	if (!state.founderProjectState?.recommendationSet?.recommendations) return;
	try {
		const result = await api('/founder/state/selections', {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedRecommendationIds: ids })
		});
		state.founderProjectState = result?.state ?? state.founderProjectState;
		renderFounder();
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}

/** Explicit Founder → Studio handoff (Phase 4). Selection alone never
 *  triggers a delivery; only this explicit send does. */
async function founderSendToStudio(ids) {
	if (!Array.isArray(ids) || ids.length === 0) return;
	if (state.founderProjectState?.handoff?.status === 'pending') return; // duplicate-submit guard (server also enforces 409)
	try {
		const result = await api('/founder/handoff', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedRecommendationIds: ids })
		});
		if (result?.state) state.founderProjectState = result.state;
		if (result?.unavailable) {
			state.founderHandoffPayload = result.payload ?? null;
			toast('Studio delivery is not configured — the handoff payload is ready to copy or export. No build was started.');
		} else {
			toast(result?.handoff?.status === 'succeeded'
				? `Sent to Studio ✓ ${result.handoff.selectedRecommendationIds?.length ?? 0} recommendation(s) delivered.`
				: 'Handoff recorded.');
		}
	} catch (error) {
		toast(error instanceof Error ? error.message : String(error));
		// Re-read state: a failed send keeps selections; status may be 'failed'.
		await founderLoadProjectState();
	}
	renderFounder();
}

/** Copy/export fallback when Studio delivery is not configured. */
async function founderExportHandoff(mode) {
	const ids = state.founderProjectState?.handoff?.selectedRecommendationIds
		?? state.founderProjectState?.selections ?? [];
	if (!ids.length) return;
	try {
		const result = await api('/founder/handoff', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ selectedRecommendationIds: ids, export: true })
		});
		const payload = result?.payload;
		if (!payload) throw new Error('No payload returned.');
		const text = JSON.stringify(payload, null, 2);
		if (mode === 'copy') {
			await navigator.clipboard.writeText(text);
			toast('Handoff payload copied to clipboard.');
		} else {
			const blob = new Blob([text], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const save = document.createElement('a');
			save.href = url;
			save.download = `founder-handoff-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
			document.body.append(save);
			save.click();
			save.remove();
			window.setTimeout(() => URL.revokeObjectURL(url), 0);
			toast('Handoff payload downloaded. No build was started.');
		}
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
	}
}
const renderFounder = founderView.render;
const renderFounderReportTab = founderView.renderReportTab;

/* ── Bug tracker (standalone view) ───────────────────────────────── */

const bugsView = createBugsView({
	elements: {
		statusFilter: $('bugs-status-filter'),
		severityFilter: $('bugs-severity-filter'),
		runSelect: $('bugs-run-filter-select'),
		searchInput: $('bugs-search-input'),
		summary: $('bugs-summary'),
		tableWrap: $('bugs-table-wrap'),
		tbody: $('bugs-tbody'),
		empty: $('bugs-empty'),
		refresh: $('bugs-refresh')
	},
	api,
	toast,
	fail,
	openRun: runId => {
		setBugsViewOpen(false);
		void selectSession(runId);
	}
});
bugsView.bind();

el.bugsClose = $('bugs-close');
el.bugsClose.onclick = () => pageRouter.leave({ name: 'runs' });

// The SSE stream is per-run, so findings filed by agents in OTHER runs never
// reach the open backlog view. While it is open, poll on a slow cadence via
// the view's own coalesced scheduleRefresh (max one refetch per 4s window).
let bugsViewLiveTimer;
function setBugsViewOpen(open) {
	state.bugsViewOpen = open;
	el.bugsView.hidden = !open;
	el.openBugs.setAttribute('aria-pressed', String(open));
	// The three-panel workspace and the bugs view are exclusive regions.
	document.querySelector('.app')?.classList.toggle('is-hidden', open);
	if (open) {
		// Coming back to the view: filters may be stale after runs finished.
		bugsView.load().catch(fail);
		if (bugsViewLiveTimer === undefined) {
			bugsViewLiveTimer = setInterval(() => bugsView.scheduleRefresh(), 10_000);
		}
	} else {
		clearInterval(bugsViewLiveTimer);
		bugsViewLiveTimer = undefined;
	}
}

el.openBugs.onclick = () => {
	if (state.bugsViewOpen) pageRouter.leave({ name: 'runs' });
	else void pageRouter.navigate({ name: 'bugs' });
};
/* ── Bugs tab (Phase 6) ──────────────────────────────────────────── */

const bugView = createBugView({
	api,
	toast,
	openRun: (runId) => void selectSession(runId).catch(fail)
});

/** Refresh the Bugs tab from /api/bugs and repaint it (safe to fire-and-forget). */
async function refreshBugs() {
	if (!el.bugsList || !el.countBugs) return;
	await bugView.refresh();
	bugView.render(el.bugsList, el.countBugs);
	paintBugFilterValues();
}

function paintBugFilterValues() {
	const filters = bugView.filters;
	const search = $('bug-search');
	if (search) search.value = filters.search;
	const status = $('bug-filter-status');
	if (status) status.value = filters.status;
	const severity = $('bug-filter-severity');
	if (severity) severity.value = filters.severity;
}

function initBugFilters() {
	const host = el.bugViewHost;
	if (!host || host.dataset.bugFilters === 'on') return;
	host.dataset.bugFilters = 'on';
	const bar = document.createElement('div');
	bar.className = 'bug-filter-bar';
	const search = document.createElement('input');
	search.id = 'bug-search';
	search.type = 'search';
	search.placeholder = 'Search bugs…';
	search.setAttribute('aria-label', 'Search bugs');
	const status = document.createElement('select');
	status.id = 'bug-filter-status';
	status.setAttribute('aria-label', 'Filter bugs by status');
	status.append(new Option('Any status', ''));
	for (const value of ['open', 'in_progress', 'resolved', 'wont_fix', 'reopened']) {
		status.append(new Option(value.replace(/_/g, ' '), value));
	}
	const severity = document.createElement('select');
	severity.id = 'bug-filter-severity';
	severity.setAttribute('aria-label', 'Filter bugs by severity');
	severity.append(new Option('Any severity', ''));
	for (const value of ['critical', 'high', 'medium', 'low']) {
		severity.append(new Option(value, value));
	}
	const rerender = () => {
		bugView.setFilter({
			search: search.value.trim(),
			status: status.value,
			severity: severity.value
		});
		bugView.render(el.bugsList, el.countBugs);
	};
	search.oninput = rerender;
	status.onchange = rerender;
	severity.onchange = rerender;
	bar.append(search, status, severity);
	const listHost = el.bugsList;
	listHost.before(bar);
}

initBugFilters();


/* ── Runs (left panel) ───────────────────────────────────────────── */

function renderRunsEmptyState() {
	el.runList.replaceChildren();
	const empty = document.createElement('div');
	empty.className = 'feed-empty';
	const line = document.createElement('p');
	line.textContent = 'No runs yet';
	empty.append(line);
	el.runList.append(empty);
}

async function refreshRuns() {
	const [runs, matrices] = await Promise.all([
		api('/sessions').catch(() => []),
		api('/matrix-runs').catch(() => ({ runs: [] }))
	]);
	// Keep accepted work discoverable before its first child session exists.
	const queued = (matrices.runs ?? []).filter(run => ['pending', 'running'].includes(run.status)
		&& (run.statusCounts?.QUEUED || run.statusCounts?.PENDING)
		&& !runs.some(session => session.matrixRunId === run.id));
	if (runs.length === 0 && queued.length === 0) {
		renderRunsEmptyState();
		state.timer.runLiveTimers.clear();
		return;
	}
	// Rating badges: the current user's own feedback for the visible runs.
	// One request, matched client-side; failures just skip the badges.
	void loadRunRatingBadges(runs);
	el.runList.replaceChildren(...queued.map(renderQueuedRun), ...runs.map(renderRun));
	filterRunHistory();
}

function renderQueuedRun(run) {
	const row = document.createElement('div');
	row.className = 'run-row';
	row.setAttribute('role', 'listitem');
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'run';
	button.setAttribute('aria-label', `${run.targetUrl || run.title} · Queued`);
	button.onclick = () => void pageRouter.navigate({ name: 'matrix-run', runId: run.id });
	const title = document.createElement('div');
	title.className = 'run-title';
	title.textContent = run.targetUrl ? hostOf(run.targetUrl) : run.title;
	const status = document.createElement('div');
	status.className = 'run-meta';
	status.textContent = 'Queued · Waiting for a browser';
	button.append(title, status);
	row.append(button);
	return row;
}

function filterRunHistory() {
	const search = $('journey-run-search');
	const term = search?.value.trim().toLowerCase() ?? '';
	const rows = [...el.runList.querySelectorAll('.run-row')];
	let matches = 0;
	for (const row of rows) {
		const button = row.querySelector('.run');
		row.hidden = Boolean(term && !`${row.textContent} ${button?.getAttribute('aria-label') ?? ''}`.toLowerCase().includes(term));
		if (!row.hidden) matches++;
	}
	$('journey-no-matches').hidden = !term || !rows.length || matches > 0;
}
$('journey-run-search')?.addEventListener('input', filterRunHistory);

// Live token commits arrive up to once a second; refreshing the whole run
// list for each is wasteful. Coalesce to at most one refetch per 5s.
let runBadgeRefreshTimer;
function scheduleRunBadgeRefresh() {
	if (runBadgeRefreshTimer) return;
	runBadgeRefreshTimer = setTimeout(() => {
		runBadgeRefreshTimer = undefined;
		void refreshRuns();
	}, 5000);
	runBadgeRefreshTimer.unref?.();
}

async function loadRunRatingBadges(runs) {
	const ids = runs.map(run => run.id).join(',');
	try {
		const list = await api(`/feedback/mine?runs=${ids}`);
		state.runRatings = new Map((list ?? []).map(record => [record.runId, record]));
	} catch {
		state.runRatings = new Map();
	}
	if (runs.some(run => state.runRatings.has(run.id))) {
		for (const node of el.runList.querySelectorAll('.run')) {
			const rating = state.runRatings.get(node.dataset.runId);
			if (rating === undefined) continue;
			const badge = document.createElement('span');
			badge.className = 'run-rating-badge';
			badge.textContent = `⭐${rating.rating}`;
			badge.title = `Your feedback: ${rating.rating} of 5${rating.comments ? ` — “${rating.comments}”` : ''}`;
			node.querySelector('.run-meta')?.append(badge);
		}
	}
	// The report's View/Provide button and USER FEEDBACK section follow the
	// freshly loaded records too (e.g. first paint raced the badge fetch).
	if (state.sessionId && state.runRatings.has(state.sessionId)) renderReport();
}

function renderRun(run) {
	const displayStatus = runPresentationStatus(run);
	const details = runCardDetails(run, deviceState.list);
	const row = document.createElement('div');
	row.className = 'run-row';
	row.setAttribute('role', 'listitem');

	const node = document.createElement('button');
	node.className = `run${run.id === state.sessionId ? ' is-active' : ''}`;
	node.type = 'button';
	node.setAttribute('aria-current', run.id === state.sessionId ? 'true' : 'false');
	node.onclick = () => selectSession(run.id);
	node.dataset.runId = run.id;

	const title = document.createElement('div');
	title.className = 'run-title';
	title.textContent = run.targetUrl ? hostOf(run.targetUrl) : run.title;
	const accessibleTitle = title.textContent || 'Untitled test';
	const accessibleStatus = runPresentationLabel(run);
	const accessibleDetails = [accessibleTitle, accessibleStatus, details.mode, details.environment].filter(Boolean).join(' · ');
	node.title = accessibleDetails;
	node.setAttribute('aria-label', accessibleDetails);
	node.dataset.status = displayStatus;

	const meta = document.createElement('div');
	meta.className = 'run-meta';
	const dot = document.createElement('span');
	dot.className = `dot${displayStatus === 'running' ? ' is-busy' : displayStatus === 'done' ? ' is-live' : displayStatus === 'blocked' ? ' is-warning' : ''}`;
	dot.setAttribute('aria-hidden', 'true');
	const age = document.createElement('span');
	age.className = 'run-age';
	age.textContent = relativeTime(run.updatedAt);
	const status = document.createElement('span');
	status.className = 'run-status-label';
	status.textContent = accessibleStatus;
	meta.append(dot, status);
	// Per-run timer: live elapsed for running runs (frozen while paused),
	// stored active duration for finished ones. Each row computes
	// independently — never a shared clock.
	if (Number.isFinite(run.startedAt)) {
		const pausedRow = Number.isFinite(run.pausedAt) && !Number.isFinite(run.completedAt);
		const duration = Number.isFinite(run.completedAt) || pausedRow
			? formatDurationShort(run.durationSeconds ?? elapsedSecondsOf(run))
			: formatDurationShort(elapsedSecondsOf(run));
		if (duration) {
			const timer = document.createElement('span');
			timer.className = `run-duration${run.status === 'running' && !pausedRow ? ' run-duration--live' : ''}${pausedRow ? ' run-duration--paused' : ''}`;
			timer.dataset.runId = run.id;
			timer.textContent = duration;
			timer.title = pausedRow
				? `Paused at ${formatTimeOfDay(run.pausedAt)} — resumes from ${duration} on continue`
				: run.status === 'running'
					? `Elapsed time — started ${formatTimeOfDay(run.startedAt)}`
					: `Total duration — completed ${formatTimeOfDay(run.completedAt)}`;
			meta.append(timer);
			if (run.status === 'running' && !pausedRow) {
				state.timer.runLiveTimers.set(run.id, timer);
			} else {
				state.timer.runLiveTimers.delete(run.id);
			}
		}
	}
	const context = document.createElement('div');
	context.className = 'run-context';
	const mode = document.createElement('span');
	mode.className = 'run-mode-badge';
	mode.textContent = details.mode;
	context.append(mode);
	if (details.environment) {
		const environment = document.createElement('span');
		environment.className = 'run-device-pill';
		environment.textContent = details.environment;
		environment.title = details.environment;
		context.append(environment);
	}
	const footer = document.createElement('div');
	footer.className = 'run-footer';
	footer.append(age);
	if (details.findings) {
		const findings = document.createElement('span');
		findings.className = 'run-finding-count';
		findings.textContent = `${details.findings} ${details.findings === 1 ? 'finding' : 'findings'}`;
		footer.append(findings);
	}
	// Mini progress row: step count + slim bar, only when a plan exists.
	let progress = null;
	if (details.total > 0) {
		progress = document.createElement('div');
		progress.className = 'run-progress';
		const steps = document.createElement('span');
		steps.className = 'run-progress-steps';
		steps.textContent = `${details.completed} of ${details.total} steps`;
		const bar = document.createElement('span');
		bar.className = 'run-progress-bar';
		const fill = document.createElement('i');
		fill.style.width = `${details.percent}%`;
		bar.setAttribute('role', 'progressbar');
		bar.setAttribute('aria-valuemin', '0');
		bar.setAttribute('aria-valuemax', '100');
		bar.setAttribute('aria-valuenow', String(details.percent));
		bar.setAttribute('aria-label', `Plan progress ${details.completed} of ${details.total} steps`);
		bar.append(fill);
		progress.append(steps, bar);
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
		localStorage.removeItem('qase.session');
		if (run.id === state.sessionId) {
			const remaining = await api('/sessions');
			if (remaining[0]) {
				await selectSession(remaining[0].id);
			} else {
				el.runList.replaceChildren();
				state.sessionId = undefined;
				state.session = undefined;
				el.chatTitle.textContent = 'Qase';
				el.chatTarget.textContent = 'Send a URL to begin';
				el.transcript.replaceChildren();
			}
		}
		await refreshRuns();
	};

	node.append(title, meta, context);
	if (progress) node.append(progress);
	node.append(footer);
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
	// Phase 5 audit: the legacy #device-select element no longer exists in
	// HTML — only the localStorage preference + deviceState.list remain live
	// (labels + defaults). The null-guarded select plumbing was removed.
	if (el.deviceLandscape) {
		el.deviceLandscape.checked = localStorage.getItem(DEVICE_LANDSCAPE_KEY) === '1';
		el.deviceLandscape.addEventListener('change', () => {
			localStorage.setItem(DEVICE_LANDSCAPE_KEY, el.deviceLandscape.checked ? '1' : '0');
		});
	}
}

function pendingDeviceId() {
	return localStorage.getItem(DEVICE_PREF_KEY) || deviceState.defaultId;
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

/* ── Cross-platform environments ──────────────────────────────── */

const ENV_PREF_KEY = 'qase.environmentId';
const envState = { list: [], loaded: false };

function populateEnvironmentSelect(select) {
	if (!select) return;
	select.replaceChildren(new Option('Emulate locally (no remote environment)', ''));
	const saved = pendingEnvironmentId();
	for (const group of envOptionGroups(envState.list)) {
		const optgroup = document.createElement('optgroup');
		optgroup.label = group.platform;
		for (const { device, envs } of group.devices) {
			for (const env of envs) {
				optgroup.append(new Option(`${device} · ${env.osVersion} — ${env.browser} ${env.browserVersion}`, env.envId));
			}
		}
		select.append(optgroup);
	}
	select.value = envState.list.some(env => env.envId === saved) ? saved : '';
	// Dialogs are reopened repeatedly; keep one preference handler per select.
	select.onchange = () => {
		if (select.value) localStorage.setItem(ENV_PREF_KEY, select.value);
		else localStorage.removeItem(ENV_PREF_KEY);
	};
}

function envLabel(env) {
	return `${env.device} · ${env.os} ${env.osVersion} — ${env.browser} ${env.browserVersion}`;
}

/** Grouped optgroups: Platform → Device → OS version → browser + version. */
function envOptionGroups(list) {
	const groups = new Map();
	for (const env of list) {
		const platformKey = env.platformLabel;
		if (!groups.has(platformKey)) groups.set(platformKey, new Map());
		const byDevice = groups.get(platformKey);
		if (!byDevice.has(env.device)) byDevice.set(env.device, []);
		byDevice.get(env.device).push(env);
	}
	return [...groups.entries()].map(([platform, byDevice]) => ({
		platform,
		devices: [...byDevice.entries()].map(([device, envs]) => ({
			device,
			envs: envs.sort((a, b) => b.osVersion.localeCompare(a.osVersion, undefined, { numeric: true })
				|| a.browser.localeCompare(b.browser)
				|| Number(b.browserVersion) - Number(a.browserVersion))
		}))
	}));
}

async function loadEnvironments() {
	if (envState.loaded) return envState.list;
	try {
		const payload = await api('/environments?active=true&limit=80000');
		envState.list = Array.isArray(payload?.environments) ? payload.environments : [];
		envState.loaded = true;
	} catch {
		envState.list = [];
		envState.loaded = true;
	}
	return envState.list;
}

function pendingEnvironmentId() {
	return localStorage.getItem(ENV_PREF_KEY) || '';
}

/* ── TEST ON block (DX Phase 3): the ONE selection shown in every start
 * dialog. Reads the store — no per-dialog device/environment state. */
function renderTestOn(containerId) {
	const box = document.getElementById(containerId);
	if (!box) return;
	// #15164: the Start-QA TEST ON block mirrors the in-modal matrix
	// selection (device scope or full-matrix counts) — never a separate
	// picker state. Other containers (SQA/Founder) keep picker semantics.
	if (containerId === 'qa-test-on') {
		box.textContent = '';
		const summaryCount = qaMatrixState.selectedEnvIds.length;
		// Pipeline Phase 1: the block always reports the GLOBAL selection —
		// a device scope is a view and never changes what a run submits.
		if (summaryCount > 0) {
			delete box.dataset.empty;
			const name = document.createElement('strong');
			name.className = 'test-on-device';
			name.textContent = 'Full device matrix';
			const line = document.createElement('span');
			line.className = 'test-on-line';
			line.textContent = `${summaryCount.toLocaleString()} selected configurations · browsers run one at a time`;
			box.append(name, line);
			return;
		}
	}
	const sel = activeTestEnvStore?.get?.();
	box.textContent = '';
	if (!sel) {
		box.dataset.empty = 'true';
		const prompt = document.createElement('span');
		prompt.className = 'test-on-prompt';
		prompt.textContent = 'Choose a device';
		box.append(prompt);
		return;
	}
	delete box.dataset.empty;
	const name = document.createElement('strong');
	name.className = 'test-on-device';
	name.textContent = sel.device;
	const line = document.createElement('span');
	line.className = 'test-on-line';
	line.textContent = [sel.os, sel.osVersion, '·', sel.browser, sel.browserVersion].filter(Boolean).join(' ');
	const meta = document.createElement('span');
	meta.className = 'test-on-meta';
	meta.textContent = `● ${executionTypeText(sel)} · ${sel.resolution ?? ''} ${sel.orientation ?? ''}`.replace(/\s+/g, ' ').trim();
	box.append(name, line, meta);
}

function renderAllTestOnBlocks() {
	renderTestOn('qa-test-on');
	renderTestOn('sqa-test-on');
	renderTestOn('founder-test-on');
}


/** Submit-time source of truth (AC14): the store's envId, read at submit. */
function selectedEnvironmentForRun() {
	const sel = activeTestEnvStore?.get?.();
	return sel?.envId || '';
}

const DEVICE_LANDSCAPE_KEY = 'qase.deviceLandscape';
function pendingLandscape() {
	if (el.deviceLandscape) return Boolean(el.deviceLandscape.checked);
	return localStorage.getItem(DEVICE_LANDSCAPE_KEY) === '1';
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


// #16228: boot-time session selection with a hard deadline. A hung server
// during boot (not a failed request — a request that never answers) must fall
// back to the runs list instead of leaving a blank workspace.
function selectSessionWithTimeout(id, options, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out opening run ${id}.`)), timeoutMs);
		selectSession(id, options).then(
			value => { clearTimeout(timer); resolve(value); },
			error => { clearTimeout(timer); reject(error); }
		);
	});
}

async function selectSession(id, { updateRoute = true } = {}) {
	if (document.body.dataset.workspaceView === 'runs') setWorkspaceView('agent');
	state.shownFounderReport = undefined;
	state.shownQaResults = undefined;
	state.shownRunningPlan = undefined;
	state.sessionId = id;
	state.bubbles.clear();
	// Feedback submitted-state is per run: drop any cached record when the
	// selected run changes so the next modal open re-fetches it.
	if (state.feedback.existingLoadedFor !== id) {
		state.feedback.existing = undefined;
		state.feedback.existingLoadedFor = undefined;
	}
	localStorage.setItem('qase.session', id);

	const session = await api(`/sessions/${id}`);
	if (state.sessionId !== id) return;
	applySessionSnapshot(session);
	if (session.status === 'done' && matchMedia('(max-width: 720px)').matches) setWorkspaceView('results');
	if (session.mode === 'founder') {
		void founderLoadProjectState().then(() => renderFounder());
	} else {
		state.founderProjectState = null;
	}	await connect(id);
	await refreshRuns();
	if (updateRoute && pageRouter.started) {
		await pageRouter.navigate({ name: session.status === 'done' ? 'results' : 'run', runId: id });
	}
}

let _runEnvHook = null;
function setRunEnvHook(fn) { _runEnvHook = fn; }

// Right-panel "LIVE DEVICE VIEW" header: every value comes from the single
// activeRuntimeEnvironment view-model — never from local fallback chains.
function renderLiveDeviceViewHeader(session, are = null) {
	const ldv = document.getElementById('live-device-view-head');
	if (!ldv) return;
	const dev = ldv.querySelector('#ldv-device');
	const exec = ldv.querySelector('#ldv-exec');
	const live = ldv.querySelector('#ldv-live');
	if (!dev || !exec || !live) return;
	live.dataset.status = runPresentationStatus(session) || 'idle';
	const completed = session?.status === 'done';
	const hasSavedPreview = completed && Boolean(session?.frame);

	const view = are ?? resolveActiveRuntimeEnvironment({ session, environments: deviceState.list });
	if (!view) {
		dev.textContent = hasSavedPreview ? 'Saved' : (activeTestEnvStore?.get?.()?.device ?? '—');
		exec.textContent = 'No device';
		exec.dataset.exec = 'none';
		live.hidden = !session;
		live.textContent = completed ? 'Complete' : 'Idle';
		live.dataset.live = 'false';
		ldv.title = hasSavedPreview ? 'Saved preview from the completed run' : 'Preview — no active browser';
		return;
	}

	state.activeRuntimeEnvironment = view;
	// Preview header/frame follow the ACTIVE RUN only; when the session is
	// idle/queued/completed, the user's store selection owns the preview
	// (same rule as the env card — a stale session must not override it).
	const activeRun = ['running', 'connected', 'connecting', 'reserving'].includes(view.runtimeStatus);
	const selView = activeRun ? null : viewForSelection(activeTestEnvStore?.get?.());
	if (!activeRun && !selView) {
		// Idle with NO store selection (e.g. after Clear): empty state — never
		// resurrect the stale session device on the header/frame.
		dev.textContent = hasSavedPreview ? 'Saved' : '—';
		exec.textContent = 'No device';
		exec.dataset.exec = 'none';
		live.hidden = !session;
		live.textContent = completed ? 'Complete' : 'Idle';
		live.dataset.live = 'false';
		ldv.title = hasSavedPreview ? 'Saved preview from the completed run' : 'Preview — no browser selected';
		renderBrowserChrome(null);
		applyDeviceFrame(null);
		renderUnavailableState(null, 'NO DEVICE');
		return;
	}
	const headerView = selView ?? view;
	const deviceLabel = headerView.device;
	const execMap = {
		real_device: headerView.executionTypeAttested ? 'REAL DEVICE' : 'REAL (UNVERIFIED)',
		virtual_device: 'VIRTUAL DEVICE',
		simulated: 'SIMULATED',
		none: 'NO DEVICE'
	};
	const execLabel = execMap[headerView.executionType] ?? headerView.executionType.toUpperCase();
	const statusMap = {
		queued: 'Queued',
		reserving: 'Preparing…',
		connecting: 'Connecting…',
		connected: 'Connected',
		running: 'Running',
		blocked: 'Needs attention',
		completed: 'Complete',
		failed: 'Failed',
		device_unavailable: 'Unavailable',
		released: 'Released'
	};
	const liveLabel = statusMap[view.runtimeStatus] ?? String(view.runtimeStatus).replaceAll('_', ' ');

	exec.dataset.exec = view.executionType;
	exec.textContent = execLabel;
	live.hidden = false;
	live.textContent = liveLabel;
	live.dataset.live = String(['running', 'connected'].includes(view.runtimeStatus));
	dev.textContent = deviceLabel;
	ldv.title = `Preview — ${headerView.device} · ${[headerView.os, headerView.osVersion].filter(Boolean).join(' ') || 'unknown OS'} · ${[headerView.browser, headerView.browserVersion].filter(Boolean).join(' ') || 'unknown browser'} · ${execLabel}`;

	// Chrome + frame + unavailable state follow the same source split: the
	// active run when executing, otherwise the store selection.
	renderBrowserChrome(activeRun ? view : headerView);
	applyDeviceFrame(activeRun ? view : headerView);
	renderUnavailableState(activeRun ? view : headerView, execLabel);
}


/* Browser chrome above the live screen — identity of the EXECUTING browser. */
function renderBrowserChrome(view) {
	const bar = document.getElementById('browser-chrome');
	if (!bar) return;
	if (!view || view.source === 'none' || view.executionType === 'none') { bar.hidden = true; return; }
	const vm = chromeViewModel({ browserKey: view.browserKey, url: el.browserUrl?.textContent, title: el.browserTitle?.textContent });
	bar.hidden = false;
	const dot = document.getElementById('chrome-brand-dot');
	if (dot) dot.style.background = vm.brand.color;
	const brand = document.getElementById('chrome-brand');
	if (brand) { brand.textContent = vm.brand.name; brand.style.color = vm.brand.color; }
	const lock = document.getElementById('chrome-lock');
	if (lock) lock.textContent = vm.secure ? '🔒' : '⚠';
	const url = document.getElementById('chrome-url');
	if (url) { url.textContent = vm.url || 'about:blank'; url.title = vm.fullUrl || ''; }
}

/* Device frame category: phone / tablet / desktop on #stage. */
function applyDeviceFrame(view) {
	if (!el.stage) return;
	if (!view || view.source === 'none') {
		el.stage.removeAttribute('data-device-kind');
		el.stage.removeAttribute('data-device-label');
		el.stage.removeAttribute('data-device-orientation');
		return;
	}
	el.stage.setAttribute('data-device-kind', view.deviceType);
	el.stage.setAttribute('data-device-label', view.device);
	el.stage.setAttribute('data-device-orientation', view.orientation);
	el.stage.setAttribute('data-browser-key', view.browserKey);
	if (view.resolution) {
		el.stage.style.setProperty('--ldv-res-w', String(view.resolution.width));
		el.stage.style.setProperty('--ldv-res-h', String(view.resolution.height));
		const ratio = view.orientation === 'landscape'
			? view.resolution.width / view.resolution.height
			: view.resolution.height / view.resolution.width;
		el.stage.style.setProperty('--ldv-aspect', String(Math.min(Math.max(ratio, 0.4), 3.2)));
	} else {
		el.stage.style.removeProperty('--ldv-aspect');
	}
}

/**
 * Execution log targeting: a pinned block at the top of the transcript that
 * names the EXACT environment under test (from the single view-model), the
 * honest execution level, the runtime id, and the final result on completion.
 */
function renderExecutionTargeting(session) {
	const host = document.getElementById('execution-target-block');
	if (!host) return;
	const view = state.activeRuntimeEnvironment;
	if (!view || view.source === 'none') { host.hidden = true; host.replaceChildren(); return; }
	host.hidden = false;
	host.replaceChildren();

	const block = document.createElement('div');
	block.className = `exec-target exec-target--${view.runtimeStatus}`;

	const head = document.createElement('div');
	head.className = 'exec-target-head';
	head.textContent = 'TARGET';
	block.append(head);

	const envLine = document.createElement('div');
	envLine.className = 'exec-target-env';
	envLine.textContent = [
		view.device,
		[view.os, view.osVersion].filter(Boolean).join(' '),
		[view.browser, view.browserVersion].filter(Boolean).join(' ')
	].filter(Boolean).join(' · ');
	block.append(envLine);

	const metaLine = document.createElement('div');
	metaLine.className = 'exec-target-meta';
	const execLabelMap = { real_device: 'REAL DEVICE', virtual_device: 'VIRTUAL DEVICE', simulated: 'SIMULATED', none: 'NO DEVICE' };
	metaLine.textContent = ['EXECUTION', execLabelMap[view.executionType] ?? view.executionType.toUpperCase(), 'RUNTIME', view.runtimeSessionId ?? '—'].join('  ');
	block.append(metaLine);

	const status = view.runtimeStatus;
	if (['running', 'connected'].includes(status)) {
		const testing = document.createElement('div');
		testing.className = 'exec-target-testing';
		testing.textContent = `TESTING — ${view.device} · ${[view.browser, view.browserVersion].filter(Boolean).join(' ')}`;
		block.append(testing);
	} else if (status === 'completed') {
		const done = document.createElement('div');
		done.className = 'exec-target-done';
		const verdict = String(session?.report?.verdict ?? session?.verdict ?? '').toUpperCase();
		done.textContent = `TEST COMPLETED — ${view.device} · ${[view.os, view.osVersion].filter(Boolean).join(' ')} · ${[view.browser, view.browserVersion].filter(Boolean).join(' ')}` + (verdict ? ` — Result: ${verdict}` : '');
		block.append(done);
	} else if (status === 'failed') {
		const failed = document.createElement('div');
		failed.className = 'exec-target-failed';
		failed.textContent = 'TEST FAILED — runtime reported an error for this environment.';
		block.append(failed);
	}

	host.append(block);
}

/* Unavailable state: honest error panel, never a fake preview. */
function renderUnavailableState(view, execLabel) {	const panel = document.getElementById('ldv-unavailable');
	if (!panel || !view) return;
	if (view.runtimeStatus !== 'device_unavailable') { panel.hidden = true; return; }
	panel.hidden = false;
	const env = document.getElementById('ldv-unavailable-env');
	if (env) env.textContent = [view.device, [view.os, view.osVersion].filter(Boolean).join(' '), [view.browser, view.browserVersion].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
	const reason = document.getElementById('ldv-unavailable-reason');
	if (reason) reason.textContent = `Reason: ${view.unavailableReason ?? 'Runtime unavailable for this device/browser combination.'}`;
	const retry = document.getElementById('ldv-retry');
	if (retry) retry.onclick = () => { panel.hidden = true; if (state.sessionId) void startRun(); };
	const change = document.getElementById('ldv-change-env');
	if (change) change.onclick = () => { panel.hidden = true; devicePicker?.open?.(); };
}

function applySessionSnapshot(session) {
	const changedSession = state.session?.id !== session.id;
	state.bubbles.clear();
	state.session = session;
	// Refresh the clock-skew sample on every snapshot (load, resync, refresh).
	noteServerNow(session.serverNow);
	applyStageDevice(session);
	resetRunMeta(session);

	renderHeader();
	// The collapse preference is UI state — reapply it on every run switch so
	// navigating between runs never unexpectedly expands/collapses the panel.
	setRunSummaryCollapsed(state.runSummaryCollapsed);
	renderTranscript();
	renderExecutionTargeting(session);
	resetThinking();
	renderQuestion();
	renderActivities();
	renderTodos();
	renderFindings();
	renderReport();
	syncSqaDetailMode(changedSession);
	renderSqa();
	renderFounder();
	showCompletedFounderReport();
	showRunningQaPlan();
	showCompletedQaResults();
	renderStageCollapse();
	updateRunTimer();
	if (_runEnvHook) _runEnvHook(session);
	// Recompute the single source of truth BEFORE anything renders from it.
	state.activeRuntimeEnvironment = resolveActiveRuntimeEnvironment({
		session,
		environments: deviceState.list
	});
	renderLiveDeviceViewHeader(session, state.activeRuntimeEnvironment);
	renderExecutionTargeting(session);

	if (session.frame) {
		applyFrame(session.frame);
	} else if (
		// Completion persistence (AC8): a run that finished with frames keeps
		// its final captured view + environment until a NEW run starts. Only a
		// genuinely frameless run shows the empty state.
		['done', 'error', 'interrupted', 'cancelled'].includes(String(session.status)) &&
		el.frame.getAttribute('src') &&
		state.sessionId === session.id
	) {
		// Keep the last frame on screen — badge already reads COMPLETED/FAILED.
	} else {
		el.frame.removeAttribute('src');
		el.stageInner.hidden = true;
		el.stageEmpty.hidden = false;
		el.browserUrl.textContent = session.targetUrl ?? 'about:blank';
		el.browserTitle.textContent = '';
		renderStageCollapse();
	}

}

async function startRun() { openQaStart(); }

async function createQaRun({
	targetUrl, device, deviceLandscape, selectedTests, securityAuthorization,
	kickoffText, engine = 'chromium', coreFlowsOnly = false, environmentId, scopeSelection
}) {
	void markOnboarded();
	const session = await api('/sessions', {
		method: 'POST',
		body: JSON.stringify({
			device,
			deviceLandscape,
			engine,
			selectedTests,
			...(securityAuthorization ? { securityAuthorization } : {}),
			...(environmentId ? { environmentId } : {}),
			...(scopeSelection ? { scopeSelection } : {})
		})
	});
	await selectSession(session.id);
	if (targetUrl) {
		const text = coreFlowsOnly && engine !== 'chromium'
			? `${targetUrl}\nFocus: core flows and cross-browser comparison on ${engine}; full sweep runs separately on Chromium.`
			: (kickoffText ?? targetUrl);
		await api(`/sessions/${session.id}/message`, { method: 'POST', body: JSON.stringify({ text }) }).catch(fail);
	}
	el.composerInput.focus();
	return session;
}

/** Compact token count: 820, 15.3k, 2.01M, 3.4B. Re-exported for callers importing from app.js. */
export { formatTokens };

/* ── One-click environment runs with honest fallbacks (Phase 23) ─── */
const runtimeBoardCache = { devices: [], at: 0 };
const RUNTIME_BOARD_TTL = 5000;

async function fetchRuntimeBoard(force = false) {
	if (!force && Date.now() - runtimeBoardCache.at < RUNTIME_BOARD_TTL) return runtimeBoardCache.devices;
	const payload = await api('/device-runtime/devices').catch(() => null);
	runtimeBoardCache.devices = payload?.devices ?? [];
	runtimeBoardCache.at = Date.now();
	return runtimeBoardCache.devices;
}

/**
 * Start a run on an environment. The UI never pre-creates a device session
 * for the direct path — the run engine (agent runTurn → deviceRuntime
 * .selectForRun) creates, labels and releases the session itself, linked to
 * the run. The UI's job is honest routing:
 *   - requested level attainable + device free → start the run directly;
 *   - otherwise → explicit fallback dialog (queue / virtualized / simulated),
 *     never a silent downgrade.
 */
async function startEnvironmentRun(env, { targetUrl = '' } = {}) {
	const devices = await fetchRuntimeBoard(true);
	const boardEntry = devices.find((d) => d.envId === env.envId) ?? null;
	const requestedLevel = boardEntry?.maximumLevel === 'REAL_DEVICE' ? 'REAL_DEVICE' : 'SIMULATED';
	const resolution = fallbackOptionsFor(boardEntry, requestedLevel);
	if (resolution.available) {
		// Guard against double-clicks: reuse an existing idle run on this
		// environment instead of piling up duplicates.
		const existing = await api('/sessions?limit=20').catch(() => []);
		const recent = (Array.isArray(existing) ? existing : [])
			.find((run) => run.environmentId === env.envId && run.status === 'idle');
		if (recent) {
			await selectSession(recent.id);
			toast(`${env.device} run is already waiting — send a URL to start testing.`);
			return;
		}
		await createQaRun({ targetUrl, environmentId: env.envId });
		toast(targetUrl
			? `Testing on ${env.device}…`
			: `${env.device} is ready — send a URL to start testing.`);
		return;
	}
	openExecFallback(env, boardEntry, requestedLevel, targetUrl);
}

/* Fallback dialog: REAL DEVICE UNAVAILABLE + honest reason; the user must
 * explicitly pick a fallback (queue / virtual / simulated) — never a silent
 * downgrade. Retry re-checks availability; "Choose another device" opens the
 * Device & Environment Matrix. */
let fallbackCtx = null;
function openExecFallback(env, boardEntry, requestedLevel, targetUrl) {
	const dialog = $('exec-fallback');
	if (!dialog) { fail(new Error('No runtime provider available for this environment.')); return; }
	fallbackCtx = { env, targetUrl, requestedLevel };
	const resolution = fallbackOptionsFor(boardEntry, requestedLevel);
	// Busy devices get a dedicated DEVICE BUSY modal — never an auto-switch.
	if (resolution.busy) {
		openDeviceBusyModal(env, resolution, requestedLevel);
		return;
	}
	$('exec-fallback-reason').textContent = `${resolution.reason} Choose how to proceed — every result is labeled with the execution type actually used.`;
	const list = $('exec-fallback-options');
	list.innerHTML = '';
	for (const option of resolution.options) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'exec-fallback-option';
		btn.innerHTML = `<strong></strong><small></small>`;
		btn.querySelector('strong').textContent = option.label;
		btn.querySelector('small').textContent = option.description;
		btn.onclick = () => { void applyFallback(option); };
		list.append(btn);
	}
	const retry = $('exec-fallback-retry');
	if (retry) {
		retry.onclick = async () => {
			retry.disabled = true;
			retry.textContent = 'Checking…';
			const devices = await fetchRuntimeBoard(true).catch(() => []);
			const fresh = devices.find((d) => d.envId === env.envId) ?? null;
			retry.disabled = false;
			retry.textContent = 'Retry';
			const again = fallbackOptionsFor(fresh, requestedLevel);
			if (again.available) {
				dialog.close();
				fallbackCtx = null;
				await startEnvironmentRun(env, { targetUrl });
			} else {
				$('exec-fallback-reason').textContent = `${again.reason} Choose how to proceed — every result is labeled with the execution type actually used.`;
			}
		};
	}
	const change = $('exec-fallback-change');
	if (change) {
		change.onclick = () => {
			dialog.close();
			fallbackCtx = null;
			deviceMatrix?.open();
		};
	}
	dialog.showModal();
}

/* DEVICE BUSY modal: shows the current runtime session and offers Queue /
 * Choose another device. Never moves the test automatically. */
function openDeviceBusyModal(env, resolution, requestedLevel) {
	const dialog = $('device-busy');
	if (!dialog) { openExecFallbackPlain(env, resolution, requestedLevel); return; }
	$('device-busy-detail').textContent = `${env.device ?? env.envId} — current session: ${resolution.busySessionId ?? 'unknown'}. New runs wait in queue.`;
	const list = $('device-busy-options');
	list.innerHTML = '';
	for (const option of resolution.options) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'exec-fallback-option';
		btn.innerHTML = `<strong></strong><small></small>`;
		btn.querySelector('strong').textContent = option.label;
		btn.querySelector('small').textContent = option.description;
		btn.onclick = () => { dialog.close(); void applyFallback(option); };
		list.append(btn);
	}
	const change = document.createElement('button');
	change.type = 'button';
	change.className = 'exec-fallback-option';
	change.innerHTML = `<strong>Choose another device</strong><small>Open the Device &amp; Environment Matrix and pick a free device.</small>`;
	change.onclick = () => { dialog.close(); deviceMatrix?.open(); };
	list.append(change);
	dialog.showModal();
}

/* Rare path: no busy dialog element — reuse the generic fallback dialog. */
function openExecFallbackPlain(env, resolution, requestedLevel) {
	$('exec-fallback-reason').textContent = `${resolution.reason} Choose how to proceed — every result is labeled with the execution type actually used.`;
	$('exec-fallback').showModal();
}

async function applyFallback(option) {
	$('exec-fallback')?.close();
	const ctx = fallbackCtx;
	fallbackCtx = null;
	if (!ctx) return;
	const { env, targetUrl } = ctx;
	if (option.action === 'queue') {
		// Explicit user choice to wait: reserve a queued slot now; when the
		// device frees up, the queued session auto-starts and we launch the
		// run against it (the engine creates its own labeled session).
		const result = await api('/device-runtime/sessions', { method: 'POST', body: JSON.stringify({
			environmentId: env.envId, requestedLevel: option.level, allowQueue: true
		}) }).catch(fail);
		if (result?.session) {
			trackQueuePanel(result.session, { env, targetUrl });
			toast('Queued — the run starts automatically when the device frees up.');
		}
		return;
	}
	// Explicit downgrade chosen by the user — recorded on the environment so
	// the run reports the level it actually runs at (env service validates).
	await api(`/environments/${encodeURIComponent(env.envId)}`, {
		method: 'PATCH',
		body: JSON.stringify({ executionLevelRequested: option.level })
	}).catch(() => { /* runTurn falls back to honest default labeling */ });
	await createQaRun({ targetUrl, environmentId: env.envId });
	toast(`Running ${option.label.toLowerCase()} — results will be labeled accordingly.`);
}

/* Queue panel: live position while a device session is queued. */
const queuePanelState = { sessionId: null, timer: null, launched: false };
function trackQueuePanel(session, runCtx = null) {
	if (!session?.sessionId) return;
	queuePanelState.sessionId = session.sessionId;
	queuePanelState.launchCtx = runCtx;
	queuePanelState.launched = false;
	const panel = $('run-queue-panel');
	if (!panel) return;
	panel.hidden = false;
	$('run-summary').hidden = false;
	$('run-queue-detail').textContent = session.environment?.device ? `on ${session.environment.device}` : session.envId ?? '';
	pollQueuePanel();
	clearInterval(queuePanelState.timer);
	queuePanelState.timer = setInterval(pollQueuePanel, 4000);
}

async function pollQueuePanel() {
	if (!queuePanelState.sessionId) return hideQueuePanel();
	const session = await api(`/device-runtime/sessions/${encodeURIComponent(queuePanelState.sessionId)}`).catch(() => null);
	if (!session || ['done', 'failed', 'cancelled'].includes(session.status)) return hideQueuePanel();
	const label = $('run-queue-label');
	if (label) label.textContent = describeQueue(session) ?? 'Queued for device';
	// Promoted from queued → running: the device is ours now — launch the run.
	if (session.status === 'running' && !queuePanelState.launched) {
		queuePanelState.launched = true;
		const ctx = queuePanelState.launchCtx;
		hideQueuePanel();
		if (ctx?.env) {
			await createQaRun({ targetUrl: ctx.targetUrl ?? '', environmentId: ctx.env.envId });
			toast(`Device free — testing on ${ctx.env.device}.`);
		}
	}
}

function hideQueuePanel() {
	clearInterval(queuePanelState.timer);
	queuePanelState.timer = null;
	queuePanelState.sessionId = null;
	$('run-queue-panel').hidden = true;
}

$('run-queue-cancel')?.addEventListener('click', async () => {
	if (!queuePanelState.sessionId) return hideQueuePanel();
	const result = await api(`/device-runtime/sessions/${encodeURIComponent(queuePanelState.sessionId)}/cancel`, { method: 'POST' }).catch(fail);
	hideQueuePanel();
	toast(result?.cancelled ? 'Queued session cancelled.' : 'Cancel not possible — the run already started.');
});



/** A run with no counted usage yet: show a pending state, never a fake 0. */
function usageIsPending(session) {
	const usage = session.tokenUsage;
	const hasUsage = usage && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0;
	return !hasUsage && session.status === 'running';
}

/**
 * Collapsed/expanded state for the run-summary section. UI preference, not run
 * state: survives run navigation and the RUNNING→DONE transition, stored in the
 * same localStorage the other UI prefs (device, session) already use.
 */
const RUN_SUMMARY_COLLAPSED_KEY = 'qase.runSummaryCollapsed';
state.runSummaryCollapsed = localStorage.getItem(RUN_SUMMARY_COLLAPSED_KEY) === '1';

function setRunSummaryCollapsed(collapsed) {
	state.runSummaryCollapsed = collapsed;
	localStorage.setItem(RUN_SUMMARY_COLLAPSED_KEY, collapsed ? '1' : '0');
	el.runSummary.classList.toggle('is-collapsed', collapsed);
	el.runSummaryMini.hidden = !collapsed;
	el.runSummaryToggle.setAttribute('aria-expanded', String(!collapsed));
	el.runSummaryToggle.setAttribute('aria-label', collapsed ? 'Expand run summary' : 'Collapse run summary');
	el.runSummaryToggle.textContent = collapsed ? '⌄' : '⌃';
	el.runSummaryToggle.title = collapsed ? 'Expand run summary' : 'Collapse run summary';
}

/**
 * Compact mirror of the run summary for the collapsed state. Reads the exact
 * same session state the expanded card reads (no extra fetching, no
 * recalculation) so live updates keep flowing while minimized.
 */
function renderMiniSummary() {
	const session = state.session;
	const usage = session?.tokenUsage;
	const displayStatus = runPresentationStatus(session);
	const mini = miniSummaryText({
		usage,
		status: displayStatus,
		progress: runProgress(),
		findings: session?.findings?.length ?? 0,
	});
	el.miniTokens.textContent = mini.tokens;
	el.miniStatus.textContent = mini.status;
	el.miniStatus.dataset.status = displayStatus;
	el.miniProgress.textContent = mini.progress;
	el.miniFindings.textContent = mini.findings;
}

function renderHeader() {
	const session = state.session;
	const guide = $('journey-run-guide');
	guide.hidden = !state.sessionId || Boolean(workflowStatus(session).hidden);
	if (state.sessionId) {
		const guidance = workflowStatus(session);
		guide.dataset.tone = guidance.tone;
		$('journey-run-title').textContent = guidance.title;
		$('journey-run-description').textContent = guidance.description;
		const action = $('journey-run-action');
		action.textContent = guidance.action;
		action.onclick = () => {
			if (guidance.destination === 'results') void pageRouter.navigate({ name: 'results', runId: state.sessionId });
			else if (guidance.destination === 'question') { setWorkspaceView('agent'); el.questionSlot.scrollIntoView({ block: 'nearest' }); el.questionSlot.querySelector('input, textarea, button')?.focus(); }
			else if (guidance.destination === 'conversation') { setWorkspaceView('agent'); el.transcript.scrollTop = el.transcript.scrollHeight; el.composerInput.focus(); }
			else el.composerInput.focus();
		};
	}
	// Customer-facing progress stays simple. Model usage remains in Run details.
	const hasRun = Boolean(state.sessionId && (session.targetUrl || session.title));
	document.body.dataset.hasRun = String(hasRun);
	el.statusChip.hidden = !hasRun;
	el.runSummary.hidden = !hasRun;
	el.tokenText.classList.remove('is-pending');
	el.tokenText.textContent = 'Run progress';
	el.tokenText.title = '';
	// LIVE pill: only while the run is actively working.
	el.livePill.hidden = session.status !== 'running';
	renderMiniSummary();
	renderProgressCard();
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
		el.chatTitle.textContent = target.name ?? session.title ?? 'Quality review';
		el.chatTarget.textContent = [target.release, target.environment].filter(Boolean).join(' · ')
			|| 'Standards-informed product quality review';
		setStatus(session.status);
		return;
	}
	const targetName = (session.targetUrl ? hostOf(session.targetUrl) : session.title) || 'this website';
	const displayStatus = runPresentationStatus(session);
	el.chatTitle.textContent = session.status === 'running'
		? `Testing ${targetName}`
		: displayStatus === 'blocked' ? 'Testing blocked'
			: session.status === 'done' ? 'Testing complete' : targetName;
	// Keep the engine visible in the header for non-chromium runs (the run
	// list already carries an engine pill in its meta row).
	if (session.engine && session.engine !== 'chromium') {
		const chip = document.createElement('span');
		chip.className = 'run-engine-pill';
		chip.textContent = session.engine;
		chip.title = `Run executed on ${session.engine}`;
		el.chatTitle.append(' ', chip);
	}
	el.chatTarget.textContent = session.targetUrl ?? 'Send a URL to begin';
	setStatus(session.status);
}

/**
 * Step counts for the progress card. Same computation renderTodos() feeds the
 * right-hand Plan tab, kept here once so the two can never disagree.
 */
function runProgress() {
	const todos = state.session?.todos ?? [];
	const total = todos.length;
	const done = todos.filter(todo => todo.status === 'completed').length;
	const percent = total > 0 ? Math.round((done / total) * 100) : undefined;
	return { total, done, percent };
}

/**
 * The RUNNING/DONE card: status + step count + percent + findings on the top
 * row, the progress bar on its own row, and the current activity below it —
 * all normal flow, no absolute positioning.
 */
function renderProgressCard() {
	const session = state.session;
	const { total, done, percent } = runProgress();
	el.progressSteps.textContent = total > 0 ? `${done}/${total}` : '';
	el.progressPct.textContent = percent !== undefined ? `${percent}%` : '';
	if (percent !== undefined) {
		el.progressBar.setAttribute('aria-valuenow', String(percent));
		el.progressBar.firstElementChild.style.width = `${percent}%`;
	} else {
		el.progressBar.setAttribute('aria-valuenow', '0');
		el.progressBar.firstElementChild.style.width = '0%';
	}
	const findings = session?.findings ?? [];
	el.progressFindings.textContent = findings.length > 0 ? `Findings ${findings.length}` : '';
	el.progressFindings.hidden = findings.length === 0;
	el.progressFindings.setAttribute('aria-label', findings.length > 0
		? `Open ${findings.length} finding${findings.length === 1 ? '' : 's'}`
		: 'No findings yet');
	renderMiniSummary();
	renderCurrentActivity();
}

function renderCurrentActivity() {
	const session = state.session;
	if (session?.status === 'running') {
		const { text, action } = state.thinking;
		const runningActivity = [...(session.activities ?? [])].reverse()
			.find(activity => activity.status === 'running');
		const activePlanItem = (session.todos ?? [])
			.find(todo => todo.status === 'in_progress');
		const savedAction = runningActivity?.label || runningActivity?.title
			|| activePlanItem?.text || activePlanItem?.title || '';
		const label = action || (text ? tailOf(text) : '') || savedAction;
		el.currentActivityState.textContent = label || 'Working…';
		el.currentActivity.hidden = false;
	} else if (session?.status === 'done') {
		el.currentActivityState.textContent = runPresentationStatus(session) === 'blocked'
			? `Testing could not proceed — ${truncate(blockedRunReason(session), 160)}`
			: 'Testing complete';
		el.currentActivity.hidden = false;
	} else {
		el.currentActivityState.textContent = '';
		el.currentActivity.hidden = true;
	}
}

function setStatus(status) {
	const previousStatus = document.body.dataset.runStatus;
	const justCompleted = status === 'done' && document.body.dataset.runStatus !== 'done';
	const justStarted = status === 'running' && previousStatus !== 'running';
	if (state.session) state.session.status = status;
	document.body.dataset.runStatus = status;
	if (justCompleted && matchMedia('(max-width: 720px)').matches) setWorkspaceView('results');
	if (justStarted && matchMedia('(max-width: 720px)').matches) setWorkspaceView('browser');
	const stopping = status === 'running' && state.stopRequests.has(state.sessionId);
	const stoppedByUser = status === 'interrupted' && state.session?.statusDetail === 'Stopped by user.';
	const displayStatus = runPresentationStatus(state.session);
	el.statusChip.dataset.status = displayStatus;
	el.statusChip.textContent = stopping ? 'Stopping…' : status === 'awaiting_input'
		? 'waiting for you'
		: status === 'running' ? 'Running'
			: displayStatus === 'blocked' ? 'Blocked'
				: status === 'done' ? 'Complete'
				: stoppedByUser ? 'Stopped'
					: status === 'interrupted' ? 'Paused'
						: status === 'error' ? 'Needs attention'
							: status;
	renderMiniSummary();
	const running = status === 'running';
	el.stopRun.hidden = !running;
	el.stopRun.disabled = stopping;
	el.stopRun.textContent = stopping ? 'Stopping…' : 'Stop';
	el.resumeRun.hidden = !((status === 'interrupted' || status === 'error') && state.sessionId);
	el.sendBtn.disabled = running;
	el.composerInput.disabled = running;
	el.composerHint.hidden = !running;
	el.livePill.hidden = !running;
	el.browserDot.className = `dot${running ? ' is-busy' : state.session?.targetUrl ? ' is-live' : ''}`;
	el.browserDot.dataset.status = displayStatus;
	syncRunTimer(status);
	syncStageCollapse(status);
	// A question raised while the tab is in the background should be noticeable.
	document.title = status === 'awaiting_input'
		? 'Qase — waiting for you'
		: 'Qase — autonomous QA agent';
	updateRunTimer();
	updateThinkingStrip();
}

/* ── Run meta: elapsed timer + context-window usage ──────────────── */

function formatElapsed(ms) {
	const total = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes >= 60) {
		const hours = Math.floor(minutes / 60);
		return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	}
	return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function runElapsedMs() {
	const timer = state.runTimer;
	if (typeof timer.startedAt !== 'number') return undefined;
	return (typeof timer.endedAt === 'number' ? timer.endedAt : Date.now()) - timer.startedAt;
}

function renderTimerChip() {
	const ms = runElapsedMs();
	if (ms === undefined) {
		el.timerChip.hidden = true;
		return;
	}
	el.timerChip.hidden = false;
	el.timerChip.textContent = formatElapsed(ms);
}

function renderTokenChip() {
	const usage = state.session?.contextUsage;
	if (!usage || typeof usage.percentage !== 'number') {
		el.tokenChip.hidden = true;
		return;
	}
	el.tokenChip.hidden = false;
	const percent = Math.max(0, Math.min(100, Math.round(usage.percentage)));
	el.tokenChip.textContent = `${percent}%`;
	const used = typeof usage.used === 'number' ? usage.used.toLocaleString() : '?';
	const windowSize = typeof usage.window === 'number' ? usage.window.toLocaleString() : '?';
	el.tokenChip.title = `Context window: ${used} / ${windowSize} tokens (${percent}%)`;
}

function syncRunTimer(status) {
	const timer = state.runTimer;
	if (status === 'running') {
		timer.endedAt = undefined;
		if (typeof timer.startedAt !== 'number') {
			timer.startedAt = state.session?.runStartedAt ?? Date.now();
		}
		if (!timer.interval) {
			renderTimerChip();
			timer.interval = setInterval(renderTimerChip, 1000);
		}
		return;
	}
	if (timer.interval) {
		clearInterval(timer.interval);
		timer.interval = undefined;
	}
	if (typeof timer.startedAt === 'number' && typeof timer.endedAt !== 'number') {
		timer.endedAt = Date.now();
	}
	renderTimerChip();
}

function resetRunMeta(session) {
	const timer = state.runTimer;
	if (timer.interval) {
		clearInterval(timer.interval);
		timer.interval = undefined;
	}
	timer.startedAt = typeof session?.runStartedAt === 'number' ? session.runStartedAt : undefined;
	timer.endedAt = typeof session?.runStartedAt === 'number' && session.status !== 'running' && session.status !== 'awaiting_input'
		? session.updatedAt ?? Date.now()
		: undefined;
	renderTimerChip();
	renderTokenChip();
}

function handleContextEvent(context) {
	if (state.session && context) {
		state.session.contextUsage = context;
	}
	renderTokenChip();
}

/* ── Post-run layout: collapse the live browser, expand the findings ── */

function stageHasContent() {
	return Boolean(state.session?.frame) || !el.stageInner.hidden;
}

function renderStageCollapse() {
	const previewAvailable = stageHasContent();
	const status = state.session?.status;
	// Default ended runs to results, but honor explicit preview preferences.
	// Without a frame, keep the compact strip without a fake preview action.
	const collapsed = previewCollapsed({ available: previewAvailable, status,
		hasSession: Boolean(state.session?.id), preference: state.stageCollapsePreferences.get(state.sessionId) });
	el.viewer.classList.toggle('stage-collapsed', collapsed);
	el.stageToggle.hidden = !previewAvailable;
	const toggleLabel = collapsed ? 'Show live preview' : 'Minimize live preview';
	el.stageToggle.textContent = collapsed ? '⤢' : '⤡';
	el.stageToggle.title = toggleLabel;
	el.stageToggle.setAttribute('aria-label', toggleLabel);
	el.stageToggle.setAttribute('aria-expanded', String(!collapsed));
	el.stageToggle.setAttribute('aria-controls', 'stage');
	el.stageNote.hidden = !collapsed;
	if (collapsed) {
		if (previewAvailable) {
			const count = state.session?.findings?.length ?? 0;
			const result = count === 1 ? '1 finding' : `${count} findings`;
			el.stageNote.textContent = runPresentationStatus(state.session) === 'blocked'
				? `Run blocked · Review report · Open preview`
				: state.session?.status === 'done'
					? `Run complete · ${result} · Open preview`
					: ['running', 'awaiting_input'].includes(status)
						? 'Live preview minimized · Open preview'
						: 'Run ended · Open saved preview';
			el.stage.setAttribute('role', 'button');
			el.stage.setAttribute('tabindex', '0');
			el.stage.setAttribute('aria-label', 'Show live preview');
		} else {
			el.stageNote.textContent = 'Preview unavailable · No saved browser image was captured for this run.';
			el.stage.removeAttribute('role');
			el.stage.removeAttribute('tabindex');
			el.stage.removeAttribute('aria-label');
		}
	} else {
		el.stage.removeAttribute('role');
		el.stage.removeAttribute('tabindex');
		el.stage.removeAttribute('aria-label');
	}
	fitStageFrame();
}

function showRunningQaPlan() {
	const session = state.session;
	if (!session || session.mode === 'sqa' || session.mode === 'founder' || session.status !== 'running') return;
	if (state.shownRunningPlan === session.id) return;
	state.shownRunningPlan = session.id;
	activateDetailTab($('tab-plan'));
}

function showCompletedQaResults() {
	const session = state.session;
	if (!session || session.mode === 'sqa' || session.mode === 'founder' || session.status !== 'done') return;
	if (state.shownQaResults === session.id) return;
	state.shownQaResults = session.id;
	activateDetailTab((session.findings?.length ?? 0) > 0 ? $('tab-findings') : el.reportTab);
}

function syncStageCollapse(status) {
	// Status events must not undo an explicit user choice during a live run.
	renderStageCollapse();
}

function toggleStageCollapse() {
	if (matchMedia('(max-width: 720px)').matches && document.body.dataset.workspaceView === 'results') {
		setWorkspaceView('browser');
		return;
	}
	state.stageCollapsePreferences.set(state.sessionId, !el.viewer.classList.contains('stage-collapsed'));
	renderStageCollapse();
}

/* ── Test Execution Timer ────────────────────────────────────────── */

function formatClock(totalSeconds) {
	if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00:00';
	const seconds = Math.floor(totalSeconds);
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return [h, m, s].map(part => String(part).padStart(2, '0')).join(':');
}

/** Human short form, e.g. "12m 18s" — used in run lists. */
function formatDurationShort(totalSeconds) {
	if (!Number.isFinite(totalSeconds)) return '';
	const seconds = Math.max(0, Math.floor(totalSeconds));
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function formatTimeOfDay(epochMs) {
	if (!Number.isFinite(epochMs)) return '';
	return new Date(epochMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** Record a server clock sample so elapsed math corrects local clock skew. */
function noteServerNow(serverNow) {
	if (Number.isFinite(serverNow) && serverNow > 0) {
		state.timer.skew = serverNow - Date.now();
	}
}

function serverNowNow() {
	return Date.now() + state.timer.skew;
}

/** Live elapsed ACTIVE seconds (server-authoritative, pause time excluded). */
function elapsedSecondsOf(session, now = serverNowNow()) {
	if (!Number.isFinite(session?.startedAt)) return undefined;
	const pausedSeconds = Number.isFinite(session.pausedSeconds) ? session.pausedSeconds : 0;
	// Currently paused: the clock is frozen at the pause point.
	if (Number.isFinite(session.pausedAt)) {
		return Math.max(0, Math.floor((session.pausedAt - session.startedAt) / 1000 - pausedSeconds));
	}
	const end = Number.isFinite(session.completedAt) ? session.completedAt : now;
	return Math.max(0, Math.floor((end - session.startedAt) / 1000 - pausedSeconds));
}

	const TIMER_LABELS = {
		running: 'Elapsed',
		awaiting_input: 'Elapsed (paused for input)',
		done: 'Total Duration',
		error: 'Duration Until Failure',
		idle: 'Duration'
	};

/**
 * Render the header timer for the current session and keep it ticking.
 * Stamps come only from the server (snapshot fields or SSE status timing);
 * the interval merely re-renders elapsed time between updates.
 */
function updateRunTimer() {
	const session = state.session;
	if (!session || !Number.isFinite(session.startedAt)) {
		el.runTimer.hidden = true;
		return;
	}
	el.runTimer.hidden = false;
	const terminal = ['done', 'error'].includes(session.status)
		|| Number.isFinite(session.completedAt);
	const paused = Number.isFinite(session.pausedAt) && !terminal;
	const label = paused ? 'Paused' : (TIMER_LABELS[session.status] ?? 'Elapsed');
	el.runTimerLabel.textContent = session.cancelledAt ? 'Duration (cancelled)' : label;
	el.runTimerLabel.dataset.state = session.status;
	if (runPresentationStatus(session) === 'blocked') {
		el.runTimer.dataset.state = 'blocked';
		el.runTimerLabel.dataset.state = 'blocked';
		el.runTimerLabel.textContent = '⚠ Testing Blocked';
	} else if (session.status === 'done') {
		el.runTimer.dataset.state = 'completed';
		el.runTimerLabel.textContent = '✓ Test Completed';
	} else if (session.status === 'error') {
		el.runTimer.dataset.state = 'failed';
		el.runTimerLabel.textContent = '⚠ Test Execution Failed';
	} else if (session.cancelledAt) {
		el.runTimer.dataset.state = 'cancelled';
		el.runTimerLabel.textContent = 'Test Cancelled';
	} else if (paused) {
		// User stop or system interruption = paused, not cancelled: elapsed
		// frozen at the pause point, resuming from exactly this value.
		el.runTimer.dataset.state = 'paused';
		el.runTimerLabel.textContent = '⏸ Paused';
	} else if (session.status === 'running') {
		el.runTimer.dataset.state = 'running';
		el.runTimerLabel.textContent = '● Testing';
	} else if (session.status === 'awaiting_input') {
		el.runTimer.dataset.state = 'paused';
		el.runTimerLabel.textContent = '⏸ Paused (awaiting input)';
	}
	const seconds = elapsedSecondsOf(session);
	el.runTimerClock.textContent = formatClock(seconds);
	// Tick the live clock only while the run can actually advance it.
	const live = session.status === 'running' && !terminal && !paused;
	el.runTimer.dataset.live = live ? 'true' : 'false';
	if (terminal || paused) {
		// Terminal or paused states don't need a second hand; show the stamps.
		el.runTimer.title = paused
			? `Paused: ${formatTimeOfDay(session.pausedAt)} — resumes from ${formatClock(seconds)} on continue`
			: Number.isFinite(session.completedAt)
				? `Test Completed: ${formatTimeOfDay(session.completedAt)}`
				: Number.isFinite(session.startedAt)
					? `Test Started: ${formatTimeOfDay(session.startedAt)}`
					: '';
	} else {
		el.runTimer.title = `Test Started: ${formatTimeOfDay(session.startedAt)}`;
	}
}

function startTimerInterval() {
	if (state.timer.interval !== undefined) return;
	state.timer.interval = setInterval(() => {
		const session = state.session;
		if (!session || el.runTimer.hidden) return;
		// Re-render only while a live run can advance the clock — paused and
		// terminal states stay frozen at their server-recorded values.
		const live = session.status === 'running'
			&& !Number.isFinite(session.completedAt)
			&& !Number.isFinite(session.pausedAt);
		if (live) {
			el.runTimerClock.textContent = formatClock(elapsedSecondsOf(session));
		}
		// Keep the runs list's live per-row elapsed times ticking too.
		if (state.timer.runLiveTimers?.size) {
			for (const [runId, node] of state.timer.runLiveTimers) {
				const run = runId === session?.id ? session : undefined;
				if (run && run.status === 'running' && !Number.isFinite(run.pausedAt)) {
					node.textContent = formatDurationShort(elapsedSecondsOf(run));
				}
			}
		}
	}, 1000);
}

/* ── Performance analytics & run-time comparison ─────────────────── */
/* The Performance sidebar panel was removed from the UI; the analytics
 * API remains available for reports. */

/* ── Post-run feedback ──────────────────────────────────────────── */

/**
 * Category values match the server contract (server/feedbackStore.js
 * FEEDBACK_CATEGORIES). Labels are display-only.
 */
const FEEDBACK_CATEGORIES = [
	{ value: 'test_accuracy', label: 'Test Accuracy' },
	{ value: 'test_coverage', label: 'Test Coverage' },
	{ value: 'execution_speed', label: 'Test Execution Speed' },
	{ value: 'results', label: 'Test Results' },
	{ value: 'ui_ux', label: 'UI/UX Experience' },
	{ value: 'automation_quality', label: 'Automation Quality' },
	{ value: 'error_handling', label: 'Error Handling' },
	{ value: 'ease_of_use', label: 'Ease of Use' },
	{ value: 'overall', label: 'Overall Experience' },
	{ value: 'other', label: 'Other' }
];

/** A run accepts feedback only once it has reached a terminal state. */
const FEEDBACK_TERMINAL_STATUSES = new Set(['done', 'error']);
let feedbackLoadGeneration = 0;

/** Spec rating semantics for the star tooltips. */
const FEEDBACK_STAR_LABELS = {
	1: '1 — Very Poor',
	2: '2 — Poor',
	3: '3 — Average',
	4: '4 — Good',
	5: '5 — Excellent'
};

function feedbackEligible(session) {
	// Feedback applies to QA runs and SQA assessments once they finish;
	// Founder reviews keep their own completion flow without feedback.
	return Boolean(session?.id) && session.mode !== 'founder'
		&& FEEDBACK_TERMINAL_STATUSES.has(session.status);
}

/**
 * Loads the submitter's existing feedback for a run so the modal can open in
 * "already submitted" mode instead of inviting a duplicate. Called when a run
 * completes and when the modal opens; failures keep the modal usable.
 */
async function syncFeedbackForSession(session) {
	if (!session?.id) return;
	const runId = session.id;
	const generation = ++feedbackLoadGeneration;
	let record;
	try {
		record = await api(`/sessions/${runId}/feedback`);
	} catch {
		return; // An unavailable read is not proof that feedback does not exist.
	}
	if (generation !== feedbackLoadGeneration || state.sessionId !== runId) return;
	state.feedback.existing = record;
	state.feedback.existingLoadedFor = runId;
	if (state.feedback.runId === runId) applyFeedbackSubmittedState();
	// Report section (and View/Provide button) follow the synced record.
	if (state.sessionId === runId) renderReport();
	// Feedback is an explicit report action. Background synchronization must
	// never interrupt result review or cover a new-run/account destination.
}

/**
 * Opens the feedback modal for the run in `state.session`. Run metadata
 * (Test Run ID, target URL, execution status, duration) is display-only —
 * the server attaches it from the run record, never from this form.
 */
async function openFeedbackModal() {
	const session = state.session;
	if (!feedbackEligible(session)) return;
	const generation = ++feedbackLoadGeneration;
	state.feedback.runId = session.id;
	state.feedback.rating = 0;
	state.feedback.editing = false;
	// Existing submission for THIS run (and user) is server-owned truth: it
	// decides submitted-vs-blank mode. Cached while the modal stays on the
	// same run, re-fetched whenever a new run opens the modal.
	if (state.feedback.existingLoadedFor !== session.id) {
		state.feedback.existing = undefined;
		try {
			const record = await api(`/sessions/${session.id}/feedback`);
			if (generation !== feedbackLoadGeneration || state.sessionId !== session.id) return;
			state.feedback.existing = record;
		} catch {
			state.feedback.existingLoadedFor = undefined;
			toast('Could not load feedback for this run. Please try again.', 'bad');
			return;
		}
		state.feedback.existingLoadedFor = session.id;
	}
	if (state.sessionId !== session.id) return;
	el.feedbackError.textContent = '';
	el.feedbackSuccess.textContent = '';
	const failed = session.status === 'error';
	el.feedbackSubmit.disabled = true;
	el.feedbackSubmit.textContent = 'Submit feedback';
	// Optional category: blank option = Overall Experience (server default).
	el.feedbackCategory.innerHTML = '<option value="" selected>Overall Experience</option>';
	for (const { value, label } of FEEDBACK_CATEGORIES) {
		if (value === 'overall') continue;
		const option = document.createElement('option');
		option.value = value;
		option.textContent = label;
		el.feedbackCategory.append(option);
	}
	el.feedbackCategory.value = '';
	el.feedbackComments.value = '';
	el.feedbackImprovement.value = '';
	renderFeedbackStars();
	const duration = Number.isFinite(session.completedAt) && Number.isFinite(session.startedAt)
		? formatClock((session.completedAt - session.startedAt - (Number.isFinite(session.pausedSeconds) ? session.pausedSeconds * 1000 : 0)) / 1000)
		: null;
	const bits = [`Test Run: ${session.id.slice(0, 8)}`];
	if (session.targetUrl) bits.push(String(session.targetUrl));
	bits.push(failed ? 'Status: Failed' : 'Status: Completed');
	if (duration) bits.push(`Duration: ${duration}`);
	el.feedbackRunMeta.textContent = bits.join(' · ');
	state.feedback.notified = '';
	el.feedbackModal.showModal();
	applyFeedbackSubmittedState();
	renderFeedbackStars();
	el.feedbackStars.querySelector('input[type="radio"]')?.focus();
}

/** Star row: five radios whose labels light up up-to the checked value. */
function renderFeedbackStars() {
	if (el.feedbackStars.childElementCount === 0) {
		for (let value = 1; value <= 5; value += 1) {
			const radio = document.createElement('input');
			radio.type = 'radio';
			radio.name = 'feedback-rating';
			radio.id = `feedback-star-${value}`;
			radio.value = String(value);
			radio.addEventListener('change', () => {
				state.feedback.rating = value;
				el.feedbackError.textContent = '';
				paintFeedbackStars(value);
				updateFeedbackSubmitEnabled();
			});
			const label = document.createElement('label');
			label.htmlFor = radio.id;
			label.className = 'feedback-star';
			label.title = FEEDBACK_STAR_LABELS[value];
			label.textContent = '★';
			label.append(radio);
			el.feedbackStars.append(label);
		}
	}
	paintFeedbackStars(state.feedback.rating);
	updateFeedbackSubmitEnabled();
}

function paintFeedbackStars(value) {
	[...el.feedbackStars.querySelectorAll('.feedback-star')].forEach((label, index) => {
		label.classList.toggle('is-on', index < value);
	});
}

function updateFeedbackSubmitEnabled() {
	// Only the rating is required — description and category are optional.
	const ready = state.feedback.rating > 0;
	el.feedbackSubmit.disabled = !ready || state.feedback.submitting || (Boolean(state.feedback.existing) && !state.feedback.editing);
}

/**
 * Submitted mode: fields go read-only with a confirmation, plus an "Edit
 * feedback" button that unlocks the submitter's OWN record for changes (PUT
 * re-uses the record id — never a duplicate). Cancel becomes "Done".
 */
function applyFeedbackSubmittedState() {
	const existing = state.feedback.existing;
	const submitted = Boolean(existing);
	const locked = submitted && !state.feedback.editing;
	for (const input of [el.feedbackCategory, el.feedbackComments, el.feedbackImprovement]) {
		input.readOnly = locked;
		input.disabled = locked;
	}
	el.feedbackStars.querySelectorAll('input').forEach(radio => {
		radio.disabled = locked;
		if (locked) radio.checked = false; // submitted view never shows an unsaved selection
	});
	if (submitted) {
		if (locked) {
			state.feedback.rating = existing.rating;
			el.feedbackCategory.value = existing.category === 'overall'
				? ''
				: FEEDBACK_CATEGORIES.some(c => c.value === existing.category) ? existing.category : '';
			el.feedbackComments.value = existing.comments ?? '';
			el.feedbackImprovement.value = existing.improvement ?? '';
		}
		paintFeedbackStars(state.feedback.rating);
		if (state.feedback.editing) {
			el.feedbackSubmit.textContent = 'Save changes';
			el.feedbackCancel.textContent = 'Cancel editing';
			el.feedbackSuccess.textContent = '';
			el.feedbackEdit.hidden = false;
		} else {
			el.feedbackSubmit.textContent = 'Feedback submitted ✓';
			el.feedbackCancel.textContent = 'Done';
			el.feedbackSuccess.textContent = state.feedback.notified
				? `Sent to the Qase team’s Feedback Inbox for human review. ${state.feedback.notified}`
				: 'Sent to the Qase team’s Feedback Inbox for human review.';
			el.feedbackEdit.hidden = false;
		}
	} else {
		el.feedbackSubmit.textContent = 'Submit feedback';
		el.feedbackCancel.textContent = 'Cancel';
		el.feedbackSuccess.textContent = '';
		el.feedbackEdit.hidden = true;
	}
	updateFeedbackSubmitEnabled();
}

/** Unlock the submitted record for editing (PUT on the same id). */
function startEditFeedback() {
	if (!state.feedback.existing) return;
	state.feedback.editing = true;
	el.feedbackError.textContent = '';
	applyFeedbackSubmittedState();
	el.feedbackStars.querySelector('input:not(:disabled)')?.focus();
}

async function cancelEditFeedback() {
	// If the user was editing, dropping back to the submitted view discards
	// any unsaved edits (the saved record is re-applied).
	if (state.feedback.editing) {
		state.feedback.editing = false;
		applyFeedbackSubmittedState();
		return;
	}
	closeFeedbackModal();
}

function clearFeedbackRating() {
	state.feedback.rating = 0;
	paintFeedbackStars(0);
}

function closeFeedbackModal() {
	// While a submission is in flight the modal stays open — closing it
	// mid-request would lose the result line (and could double-submit on
	// reopen). The request completes in the background regardless.
	if (state.feedback.submitting) return;
	state.feedback.editing = false;
	state.feedback.notified = '';
	el.feedbackModal.close();
}

async function submitFeedback(event) {
	event.preventDefault();
	if (state.feedback.submitting) return;
	const feedbackRunId = state.feedback.runId;
	if (feedbackRunId !== state.session?.id || !feedbackEligible(state.session)) {
		el.feedbackError.textContent = 'Open feedback from the test you want to review. Your draft has not been submitted.';
		return;
	}
	if (state.feedback.existing?.runId && state.feedback.existing.runId !== feedbackRunId) {
		el.feedbackError.textContent = 'Reload feedback for the selected test before saving.';
		return;
	}
	if (state.feedback.existing && !state.feedback.editing) return;
	const rating = state.feedback.rating;
	if (!rating) {
		el.feedbackError.textContent = 'Please choose a rating first.';
		return;
	}
	const category = el.feedbackCategory.value || undefined;
	const comments = el.feedbackComments.value.trim();
	const improvement = el.feedbackImprovement.value.trim() || undefined;
	state.feedback.submitting = true;
	el.feedbackSubmit.disabled = true;
	el.feedbackSubmit.textContent = state.feedback.editing ? 'Saving…' : 'Submitting…';
	el.feedbackError.textContent = '';
	try {
		if (state.feedback.editing && state.feedback.existing) {
			const record = await api(`/feedback/${state.feedback.existing.id}`, {
				method: 'PUT',
				body: JSON.stringify({ rating, category, comments, improvement })
			});
			if (state.sessionId !== feedbackRunId || state.feedback.runId !== feedbackRunId) return;
			feedbackLoadGeneration++;
			state.feedback.existingLoadedFor = feedbackRunId;
			state.feedback.existing = record;
			state.feedback.editing = false;
			applyFeedbackSubmittedState();
			toast('Feedback updated in the Qase team’s Feedback Inbox.', 'good');
			void refreshRuns();
			renderReport();
		} else {
			const record = await api('/feedback', {
				method: 'POST',
				body: JSON.stringify({ runId: feedbackRunId, rating, category, comments, improvement })
			});
			if (state.sessionId !== feedbackRunId || state.feedback.runId !== feedbackRunId) return;
			feedbackLoadGeneration++;
			state.feedback.existingLoadedFor = feedbackRunId;
			state.feedback.existing = record;
			state.feedback.editing = false;
			// Truthful outcome line: the server now reports whether the
			// Telegram notification was actually dispatched. Feedback is
			// ALWAYS saved first — a notification failure is never presented
			// as a submission failure (record exists → 201, never 5xx).
			const sent = record?.telegramSent === true;
			const pending = record?.telegram?.status === 'PENDING' || record?.telegram?.status === 'SENDING';
			const failed = record?.telegram?.status === 'FAILED';
			if (sent) {
				toast('Thank you! Your feedback has been submitted successfully.', 'good');
				state.feedback.notified = 'Telegram notification sent ✓';
			} else if (pending) {
				toast('Feedback saved. Telegram notification is still being delivered.', 'info');
				state.feedback.notified = 'Telegram notification pending — feedback saved.';
			} else if (failed) {
				toast('Feedback saved. Telegram notification could not be delivered.', 'info');
				state.feedback.notified = 'Telegram notification failed — feedback saved.';
			} else {
				toast('Thank you! Your feedback has been submitted successfully.', 'good');
				state.feedback.notified = '';
			}
			applyFeedbackSubmittedState();
			toast('Feedback sent to the Qase team’s Feedback Inbox.', 'good');
			void refreshRuns();
			renderReport();
		}
	} catch (error) {
		// Retry keeps every entered field — only the button returns to idle.
		el.feedbackError.textContent = `${error.message} Your feedback was kept — please try again.`;
		el.feedbackSubmit.textContent = state.feedback.editing ? 'Retry save' : 'Retry submit';
		if (error.status === 409 && !state.feedback.editing) {
			try {
				const existing = await api(`/sessions/${feedbackRunId}/feedback`);
				if (existing && state.feedback.runId === feedbackRunId) {
					state.feedback.existing = existing;
					state.feedback.editing = true;
					applyFeedbackSubmittedState();
					el.feedbackError.textContent = 'Feedback was already saved. Your current draft is preserved; choose Save changes to update it.';
				}
			} catch { /* retain the draft and the original retry message */ }
		}
	} finally {
		state.feedback.submitting = false;
		updateFeedbackSubmitEnabled();
	}
}

/* ── Transcript ──────────────────────────────────────────────────── */

function renderTranscript() {
	// Keep the execution-target host alive across renders — only messages
	// are replaced. (replaceChildren would destroy the pinned block.)
	const targetHost = document.getElementById('execution-target-block');
	const children = targetHost ? [targetHost] : [];
	el.transcript.replaceChildren(...children);
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
		renderCurrentActivity();
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
	const credentialLike = isCredentialQuestion(question);
	tag.textContent = credentialLike ? 'Credentials needed' : 'Decision needed';

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

	card.append(credentialLike ? credentialForm() : optionForm(question));
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
	note.innerHTML = 'Encrypted locally for this run and deleted when the run ends — never sent to the model. ' +
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
	const chromeBar = document.getElementById('browser-chrome');
	const chromeHeight = chromeBar && !chromeBar.hidden ? chromeBar.offsetHeight : 0;
	const availableHeight = el.stage.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom) - chromeHeight;
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
	renderStageCollapse();
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
		el.activityFeed.innerHTML = '<div class="feed-empty">No activity yet — start a QA run to see the agent execution log.</div>';
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

/* Activity feed always keeps the latest output visible (#14124: the
 * ON/OFF toggle was removed — auto-scroll is now unconditional). */
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
		el.planList.innerHTML = '<div class="feed-empty">No test plan generated yet — the agent writes one at the start of each run.</div>';
		return;
	}
	for (const todo of todos) {
		const node = document.createElement('div');
		node.className = `todo ${todo.status}`;
		node.setAttribute('role', 'listitem');
		const mark = document.createElement('span');
		mark.className = 'todo-mark';
		mark.textContent = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '◉' : '○';
		/* Status chip (UI Fix Phase 1): text label, not color-only — maps the
		 * raw todo status onto the run vocabulary. */
		const chip = document.createElement('span');
		chip.className = `todo-chip todo-chip-${todo.status ?? 'pending'}`;
		chip.textContent = { completed: 'Passed', in_progress: 'Running', failed: 'Failed', blocked: 'Blocked' }[todo.status ?? 'pending'] ?? 'Queued';
		const text = document.createElement('span');
		text.className = 'todo-text';
		text.textContent = todo.text;
		node.append(mark, chip, text);
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
		const empty = document.createElement('div');
		empty.className = 'feed-empty';
		empty.textContent = state.session.status === 'done'
			? 'No findings recorded for this run. Open Report to review completed checks and coverage limits.'
			: 'No findings yet. They appear here as the agent tests your website.';
		el.findingsList.append(empty);
		return;
	}
	const sorted = [...findings].sort(
		(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
	);
	const selection = findingSelectionFor(sorted);
	const selectionBar = document.createElement('div');
	selectionBar.className = 'findings-selection';

	const selectAll = document.createElement('label');
	selectAll.className = 'check findings-selection-all';
	const selectAllBox = document.createElement('input');
	selectAllBox.type = 'checkbox';
	const selectAllLabel = document.createElement('span');
	selectAllLabel.textContent = 'Select all';
	selectAll.append(selectAllBox, selectAllLabel);

	const count = document.createElement('span');
	count.className = 'findings-selection-count';
	count.setAttribute('role', 'status');
	count.setAttribute('aria-live', 'polite');

	const copySelected = document.createElement('button');
	copySelected.className = 'btn btn-primary btn-sm';
	copySelected.type = 'button';
	copySelected.textContent = 'Copy selected fixes';
	copySelected.onclick = async () => {
		const selected = sorted.filter(finding => selection.selected.has(finding.id));
		const markdown = buildAllFixPromptsMarkdown({ ...state.session, findings: selected });
		if (!markdown) { toast('Select at least one finding to copy.', 'bad'); return; }
		try { await navigator.clipboard.writeText(markdown); toast(`${selected.length} selected fix${selected.length === 1 ? '' : 'es'} copied.`, 'good'); }
		catch { toast('Clipboard is blocked in this browser.', 'bad'); }
	};
	selectionBar.append(selectAll, count, copySelected);
	el.findingsList.append(selectionBar);

	const boxes = [];
	const syncSelection = () => {
		const selectedCount = boxes.filter(({ box }) => box.checked).length;
		selectAllBox.checked = selectedCount === boxes.length;
		selectAllBox.indeterminate = selectedCount > 0 && selectedCount < boxes.length;
		count.textContent = `${selectedCount} of ${boxes.length} selected`;
		copySelected.disabled = selectedCount === 0;
		for (const { box, node } of boxes) node.classList.toggle('is-selected', box.checked);
	};
	for (const finding of sorted) {
		const node = renderFinding(finding, selection, syncSelection);
		boxes.push({ box: node.querySelector('.finding-select-input'), node });
		el.findingsList.append(node);
	}
	selectAllBox.onchange = () => {
		for (const { box } of boxes) {
			box.checked = selectAllBox.checked;
			if (box.checked) selection.selected.add(box.value);
			else selection.selected.delete(box.value);
		}
		syncSelection();
	};
	syncSelection();
}

function findingSelectionFor(findings) {
	let selection = state.findingSelections.get(state.sessionId);
	if (!selection) {
		selection = { selected: new Set(), known: new Set() };
		state.findingSelections.set(state.sessionId, selection);
	}
	const current = new Set(findings.map(finding => finding.id));
	for (const finding of findings) {
		if (!selection.known.has(finding.id)) selection.selected.add(finding.id);
		selection.known.add(finding.id);
	}
	for (const id of selection.known) {
		if (current.has(id)) continue;
		selection.known.delete(id);
		selection.selected.delete(id);
	}
	return selection;
}

function renderFinding(finding, selection, syncSelection) {
	const findingKey = `${state.sessionId}:${finding.id}`;
	const node = document.createElement('article');
	node.className = 'finding';
	node.classList.toggle('is-open', state.openFindings.has(findingKey));
	node.dataset.sev = finding.severity;
	node.setAttribute('role', 'listitem');

	const selector = document.createElement('label');
	selector.className = 'finding-select';
	const selectBox = document.createElement('input');
	selectBox.className = 'finding-select-input';
	selectBox.type = 'checkbox';
	selectBox.value = finding.id;
	selectBox.checked = selection.selected.has(finding.id);
	selectBox.setAttribute('aria-label', `Select finding: ${finding.title}`);
	selectBox.onchange = () => {
		if (selectBox.checked) selection.selected.add(finding.id);
		else selection.selected.delete(finding.id);
		syncSelection();
	};
	selector.append(selectBox);

	const head = document.createElement('button');
	head.className = 'finding-head';
	head.type = 'button';
	head.setAttribute('aria-expanded', String(state.openFindings.has(findingKey)));
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
		if (open) state.openFindings.add(findingKey);
		else state.openFindings.delete(findingKey);
		head.setAttribute('aria-expanded', String(open));
	};

	const body = document.createElement('div');
	body.className = 'finding-body';
	body.id = disclosureId;

	const meta = document.createElement('div');
	meta.className = 'finding-meta';
	meta.textContent = [finding.category, finding.url].filter(Boolean).join(' · ');
	if (finding.engine) {
		const chip = document.createElement('span');
		chip.className = 'engine-chip';
		chip.textContent = finding.engine;
		meta.append(' ', chip);
	}
	body.append(meta);

	// RT5 (#14757): the EXACT environment this finding occurred on —
	// runtime-detected identity (profile, device, OS, browser+version, the
	// engine that actually launched, execution level/provider) plus its
	// session linkage. Structure unchanged; one compact env line added.
	let environmentLine;
	if (finding.environment) {
		const env = finding.environment;
		const parts = [
			env.profileId,
			[env.device, env.os, env.osVersion].filter(Boolean).join(' · '),
			[env.browser, env.browserVersion].filter(Boolean).join(' '),
			env.launchedEngine ? `engine: ${env.launchedEngine}` : null,
			env.brandedBinary?.detectedVersion ? `binary ${env.brandedBinary.detectedVersion}` : null,
			env.executionLevel ? `${env.executionLevel}${env.executionProvider ? ` · ${env.executionProvider}` : ''}` : null,
			env.sessionId ? `session ${String(env.sessionId).slice(0, 8)}` : null
		].filter(Boolean);
		if (parts.length) {
			environmentLine = document.createElement('div');
			environmentLine.className = 'finding-env';
			environmentLine.textContent = parts.join(' — ');
		}
	}

	if (finding.steps?.length) {
		const stepsTitle = document.createElement('h4');
		stepsTitle.textContent = 'Reproduction';
		const steps = document.createElement('ol');
		for (const step of finding.steps) {
			const item = document.createElement('li');
			item.textContent = step;
			steps.append(item);
		}
		body.append(stepsTitle, steps);
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
		const evidenceTitle = document.createElement('h4');
		evidenceTitle.textContent = 'Evidence';
		const pre = document.createElement('pre');
		pre.textContent = finding.evidence;
		body.append(evidenceTitle, pre);
	}
	if (environmentLine) body.append(environmentLine);

	const fixPrompt = buildFindingFixPrompt(finding, {
		targetUrl: state.session?.targetUrl,
		mode: state.session?.mode
	});
	const fixWrap = document.createElement('details');
	fixWrap.className = 'finding-fix-prompt';
	fixWrap.open = state.openFixInstructions.has(findingKey);
	fixWrap.ontoggle = () => {
		if (!fixWrap.isConnected) return;
		if (fixWrap.open) state.openFixInstructions.add(findingKey);
		else state.openFixInstructions.delete(findingKey);
	};
	const fixHead = document.createElement('summary');
	fixHead.className = 'finding-fix-prompt-head';
	const fixTitle = document.createElement('span');
	fixTitle.textContent = 'View fix instructions';
	const fixHint = document.createElement('span');
	fixHint.className = 'finding-fix-prompt-hint';
	fixHint.textContent = 'For your coding agent';
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
	copyPrompt.textContent = 'Copy fix instructions';
	copyPrompt.title = 'Copy instructions for your coding agent to diagnose and fix this finding.';
	copyPrompt.onclick = async () => {
		try { await navigator.clipboard.writeText(fixPrompt); toast('Fix instructions copied.', 'good'); }
		catch { toast('Clipboard is blocked in this browser.', 'bad'); }
	};
	actions.append(copy, copyPrompt);
	body.append(actions);

	node.append(selector, head, body);
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

/** "Test these next": pre-checked follow-ups that start a scoped follow-up run. */
function renderFollowUps(targetUrl, suggestions) {
	const wrap = document.createElement('div');
	wrap.className = 'follow-ups';

	const head = document.createElement('div');
	head.className = 'follow-ups-head';
	const title = document.createElement('strong');
	title.textContent = 'Test these next';
	const hint = document.createElement('small');
	hint.textContent = 'Left untested or recommended by this run — start a focused follow-up';
	const selectAll = document.createElement('label');
	selectAll.className = 'check follow-ups-all';
	const selectAllBox = document.createElement('input');
	selectAllBox.type = 'checkbox';
	selectAllBox.checked = true;
	const selectAllText = document.createElement('span');
	selectAllText.textContent = 'Select all';
	selectAll.append(selectAllBox, selectAllText);
	head.append(title, hint, selectAll);
	wrap.append(head);

	const boxes = [];
	const listNode = document.createElement('div');
	listNode.className = 'follow-ups-list';
	for (const suggestion of suggestions) {
		const row = document.createElement('label');
		row.className = 'check';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = true;
		box.dataset.suggestion = suggestion;
		boxes.push(box);
		const label = document.createElement('span');
		label.textContent = suggestion;
		row.append(box, label);
		listNode.append(row);
	}
	wrap.append(listNode);

	const syncSelectAll = () => {
		selectAllBox.checked = boxes.length > 0 && boxes.every(box => box.checked);
		selectAllBox.indeterminate = !selectAllBox.checked && boxes.some(box => box.checked);
	};
	selectAllBox.addEventListener('change', () => {
		for (const box of boxes) box.checked = selectAllBox.checked;
		syncSelectAll();
	});
	for (const box of boxes) box.addEventListener('change', syncSelectAll);

	const run = document.createElement('button');
	run.className = 'btn btn-primary btn-sm';
	run.type = 'button';
	run.textContent = 'Run selected follow-ups';
	run.onclick = async () => {
		const selected = boxes.filter(box => box.checked).map(box => box.dataset.suggestion);
		const message = buildFollowUpMessage(targetUrl, selected);
		if (!message) {
			toast('Check at least one item to run a follow-up.', 'bad');
			return;
		}
		run.disabled = true;
		run.textContent = 'Starting…';
		try {
			const device = state.session?.device;
			const deviceLandscape = state.session?.deviceLandscape === true;
			await createQaRun({ targetUrl, device, deviceLandscape, kickoffText: message });
			toast('Follow-up run started.', 'good');
		} catch (error) {
			fail(error);
		} finally {
			run.disabled = false;
			run.textContent = 'Run selected follow-ups';
		}
	};
	wrap.append(run);
	return wrap;
}

/* ── Drytis board push (findings → tickets) ─────────────────────── */

/** True when the current run has a Drytis review attached. */
function drytisBoardAvailable() {
	return Boolean(state.session?.drytisIntegration);
}

/** Render the findings→board panel: accept checkboxes + push button. */
function renderDrytisBoard() {
	const wrap = document.createElement('div');
	wrap.className = 'drytis-board';
	wrap.id = 'drytis-board';

	const integration = state.session.drytisIntegration;
	const findings = state.session.findings ?? [];
	const pushed = integration.tickets;
	const pushState = pushed?.status;

	const title = document.createElement('h3');
	title.className = 'drytis-board-title';
	title.textContent = 'Push findings to the Drytis board';
	wrap.append(title);

	if (pushState === 'delivered') {
		const done = document.createElement('p');
		done.className = 'drytis-board-done';
		done.textContent = `${pushed.ticketCount} ticket${pushed.ticketCount === 1 ? '' : 's'} delivered to the board${pushed.deliveredAt ? ` · ${new Date(pushed.deliveredAt).toLocaleString()}` : ''}.`;
		wrap.append(done);
		return wrap;
	}
	if (pushState === 'delivering') {
		const busy = document.createElement('p');
		busy.className = 'drytis-board-busy';
		busy.textContent = 'Delivering tickets to the Drytis board…';
		wrap.append(busy);
		return wrap;
	}
	if (findings.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'drytis-board-empty';
		empty.textContent = 'No findings to push yet — the board panel fills in once findings are filed.';
		wrap.append(empty);
		return wrap;
	}

	if (pushState === 'failed') {
		const failed = document.createElement('p');
		failed.className = 'drytis-board-failed';
		failed.textContent = 'The last push did not complete. You can retry below.';
		wrap.append(failed);
	}

	// Per-finding accept checkboxes — all checked by default ("accept-all first").
	const rows = document.createElement('div');
	rows.className = 'drytis-board-rows';
	const boxes = [];
	for (const finding of findings) {
		const row = document.createElement('label');
		row.className = 'drytis-board-row check';
		const box = document.createElement('input');
		box.type = 'checkbox';
		box.checked = true;
		box.dataset.drytisFinding = finding.id;
		const label = document.createElement('span');
		label.textContent = finding.title;
		const sev = document.createElement('em');
		sev.textContent = finding.severity;
		row.append(box, label, sev);
		rows.append(row);
		boxes.push({ box, finding });
	}
	wrap.append(rows);

	const all = document.createElement('label');
	all.className = 'drytis-board-acceptall check';
	const allBox = document.createElement('input');
	allBox.type = 'checkbox';
	allBox.checked = true;
	allBox.id = 'drytis-accept-all';
	const allLabel = document.createElement('span');
	allLabel.textContent = `Accept all (${findings.length})`;
	all.append(allBox, allLabel);
	const syncAll = () => {
		for (const { box } of boxes) box.checked = allBox.checked;
	};
	allBox.onchange = syncAll;
	// Any single change re-derives the master state.
	rows.addEventListener('change', () => {
		allBox.checked = boxes.every(({ box }) => box.checked);
	});
	wrap.append(all);

	const error = document.createElement('p');
	error.className = 'test-result bad drytis-board-error';
	error.id = 'drytis-board-error';
	error.hidden = true;
	wrap.append(error);

	const push = document.createElement('button');
	push.className = 'btn btn-primary';
	push.type = 'button';
	push.id = 'drytis-push-btn';
	push.textContent = 'Push accepted findings to Drytis';
	push.onclick = async () => {
		const accepted = boxes.filter(({ box }) => box.checked).map(({ finding }) => finding.id);
		if (accepted.length === 0) {
			error.textContent = 'Check at least one finding to push.';
			error.hidden = false;
			return;
		}
		push.disabled = true;
		push.textContent = 'Pushing…';
		error.hidden = true;
		try {
			const result = await api(`/sessions/${state.session.id}/drytis/push`, {
				method: 'POST',
				body: JSON.stringify({ acceptedFindingIds: accepted })
			});
			toast(`Pushed ${result.tickets.ticketCount} ticket${result.tickets.ticketCount === 1 ? '' : 's'} to the Drytis board.`, 'good');
			renderDrytisBoardRefresh();
		} catch (err) {
			error.textContent = err instanceof Error ? err.message : String(err);
			error.hidden = false;
		} finally {
			push.disabled = false;
			push.textContent = 'Push accepted findings to Drytis';
		}
	};
	wrap.append(push);
	return wrap;
}

/** Re-render the board panel in place after a push (keeps report layout). */
function renderDrytisBoardRefresh() {
	const host = document.getElementById('drytis-board');
	if (!host) return;
	host.replaceWith(renderDrytisBoard());
}

/**
 * Evidence provenance (Phase 4): every artifact the run captured already
 * carries device/OS/browser/orientation/execution-level/runtime metadata in
 * its sidecar (server/artifactStore.js). Render that metadata alongside the
 * evidence so it is immediately clear which environment produced it.
 */
async function renderEvidenceSection(sessionId) {
	try {
		const payload = await api(`/sessions/${sessionId}/artifacts`);
		const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
		if (!artifacts.length || state.sessionId !== sessionId) return;
		const host = document.createElement('div');
		host.className = 'evidence-section';
		host.dataset.forSession = sessionId;
		const title = document.createElement('h3');
		title.textContent = `Evidence (${artifacts.length})`;
		host.append(title);
		for (const [index, artifact] of artifacts.entries()) {
			const card = document.createElement('div');
			card.className = 'evidence-card';
			const head = document.createElement('div');
			head.className = 'evidence-head';
			head.textContent = `Evidence #${index + 1} — ${artifact.kind ?? artifact.type ?? 'artifact'}`;
			card.append(head);
			const meta = artifact.meta ?? artifact;
			const provParts = [
				meta.evidenceHeader,
				meta.orientation ? String(meta.orientation).toUpperCase() : null,
				meta.capturedAt ? new Date(meta.capturedAt).toLocaleString() : null
			].filter(Boolean);
			const prov = document.createElement('div');
			prov.className = 'evidence-prov';
			prov.textContent = provParts.join(' · ') || 'No environment metadata recorded';
			card.append(prov);
			host.append(card);
		}
		// The report tab may have re-rendered while artifacts loaded.
		if (state.sessionId !== sessionId) return;
		el.reportView.append(host);
	} catch {
		// Artifacts endpoint unavailable — evidence section is additive; skip.
	}
}

/**
 * "What was tested" block: selected coverage (✓/✗ per option, from the
 * persisted scopeSelection) rendered above the agent-executed Covered /
 * Not covered sections so selected vs executed stay visually distinct.
 * Legacy runs without scopeSelection render nothing.
 */
function renderCoverageSelection(session) {
	const selected = Array.isArray(session?.scopeSelection) ? session.scopeSelection : null;
	if (!selected || selected.length === 0) return document.createComment('no scope selection');
	const wrap = document.createElement('div');
	wrap.className = 'report-section coverage-selection';
	const title = document.createElement('h3');
	title.textContent = 'What was tested — selected coverage';
	const sub = document.createElement('p');
	sub.className = 'muted';
	sub.textContent = 'Coverage selected for this run. “Covered” below lists what the agent executed.';
	wrap.append(title, sub);
	for (const group of [{ key: 'uiux', label: 'UI & User Experience' }, { key: 'other', label: 'Other supported coverage' }]) {
		const options = QA_SCOPE_OPTIONS.filter(option => option.group === group.key);
		if (options.length === 0) continue;
		const inGroup = options.some(option => selected.includes(option.value));
		if (!inGroup) continue;
		const heading = document.createElement('h4');
		heading.textContent = group.label;
		const ul = document.createElement('ul');
		ul.className = 'coverage-selection-list';
		for (const option of options) {
			const li = document.createElement('li');
			const mark = document.createElement('span');
			mark.className = `coverage-mark ${selected.includes(option.value) ? 'is-on' : 'is-off'}`;
			mark.textContent = selected.includes(option.value) ? '✓' : '✗';
			const name = document.createElement('span');
			name.textContent = option.friendly;
			li.append(mark, name);
			ul.append(li);
		}
		wrap.append(heading, ul);
	}
	return wrap;
}

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
		el.reportView.innerHTML = '<div class="feed-empty">No report available — it is published when a run finishes.</div>';
		return;
	}
	el.reportView.append(renderResultsOverview(state.session, {
		document,
		onFindings: () => activateDetailTab($('tab-findings'), true),
		onWorkspace: () => { void pageRouter.navigate({ name: 'run', runId: state.sessionId }); }
	}));

	/* Export report (UI Fix Phase 1): JSON download of the finished report —
	 * presented once, inside the Report tab workspace. */
	const exportBar = document.createElement('div');
	exportBar.className = 'report-export-bar';
	const exportBtn = document.createElement('button');
	exportBtn.type = 'button';
	exportBtn.className = 'btn btn-ghost btn-sm';
	exportBtn.textContent = 'Export report';
	exportBtn.onclick = () => {
		const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `qase-report-${state.sessionId ?? 'run'}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};
	exportBar.append(exportBtn);

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
	const reportFindingCount = Number.isFinite(report.findings) ? report.findings : state.session?.findings?.length ?? 0;
	const reportTime = report.ts ?? state.session?.completedAt ?? state.session?.updatedAt;
	sub.textContent = `${reportFindingCount} finding${reportFindingCount === 1 ? '' : 's'}`
		+ (reportTime ? ` · ${new Date(reportTime).toLocaleString()}` : '');
	text.append(label, sub);
	banner.append(mark, text);
	el.reportView.append(banner);

	const stats = document.createElement('div');
	stats.className = 'sev-grid';
	for (const severity of SEVERITY_ORDER) {
		const count = resultsOverviewModel(state.session).severity[severity] ?? 0;
		const stat = document.createElement('div');
		stat.className = `sev-stat${count === 0 ? ' is-zero' : ''}`;
		const value = document.createElement('b');
		value.textContent = count;
		const name = document.createElement('span');
		name.textContent = severity;
		stat.append(value, name);
		stats.append(stat);
	}
	const summarySection = section('Summary', paragraph(report.summary));
	summarySection.classList.add('report-summary-detail');
	el.reportView.append(summarySection);
	if (report.recommendations?.length) {
		const nextSection = section('Recommended next action', list(report.recommendations));
		nextSection.classList.add('report-next-detail');
		el.reportView.append(nextSection);
	}
	el.reportView.append(stats);
	el.reportView.append(renderCoverageSelection(state.session));
	if (report.covered?.length) el.reportView.append(section('Covered', list(report.covered)));
	if (report.notCovered?.length) el.reportView.append(section('Not covered', list(report.notCovered)));
	el.reportView.append(exportBar);
	void renderEvidenceSection(state.sessionId);

	const suggestions = followUpSuggestions(report);
	if (suggestions.length > 0 && state.session?.targetUrl) {
		el.reportView.append(renderFollowUps(state.session.targetUrl, suggestions));
	}

	// Drytis board panel — only for sessions a Drytis review was attached to.
	if (state.session?.drytisIntegration) {
		el.reportView.append(renderDrytisBoard());
	}

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
			exportError(error, 'The report download failed.');
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
			exportError(error, 'The report copy failed.');
		}
	};
	const pdf = document.createElement('button');
	pdf.className = 'btn btn-primary btn-sm';
	pdf.type = 'button';
	pdf.textContent = 'Download PDF';
	pdf.onclick = async () => { try { await downloadReportPdf('qase-qa-report.pdf'); } catch (error) { exportError(error, 'The PDF export failed.'); } };

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

	const rated = state.runRatings.get(state.session.id)
		?? (state.feedback.existingLoadedFor === state.session.id ? state.feedback.existing : undefined);
	const provideFeedback = document.createElement('button');
	provideFeedback.className = 'btn btn-ghost btn-sm';
	provideFeedback.type = 'button';
	provideFeedback.textContent = rated ? 'View Feedback' : 'Provide Feedback';
	provideFeedback.title = rated
		? 'View your submitted feedback for this run.'
		: 'Rate this QASE testing run and tell us how it went.';
	provideFeedback.onclick = () => openFeedbackModal();

	actions.append(pdf, provideFeedback);
	const developerActions = document.createElement('details');
	developerActions.className = 'report-developer-actions';
	const developerSummary = document.createElement('summary');
	developerSummary.textContent = 'Advanced / developer tools';
	const developerButtons = document.createElement('div');
	developerButtons.className = 'report-developer-buttons';
	developerButtons.append(download, copy, copyFixes, downloadFixes);
	developerActions.append(developerSummary, developerButtons);
	// The re-run control only applies to runs launched from a saved environment
	// snapshot (environmentSnapshot carries envId for createQaRun); runs without
	// one keep the standard download/copy actions only.
	const snapshot = state.session?.environmentSnapshot;
	if (snapshot) {
		const rerun = document.createElement('button');
		rerun.className = 'btn btn-ghost btn-sm';
		rerun.type = 'button';
		rerun.textContent = 'Re-run with same environment';
		rerun.title = `Starts a fresh run against ${snapshot.device ?? snapshot.deviceLabel} · ${snapshot.osVersion} · ${snapshot.browser} ${snapshot.browserVersion}`;
		rerun.onclick = async () => {
			const target = state.session?.targetUrl;
			if (!target) { toast('This run has no target URL to reproduce.', 'bad'); return; }
			try {
				await createQaRun({ targetUrl: target, environmentId: snapshot.envId });
				toast(`New run started on ${snapshot.envId}.`, 'good');
			} catch (error) {
				toast(error?.message ?? 'Could not start the re-run.', 'bad');
			}
		};
		actions.append(rerun);
	}

	// Agent generation on demand: derive test cases from this completed run.
	// Idempotent — a second click never duplicates the same cases.
	if (state.sessionId && state.session.report) {
		const generate = document.createElement('button');
		generate.className = 'btn btn-ghost btn-sm';
		generate.type = 'button';
		generate.textContent = 'Generate test cases';
		generate.title = 'Ask the agent to turn this run into reusable test cases';
		generate.onclick = async () => {
			generate.disabled = true;
			generate.textContent = 'Generating…';
			try {
				const result = await api('/test-cases/generate', {
					method: 'POST',
					body: JSON.stringify({ runId: state.sessionId })
				});
				const count = Number(result?.count ?? 0);
				if (count > 0) {
					toast(`${count} test case${count === 1 ? '' : 's'} generated from this run.`, 'good');
					testCaseView?.refresh?.();
				} else if (result?.skipped === 'already-generated') {
					toast('Test cases were already generated from this run.', 'good');
				} else if (result?.skipped === 'from-test-case') {
					toast('This run came from a test case, so nothing new was generated.', 'good');
				} else if (result?.skipped === 'disabled') {
					toast('Nothing to generate from this run.', 'good');
				}
			} catch (error) {
				fail(error);
			} finally {
				generate.disabled = false;
				generate.textContent = 'Generate test cases';
			}
		};
		developerButtons.append(generate);
	}

	el.reportView.append(actions, developerActions);
	el.reportView.append(renderFeedback());
	renderReportFeedbackSection(rated);
	el.reportView.append(renderFilesSection(findings));
}

/**
 * Files section — the run's downloadable artifacts, grouped in one place at
 * the end of the report. Only real exports the run actually supports are
 * listed; runs without artifacts get an empty state, never fabricated rows.
 */
function renderFilesSection(findings = []) {
	const wrap = document.createElement('section');
	wrap.className = 'files-section';
	wrap.setAttribute('aria-label', 'Files');

	const title = document.createElement('h3');
	title.className = 'files-title';
	title.textContent = 'FILES';
	wrap.append(title);

	const runId = state.sessionId;
	const rows = [];
	const addRow = (icon, name, description, enabled, handler, disabledTitle) => {
		const row = document.createElement('div');
		row.className = 'file-row';
		const glyph = document.createElement('span');
		glyph.className = 'file-icon';
		glyph.textContent = icon;
		glyph.setAttribute('aria-hidden', 'true');
		const info = document.createElement('div');
		info.className = 'file-info';
		const label = document.createElement('span');
		label.className = 'file-name';
		label.textContent = name;
		const desc = document.createElement('span');
		desc.className = 'file-desc';
		desc.textContent = description;
		info.append(label, desc);
		const get = document.createElement('button');
		get.type = 'button';
		get.className = 'btn btn-ghost btn-sm';
		get.textContent = 'Download';
		get.disabled = !enabled;
		if (!enabled) get.title = disabledTitle ?? 'Not available for this run.';
		else get.onclick = handler;
		row.append(glyph, info, get);
		rows.push(row);
	};

	addRow(
		'🗎', 'QA report (PDF)', 'Full test report as a printable PDF.',
		true,
		async () => { try { await downloadReportPdf('qase-qa-report.pdf'); } catch (error) { exportError(error, 'The PDF export failed.'); } }
	);
	addRow(
		'▤', 'QA report (Markdown)', 'Plain-text report for notes and diffs.',
		true,
		async () => {
			try {
				const markdownText = await apiText(`/sessions/${runId}/report.md`);
				const url = URL.createObjectURL(new Blob([markdownText], { type: 'text/markdown;charset=utf-8' }));
				const save = document.createElement('a');
				save.href = url;
				save.download = 'qase-report.md';
				document.body.append(save);
				save.click();
				save.remove();
				window.setTimeout(() => URL.revokeObjectURL(url), 0);
			} catch (error) { exportError(error, 'The report download failed.'); }
		}
	);
	addRow(
		'🛠', 'Fix prompts (Markdown)', 'One fix prompt per finding for your engineers.',
		findings.length > 0,
		() => {
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
		},
		'No findings to generate fix prompts for.'
	);

	if (rows.length === 0) {
		const empty = document.createElement('p');
		empty.className = 'files-empty';
		empty.textContent = 'No files available for this run yet.';
		wrap.append(empty);
	} else {
		wrap.append(...rows);
	}
	return wrap;
}

/** Thumbs up/down feedback on the finished run; last vote wins. */
function renderFeedback() {
	const wrap = document.createElement('div');
	wrap.className = 'run-feedback';

	const label = document.createElement('span');
	label.className = 'run-feedback-label';
	label.textContent = 'How was this run?';
	wrap.append(label);

	const current = state.session?.feedback?.rating;
	for (const rating of ['up', 'down']) {
		const button = document.createElement('button');
		button.type = 'button';
		button.className = `btn btn-ghost btn-sm run-feedback-btn is-${rating}`;
		button.textContent = rating === 'up' ? '👍' : '👎';
		button.title = rating === 'up' ? 'This run was useful' : 'This run missed the mark';
		button.setAttribute('aria-pressed', String(current === rating));
		if (current === rating) button.classList.add('is-selected');
		button.onclick = async () => {
			button.disabled = true;
			try {
				const result = await api(`/sessions/${state.sessionId}/feedback`, {
					method: 'POST',
					body: JSON.stringify({ rating })
				});
				if (state.session) state.session.feedback = result?.feedback ?? { rating };
				renderReport();
				toast('Thanks for the feedback.', 'good');
			} catch (error) {
				fail(error);
				button.disabled = false;
			}
		};
		wrap.append(button);
	}
	if (current) {
		const thanks = document.createElement('span');
		thanks.className = 'run-feedback-thanks';
		thanks.textContent = 'Thanks — noted.';
		wrap.append(thanks);
	}
	return wrap;
}

/**
 * USER FEEDBACK section in the QA Run Report: the submitter's exact rating
 * and description for THIS run. Scoped by run id — another run's feedback can
 * never render here. Rendered with textContent only (XSS-safe).
 */
function renderReportFeedbackSection(record) {
	if (!record) return;
	const section = document.createElement('section');
	section.className = 'report-feedback';
	section.setAttribute('aria-label', 'User feedback');

	const heading = document.createElement('h3');
	heading.className = 'report-feedback-title';
	heading.textContent = 'USER FEEDBACK';

	const stars = document.createElement('div');
	stars.className = 'report-feedback-stars';
	stars.textContent = '★'.repeat(record.rating) + '☆'.repeat(5 - record.rating);
	const score = document.createElement('span');
	score.className = 'report-feedback-score';
	score.textContent = ` ${record.rating}/5`;
	stars.append(score);

	const description = document.createElement('p');
	description.className = 'report-feedback-description';
	description.textContent = record.comments?.trim()
		? record.comments
		: 'No description provided.';

	const improvement = document.createElement('p');
	improvement.className = 'report-feedback-improvement';
	if (record.improvement?.trim()) {
		const label = document.createElement('strong');
		label.textContent = 'What should we improve? ';
		improvement.append(label, document.createTextNode(record.improvement));
	}

	const meta = document.createElement('p');
	meta.className = 'report-feedback-meta';
	const submittedBy = state.user?.displayName ?? state.user?.email ?? 'You';
	// Server-rendered, system-timezone string (submittedAtFormatted) — the
	// EXACT string the Telegram notification and md/PDF reports show. Only
	// fall back to the browser locale string for legacy records served by an
	// older API shape, so QASE and Telegram can never disagree.
	const submittedOn = typeof record.submittedAtFormatted === 'string' && record.submittedAtFormatted !== ''
		? record.submittedAtFormatted
		: (Number.isFinite(record.submittedAt) ? new Date(record.submittedAt).toLocaleString() : '');
	meta.textContent = `Submitted By: ${submittedBy}${submittedOn ? ` · Submitted On: ${submittedOn}` : ''}`;

	section.append(heading, stars, description, ...(improvement.childNodes.length ? [improvement] : []), meta);
	el.reportView.append(section);
}

function renderSqaReportTab() {
	const sqa = state.session?.sqa ?? {};
	const assessment = sqa.assessment;
	const lifecycle = describeSqaLifecycle(sqa, state.session?.status, state.session?.activities?.length ?? 0);
	if (!lifecycle.finalized || !assessment) {
		const pending = document.createElement('div');
		pending.className = 'feed-empty';
		pending.textContent = lifecycle.detail || 'The quality report is available after the review is finalized.';
		el.reportView.append(pending);
		return;
	}

	const notice = document.createElement('aside');
	notice.className = 'sqa-notice';
	const noticeTitle = document.createElement('strong');
	noticeTitle.textContent = 'Quality review report';
	const noticeText = document.createElement('p');
	noticeText.textContent = assessment.disclaimer
		?? 'This scoped engineering assessment is not legal advice, regulatory approval, accreditation, an audit opinion, or certification.';
	notice.append(noticeTitle, noticeText);

	el.reportView.append(notice, renderSqaVerdict(assessment, lifecycle), renderSqaReportActions());
	el.reportView.append(
		renderSqaUnresolved(assessment),
		renderSqaCoverage(assessment)
	);
	if (assessment.technicalSummary) el.reportView.append(renderSqaTechnicalSummary(assessment.technicalSummary));
	el.reportView.append(
		renderSqaControls(assessment.results ?? []),
		renderSqaSources(assessment.frameworkCoverage ?? []),
		renderSqaScope(sqa.scope ?? {}, assessment)
	);
	// USER FEEDBACK section — the submitter's own feedback for THIS SQA run,
	// same rendering and run-scoping as the QA report.
	renderReportFeedbackSection(state.runRatings.get(state.session.id)
		?? (state.feedback.existingLoadedFor === state.session.id ? state.feedback.existing : undefined));
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

function showCompletedFounderReport() {
	const session = state.session;
	if (session?.mode !== 'founder' || session.status !== 'done'
		|| !session.founder?.report || !session.founder.finalizedAt) return;
	const reportKey = `${session.id}:${session.founder.finalizedAt}`;
	if (state.shownFounderReport === reportKey) return;
	state.shownFounderReport = reportKey;
	activateDetailTab(el.reportTab);
}

function syncSqaDetailMode(selectDefault = false) {
	const isSqa = state.session?.mode === 'sqa';
	const isFounder = state.session?.mode === 'founder';
	const enteringFounder = isFounder && (el.founderTab.hidden || selectDefault);
	el.sqaTab.hidden = !isSqa;
	el.founderTab.hidden = !isFounder;
	if (isSqa && !el.sqaTab.classList.contains('is-active')) {
		activateDetailTab(el.sqaTab);
	} else if (enteringFounder) {
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
	noticeTitle.textContent = 'Review boundary';
	const noticeText = document.createElement('p');
	noticeText.textContent = assessment?.disclaimer ?? scope.disclaimer
		?? 'This scoped engineering assessment is not legal advice, regulatory approval, accreditation, an audit opinion, or certification.';
	notice.append(noticeTitle, noticeText);
	el.sqaView.append(notice);

	el.sqaView.append(renderSqaVerdict(assessment, lifecycle));

	if (!lifecycle.finalized && lifecycle.phase === 'ready') {
		const pending = document.createElement('div');
		pending.className = 'sqa-pending';
		const label = document.createElement('strong');
		label.textContent = 'Preparing the review';
		const text = document.createElement('p');
		text.textContent = 'Qase will open the target and begin collecting evidence. The final result appears after every applicable check finishes.';
		pending.append(label, text);
		el.sqaView.append(pending);
		return;
	}
	if (!assessment) return;

	if (lifecycle.finalized) el.sqaView.append(renderSqaReportActions());
	el.sqaView.append(renderSqaUnresolved(assessment));
	el.sqaView.append(renderSqaCoverage(assessment));
	if (assessment.technicalSummary) el.sqaView.append(renderSqaTechnicalSummary(assessment.technicalSummary));
	el.sqaView.append(renderSqaControls(assessment.results ?? []));
	el.sqaView.append(renderSqaSources(assessment.frameworkCoverage ?? []));
	el.sqaView.append(renderSqaScope(scope, assessment));
}

function renderSqaReportActions() {
	const actions = document.createElement('div');
	actions.className = 'report-actions sqa-report-actions';
	actions.setAttribute('aria-label', 'Quality review report actions');

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
			exportError(error, 'The SQA report download failed.');
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
			toast('Quality review copied to the clipboard.', 'good');
		} catch (error) {
			exportError(error, 'The SQA report copy failed.');
		}
	};

	const pdf = document.createElement('button');
	pdf.className = 'btn btn-primary btn-sm';
	pdf.type = 'button';
	pdf.textContent = 'Download PDF';
	pdf.onclick = async () => {
		try { await downloadReportPdf('qase-sqa-assessment.pdf'); }
		catch (error) { exportError(error, 'The PDF export failed.'); }
	};

	const findings = Array.isArray(state.session?.findings) ? state.session.findings : [];

	const copyFixes = document.createElement('button');
	copyFixes.className = 'btn btn-ghost btn-sm';
	copyFixes.type = 'button';
	copyFixes.textContent = 'Copy fix prompts';
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
		save.download = 'qase-sqa-fix-prompts.md';
		document.body.append(save);
		save.click();
		save.remove();
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
	};

	const rated = state.runRatings.get(state.sessionId)
		?? (state.feedback.existingLoadedFor === state.sessionId ? state.feedback.existing : undefined);
	const provideFeedback = document.createElement('button');
	provideFeedback.className = 'btn btn-ghost btn-sm';
	provideFeedback.type = 'button';
	provideFeedback.textContent = rated ? 'View Feedback' : 'Provide Feedback';
	provideFeedback.title = rated
		? 'View your submitted feedback for this assessment.'
		: 'Rate this SQA assessment experience and tell us how it went.';
	provideFeedback.onclick = () => openFeedbackModal();

	actions.append(pdf, provideFeedback);
	const developerActions = document.createElement('details');
	developerActions.className = 'report-developer-actions';
	const developerSummary = document.createElement('summary');
	developerSummary.textContent = 'Advanced / developer tools';
	const developerButtons = document.createElement('div');
	developerButtons.className = 'report-developer-buttons';
	developerButtons.append(download, copy, copyFixes, downloadFixes);
	developerActions.append(developerSummary, developerButtons);
	const actionGroup = document.createElement('div');
	actionGroup.className = 'report-action-group';
	actionGroup.append(actions, developerActions);
	return actionGroup;
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
		clearTimeout(resyncTimer);
		void resync();
	};
	stream.onerror = () => {
		connected();
		clearTimeout(resyncTimer);
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
				renderCurrentActivity();
			}
			if (session.mode === 'founder') renderFounder();
			break;
		}

		case 'todos':
			session.todos = event.todos;
			renderTodos();
			renderProgressCard();
			break;

		case 'context':
			session.contextUsage = event.context;
			renderHeader();
			break;

		case 'usage':
			session.tokenUsage = event.usage;
			renderHeader();
			// Keep the sidebar's token badge in step without a full refetch;
			// throttled so a fast series of commits stays cheap.
			scheduleRunBadgeRefresh();
			break;

		case 'finding':
			session.findings.push(event.finding);
			renderFindings();
			renderProgressCard();
			// The backlog view is server-sourced; a new finding anywhere in
			// this account's stream coalesces to one throttled refetch.
			if (state.bugsViewOpen) bugsView.scheduleRefresh();
			if (event.finding.severity === 'critical' || event.finding.severity === 'high') {
				toast(`${event.finding.severity.toUpperCase()}: ${event.finding.title}`, 'bad');
			}
			break;

		case 'report':
			session.report = event.report;
			renderReport();
			renderHeader();
			updateRunTimer();
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
			if (event.final) toast('Quality review published.', 'good');
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
			showCompletedFounderReport();
			void refreshRuns();
			toast('Founder brief published.', 'good');
			break;

		case 'context':
			handleContextEvent(event.context);
			break;

		case 'question':
			session.pendingQuestion = event.question;
			renderQuestion();
			break;

		case 'status':
			session.statusDetail = event.detail || undefined;
			setStatus(event.status);
			if (event.status === 'running' && typeof session.runStartedAt !== 'number') {
				session.runStartedAt = event.ts ?? Date.now();
			}
			renderCurrentActivity();
			// Server-authoritative timing arrives with every status event.
			if (event.timing) {
				noteServerNow(event.timing.serverNow);
				Object.assign(session, {
					startedAt: event.timing.startedAt,
					completedAt: event.timing.completedAt,
					cancelledAt: event.timing.cancelledAt,
					pausedAt: event.timing.pausedAt,
					pausedSeconds: event.timing.pausedSeconds ?? session.pausedSeconds ?? 0,
					failureReason: event.timing.failureReason
				});
			}
			renderHeader();
			updateRunTimer();
			if (session.mode === 'sqa') {
				renderSqa();
				renderReport();
			}
			if (session.mode === 'founder') {
				renderFounder();
				renderReport();
				showCompletedFounderReport();
			}
		if (event.status !== 'running') {
			void refreshRuns();
			if (FEEDBACK_TERMINAL_STATUSES.has(event.status) && feedbackEligible(session)) {
				renderReport();
				showCompletedQaResults();
				void syncFeedbackForSession(session);
			}
		}
			if (event.detail && event.status === 'error') {
				toast(event.detail, 'bad');
			}
			// Status changes move the runtime through the lifecycle — refresh the
			// single source of truth so every live-view element follows.
			if (session) {
				state.activeRuntimeEnvironment = resolveActiveRuntimeEnvironment({ session, environments: deviceState.list });
				renderLiveDeviceViewHeader(session, state.activeRuntimeEnvironment);
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
	testOn: $('qa-test-on'),
	testOnChange: document.querySelector('#qa-start [data-test-on-change]'),
	deviceLandscape: $('qa-device-landscape'),
	testsFieldset: $('qa-tests-fieldset'),
	testsState: $('qa-tests-state'),
	testsCount: $('qa-tests-count'),
	testOptions: $('qa-test-options'),
	securityOptions: $('qa-security-options'),
	securityCategory: $('qa-category-security'),
	standardCategoryToggle: $('qa-category-standard-toggle'),
	securityCategoryToggle: $('qa-category-security-toggle'),
	securityAuth: $('qa-security-auth'),
	securityAuthorized: $('qa-security-authorized'),
	securityNotes: $('qa-security-notes'),
	selectAll: $('qa-select-all'),
	deselectAll: $('qa-deselect-all'),
	scopeAll: $('qa-scope-all'),
	scopeSelectAll: $('qa-scope-select-all'),
	scopeDeselectAll: $('qa-scope-deselect-all'),
	scopeOptions: $('qa-scope-options'),
	founderMode: $('qa-founder-mode'),
	compliance: $('qa-compliance'),
	// Phase 5 audit: dead #qa-environment-select removed (never populated or
	// read; QA submit uses matrix configurationEnvIds exclusively).
	error: $('qa-form-error'),
	// QA matrix (Phase 2 #15013): device & browser configuration matrix.
	matrix: {
		fieldset: $('qa-matrix-fieldset'),
		state: $('qa-matrix-state'),
		root: $('qa-matrix-root'),
		error: $('qa-matrix-error'),
		errorText: $('qa-matrix-error-text'),
		retry: $('qa-matrix-retry'),
		search: $('qa-matrix-search'),
		filterPlatform: $('qa-matrix-filter-platform'),
		filterManufacturer: $('qa-matrix-filter-manufacturer'),
		filterOs: $('qa-matrix-filter-os'),
		filterOrientation: $('qa-matrix-filter-orientation'),
		browsers: $('qa-matrix-browsers'),
		devices: $('qa-matrix-devices'),
		summary: $('qa-matrix-summary')
	}
};

let qaJourney;
let qaJourneySelectionMode = (() => {
	try { return sessionStorage.getItem('qase.launcher.coverage') === 'custom' ? 'custom' : 'quick'; }
	catch { return 'quick'; }
})();
let qaJourneyCustomSelection;

function qaFocusedSelection() {
	return singleSelection(qaMatrixState.index, preferredConfiguration(qaMatrixState.index.filter(item =>
		isSelectable(item) && item.browserCode === 'chrome' && item.deviceType === 'desktop')));
}

function syncJourneyPreset() {
	try { sessionStorage.setItem('qase.launcher.coverage', qaJourneySelectionMode); } catch { /* private browsing can disable storage */ }
	$('journey-focused')?.setAttribute('aria-pressed', String(qaJourneySelectionMode === 'quick'));
	$('journey-custom')?.setAttribute('aria-pressed', String(qaJourneySelectionMode !== 'quick'));
}

function selectedQaScopeValues() {
	if (!qaUi.scopeOptions) return undefined;
	const values = [...qaUi.scopeOptions.querySelectorAll('.qa-scope')]
		.filter(box => box.checked)
		.map(box => box.value);
	// Browser compatibility is a UI alias for the configuration matrix: reflect
	// it in the persisted selection when at least one configuration is chosen.
	if (qaMatrixState.selectedEnvIds.length > 0 && !values.includes('browser-compatibility')) {
		values.push('browser-compatibility');
	}
	syncQaSelectionSummary();
	return values;
}

/* ── QA configuration matrix (Phase 2 #15013) ────────────────────── */

const qaMatrixState = {
	fetchState: 'loading', // loading | ready | empty | error
	index: [], // compact full-catalog rows: selection/facets/summary math
	windowRows: [], // heavy rows currently rendered in the device tree
	windowTotal: 0,
	windowDeviceOffset: 0, // #15439: device-grouped pagination offsets
	windowDeviceTotal: 0,
	windowLoading: false,
	browserFamilies: [],
	providers: [],
	selectedEnvIds: [],
	// Pipeline Phase 1: EXPLICIT selection state — which devices and which
	// browser families are selected, plus granular envId-level deselection
	// overrides. Replaces the derived-and-capped model (#14276/#15323):
	// selection is NEVER truncated; the 2,000 limit is a per-batch execution
	selection: createSelectionState(),
	// #16043: per-browser mode UI state — which selected family the device
	// list is picking a device for. Lives OUTSIDE the persisted selection
	// (session-scoped convenience, like activeTab).
	activeFamily: null,
	filters: { search: '', platform: '', manufacturer: '', osVersion: '', orientation: '', deviceType: '' },
	// #15969: remembered platform tab so re-renders keep the user's tab.
	activeTab: 'all'
};

const qaSelectionStore = createSelectionStore(window.localStorage, () => qaMatrixState.index);


function qaMatrixSetState(fetchState, message) {
	qaMatrixState.fetchState = fetchState;
	const matrix = qaUi.matrix;
	if (!matrix.state) return;
	matrix.state.hidden = fetchState === 'ready' || fetchState === 'error';
	matrix.state.textContent = message ?? '';
	matrix.state.dataset.state = fetchState;
	if (matrix.root) matrix.root.hidden = fetchState !== 'ready';
	if (matrix.error) {
		const hasError = fetchState === 'error';
		matrix.error.hidden = !hasError;
		if (hasError && matrix.errorText) matrix.errorText.textContent = message ?? 'The device catalog could not be loaded.';
	}
}

/** Reload the launcher catalog with honest loading/empty/error states. */
async function loadQaMatrixCatalog() {
	const controller = new AbortController();
	if (qaMatrixState.abort) qaMatrixState.abort.abort();
	qaMatrixState.abort = controller;
	qaMatrixSetState('loading', 'Loading device & browser catalog…');
	try {
		const payload = await fetchQaConfigurations({ signal: controller.signal });
		if (controller.signal.aborted) return;
		qaMatrixState.browserFamilies = payload.browserFamilies ?? [];
		qaMatrixState.providers = payload.providers ?? [];
		const index = await fetchConfigurationIndex({ signal: controller.signal });
		if (controller.signal.aborted) return;
		qaMatrixState.index = index;
		// Pipeline Phase 1: the explicit selection store initializes against
		// the fresh index (first load migrates legacy deselections).
		qaMatrixState.selection = normalizeSingleSelection(index, qaSelectionStore.get());
		if (qaJourneySelectionMode === 'quick') {
			qaJourneyCustomSelection ??= qaFocusedSelection();
			qaMatrixState.selection = qaFocusedSelection();
		}
		qaMatrixState.selectedEnvIds = qaMatrixEffectiveSelection();
		qaMatrixRender();
		qaMatrixSetState(qaMatrixState.index.length === 0 ? 'empty' : 'ready', '');
		if (qaMatrixState.index.length === 0) {
			qaMatrixSetState('empty', 'No device or browser configurations are available. Connect an execution provider or check the catalog.');
		}
	} catch (error) {
		if (controller.signal.aborted || error?.name === 'AbortError') return;
		qaMatrixState.index = [];
		qaMatrixState.windowRows = [];
		qaMatrixState.windowDeviceOffset = 0;
		qaMatrixState.windowDeviceTotal = 0;
		// Pipeline Phase 1: a failed catalog load clears the DERIVED selection
		// (nothing is provably available) but keeps the explicit selection
		// state — a retry reloads the catalog and re-derives without the user
		// losing their device/family choices.
		qaMatrixState.selectedEnvIds = [];
		qaMatrixSetState('error', error instanceof Error ? error.message : String(error));
	} finally {
		syncQaSubmitState();
	}
}


/**
 * Pipeline Phase 1: effective selection = explicit device keys × explicit
 * browser families minus granular deselections, over the full catalog index.
 * UNCAPPED — the 2,000 limit is a per-batch execution limit (Phase 2
 * batches on submit), never a selection limit. The device scope (a VIEW)
 * does not participate: scoping narrows what is rendered, never what runs.
 */
function qaMatrixEffectiveSelection() {
	return computeExplicitSelection(qaMatrixState.index, normalizeSingleSelection(qaMatrixState.index, qaMatrixState.selection));
}

/** Apply a selection-state change, re-derive, persist, re-render. */
function qaMatrixApplySelection(nextState, fromPreset = false) {
	nextState = normalizeSingleSelection(qaMatrixState.index, nextState);
	if (!fromPreset) { qaJourneySelectionMode = 'custom'; qaJourneyCustomSelection = nextState; }
	syncJourneyPreset();
	qaMatrixState.selection = nextState;
	qaSelectionStore.save(nextState);
	qaMatrixState.selectedEnvIds = qaMatrixEffectiveSelection();
	qaMatrixRender();
	syncQaSubmitState();
}

// #15969: the device-scope VIEW functions (qaMatrixSetDeviceScope /
// qaMatrixScopeLabel) were removed with the scoped-view UI — selection is
// direct on device rows now.

function qaMatrixRender() {
	const matrix = qaUi.matrix;
	if (!matrix.browsers || !matrix.devices || !matrix.summary) return;
	if (matrix.fieldset) matrix.fieldset.hidden = qaJourneySelectionMode === 'quick';
	qaMatrixState.picker ??= { category: '', platform: '', selectedOnly: false, limit: 10, reviewOpen: false };
	renderMatrixPicker({ document, hosts: matrix, index: qaMatrixState.index,
		families: qaMatrixState.browserFamilies, selection: qaMatrixState.selection,
		search: qaMatrixState.filters.search, view: qaMatrixState.picker,
		apply: qaMatrixApplySelection, render: qaMatrixRender, brandIcon });
	renderTestOn('qa-test-on');
}

function qaMatrixWiring() {
	const matrix = qaUi.matrix;
	if (!matrix.fieldset) return;
	matrix.retry?.addEventListener('click', () => { void loadQaMatrixCatalog(); });
	let searchTimer = null;
	matrix.search?.addEventListener('input', () => {
		window.clearTimeout(searchTimer);
		searchTimer = window.setTimeout(() => {
			qaMatrixState.filters.search = matrix.search.value;
			if (qaMatrixState.picker) qaMatrixState.picker.limit = 10;
			qaMatrixRender();
		}, 150);
	});
	// #15969: the facet dropdowns are removed from the markup — platform
	// filtering lives in the platform tab bar; the other facets via search.
}

function setQaFormError(message = '') {
	if (!qaUi.error) return;
	qaUi.error.className = `test-result${message ? ' bad' : ''}`;
	qaUi.error.textContent = message;
}

/** Test selection lives on the qaUi object itself so it survives any
 *  re-render of the dialog chrome while the user configures the run. */
qaUi.selectedTests = new Set();

/** All selectable test inputs, both categories. Unavailable checks are never
 *  rendered as inputs, so they can never enter a selection. */
function qaSelectableInputs(scope = document) {
	return [...scope.querySelectorAll('input[name="qa-test"]:not([disabled])')];
}

function qaCheckedTests() {
	return qaSelectableInputs(qaUi.testOptions.ownerDocument).filter(input => input.checked).map(input => input.value);
}

/** Selected count and total exclude unavailable checks entirely. */
function qaCatalogSize() {
	return qaSelectableInputs().length;
}

function syncQaCategoryToggles() {
	for (const [section, toggle] of [
		[qaUi.testOptions?.closest('.qa-category'), qaUi.standardCategoryToggle],
		[qaUi.securityOptions?.closest('.qa-category'), qaUi.securityCategoryToggle]
	]) {
		if (!section || !toggle) continue;
		const inputs = qaSelectableInputs(section);
		const checked = inputs.filter(input => input.checked).length;
		toggle.checked = inputs.length > 0 && checked === inputs.length;
		toggle.indeterminate = checked > 0 && checked < inputs.length;
		toggle.disabled = inputs.length === 0;
	}
}

function syncQaSubmitState() {
	if (!qaUi.submit) return;
	const selected = qaUi.selectedTests.size;
	// QA matrix (#15013): Start requires a valid URL and ≥1 selected
	// configuration while the dialog is open (fetch error → 0 selected → held).
	// Pipeline Phase 1: the 2,000 limit is a per-batch EXECUTION limit, not a
	// selection gate — any non-empty selection is startable (Phase 2 batches).
	const urlValid = !qaUi.dialog?.open || isValidTargetUrl(qaUi.targetUrl?.value);
	const selectedCount = qaMatrixState.selectedEnvIds.length;
	const matrixReady = qaJourneySelectionMode === 'quick' || !qaUi.dialog?.open || selectedCount === 1;
	// DEV merge: security tests require the explicit authorization checkbox
	// before Start unlocks. withinCap is deliberately NOT part of the gate —
	// Pipeline Phase 1: the 2,000 limit is a per-batch EXECUTION limit and
	// Phase 2 batches oversized selections on submit.
	const authorizationReady = !qaUi.dialog?.open || !qaSecuritySelected() || Boolean(qaUi.securityAuthorized?.checked);
	qaUi.submit.disabled = selected === 0 || !urlValid || !authorizationReady || !matrixReady || qaUi.submit.dataset.busy === 'true';
	const blockedReason = qaLaunchBlockedReason();
	qaUi.submit.title = blockedReason ?? '';
	if (qaUi.testsCount) {
		qaUi.testsCount.textContent = `${selected} of ${qaUi.selectedTests.catalogSize ?? selected} selected`;
	}
	syncQaCategoryToggles();
	syncQaSelectionSummary();
	if (qaJourney) {
		qaUi.submit.disabled ||= !state.config?.ready;
		qaJourney.sync();
	}
}

/** Plain-language reason the primary action cannot run yet. This is also the
 * source for the button tooltip, so disabled never means unexplained. */
function qaLaunchBlockedReason() {
	if (!qaUi.dialog?.open || qaUi.submit?.dataset.busy === 'true') return null;
	const target = qaUi.targetUrl?.value?.trim() ?? '';
	if (!target) return 'Enter a website URL to start.';
	if (!isValidTargetUrl(target)) return 'Enter a valid http(s) website URL.';
	if (!state.qaTestCatalog) return 'Loading recommended checks…';
	if (qaUi.selectedTests.size === 0) return 'Select at least one check.';
	if (qaSecuritySelected() && !qaUi.securityAuthorized?.checked) {
		return 'Confirm that you are authorized to test this site.';
	}
	if (qaJourneySelectionMode === 'quick') return null;
	if (qaMatrixState.fetchState === 'loading') return 'Loading browsers and devices…';
	if (qaMatrixState.fetchState === 'error') return 'Browsers and devices could not be loaded. Open Customize and retry.';
	const configurations = qaMatrixState.selectedEnvIds.length;
	if (configurations !== 1) return 'Choose one browser and one device.';
	// One exact environment; versions never expand into additional runs.
	return null;
}

/** Keep the compact launcher honest when availability or selection changes. */
function syncQaSelectionSummary() {
	const summary = $('qa-selection-summary');
	if (!summary) return;
	const blockedReason = qaLaunchBlockedReason();
	if (!state.qaTestCatalog) {
		summary.textContent = 'Loading available checks…';
		return;
	}
	const checks = qaUi.selectedTests.size;
	if (qaJourneySelectionMode === 'quick') {
		summary.textContent = `${checks} checks · Chrome on the default desktop · One test run. No setup required.`;
		return;
	}
	const configurations = qaMatrixState.selectedEnvIds.length;
	const loading = qaMatrixState.fetchState === 'loading';
	const selected = qaMatrixState.index.find(row => qaMatrixState.selectedEnvIds.includes(row.envId));
	const detail = loading ? 'Loading browsers and devices…'
		: selected ? `${selected.browser || selected.browserCode} · ${selected.device} · One test run` : 'Choose one browser and one device.';
	summary.textContent = blockedReason
		? `${checks} check${checks === 1 ? '' : 's'} selected · ${blockedReason}`
		: `${checks} check${checks === 1 ? '' : 's'} selected · ${detail}`;
	if (!loading && configurations === 0) $('qa-customize').open = true;
}

function qaTestOption(test) {
	const label = document.createElement('label');
	const isAvailable = test.availability?.available !== false;
	label.className = `sqa-option${isAvailable ? '' : ' is-unavailable'}`;
	const input = document.createElement('input');
	input.type = 'checkbox';
	input.name = 'qa-test';
	input.value = test.id;
	if (isAvailable) {
		// A normal run starts with the recommended standard checks. Security is
		// opt-in because it requires explicit authorization and a safe target.
		const selectedByDefault = (test.category ?? 'standard') !== 'security';
		input.checked = selectedByDefault;
		input.defaultChecked = selectedByDefault;
	} else {
		// Unavailable checks are never selectable and never counted.
		input.disabled = true;
		input.setAttribute('aria-disabled', 'true');
	}
	const copy = document.createElement('span');
	const heading = document.createElement('strong');
	heading.textContent = test.title;
	const description = document.createElement('small');
	description.textContent = test.description;
	copy.append(heading, description);
	if (!isAvailable && test.availability?.reason) {
		const reason = document.createElement('em');
		reason.className = 'qa-unavailable-reason';
		reason.textContent = test.availability.reason;
		copy.append(reason);
	}
	label.append(input, copy);
	return label;
}

/** Groups the catalog by category into its section grid. */
function paintQaTestCatalog(catalog) {
	const tests = catalog?.tests ?? [];
	const byCategory = new Map([
		['standard', []],
		['security', []]
	]);
	for (const test of tests) {
		const bucket = byCategory.get(test.category ?? 'standard');
		if (bucket) bucket.push(test);
	}
	qaUi.testOptions.replaceChildren(...byCategory.get('standard').map(qaTestOption));
	if (qaUi.securityOptions) {
		qaUi.securityOptions.replaceChildren(...byCategory.get('security').map(qaTestOption));
		qaUi.securityCategory.hidden = byCategory.get('security').length === 0;
	}
	qaUi.selectedTests = new Set(qaSelectableInputs().filter(input => input.checked).map(input => input.value));
	qaUi.selectedTests.catalogSize = qaCatalogSize();
	qaUi.testsState.hidden = true;
	qaUi.testsFieldset.disabled = false;
	syncQaSecurityGate();
	syncQaSubmitState();
}

function refreshQaSelection() {
	qaUi.selectedTests = new Set(qaCheckedTests());
	qaUi.selectedTests.catalogSize = qaCatalogSize();
	syncQaSecurityGate();
	syncQaSubmitState();
}

/** True when the current selection includes at least one security check. */
function qaSecuritySelected() {
	return qaCheckedTests().some(id => id.startsWith('security_'));
}

/**
 * The authorization gate: security checks only run against targets the user
 * has explicitly confirmed are authorized, isolated test environments. The
 * confirmation travels with the run request; the server enforces it
 * independently (a forged client gets a 400), this gate just makes the honest
 * path the easy path.
 */
function syncQaSecurityGate() {
	if (!qaUi.securityAuth || !qaUi.securityAuthorized) return;
	const needed = qaSecuritySelected();
	qaUi.securityAuth.hidden = !needed;
	if (!needed) {
		// Confirmation becomes inert when no security check is selected.
		qaUi.securityAuthorized.required = false;
		qaUi.securityAuthorized.setCustomValidity('');
		return;
	}
	// Native validation would show a generic bubble; use the specific message —
	// but only while the box is actually unchecked. A stale custom validity on
	// a checked box would block the submit forever.
	qaUi.securityAuthorized.required = true;
	qaUi.securityAuthorized.setCustomValidity(qaUi.securityAuthorized.checked ? '' : 'Confirm the target is an explicitly authorized, isolated test environment before running security tests.');
}

if (qaUi.securityAuthorized) {
	// Mirror the gate's validity message into the dialog error element so the
	// wording is visible regardless of how the browser renders the bubble.
	qaUi.securityAuthorized.addEventListener('invalid', () => {
		setQaFormError('Confirm the target is an explicitly authorized, isolated test environment before running security tests.');
		// #15270: a first Start click that only surfaces this gate reads as
		// "the button does nothing" — bring the checkbox into view and focus
		// it so the required action is unmissable, still inside this modal.
		if (!qaUi.securityAuthorized.checked && typeof qaUi.securityAuthorized.scrollIntoView === 'function') {
			qaUi.securityAuthorized.scrollIntoView({ block: 'center', behavior: 'smooth' });
		}
		qaUi.securityAuthorized.focus({ preventScroll: true });
	});
	// Checking the box resolves the validity error immediately.
	qaUi.securityAuthorized.addEventListener('change', () => {
		syncQaSecurityGate();
		setQaFormError('');
		syncQaSubmitState();
	});
}

function qaSecurityAuthorization() {
	if (!qaSecuritySelected()) return undefined;
	if (!qaUi.securityAuthorized?.checked) return undefined;
	const notes = qaUi.securityNotes?.value?.trim();
	return notes ? { confirmed: true, notes } : { confirmed: true };
}

function qaCategoryFor(input) {
	return input.closest('.qa-category');
}

if (qaUi.testOptions) {
	for (const grid of [qaUi.testOptions, qaUi.securityOptions]) {
		if (!grid) continue;
		grid.addEventListener('change', event => {
			const input = event.target;
			if (input?.name !== 'qa-test') return;
			refreshQaSelection();
		});
	}
	// Category header toggles select/deselect every available check in their
	// own category (indeterminate state resolves toward "select all").
	for (const toggle of [qaUi.standardCategoryToggle, qaUi.securityCategoryToggle]) {
		if (!toggle) continue;
		toggle.addEventListener('click', () => {
			// click fires before checked settles for indeterminate boxes; the
			// handler runs on the final state, so decide from checked.
			const section = toggle.closest('.qa-category');
			const inputs = qaSelectableInputs(section);
			const willCheck = toggle.checked;
			for (const input of inputs) input.checked = willCheck;
			refreshQaSelection();
		});
	}
}

async function loadQaTestCatalog() {
	if (state.qaTestCatalog) return state.qaTestCatalog;
	if (!state.qaTestCatalogPromise) {
		state.qaTestCatalogPromise = api('/qa/catalog')
			.then(catalog => {
				if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.tests) || catalog.tests.length === 0) {
					throw new Error('The standard test catalog response is invalid.');
				}
				state.qaTestCatalog = catalog;
				return catalog;
			})
			.finally(() => {
				state.qaTestCatalogPromise = undefined;
			});
	}
	return state.qaTestCatalogPromise;
}

/** The built-in deliberately-broken demo site, when this instance serves one. */
function demoSiteUrl() {
	return `${window.location.origin}/demo`;
}

function studioProjectContext() {
	const context = window.qaseStudioContext;
	if (context?.mode !== 'mock-studio') return undefined;
	try {
		const target = new URL(context.targetUrl);
		if (!['http:', 'https:'].includes(target.protocol)) return undefined;
		return {
			project: String(context.project ?? '').trim().slice(0, 120),
			targetUrl: target.href
		};
	} catch {
		return undefined;
	}
}

function applyStudioTarget(input) {
	const context = studioProjectContext();
	if (input && context) input.value = context.targetUrl;
	return context;
}

async function openQaStartWithDemo() {
	if (!qaUi.dialog) return;
	await openQaStart();
	if (qaUi.targetUrl) {
		qaUi.targetUrl.value = demoSiteUrl();
		setQaFormError('Demo site loaded — it plants real bugs on purpose (login demo@qase.dev / demo1234).');
	}
}

/* ── First-run welcome checklist ─────────────────────────────────── */

/** One-time onboarding flag; true once the user has started their first run. */
async function markOnboarded() {
	try {
		await api('/profile', {
			method: 'PUT',
			body: JSON.stringify({ profile: { onboardingComplete: true } })
		});
	} catch { /* cosmetic — onboarding state does not block a run */ }
}

async function openQaStart() {
	return pageRouter.navigate({ name: 'new-run' });
}

function showQaStartPage() {
	if (!qaUi.dialog) return;
	qaJourneySelectionMode = 'quick';
	syncJourneyPreset();
	qaJourney ??= createQaJourney({ document, changed: syncQaSubmitState, getState: () => ({
		config: state.config,
		checks: qaUi.selectedTests.size,
		automatic: qaJourneySelectionMode === 'quick',
		configurations: qaJourneySelectionMode === 'quick' ? 1 : qaMatrixState.selectedEnvIds.length,
		environmentLabel: (() => { const row = qaMatrixState.index.find(r => qaMatrixState.selectedEnvIds.includes(r.envId)); return row ? `${row.browser || row.browserCode} · ${row.device} · 1 run` : null; })(),
		busy: qaUi.submit.dataset.busy === 'true',
		blocked: qaLaunchBlockedReason(),
		coverageBlocked: !state.qaTestCatalog ? 'Loading available checks…'
			: !qaUi.selectedTests.size ? 'Choose at least one check to continue.'
			: qaSecuritySelected() && !qaUi.securityAuthorized?.checked ? 'Confirm security testing authorization below.'
			: qaJourneySelectionMode === 'quick' ? null
			: qaMatrixState.fetchState === 'loading' ? 'Loading browsers and devices…'
			: qaMatrixState.fetchState === 'error' ? 'The device catalog could not load. Open customization and retry.'
			: !qaMatrixState.selectedEnvIds.length ? 'Choose at least one available browser and device.' : null
	}) });
	setQaFormError();
	const draft = { url: qaUi.targetUrl.value, goal: $('qa-goal').value };
	qaUi.form.reset();
	if (draft.url) qaUi.targetUrl.value = draft.url;
	if (draft.goal) $('qa-goal').value = draft.goal;
	// Studio context prefill first, then the matrix top bar's target URL wins
	// if set (M4 #14423): applied AFTER reset() so it survives it.
	applyStudioTarget(qaUi.targetUrl);
	populateDeviceSelect(qaUi.deviceSelect, pendingDeviceId());
	qaUi.environmentSelect && populateEnvironmentSelect(qaUi.environmentSelect);
	const matrixUrl = $('mx-target-url')?.value?.trim();
	if (matrixUrl && qaUi.targetUrl) qaUi.targetUrl.value = matrixUrl;
	renderTestOn('qa-test-on');
	qaUi._testCaseId = undefined;
	qaUi._testCaseSnapshot = undefined;
	if (qaUi.deviceLandscape) qaUi.deviceLandscape.checked = pendingLandscape();
	qaUi.testsState.hidden = false;
	qaUi.testsState.textContent = 'Loading standard tests…';
	qaUi.submit.dataset.busy = 'false';
	qaUi.submit.disabled = true;
	qaUi.submit.textContent = 'Start testing';
	$('qa-customize').open = false;
	// form.reset() restores the confirmation checkbox, but a stale custom
	// validity from a previous open must be cleared explicitly.
	qaUi.securityAuthorized?.setCustomValidity('');
	syncQaSecurityGate();
	if (qaUi.environmentSelect) {
		delete qaUi.environmentSelect._testCaseId;
		delete qaUi.environmentSelect._testCaseSnapshot;
		for (const option of qaUi.environmentSelect.options) {
			option.disabled = false;
			option.hidden = false;
		}
	}
	if (!qaUi.dialog.open) qaUi.dialog.showModal();
	qaJourney.start();
	syncJourneyPreset();
	if (matchMedia('(pointer: fine)').matches) setTimeout(() => qaUi.targetUrl?.focus(), 0);
	syncQaSubmitState();
	// #15164: 'Change device' stays INSIDE the Start QA run modal — it scrolls
	// to and focuses the in-modal device matrix (single source of truth)
	// instead of opening the separate #device-picker dialog.
	if (qaUi.testOnChange) qaUi.testOnChange.onclick = () => {
		const matrix = qaUi.matrix;
		const target = matrix.fieldset ?? matrix.root;
		if (!target) return;
		target.scrollIntoView({ behavior: 'smooth', block: 'start' });
		target.classList.remove('qa-matrix-flash');
		// restart the highlight animation
		void target.offsetWidth;
		target.classList.add('qa-matrix-flash');
		matrix.search?.focus({ preventScroll: true });
	};
	// QA matrix (#15013): reload the device & browser catalog on every open —
	// honest loading/empty/error states, defaults re-applied minus the user's
	// persisted deselections. Start stays disabled until it resolves.
	void loadQaMatrixCatalog();
	qaMatrixWiring();
	void loadQaTestCatalog()
		.then(paintQaTestCatalog)
		.catch(error => {
			qaUi.testsState.hidden = false;
			qaUi.testsState.textContent = 'The standard test catalog could not be loaded.';
			setQaFormError(error instanceof Error ? error.message : String(error));
			$('qa-customize').open = true;
			$('qa-selection-summary').textContent = 'Checks could not be loaded. Close this window and try again.';
			syncQaSubmitState();
		});
}

function closeQaStart({ updateRoute = true } = {}) {
	if (updateRoute) {
		pageRouter.leave({ name: 'runs' });
		return;
	}
	if (qaUi.dialog?.open) qaUi.dialog.close();
}



if (qaUi.dialog) {
	$('journey-focused')?.addEventListener('click', () => {
		if (qaJourneySelectionMode !== 'quick') qaJourneyCustomSelection = qaMatrixState.selection;
		qaJourneySelectionMode = 'quick';
		qaMatrixApplySelection(qaFocusedSelection(), true);
		$('qa-customize').open = false;
	});
	$('journey-custom')?.addEventListener('click', () => {
		qaJourneySelectionMode = 'custom';
		if (qaJourneyCustomSelection) qaMatrixApplySelection(qaJourneyCustomSelection, true);
		syncJourneyPreset();
		qaMatrixRender();
		$('qa-customize').open = false;
	});
	for (const control of [qaUi.deviceSelect, qaUi.engineOptions, qaUi.scopeOptions]) {
		control?.addEventListener('change', syncQaSelectionSummary);
	}
	qaUi.form.addEventListener('invalid', event => {
		if (event.target.closest('#qa-customize')) $('qa-customize').open = true;
	}, true);
	// URL typing re-evaluates Start gating live (#15013).
	qaUi.targetUrl?.addEventListener('input', () => syncQaSubmitState());
	qaUi.close.onclick = () => closeQaStart();
	qaUi.cancel.onclick = () => closeQaStart();
	qaUi.dialog.addEventListener('cancel', event => {
		event.preventDefault();
		closeQaStart();
	});
	$('qa-demo-fill')?.addEventListener('click', () => {
		if (qaUi.targetUrl) {
			qaUi.targetUrl.value = demoSiteUrl();
			syncQaSubmitState();
			setQaFormError('Demo site loaded — it plants real bugs on purpose (login demo@qase.dev / demo1234).');
			qaUi.targetUrl.focus();
		}
	});

	// Select All / Deselect All drive the individual coverage checkboxes.
	// Individual toggles change only their own option — nothing else resets.
	// The UI & User Experience parent reflects (and drives) its child options;
	// browser compatibility tracks the engine checkboxes instead.
	if (qaUi.scopeOptions) {
		const scopeBoxes = () => [...qaUi.scopeOptions.querySelectorAll('.qa-scope')];
		qaUi.scopeSelectAll?.addEventListener('click', () => {
			for (const box of scopeBoxes()) box.checked = true;
			syncUiuxParent();
		});
		qaUi.scopeDeselectAll?.addEventListener('click', () => {
			for (const box of scopeBoxes()) box.checked = false;
			syncUiuxParent();
		});
		const uiuxParent = document.getElementById('qa-uiux-parent');
		const uiuxGroup = document.getElementById('qa-scope-group-uiux');
		const uiuxChildren = () => [...(uiuxGroup?.querySelectorAll('.qa-scope') ?? [])];
		const browserInline = document.getElementById('qa-scope-options')?.querySelector('.qa-browser-inline');
		const syncUiuxParent = () => {
			if (!uiuxParent || uiuxChildren().length === 0) return;
			const boxes = uiuxChildren();
			uiuxParent.checked = boxes.length > 0 && boxes.every(box => box.checked);
			uiuxParent.indeterminate = !uiuxParent.checked && uiuxParent.checked !== undefined && boxes.some(box => box.checked);
			// Browser compatibility rides the configuration matrix (≥1 selected).
			if (browserInline) {
				browserInline.checked = qaMatrixState.selectedEnvIds.length > 0;
			}
		};
		uiuxParent?.addEventListener('change', () => {
			for (const box of uiuxChildren()) box.checked = uiuxParent.checked;
		});
		for (const box of uiuxChildren()) {
			box.addEventListener('change', syncUiuxParent);
		}
		syncUiuxParent();
	}

	qaUi.selectAll.onclick = () => {
		for (const input of qaSelectableInputs()) {
			input.checked = true;
		}
		refreshQaSelection();
	};

	qaUi.deselectAll.onclick = () => {
		for (const input of qaSelectableInputs()) {
			input.checked = false;
		}
		refreshQaSelection();
	};

	qaUi.form.onsubmit = async event => {
		event.preventDefault();
		if (qaUi.submit.dataset.busy === 'true') return;
		setQaFormError();
		if (!qaUi.form.reportValidity()) return;
		if (!ensureModelConfigured('QA launcher')) return;
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
		const selectedTests = qaCheckedTests();
		if (selectedTests.length === 0) {
			setQaFormError('Select at least one test.');
			$('qa-customize').open = true;
			return;
		}
		const securityAuthorization = qaSecurityAuthorization();
		if (qaSecuritySelected() && !securityAuthorization) {
			setQaFormError('Confirm the target is an explicitly authorized, isolated test environment before running security tests.');
			qaUi.securityAuthorized?.focus();
			return;
		}
		const scopeValues = selectedQaScopeValues();
		const scopeMessage = buildQaKickoffMessage(scopeValues);
		if (scopeMessage === null && Array.isArray(scopeValues) && scopeValues.length === 0) {
			setQaFormError('Check at least one item under “What to test”.');
			$('qa-customize').open = true;
			return;
		}
		const goal = $('qa-goal')?.value.trim();
		const kickoffText = [targetUrl, scopeMessage, goal ? `User focus for this run: ${goal}` : ''].filter(Boolean).join('\n');
		// QA matrix (#15013): the run set is the selected device–OS–browser–version
		// configurations. At least one configuration must be selected and validated.
		const automatic = qaJourneySelectionMode === 'quick';
		if (!automatic && qaMatrixState.selectedEnvIds.length === 0) {
			setQaFormError('Select at least one browser configuration.');
			$('qa-customize').open = true;
			return;
		}
		const selectedEnvIds = automatic ? [] : sanitizeSelection(qaMatrixState.index, qaMatrixState.selectedEnvIds);
		if (!automatic && selectedEnvIds.length !== 1) {
			setQaFormError('The selected configurations are no longer available. Reload the catalog and pick again.');
			return;
		}
		// Exactly one request and one item. No parent runs, batches or version fan-out.
		qaUi.submit.dataset.busy = 'true';
		qaUi.submit.disabled = true;
		qaUi.submit.textContent = 'Starting…';
		try {
			const matrixRun = await apiWithTimeout('/qa-matrix-runs', 20000, {
				method: 'POST',
				body: JSON.stringify({
					browserMode: automatic ? 'automatic' : 'custom', targetUrl,
					configurationEnvIds: selectedEnvIds, kickoffText, selectedTests,
					securityAuthorization, scopeSelection: scopeValues, testCaseId: qaUi._testCaseId
				})
			});
			if (!matrixRun.reused) {
				qaUi.targetUrl.value = '';
				$('qa-goal').value = '';
			}
			closeQaStart({ updateRoute: false });
			void markOnboarded();
			// Persist the accepted test immediately, before its session is allocated.
			await pageRouter.navigate({ name: 'matrix-run', runId: matrixRun.id });
			void refreshRuns();
			toast(matrixRun.reused ? 'Opened your existing test. No additional run was created.' : 'Starting one test on your selected browser and device.');
			// Optional follow-on flows: the QA run is already underway; each
			// checked option opens the existing dialog prefilled with the same
			// target for the user to confirm — nothing starts automatically.
			if (qaUi.founderMode?.checked) {
				await openFounderStart();
				founderUi.targetUrl.value = targetUrl;
			} else if (qaUi.compliance?.checked) {
				await openSqaStart();
				sqaUi.targetUrl.value = targetUrl;
			}
		} catch (error) {
			setQaFormError(error instanceof Error ? error.message : String(error));
		} finally {
			qaUi.submit.dataset.busy = 'false';
			qaUi.submit.textContent = 'Start testing';
			syncQaSubmitState();
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
	selectionSummary: $('sqa-selection-summary'),
	customize: $('sqa-customize'),
	disclaimer: $('sqa-catalog-disclaimer'),
	deviceSelect: null, // legacy select removed (DX Phase 3)
	deviceLandscape: $('sqa-device-landscape'),
	testOnChange: document.querySelector('#sqa-start [data-test-on-change]'),
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
	syncSqaSelectionSummary();
	syncSqaSubmitState();
}

function syncSqaSelectionSummary() {
	if (!sqaUi.selectionSummary) return;
	if (!state.sqaCatalog) {
		sqaUi.selectionSummary.textContent = 'Loading the recommended scope…';
		return;
	}
	const profiles = [...sqaUi.profileOptions.querySelectorAll('input:checked')]
		.filter(input => input.value !== 'core').length;
	const attributes = [...sqaUi.attributeOptions.querySelectorAll('input:checked')].length;
	const additions = [];
	if (profiles) additions.push(`${profiles} additional profile${profiles === 1 ? '' : 's'}`);
	if (attributes) additions.push(`${attributes} product characteristic${attributes === 1 ? '' : 's'}`);
	sqaUi.selectionSummary.textContent = additions.length
		? `Universal quality baseline · ${additions.join(' · ')}`
		: 'Universal quality baseline · Recommended browser evidence';
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
	applyStudioTarget(sqaUi.targetUrl);
	if (sqaUi.customize) sqaUi.customize.open = false;
	populateDeviceSelect(sqaUi.deviceSelect, pendingDeviceId());
	sqaUi.environmentSelect && populateEnvironmentSelect(sqaUi.environmentSelect);
	renderTestOn('sqa-test-on');
	if (sqaUi.testOnChange) sqaUi.testOnChange.onclick = () => devicePicker?.open?.();
	if (sqaUi.deviceLandscape) sqaUi.deviceLandscape.checked = pendingLandscape();
	sqaUi.profilesFieldset.disabled = true;
	sqaUi.attributesFieldset.disabled = true;
	sqaUi.catalogState.hidden = false;
	sqaUi.catalogState.textContent = 'Loading assessment catalog…';
	syncSqaSelectionSummary();
	sqaUi.submit.dataset.busy = 'false';
	syncSqaSubmitState();
	if (!sqaUi.dialog.open) sqaUi.dialog.showModal();
	if (matchMedia('(pointer: fine)').matches) setTimeout(() => sqaUi.targetUrl?.focus(), 0);

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
sqaUi.profileOptions.onchange = syncSqaSelectionSummary;
sqaUi.attributeOptions.onchange = syncSqaSelectionSummary;

sqaUi.form.onsubmit = async event => {
	event.preventDefault();
	setSqaFormError();
	if (!sqaUi.form.reportValidity()) return;
	if (!ensureModelConfigured('SQA launcher')) return;
	let targetUrl;
	let parsedTargetUrl;
	try {
		parsedTargetUrl = new URL(sqaUi.targetUrl.value.trim());
		if (!['http:', 'https:'].includes(parsedTargetUrl.protocol)) throw new TypeError();
		targetUrl = parsedTargetUrl.href;
	} catch {
		setSqaFormError('Enter a complete HTTP or HTTPS target URL.');
		sqaUi.targetUrl.focus();
		return;
	}
	const target = {
		name: sqaUi.targetName.value.trim() || parsedTargetUrl.hostname,
		release: sqaUi.targetRelease.value.trim() || 'Current',
		environment: sqaUi.targetEnvironment.value.trim() || 'Preview'
	};
	if (!sqaUi.authorization.checked) {
		setSqaFormError('Confirm testing authorization and the non-destructive boundary first.');
		sqaUi.authorization.focus();
		return;
	}

	const profiles = [...sqaUi.profileOptions.querySelectorAll('input:checked')].map(input => input.value);
	if (!profiles.includes('core')) profiles.unshift('core');
	const attributes = [...sqaUi.attributeOptions.querySelectorAll('input:checked')].map(input => input.value);
	sqaUi.submit.dataset.busy = 'true';
	sqaUi.submit.textContent = 'Starting review…';
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
				device: activeTestEnvStore?.get?.()?.device || pendingDeviceId(),
				deviceLandscape: (sqaUi.deviceLandscape?.checked) === true,
				environmentId: selectedEnvironmentForRun() || undefined
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
		sqaUi.submit.textContent = 'Start quality review';
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
	deviceSelect: null, // legacy select removed (DX Phase 3)
	deviceLandscape: $('founder-device-landscape'),
	testOnChange: document.querySelector('#founder-start [data-test-on-change]'),
	targetName: $('founder-target-name'),
	targetUrl: $('founder-target-url'),
	targetRelease: $('founder-target-release'),
	targetEnvironment: $('founder-target-environment'),
	primaryGoal: $('founder-primary-goal'),
	constraints: $('founder-constraints'),
	authorization: $('founder-authorization'),
	advanced: $('founder-advanced'),
	detectedContext: $('founder-detected-context'),
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
	$('founder-customize').open = false;
	const studioContext = applyStudioTarget(founderUi.targetUrl);
	if (studioContext && founderUi.targetName) founderUi.targetName.value = studioContext.project;
	founderUi.detectedContext && (founderUi.detectedContext.hidden = true);
	if (founderUi.detectedContext) founderUi.detectedContext.textContent = '';
	populateDeviceSelect(founderUi.deviceSelect, pendingDeviceId());
	founderUi.environmentSelect && populateEnvironmentSelect(founderUi.environmentSelect);
	renderTestOn('founder-test-on');
	if (founderUi.testOnChange) founderUi.testOnChange.onclick = () => devicePicker?.open?.();
	if (founderUi.deviceLandscape) founderUi.deviceLandscape.checked = pendingLandscape();
	founderUi.submit.dataset.busy = 'false';
	founderUi.catalogMeta.textContent = 'Loading review catalog…';
	syncFounderSubmitState();
	if (!founderUi.dialog.open) founderUi.dialog.showModal();
	// Prefill from detected project context (trusted server-side records).
	// Missing context is not an error here — the fields stay editable.
	try {
		const context = await api('/founder/context');
		if (context && typeof context === 'object') applyFounderDetectedContext(context);
	} catch { /* detection is best-effort; the form remains fully usable */ }
	try {
		paintFounderCatalog(await loadFounderCatalog());
	} catch (error) {
		founderUi.catalogMeta.textContent = 'Review catalog unavailable.';
		setFounderFormError(error instanceof Error ? error.message : String(error));
	}
}

/** Show detected context and prefill target fields without overwriting user input. */
function applyFounderDetectedContext(context) {
	const chips = [];
	if (context.targetUrl) chips.push(`Target: ${context.targetUrl}`);
	if (context.studio?.project?.name) chips.push(`Studio project: ${context.studio.project.name}`);
	if (context.previousFindings) chips.push(`${context.previousFindings.count} prior QA finding(s)`);
	if (context.previousFounder) chips.push('Prior Founder review found');
	if (chips.length > 0) {
		founderUi.detectedContext.textContent = `Detected project context — ${chips.join(' · ')}. Advanced options below are optional.`;
	} else {
		// Distinct missing-context state: no prior Qase context exists for this
		// project, so only the essential target fields are needed.
		founderUi.detectedContext.textContent = 'No prior project context was found for this workspace yet — just enter the target URL and product name below to get started. Everything else is optional.';
	}
	founderUi.detectedContext.hidden = false;
	if (context.targetUrl && !founderUi.targetUrl.value.trim()) founderUi.targetUrl.value = context.targetUrl;
	if (context.targetName && !founderUi.targetName.value.trim()) founderUi.targetName.value = context.targetName;
	if (context.previousFounder?.productContext?.primaryGoal && !founderUi.primaryGoal.value.trim()) {
		founderUi.primaryGoal.value = context.previousFounder.productContext.primaryGoal;
	}
	if (context.previousFounder?.productContext?.constraints && !founderUi.constraints.value.trim()) {
		founderUi.constraints.value = context.previousFounder.productContext.constraints;
	}
}

function closeFounderStart() {
	if (founderUi.dialog.open) founderUi.dialog.close();
}

function founderOptional(value) {
	const text = String(value ?? '').trim();
	return text || undefined;
}

founderUi.close.onclick = closeFounderStart;
founderUi.cancel.onclick = closeFounderStart;
founderUi.authorization.onchange = syncFounderSubmitState;

founderUi.form.onsubmit = async event => {
	event.preventDefault();
	setFounderFormError();
	if (!founderUi.form.reportValidity()) return;
	if (!ensureModelConfigured('Founder launcher')) return;
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
	if (!founderUi.authorization.checked) {
		setFounderFormError('Confirm review authorization and the non-destructive boundary first.');
		founderUi.authorization.focus();
		return;
	}

	const target = {
		name: founderUi.targetName.value.trim() || new URL(targetUrl).hostname,
		url: targetUrl,
		...(founderOptional(founderUi.targetRelease.value) ? { release: founderUi.targetRelease.value.trim() } : {}),
		...(founderOptional(founderUi.targetEnvironment.value) ? { environment: founderUi.targetEnvironment.value.trim() } : {})
	};
	const productContext = {
		...(founderOptional(founderUi.primaryGoal.value) ? { primaryGoal: founderUi.primaryGoal.value.trim() } : {}),
		...(founderOptional(founderUi.constraints.value) ? { constraints: founderUi.constraints.value.trim() } : {})
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
				device: activeTestEnvStore?.get?.()?.device || pendingDeviceId(),
				deviceLandscape: (founderUi.deviceLandscape?.checked) === true,
				environmentId: selectedEnvironmentForRun() || undefined,
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
	keyField: $('cfg-key-field'),
	keyNote: $('cfg-key-note'),
	baseUrlField: $('cfg-baseurl-field'),
	baseUrl: $('cfg-baseurl'),
	model: $('cfg-model'),
	modelCustom: $('cfg-model-custom'),
	reasoning: $('cfg-reasoning'),
	maxTurns: $('cfg-maxturns'),
	headless: $('cfg-headless'),
	theme: $('cfg-theme'),
	test: $('cfg-test'),
	testBtn: $('cfg-test-btn'),
	saveBtn: $('cfg-save')
};

/** Providers whose endpoint the user supplies themselves. */
const BASE_URL_REQUIRED = new Set(['custom', 'azureOpenAI']);
const BASE_URL_OPTIONAL = new Set(['openai', 'openrouter', 'nvidia', 'grok']);
const CUSTOM_MODEL_VALUE = '__qase_custom_model__';
const DEFAULT_CUSTOM_MODEL = 'z-ai/glm-5.2';

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
		// When no model is explicitly configured, prefer the server default
		// (z-ai/glm-5.2 for the managed custom gateway) over the first listed.
		const preferred = selectedIsListed ? selected
			: (uniqueModels.includes(DEFAULT_CUSTOM_MODEL) ? DEFAULT_CUSTOM_MODEL : (uniqueModels[0] ?? CUSTOM_MODEL_VALUE));
		cfg.model.value = preferred;
		if (preferred !== CUSTOM_MODEL_VALUE) cfg.modelCustom.value = '';
	}
	syncCustomModelField();
}

function paintConfig(config) {
	state.config = config;
	qaJourney?.sync();
	if (qaJourney) syncQaSubmitState();
	// #15643: the sidebar model badge was removed with the Advanced section;
	// model status surfaces via Settings and the launcher gate instead.
	// #16228 follow-up (rule from #15766 round 3): a tab that loaded older
	// assets never refetches them — hash routes keep stale code alive. The
	// server stamps /api/config with the CURRENT asset version; a mismatch
	// here means this tab is stale. ONE clean reload, guarded against loops.
	ensureUiVersionFresh(config);
}

/** Asset version bundled into THIS document's script URLs (e.g. 20261014-3). */
function currentUiAssetVersion() {
	const scripts = document.querySelectorAll('script[src], link[href]');
	const stamps = [];
	for (const node of scripts) {
		const stamp = /[?&]v=(\d{8}-\d+)\b/.exec(node.getAttribute('src') ?? node.getAttribute('href') ?? '');
		if (stamp) stamps.push(stamp[1]);
	}
	return stamps.sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1) ?? null;
}

/**
 * Stale-tab handshake: reload ONCE when the server's asset version is newer
 * than this document's. Session-guarded so a reload loop cannot form; if
 * the reloaded tab is still behind (intercepting cache), it degrades to a
 * visible banner with a manual Reload button instead of spinning forever.
 */
function ensureUiVersionFresh(config) {
	const serverVersion = config?.uiVersion;
	const localVersion = currentUiAssetVersion();
	if (!serverVersion) return; // server could not read a stamp — never reload
	if (localVersion && String(serverVersion) === String(localVersion)) return;
	if (sessionStorage.getItem('qase.ui.reload') === serverVersion) {
		renderStaleUiBanner(serverVersion);
		return;
	}
	try {
		sessionStorage.setItem('qase.ui.reload', String(serverVersion));
	} catch { /* private mode — the banner fallback covers it */ }
	console.warn(`[qase] stale client UI (have ${localVersion ?? '?'}), reloading for ${serverVersion}.`);
	window.location.reload();
}

/** Visible escape hatch when a reload did not (or cannot) refresh assets. */
function renderStaleUiBanner(serverVersion) {
	if (document.getElementById('stale-ui-banner')) return;
	const banner = document.createElement('div');
	banner.id = 'stale-ui-banner';
	banner.setAttribute('role', 'alert');
	const text = document.createElement('span');
	text.textContent = `This tab is running an older version of Qase (page has ${currentUiAssetVersion() ?? 'no version'}, latest is ${serverVersion}). If the page looks blank or broken, reload once.`;
	const button = document.createElement('button');
	button.type = 'button';
	button.className = 'btn btn-primary';
	button.textContent = 'Reload';
	button.onclick = () => {
		sessionStorage.removeItem('qase.ui.reload');
		window.location.reload();
	};
	banner.append(text, button);
	(document.body ?? document.documentElement).prepend(banner);
}

/**
 * Launcher gate: every run mode needs a working model endpoint. Returns true
 * when the platform model is configured; customers do not supply credentials.
 */
function ensureModelConfigured(contextLabel) {
	if (state.config?.ready) return true;
	toast('Qase’s model service is unavailable. Please try again later or contact support.', 'bad');
	if (contextLabel) console.debug(`[qase] ${contextLabel} blocked: model not configured.`);
	return false;
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
		? 'A key is already configured. Leave this blank to keep it, or enter a replacement.'
		: 'Enter the API key for your chosen provider. It is used by the server to contact that provider.';

	cfg.test.className = 'test-result';
	cfg.test.textContent = '';
	syncProviderFields();
}

function syncProviderFields() {
	const provider = cfg.provider.value;
	const required = BASE_URL_REQUIRED.has(provider);
	cfg.baseUrlField.hidden = !required && !BASE_URL_OPTIONAL.has(provider);
	// The custom gateway is provisioned by the server (key comes from env) —
	// no API key entry needed unless the user wants to override with their own.
	const managedKey = provider === 'custom' && state.config?.provider === 'custom' && state.config?.hasApiKey && state.config?.apiKeyFromEnv;
	cfg.keyField.hidden = false;
	cfg.keyNote.hidden = false;
	cfg.providerNote.textContent = required
		? (managedKey
			? 'A server-managed key is available. Keep it, or enter your own endpoint and key.'
			: 'Use an OpenAI-compatible gateway. Enter its API key, endpoint URL, and model ID.')
		: BASE_URL_OPTIONAL.has(provider)
			? 'Base URL is optional — leave it blank to use the provider default.'
			: 'This provider uses its own endpoint.';
}

function readSettings() {
	const patch = {
		model: selectedModelId(),
		reasoning: cfg.reasoning.value,
		maxTurns: Number(cfg.maxTurns.value),
		headless: cfg.headless.checked
	};
	return patch;
}

cfg.provider.onchange = syncProviderFields;
cfg.model.onchange = syncCustomModelField;

async function probeModelEndpoint({ announce = true } = {}) {
	if (announce) {
		cfg.test.className = 'test-result busy';
		cfg.test.textContent = 'Checking model availability…';
	}
	const requestedModel = selectedModelId();
	const result = await api('/config/test', {
		method: 'POST',
		body: JSON.stringify(readSettings())
	}).catch(error => ({ ok: false, error: error.message }));

	if (!result.ok) {
		if (announce) {
			cfg.test.className = 'test-result bad';
			cfg.test.textContent = 'Qase’s model service could not be reached. Try again shortly or contact your workspace administrator.';
		}
		return result;
	}
	fillModelOptions(result.models ?? [], requestedModel);
	cfg.test.className = 'test-result ok';
	cfg.test.textContent = result.completionVerified === false
		? result.message
		: result.matched === false
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
const pageRouteNotice = $('page-route-notice');
const pageRouteMessage = $('page-route-message');
const pageRouteRetry = $('page-route-retry');

function setPageRouteNotice(message = '', { state: noticeState = 'loading', retry } = {}) {
	if (!pageRouteNotice || !pageRouteMessage || !pageRouteRetry) return;
	pageRouteMessage.textContent = message;
	pageRouteNotice.dataset.state = noticeState;
	pageRouteNotice.hidden = !message;
	pageRouteRetry.hidden = typeof retry !== 'function';
	pageRouteRetry.onclick = typeof retry === 'function' ? retry : null;
}

function focusPageHeading(node) {
	requestAnimationFrame(() => node?.focus({ preventScroll: true }));
}

function closePageDialog(dialog) {
	if (dialog?.open) dialog.close();
}

function renderResultsPageHeader() {
	const session = state.session;
	if (!session) return;
	const findings = session.findings?.length ?? 0;
	$('results-page-title').textContent = session.title || 'Test results';
	const displayStatus = runPresentationStatus(session);
	$('results-page-status').textContent = displayStatus === 'blocked'
		? 'Blocked'
		: session.status === 'done' ? 'Complete' : 'Results available';
	$('results-page-status').dataset.status = displayStatus;
	$('results-page-findings').textContent = `${findings} finding${findings === 1 ? '' : 's'}`;
	let target = '';
	try { target = session.targetUrl ? new URL(session.targetUrl).host : ''; } catch { target = session.targetUrl ?? ''; }
	$('results-page-target').textContent = target;
	$('results-page-target').hidden = !target;
	$('results-page-title').textContent = target || session.title || 'Test results';
	$('results-page-title').title = session.title || 'Test results';
	$('results-page-target').hidden = Boolean(target);
	const finished = new Date(session.report?.ts || session.completedAt || session.updatedAt || NaN);
	const date = $('results-page-date');
	date.hidden = Number.isNaN(finished.getTime());
	if (!date.hidden) {
		date.dateTime = finished.toISOString();
		date.textContent = finished.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
	}
	const exported = $('results-page-export');
	exported.hidden = !session.report;
}

async function applyPageRoute(route) {
	if (!workspaceBooted || !el.authGate?.hidden) return;
	document.body.dataset.page = route.name;
	const workspace = document.querySelector('.app');
	if (route.name === 'matrix-run') { workspace?.setAttribute('inert', ''); workspace?.setAttribute('aria-hidden', 'true'); }
	else { workspace?.removeAttribute('inert'); workspace?.removeAttribute('aria-hidden'); }
	$('tab-report').textContent = route.name === 'results' ? 'Overview' : 'Report';
	document.body.dataset.pageLoading = 'true';
	document.querySelector('.app')?.setAttribute('aria-busy', 'true');
	if (route.name !== 'new-run') closePageDialog(qaUi.dialog);
	if (route.name !== 'account') closePageDialog(profileDialog);
	if (route.name !== 'matrix-run') closeQaMatrixRunDialog({ updateRoute: false });
	if (route.name !== 'matrix-run') runStartupView?.stop();
	if (route.name !== 'bugs' && state.bugsViewOpen) setBugsViewOpen(false);

	try {
		if (route.name === 'matrix-run') {
			setPageRouteNotice('Loading your queued test run…');
			void runStartupView?.load(route.runId);
			document.title = 'Starting your test — QASE';
			return;
		}
		if (route.name === 'new-run') {
			setPageRouteNotice('Preparing test setup…');
			showQaStartPage();
			document.title = 'Start testing — Qase';
			focusPageHeading($('qa-start-title'));
			return;
		}
		if (route.name === 'account') {
			setPageRouteNotice('Loading account settings…');
			await showAccountPage();
			document.title = 'My account — Qase';
			focusPageHeading($('profile-title'));
			return;
		}
		if (route.name === 'bugs') {
			setPageRouteNotice('Loading bug tracker…');
			setBugsViewOpen(true);
			document.title = 'Bug tracker — Qase';
			focusPageHeading($('bugs-title'));
			return;
		}
		if (route.name === 'run' || route.name === 'results') {
			setPageRouteNotice(route.name === 'results' ? 'Loading test results…' : 'Loading test run…');
			if (state.sessionId !== route.runId) await selectSession(route.runId, { updateRoute: false });
			if (route.name === 'results') {
				const resultTab = $(preferredResultTab(state.session, {
					sqaVisible: !$('tab-sqa').hidden, founderVisible: !$('tab-founder').hidden
				}));
				renderResultsPageHeader();
				state.stageCollapsePreferences.delete(route.runId);
				renderStageCollapse();
				activateDetailTab(resultTab);
				setWorkspaceView('results');
				focusPageHeading($('results-page-title'));
				document.title = `Results — ${state.session?.title ?? 'Qase'}`;
			} else {
				if (matchMedia('(max-width: 720px)').matches && state.session?.status === 'running') setWorkspaceView('browser');
				else if (matchMedia('(max-width: 720px)').matches) setWorkspaceView('agent');
				else if (document.body.dataset.workspaceView === 'runs') setWorkspaceView('agent');
				focusPageHeading(el.chatTitle);
				document.title = `${state.session?.title ?? 'Test run'} — Qase`;
			}
			return;
		}

		const narrow = matchMedia('(max-width: 720px)').matches;
		setWorkspaceView(narrow && state.session?.status === 'done'
			? 'results'
			: narrow && state.session?.status === 'running'
				? 'browser'
				: 'agent');
		document.title = 'Qase — autonomous QA agent';
		focusPageHeading(el.chatTitle);
	} catch (error) {
		const message = route.name === 'account'
			? 'Account settings could not be loaded.'
			: route.name === 'bugs'
				? 'The bug tracker could not be loaded.'
				: 'That test run could not be opened.';
		setPageRouteNotice(`${message} Try again or return to your runs.`, {
			state: 'error',
			retry: () => void applyPageRoute(route)
		});
		return;
	} finally {
		delete document.body.dataset.pageLoading;
		document.querySelector('.app')?.removeAttribute('aria-busy');
		if (pageRouteNotice?.dataset.state !== 'error') setPageRouteNotice();
	}
}

const pageRouter = createPageRouter({ onRoute: applyPageRoute });

document.addEventListener('click', event => {
	const jump = event.target.closest('[data-page-jump]');
	if (!jump) return;
	const target = document.getElementById(jump.dataset.pageJump);
	if (!target) return;
	if (target instanceof HTMLDetailsElement) target.open = true;
	const focusTarget = target instanceof HTMLDetailsElement
		? target.querySelector('summary')
		: target;
	target.scrollIntoView({
		behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
		block: 'start'
	});
	focusTarget?.focus({ preventScroll: true });
});

function renderAuthMode() {
	if (!el.authGate) return;
	const register = authRegisterMode;
	if (el.authTitle) el.authTitle.textContent = register ? 'Create your account.' : 'Welcome back.';
	if (el.authCopy) el.authCopy.textContent = register
		? 'A dedicated space for your test runs, findings, and context.'
		: 'Sign in to pick up where you left off.';
	const passwordHint = $('auth-password-hint');
	if (passwordHint) passwordHint.hidden = !register;
	const switchContext = $('auth-switch-context');
	if (switchContext) switchContext.textContent = register ? 'Already have an account?' : 'New to QASE?';
	if (el.authDisplay) { el.authDisplay.hidden = !register; el.authDisplay.required = register; }
	if (el.authDisplayLabel) el.authDisplayLabel.hidden = !register;
	// Invite code field: only meaningful when this instance is in pilot
	// (invite-only) mode — surfaced when the server says so.
	if (el.authInvite) el.authInvite.hidden = !(register && state.pilotMode);
	if (el.authInviteLabel) el.authInviteLabel.hidden = !(register && state.pilotMode);
	if (el.authInvite && !state.pilotMode) { el.authInvite.required = false; }
	if (el.authPassword) {
		el.authPassword.autocomplete = register ? 'new-password' : 'current-password';
		el.authPassword.minLength = register ? 8 : 1;
		if (register) el.authPassword.setAttribute('aria-describedby', 'auth-password-hint');
		else el.authPassword.removeAttribute('aria-describedby');
	}
	if (el.authSubmit) el.authSubmit.textContent = register ? 'Create account' : 'Sign in';
	if (el.authSwitch) el.authSwitch.textContent = register ? 'Sign in' : 'Create an account';
	// Forgot-password entry point lives on the login card only.
	if (el.authForgotSwitch) el.authForgotSwitch.hidden = register;
}

function showAuthGate() {
	if (!el.authGate) return;
	el.authGate.hidden = false;
	document.querySelector('.app').inert = true;
	document.querySelector('.app').setAttribute('aria-hidden', 'true');
	// Restore the plain sign-in card (forgot/reset panels stay hidden).
	showAuthCard('signin');
	el.authEmail?.focus({ preventScroll: true });
}

function hideAuthGate() {
	if (el.authGate) el.authGate.hidden = true;
	for (const node of document.querySelectorAll('.app, .skip-link, #settings, #environments, #toasts')) { node.inert = false; node.removeAttribute('aria-hidden'); }
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
	el.authSubmit.textContent = authRegisterMode ? 'Creating account…' : 'Signing in…';
	el.authSwitch.disabled = true;
	if (el.authForgotSwitch) el.authForgotSwitch.disabled = true;
	el.authForm.setAttribute('aria-busy', 'true');
	try {
		state.user = await api(authRegisterMode ? '/auth/register' : '/auth/login', {
			method: 'POST',
			body: JSON.stringify({
				email: el.authEmail.value.trim(),
				password: el.authPassword.value,
				displayName: el.authDisplay?.value.trim(),
				inviteCode: el.authInvite && !el.authInvite.hidden ? el.authInvite.value.trim() : undefined
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
		el.authSubmit.textContent = authRegisterMode ? 'Create account' : 'Sign in';
		el.authSwitch.disabled = false;
		if (el.authForgotSwitch) el.authForgotSwitch.disabled = false;
		el.authForm.removeAttribute('aria-busy');
	}
});

// ── Forgot / reset password (ticket #15673) ─────────────────────────
// The four cards (sign-in, forgot, OTP, reset) swap inside the same auth gate.
// Flow: email → 6-digit email OTP → new password (min 8 chars).
let resetAuthorization; // short-lived single-use authorization from OTP verification
let resetEmail;        // email the OTP was requested for (kept for resend)

function showAuthCard(which) {
	el.authGate?.setAttribute('aria-labelledby', ({ signin: 'auth-title', forgot: 'forgot-title', recover: 'recover-title', otp: 'otp-title', reset: 'reset-title' })[which] ?? 'auth-title');
	if (el.forgotPanel) el.forgotPanel.hidden = which !== 'forgot';
	if (el.otpPanel) el.otpPanel.hidden = which !== 'otp';
	if (el.resetPanel) el.resetPanel.hidden = which !== 'reset';
	if (el.recoverPanel) el.recoverPanel.hidden = which !== 'recover';
	const signInPanel = document.querySelector('.auth-panel:not(#forgot-panel):not(#otp-panel):not(#reset-panel):not(#recover-panel)');
	if (signInPanel) signInPanel.hidden = which !== 'signin';
	if (which === 'signin') { authRegisterMode = false; renderAuthMode(); }
	if (el.authGate) el.authGate.hidden = false;
	document.querySelector('.app').inert = true;
	document.querySelector('.app').setAttribute('aria-hidden', 'true');
}

el.authForgotSwitch?.addEventListener('click', () => {
	showAuthCard('recover');
	if (el.recoverError) el.recoverError.hidden = true;
	if (el.recoverNotice) el.recoverNotice.hidden = true;
	if (el.recoverEmail) el.recoverEmail.value = el.authEmail?.value.trim() || '';
	if (el.recoverCode) el.recoverCode.value = '';
	(el.recoverEmail?.value ? el.recoverCode : el.recoverEmail)?.focus();
});
// Recovery-code card (#15727): email + one unused code → new password.
// Verifying the code yields the SAME short-lived single-use reset
// authorization the email-OTP flow issues, so the existing #reset-panel
// completes the journey unchanged.
el.recoverBack?.addEventListener('click', () => {
	showAuthCard('signin');
	el.authEmail?.focus();
});
el.forgotRecoverLink?.addEventListener('click', () => {
	showAuthCard('recover');
	if (el.recoverError) el.recoverError.hidden = true;
	if (el.recoverNotice) el.recoverNotice.hidden = true;
	el.recoverEmail?.focus();
});
el.recoverForm?.addEventListener('submit', async event => {
	event.preventDefault();
	if (!el.recoverEmail || !el.recoverCode || !el.recoverSubmit) return;
	if (el.recoverError) el.recoverError.hidden = true;
	if (el.recoverNotice) el.recoverNotice.hidden = true;
	const email = el.recoverEmail.value.trim();
	const code = el.recoverCode.value.trim();
	if (!/^[A-Za-z0-9]{12}$|^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(code)) {
		if (el.recoverError) { el.recoverError.textContent = 'Enter a recovery code in the format XXXX-XXXX-XXXX.'; el.recoverError.hidden = false; }
		return;
	}
	el.recoverSubmit.disabled = true;
	el.recoverForm.setAttribute('aria-busy', 'true');
	try {
		const result = await api('/auth/recover', {
			method: 'POST',
			body: JSON.stringify({ email, code })
		});
		resetAuthorization = result?.authorization;
		if (!resetAuthorization) throw new Error('This recovery code is invalid or has expired.');
		el.recoverCode.value = '';
		showAuthCard('reset');
		if (el.resetError) el.resetError.hidden = true;
		if (el.resetNotice) el.resetNotice.hidden = true;
		el.resetPassword?.focus();
	} catch (error) {
		if (el.recoverError) {
			el.recoverError.textContent = error instanceof Error ? error.message : String(error);
			el.recoverError.hidden = false;
		}
	} finally {
		el.recoverSubmit.disabled = false;
		el.recoverForm.removeAttribute('aria-busy');
	}
});
el.forgotBack?.addEventListener('click', () => {
	showAuthCard('signin');
	el.authEmail?.focus();
});
el.otpBack?.addEventListener('click', () => {
	showAuthCard('signin');
	el.authEmail?.focus();
});
el.resetBack?.addEventListener('click', () => {
	showAuthCard('signin');
	el.authEmail?.focus();
});

async function requestCode() {
	if (!el.forgotEmail || !el.forgotSubmit) return false;
	if (el.forgotError) el.forgotError.hidden = true;
	el.forgotSubmit.disabled = true;
	el.forgotForm.setAttribute('aria-busy', 'true');
	try {
		resetEmail = el.forgotEmail.value.trim();
		const result = await api('/auth/forgot-password', {
			method: 'POST',
			body: JSON.stringify({ email: resetEmail })
		});
		// Same neutral message whether or not the account exists.
		if (el.forgotNotice) {
			el.forgotNotice.textContent = result?.message ?? 'If an account exists for that email, a reset code has been sent.';
			el.forgotNotice.hidden = false;
		}
		showAuthCard('otp');
		if (el.otpError) el.otpError.hidden = true;
		if (el.otpNotice) el.otpNotice.hidden = true;
		el.otpInput?.focus();
		return true;
	} catch (error) {
		if (el.forgotError) {
			el.forgotError.textContent = error instanceof Error ? error.message : String(error);
			el.forgotError.hidden = false;
		}
		return false;
	} finally {
		el.forgotSubmit.disabled = false;
		el.forgotForm.removeAttribute('aria-busy');
	}
}

el.forgotForm?.addEventListener('submit', async event => {
	event.preventDefault();
	await requestCode();
});

el.otpResend?.addEventListener('click', () => {
	// Resend from the OTP card: reuse the email step's request path.
	showAuthCard('forgot');
	if (el.forgotNotice) { el.forgotNotice.hidden = true; }
	el.forgotEmail?.focus();
});

el.otpForm?.addEventListener('submit', async event => {
	event.preventDefault();
	if (!el.otpInput || !el.otpSubmit) return;
	if (el.otpError) el.otpError.hidden = true;
	const otp = el.otpInput.value.trim();
	if (!/^[0-9]{6}$/.test(otp)) {
		if (el.otpError) { el.otpError.textContent = 'Enter the 6-digit code from your email.'; el.otpError.hidden = false; }
		return;
	}
	el.otpSubmit.disabled = true;
	el.otpForm.setAttribute('aria-busy', 'true');
	try {
		const result = await api('/auth/verify-reset-otp', {
			method: 'POST',
			body: JSON.stringify({ email: resetEmail, otp })
		});
		resetAuthorization = result?.authorization;
		if (!resetAuthorization) throw new Error('Verification failed. Request a new code.');
		el.otpInput.value = '';
		showAuthCard('reset');
		if (el.resetError) el.resetError.hidden = true;
		if (el.resetNotice) el.resetNotice.hidden = true;
		el.resetPassword?.focus();
	} catch (error) {
		if (el.otpError) {
			el.otpError.textContent = error instanceof Error ? error.message : String(error);
			el.otpError.hidden = false;
		}
	} finally {
		el.otpSubmit.disabled = false;
		el.otpForm.removeAttribute('aria-busy');
	}
});

el.resetForm?.addEventListener('submit', async event => {
	event.preventDefault();
	if (!el.resetPassword || !el.resetConfirm || !el.resetSubmit) return;
	if (el.resetError) el.resetError.hidden = true;
	if (el.resetNotice) el.resetNotice.hidden = true;
	// Inline validation before any network call.
	if (el.resetPassword.value !== el.resetConfirm.value) {
		if (el.resetError) { el.resetError.textContent = 'Passwords do not match.'; el.resetError.hidden = false; }
		return;
	}
	if (!resetAuthorization) {
		if (el.resetError) { el.resetError.textContent = 'This reset session is invalid or has expired. Start again.'; el.resetError.hidden = false; }
		return;
	}
	el.resetSubmit.disabled = true;
	el.resetForm.setAttribute('aria-busy', 'true');
	try {
		const result = await api('/auth/reset-password', {
			method: 'POST',
			body: JSON.stringify({ authorization: resetAuthorization, password: el.resetPassword.value })
		});
		if (el.resetNotice) {
			el.resetNotice.textContent = result?.message ?? 'Password updated. You can now sign in.';
			el.resetNotice.hidden = false;
		}
		el.resetPassword.value = '';
		el.resetConfirm.value = '';
		// The authorization is single-use; drop it and return to sign-in.
		resetAuthorization = undefined;
		showAuthCard('signin');
		el.authEmail?.focus();
	} catch (error) {
		if (el.resetError) {
			el.resetError.textContent = error instanceof Error ? error.message : String(error);
			el.resetError.hidden = false;
		}
	} finally {
		el.resetSubmit.disabled = false;
		el.resetForm.removeAttribute('aria-busy');
	}
});

// Merge note (807bd76 regression): the legacy #open-settings button was
// removed by DEV's sidebar footer redesign (#15651). Binding onclick on the
// null element threw during module evaluation and silently killed EVERY
// handler below this line — no nav, no dialogs, no sign-in. Settings is now
// reached via #sidebar-open-settings below; keep a guard in case the old
// button ever returns.
document.getElementById('open-settings')?.addEventListener('click', openSettings);

// Sidebar footer (#15651): Settings / Account / Sign out. Account uses the
// route-backed account page (merged from origin/DEV) so URL + dialog stay in sync.
const openSettingsButton = $('sidebar-open-settings');
if (openSettingsButton) openSettingsButton.onclick = () => void openSettings();
const openProfileButton = $('sidebar-open-profile');
if (openProfileButton) openProfileButton.onclick = () => void pageRouter.navigate({ name: 'account' });
const sidebarSignOut = $('sidebar-sign-out');
sidebarSignOut?.addEventListener('click', async () => {
	sidebarSignOut.disabled = true;
	try {
		await api('/auth/logout', { method: 'POST' });
		state.stream?.close();
		localStorage.removeItem('qase.session');
		window.location.reload();
	} catch (error) {
		fail(error);
		sidebarSignOut.disabled = false;
	}
});

const openDeviceMatrixButton = $('open-device-matrix');

const envUi = {
	dialog: $('environments'),
	close: $('env-close'),
	filters: {
		platform: $('env-filter-platform'),
		osVersion: $('env-filter-osversion'),
		browser: $('env-filter-browser'),
		browserVersion: $('env-filter-browserversion'),
		active: $('env-filter-active'),
		search: $('env-filter-search')
	},
	summary: $('env-summary'),
	tbody: $('env-tbody'),
	detail: $('env-detail'),
	availabilityBody: $('env-availability-body')
};

function fillEnvFilterOptions(select, values) {
	if (!select) return;
	const current = select.value;
	select.innerHTML = '';
	const all = document.createElement('option');
	all.value = '';
	all.textContent = 'All';
	select.append(all);
	for (const value of values) {
		const option = document.createElement('option');
		option.value = String(value);
		option.textContent = String(value);
		select.append(option);
	}
	if ([...select.options].some(option => option.value === current)) select.value = current;
}

function envActiveQuery() {
	const filters = {};
	for (const [key, select] of Object.entries(envUi.filters)) {
		if (!select || !select.value) continue;
		filters[key === 'osVersion' ? 'osVersion' : key === 'browserVersion' ? 'browserVersion' : key] = select.value;
	}
	return filters;
}

async function refreshEnvTable() {
	if (!envUi.tbody) return;
	const filters = envActiveQuery();
	const params = new URLSearchParams(filters);
	params.set('limit', '300');
	const payload = await api(`/environments?${params.toString()}`).catch(() => ({ total: 0, environments: [] }));
	const rows = payload.environments ?? [];
	envUi.tbody.innerHTML = '';
	for (const env of rows) {
		const tr = document.createElement('tr');
		tr.dataset.envId = env.envId;
		tr.className = env.active ? '' : 'env-inactive';
		const cells = [
			env.envId,
			env.device,
			`${env.os} ${env.osVersion}`,
			env.browser,
			env.browserVersion,
			env.deviceType,
			env.executionProvider === 'browserstack' ? 'Remote runtime' : env.executionProvider,
			env.active ? 'active' : 'inactive'
		];
		for (const [index, text] of cells.entries()) {
			const td = document.createElement('td');
			td.textContent = String(text);
			if (index === 7) td.dataset.state = env.active ? 'active' : 'inactive';
			tr.append(td);
		}
		tr.title = `${env.screenSize}${env.isRealDevice ? ' · real device' : ' · desktop VM'} — click to inspect capabilities`;
		tr.onclick = () => {
			envUi.detail.textContent = `${env.envId} → ${JSON.stringify(env.browserstackCapabilities ?? env.runtimeCapabilities ?? null)}${env.active ? '' : ' (INACTIVE — not selectable for new runs)'}`;
		};
		envUi.tbody.append(tr);
	}
	envUi.summary.textContent = `${payload.total} environment${payload.total === 1 ? '' : 's'} match the current filters (showing first ${rows.length}).`;
}

async function refreshEnvFacets() {
	const payload = await api(`/environments/facets?${new URLSearchParams(envActiveQuery()).toString()}`).catch(() => null);
	if (!payload) return;
	fillEnvFilterOptions(envUi.filters.platform, payload.platform.map(entry => entry.value));
	fillEnvFilterOptions(envUi.filters.osVersion, payload.osVersion.map(entry => entry.value).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })));
	fillEnvFilterOptions(envUi.filters.browser, payload.browser.map(entry => entry.value));
	fillEnvFilterOptions(envUi.filters.browserVersion, payload.browserVersion.map(entry => entry.value).sort((a, b) => Number(b) - Number(a)));
}

async function openEnvironments() {
	if (!envUi.dialog) return;
	if (!envUi.dialog.open) envUi.dialog.showModal();
	await Promise.all([refreshEnvFacets(), refreshEnvTable()]);
	if (envUi.availabilityBody && !envUi.availabilityBody.dataset.filled) {
		const report = await api('/environments/availability').catch(() => []);
		envUi.availabilityBody.innerHTML = '';
		for (const entry of report) {
			const p = document.createElement('p');
			const strong = document.createElement('strong');
			strong.textContent = entry.platformLabel;
			p.append(strong, ` — available: ${entry.available.join(', ') || 'none'}.`);
			if (entry.unavailable.length) {
				const ul = document.createElement('ul');
				for (const { browser, reason } of entry.unavailable) {
					const li = document.createElement('li');
					li.textContent = `${browser}: ${reason}`;
					ul.append(li);
				}
				p.append(ul);
			}
			envUi.availabilityBody.append(p);
		}
		envUi.availabilityBody.dataset.filled = '1';
	}
}

if (envUi.dialog) {
	envUi.close.onclick = () => envUi.dialog.close();
	for (const select of Object.values(envUi.filters)) {
		select?.addEventListener('change', () => {
			void refreshEnvFacets();
			void refreshEnvTable();
		});
	}
	envUi.filters.search?.addEventListener('input', () => {
		clearTimeout(envUi.filters.search._timer);
		envUi.filters.search._timer = setTimeout(() => void refreshEnvTable(), 250);
	});
}
	const openEnvironmentsButton = $('nav-environments');
	if (openEnvironmentsButton) openEnvironmentsButton.onclick = openEnvironments;

/* ── Sidebar workspace nav (UX U2) ─────────────────────────────── */
const sidebarNav = [
	['nav-analytics', () => analyticsView?.open()]
];
for (const [id, opener] of sidebarNav) {
	const btn = $(id);
	if (btn) btn.onclick = () => opener();
}

/* ── Device & Environment Matrix (Phase 3) ────────────────────── */
const deviceMatrix = $('device-matrix') ? createDeviceMatrixView({
	api,
	toast,
	fail,
	onRunEnvironment: (env) => startEnvironmentRun(env),
	onOpenRun: (runId) => selectSession(runId),
	elements: {
		dialog: $('device-matrix'),
		navButton: $('nav-device-matrix'),
		tabs: [...document.querySelectorAll('#device-matrix [data-dm-tab]')],
		browseList: $('dm-browse-list'),
		browseSearch: $('dm-browse-search'),
		browseCategory: $('dm-browse-category'),
		builderDevices: $('dm-builder-devices'),
		builderOs: $('dm-builder-os'),
		builderBrowsers: $('dm-builder-browsers'),
		builderPreview: $('dm-builder-preview'),
		builderCreate: $('dm-builder-create'),
		envTbody: $('dm-env-tbody'),
		envSummary: $('dm-env-summary'),
		envFilterPlatform: $('dm-env-platform'),
		envFilterBrowser: $('dm-env-browser'),
		envFilterActive: $('dm-env-active'),
		envFilterSearch: $('dm-env-search'),
		envPrev: $('dm-env-prev'),
		envNext: $('dm-env-next'),
		envEditor: $('dm-env-editor'),
		catalogForms: $('dm-catalog-forms'),
		coverageMetrics: $('dm-coverage-metrics'),
		coverageHead: $('dm-coverage-head'),
		coverageTbody: $('dm-coverage-tbody'),
		coverageDetail: $('dm-coverage-detail'),
		facetSummary: $('dm-facet-summary')
	}
}) : null;

/* ── Test cases (Phase 4) ───────────────────────────────────────── */
function startRunForTestCase(testCase) {
	openQaStart();
	// DX Phase 3: assigned-env prefill goes through the ONE picker's data, not
	// a disabled select. If the current selection isn't assigned to the case,
	// switch to the first assigned environment (still one source of truth).
	const assigned = testCase.environmentIds ?? [];
	if (assigned.length) {
		const current = activeTestEnvStore?.get?.();
		if (!current || !assigned.includes(current.envId)) {
			const env = (devicePicker?.state?.environments ?? []).find((e) => assigned.includes(e.envId));
			if (env) {
				activeTestEnvStore.setSelection(env);
				if (devicePicker) devicePicker.state.selectedDevice = env.device;
				renderAllTestOnBlocks();
				deviceDrawer?.paintChip?.();
			}
		}
	}
	qaUi._testCaseId = testCase.caseNumber;
	qaUi._testCaseSnapshot = testCase;
	el.composerInput.placeholder = `Run ${testCase.caseNumber} — ${testCase.title}`;
}

function createQaRunWithCase({ targetUrl, device, deviceLandscape, environmentId, testCaseId }) {
	if (!testCaseId) return createQaRun({ targetUrl, device, deviceLandscape, environmentId });
	return api('/sessions', { method: 'POST', body: JSON.stringify({
		device, deviceLandscape, ...(environmentId ? { environmentId } : {}), testCaseId
	}) }).then(async (session) => {
		await selectSession(session.id);
		if (targetUrl) {
			await api(`/sessions/${session.id}/message`, { method: 'POST', body: JSON.stringify({ text: targetUrl }) }).catch(fail);
		}
		return session;
	});
}

const quickRunState = { testCase: null };

const workflow = {
	lastRunByCase,
	caseStatus,
	platformsOf,
	caseEnvLines,
	oneClickRun(testCase) {
		const assigned = testCase.environmentIds ?? [];
		if (!assigned.length) {
			// Zero assigned environments → current device emulation with a note.
			openRunTarget(testCase);
			return;
		}
		if (assigned.length === 1) {
			// One-click: no configuration steps.
			void launchPairs([{ testCase, envId: assigned[0] }], `${testCase.caseNumber}: `);
			return;
		}
		openRunTarget(testCase);
	}
};

const testCaseView = $('test-cases') ? createTestCaseView({
	api, toast, fail,
	onStartRun: startRunForTestCase,
	onOpenRun: (runId) => { void selectSession(runId).catch(fail); },
	workflow,
	elements: {
		dialog: $('test-cases'),
		navButton: $('nav-test-cases'),
		list: $('tc-tbody'),
		search: $('tc-search'),
		source: $('tc-source'),
		form: $('tc-form'),
		formTitle: $('tc-title'),
		formDescription: $('tc-description'),
		formExpected: $('tc-expected'),
		formSteps: $('tc-steps'),
		formTags: $('tc-tags'),
		deviceChips: $('tc-device-chips'),
		addDeviceBtn: $('tc-add-device'),
		submitBtn: $('tc-submit'),
		formCancel: $('tc-cancel'),
		closeButton: $('tc-close'),
		editorSummary: $('tc-summary')
	}
}) : null;

const bulkRunView = $('bulk-run') ? createBulkRunView({
	api, toast, fail,
	onLaunch: (pairs, label) => launchPairs(pairs, label),
	elements: {
		dialog: $('bulk-run'),
		navButton: $('nav-bulk-runs'),
		close: $('bulk-close'),
		what: $('bulk-what'),
		casesField: $('bulk-cases-field'),
		caseList: $('bulk-case-list'),
		casesCount: $('bulk-cases-count'),
		casesAll: $('bulk-cases-all'),
		casesNone: $('bulk-cases-none'),
		where: $('bulk-where'),
		deviceChips: $('bulk-device-chips'),
		addDeviceBtn: $('bulk-add-device'),
		preview: $('bulk-preview'),
		availabilityEl: $('bulk-availability'),
		launchBtn: $('bulk-launch'),
		result: $('bulk-result'),
		steps: [...document.querySelectorAll('#bulk-run [data-bulk-step]')]
	}
}) : null;
if (bulkRunView) {
	bulkRunView.setWizardFilter((mode) => filterCasesForWizard(bulkRunView.state.cases, mode, bulkRunView.state.lastRuns));
	bulkRunView.setLastRunIndex(lastRunByCase);
	// Phase D6 (#13782): step-3 availability rows read the runtime board.
	bulkRunView.setRuntimeBoardFetch(fetchRuntimeBoard);
}

/* ── Analytics dashboard (UX U5) ────────────────────────────────── */
const analyticsView = $('analytics') ? createAnalyticsView({
	api,
	fail,
	elements: {
		dialog: $('analytics'),
		navButton: $('nav-analytics'),
		closeButton: $('analytics-close'),
		body: $('analytics-body'),
		refreshButton: $('analytics-refresh')
	}
}) : null;

/* ── QA matrix run results board (#14942 Phase 4) ──────────────────── */

const runStartupView = $('run-startup-page') ? createRunStartupView({
	container: $('run-startup-page'),
	api: (path, options) => apiWithTimeout(path, 15000, options),
	openSession: sessionId => void pageRouter.navigate({ name: 'run', runId: sessionId }, { replace: true }).catch(fail),
	back: () => void pageRouter.navigate({ name: 'runs' }),
	details: openQaMatrixRunDialog
}) : null;

const qaMatrixResultsView = $('qa-matrix-run-dialog') ? createQaMatrixResultsView({
	container: $('qa-matrix-run-body'),
	api,
	selectSession: async (sessionId) => {
		closeQaMatrixRunDialog({ updateRoute: false });
		await selectSession(sessionId).catch(fail);
	},
	toast,
	onRunFinished: () => {},
	onRunUpdated: run => {
		const route = pageRouter.current();
		if (route.name !== 'matrix-run' || route.runId !== run.id) return;
		const sessionId = firstMatrixSessionId(run);
		// The startup page owns automatic handoff. This is an explicit diagnostics view.
	}
}) : null;

/** Open the results board for a QA matrix run (live updates until terminal). */
function openQaMatrixRunDialog(matrixRunId) {
	const dialog = $('qa-matrix-run-dialog');
	if (!dialog || !qaMatrixResultsView || !matrixRunId) return;
	if (!dialog.open) dialog.showModal();
	void qaMatrixResultsView.load(matrixRunId);
}

function closeQaMatrixRunDialog({ updateRoute = false } = {}) {
	const dialog = $('qa-matrix-run-dialog');
	if (dialog?.open) dialog.close();
	qaMatrixResultsView?.stop();
	if (updateRoute && pageRouter.current().name === 'matrix-run') void pageRouter.navigate({ name: 'runs' }, { replace: true });
}

if ($('qa-matrix-run-close')) {
	$('qa-matrix-run-close').onclick = closeQaMatrixRunDialog;
}
$('qa-matrix-run-dialog')?.addEventListener('cancel', event => {
	event.preventDefault();
	closeQaMatrixRunDialog();
});
// The view renders its own Cancel-run button (it knows live run status).

/* ── Phase 11: run-target dialog + quick actions + presets ────────── */

const runTarget = $('run-target') ? {
	dialog: $('run-target'),
	close: $('rt-close'),
	cancel: $('rt-cancel'),
	runBtn: $('rt-run'),
	envsField: $('rt-envs-field'),
	error: $('rt-error'),
	sub: $('run-target-sub')
} : null;

/** Run-target dialog chip list (DX Phase 4) — same picker, add-mode. */
const runTargetDevices = $('run-target') ? createDeviceChipList({
	container: $('rt-device-chips'),
	addBtn: $('rt-add-device'),
	environmentsById: (id) => (testCaseView?.state.environmentsById ?? new Map()).get(id),
	onChange: () => {}
}) : null;


async function defaultEnvironmentId() {
	return localStorage.getItem('qase.environmentId') || '';
}

async function launchPairs(pairs, sourceLabel = '') {
	let created = 0;
	const failures = [];
	const sessionIds = [];
	const testCaseTitles = {};
	for (const { testCase, envId } of pairs) {
		try {
			const session = await createQaRunWithCase({ testCaseId: testCase.caseNumber, environmentId: envId });
			created += 1;
			if (session?.id) {
				sessionIds.push(session.id);
				testCaseTitles[session.id] = `${testCase.caseNumber} ${testCase.title ?? ''}`.trim();
			}
		} catch (error) {
			failures.push(`${testCase.caseNumber} @ ${envId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (batchTracker && sessionIds.length) {
		batchTracker.track(recordBatch({ label: sourceLabel.trim() || 'Bulk run', sessionIds, testCaseTitles }));
	}
	toast(
		created && !failures.length
			? `${sourceLabel}${created} run${created === 1 ? '' : 's'} launched.`
			: failures.length ? `${created} launched, ${failures.length} failed.` : 'Nothing launched.',
		failures.length ? 'bad' : ''
	);
	return { created, failures };
}

function openRunTarget(testCase) {
	if (!runTarget) return;
	quickRunState.testCase = testCase;
	runTarget.error.hidden = true;
	runTarget.error.textContent = '';
	const assigned = testCase.environmentIds ?? [];
	if (runTarget.sub) {
		runTarget.sub.textContent = assigned.length
			? `${assigned.length} device${assigned.length === 1 ? '' : 's'} assigned to this test.`
			: 'This test has no assigned devices — it will run on the current device emulation.';
	}
	runTargetDevices?.set(assigned);
	runTarget.envsField.hidden = true;
	for (const radio of runTarget.dialog.querySelectorAll('input[name="rt-choice"]')) radio.checked = radio.value === 'current';
	runTarget.dialog.querySelectorAll('input[name="rt-choice"]').forEach((radio) => {
		radio.onchange = () => { if (runTarget.envsField) runTarget.envsField.hidden = radio.value !== 'choose' || !radio.checked; };
	});
	if (!runTarget.dialog.open) runTarget.dialog.showModal();
}

async function submitRunTarget() {
	if (!runTarget || !quickRunState.testCase) return;
	const choice = runTarget.dialog.querySelector('input[name="rt-choice"]:checked')?.value ?? 'current';
	const testCase = quickRunState.testCase;
	const pairs = resolveRunPairs([testCase], choice, {
		defaultEnvId: await defaultEnvironmentId(),
		chosenEnvIds: runTargetDevices?.ids ?? []
	});
	runTarget.error.hidden = true;
	if (!pairs.length) {
		if (choice === 'current' && !(await defaultEnvironmentId())) {
			runTarget.error.hidden = false;
			runTarget.error.textContent = 'No current device chosen — open the device panel and pick one, or choose "All selected devices".';
			return;
		}
		runTarget.error.hidden = false;
		runTarget.error.textContent = 'Pick at least one device to run on.';
		return;
	}
	runTarget.dialog.close();
	await launchPairs(pairs, `${testCase.caseNumber}: `);
}


async function runAllTests() {
	if (!bulkRunView) return;
	const sessions = await loadSessionsForFilters();
	bulkRunView.state.lastRuns = lastRunByCase(sessions);
	bulkRunView.state.cases = (await api('/test-cases').then((p) => p.testCases ?? []).catch(() => []));
	const pairs = resolveRunPairs(bulkRunView.state.cases, 'all');
	if (!pairs.length) {
		toast('No test cases with assigned environments yet — create one first.');
		return;
	}
	await launchPairs(pairs, 'Run all: ');
}

async function runFailedTests() {
	const sessions = await loadSessionsForFilters();
	const lastRuns = lastRunByCase(sessions);
	const cases = (await api('/test-cases').then((p) => p.testCases ?? []).catch(() => []));
	const failed = filterCasesForWizard(cases, 'failed', lastRuns);
	if (!failed.length) {
		toast('No failed runs to re-run — nice and green.');
		return;
	}
	await launchPairs(resolveRunPairs(failed, 'all'), 'Re-run failed: ');
}

async function createBugReport() {
	const sessions = await loadSessionsForFilters();
	const failed = sessions
		.filter((s) => s.mode !== 'sqa' && s.mode !== 'founder' && Array.isArray(s.findings) && s.findings.length)
		.sort((a, b) => (Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0) - (Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0));
	if (!failed.length) {
		toast('No findings recorded yet — nothing to report.');
		return;
	}
	const session = failed[0];
	const env = session.environmentSnapshot
		?? (session.environmentId ? (await api(`/environments/${encodeURIComponent(session.environmentId)}`).catch(() => null)) : null);
	const markdown = buildBugMarkdown(session, env);
	try {
		await navigator.clipboard.writeText(markdown);
		toast('Bug report copied to the clipboard.');
	} catch {
		toast('Bug report generated (clipboard blocked) — downloading instead.');
	}
	const blob = new Blob([markdown], { type: 'text/markdown' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = `bug-${session.id?.slice(0, 8) ?? 'report'}.md`;
	link.click();
	URL.revokeObjectURL(url);
}

/* Permanent quick actions were removed. Start testing stays primary; the
   current run exposes only the actions that make sense for its state. */

if (runTarget) {
	runTarget.close?.addEventListener('click', () => runTarget.dialog.close());
	runTarget.cancel?.addEventListener('click', () => runTarget.dialog.close());
	runTarget.runBtn?.addEventListener('click', () => void submitRunTarget());
}

/* ── Phase 12: run-screen environment block + bulk progress ───────── */

const batchTracker = $('bulk-progress') ? createBatchTracker({
	api,
	elements: {
		block: $('bulk-progress'),
		label: $('bulk-progress-label'),
		pct: $('bulk-progress-pct'),
		bar: $('bulk-progress-bar'),
		counts: $('bulk-progress-counts'),
		list: $('bulk-progress-list')
	},
	// Phase 4: the live preview follows the ACTIVE batch run. When the
	// executing run changes (RUN 1 finishes → RUN 2 starts), the whole live
	// view — device frame, browser chrome, environment card, runtime id —
	// switches to that run's environment automatically. One preview per
	// execution; environments are never blended.
	onTick: (batch, sessionsById) => {
		const activeId = activeBatchRunId(batch, sessionsById);
		if (!activeId || activeId === state.sessionId) return;
		void selectSession(activeId);
	}
}) : null;

// Environment block inside #run-summary-detail: test-case title, current
// environment, batch size — driven from the selected session's snapshot.
setRunEnvHook(renderRunEnvBlock);

// Restore a persisted batch after reload so mid-batch progress reappears.
if (batchTracker) {
	const restored = loadBatches().at(-1);
	if (restored?.sessionIds?.length) batchTracker.track(restored);
}

function renderRunEnvBlock(session) {
	const block = $('run-env-block');
	const details = $('execution-details');
	if (!block || !details) return;
	const testcaseLine = $('run-env-testcase');
	const currentLine = $('run-env-current');
	const executionLine = $('run-env-execution');
	const sessionLine = $('run-env-session');
	const usageLine = $('run-env-usage');
	const countLine = $('run-env-count');
	const snap = session?.environmentSnapshot;
	const hasEnv = Boolean(snap || session?.environmentId);
	details.hidden = !session?.id;
	if (details.dataset.sessionId !== session?.id) {
		details.open = false;
		details.dataset.sessionId = session?.id ?? '';
	}
	if (testcaseLine) {
		const title = session?.testCaseSnapshot?.title ?? session?.testCaseId;
		testcaseLine.textContent = title ? `Test case: ${title}` : '';
		testcaseLine.hidden = !title;
	}
	if (currentLine) {
		const deviceText = snap
			? [snap.device, [snap.os, snap.osVersion].filter(Boolean).join(' '), [snap.browser, snap.browserVersion].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
			: session?.environmentId ?? '';
		currentLine.textContent = `Browser and device: ${deviceText || 'Not recorded'}`;
		currentLine.hidden = false;
	}
	if (executionLine) {
		const rawLevel = session?.runtimeFacts?.executionLevel
			?? (snap?.executionProvider === 'local' ? 'SIMULATED' : hasEnv ? 'VIRTUAL_DEVICE' : 'Not recorded');
		const level = String(rawLevel).toLowerCase().replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
		const runState = runPresentationStatus(session) === 'blocked' ? 'Blocked'
			: session?.status === 'done' ? 'Complete'
			: session?.status === 'running' ? 'Running'
				: session?.status === 'interrupted' ? 'Paused' : String(session?.status ?? 'Unknown');
		executionLine.textContent = `Execution: ${level} · ${runState}`;
		executionLine.hidden = false;
	}
	if (sessionLine) {
		sessionLine.textContent = `Session: ${session?.id ?? 'Not recorded'}`;
		sessionLine.hidden = false;
	}
	if (usageLine) {
		const usage = tokenSummaryText(session?.tokenUsage);
		usageLine.textContent = usage ? `Model usage: ${usage}` : 'Model usage: Not recorded';
		usageLine.hidden = false;
	}
	if (countLine) {
		const batch = batchTracker?.current;
		countLine.textContent = batch && batch.sessionIds.length > 1
			? `${batch.sessionIds.length} environments in this batch`
			: hasEnv ? '1 environment' : '';
		countLine.hidden = !countLine.textContent;
	}
}

// Paint on every snapshot and restore any persisted batch on load.
// Re-render the env block on every snapshot without redefining the hoisted
// function: a small post-hook invoked from applySessionSnapshot itself.

/* ── ONE Device Picker + activeTestEnvironment store (DX Phase 1) ── */
const activeTestEnvStore = createActiveTestEnvironmentStore();

// One live preference for Settings, the sidebar, the entry screen and Studio.
function syncThemeControls({ preference, applied }) {
	applyThemeToDocument(document, applied);
	document.documentElement.style.colorScheme = applied;
	document.querySelector('meta[name="theme-color"]').content = applied === 'dark' ? '#000000' : '#ffffff';
	const icon = document.querySelector('link[rel="icon"]');
	if (icon) icon.href = applied === 'dark' ? 'qase-mark-white.svg' : 'qase-mark.svg';
	for (const control of document.querySelectorAll('[data-theme-control]')) control.value = preference;
	const themeToggle = $('theme-toggle');
	if (themeToggle) {
		const dark = applied === 'dark';
		const nextTheme = dark ? 'light' : 'dark';
		themeToggle.setAttribute('aria-pressed', String(dark));
		themeToggle.setAttribute('aria-label', `Switch to ${nextTheme} theme`);
		themeToggle.title = `Switch to ${nextTheme} theme`;
		const label = $('theme-toggle-text');
		if (label) label.textContent = dark ? 'Dark' : 'Light';
	}
}
const themeStore = createThemeStore({
	onChange: syncThemeControls
});
syncThemeControls({ preference: themeStore.preference(), applied: themeStore.applied() });
globalThis.__qaseThemeStore = themeStore; // Settings UI (Phase T2) + tests
for (const control of document.querySelectorAll('[data-theme-control]')) {
	control.addEventListener('change', () => themeStore.set(control.value));
}
$('theme-toggle')?.addEventListener('click', () => {
	themeStore.set(themeStore.applied() === 'dark' ? 'light' : 'dark');
});
window.addEventListener('storage', event => {
	if (event.key !== 'qase.theme' && event.key !== null) return;
	try { if (event.storageArea !== localStorage) return; } catch { return; }
	themeStore.set(event.newValue);
});
/* UI Fix Phase 3: the feature-dock device chip (deviceDrawer.js, non-module
 * script scope boundary) reads the store through this accessor — one source
 * of truth for the selection. */
globalThis.__qaseActiveSelection = () => activeTestEnvStore.get();
const devicePicker = $('device-picker') ? createDevicePicker({
	elements: {
		dialog: $('device-picker'),
		search: $('dp-search'),
		cards: $('dp-cards'),
		summary: $('dp-summary'),
		closeBtn: $('dp-close')
	},
	store: activeTestEnvStore,
	runtimeProfiles: RUNTIME_PROFILES,
	onSelect: (selection, env) => {
		if (deviceDrawer) deviceDrawer.state.defaultEnvId = env?.envId ?? null;
		deviceDrawer?.paintChip?.();
		if (state.session) applySessionSnapshot(state.session);
		// #14132: with no card to carry identity, a fresh pick must repaint the
		// header/preview IMMEDIATELY — even with no session (idle), so exec badge
		// + device frame reflect the new selection at once, not on next render.
		renderLiveDeviceViewHeader(state.session ?? null, state.activeRuntimeEnvironment);
		renderAllTestOnBlocks(); // start dialogs read the same selection (DX Phase 3)
		// M3 (#14422): keep the sidebar highlight in sync with card selections.
		matrixSidebar?.setSelection?.(selection?.device ?? null, selection?.osVersion ?? null);
	},
	onClose: () => void refreshDevicePickerData(),
	onOpen: () => {
		void refreshDevicePickerData();
		// Re-sync the sidebar highlight to the current selection on every open.
		const current = activeTestEnvStore.get();
		if (current) matrixSidebar?.setSelection?.(current.device, current.osVersion);
	}
}) : null;

/* ── Device & Browser Matrix (M3 #14422): sidebar + stores inside the picker.
 * The M2 model layer builds the tree; this wires the renderer, the shared
 * search box, and selection sync with the legacy card list. */
const matrixFavorites = createFavoritesStore({});
const matrixRecents = createRecentsStore({});
/** Shared cache of the picker's environment data for column derivation. */
const matrixPickerData = { environments: [], boardByEnvId: new Map() };
const matrixSidebar = $('mx-sidebar') ? createMatrixSidebar({
	container: $('mx-sidebar'),
	favoritesStore: matrixFavorites,
	recentsStore: matrixRecents,
	onSelectDevice: (device, osVersion, env) => {
		// Route through the picker's own selection path so add-mode (chip
		// lists' [+ Add device]) and every onSelect side effect (drawer chip,
		// session snapshot, header repaint) behave EXACTLY as the card path.
		if (env) {
			if (devicePicker?.state) devicePicker.state.selectedDevice = device;
			devicePicker?.selectEnvironment?.(env);
		}
		// M4: device/OS selection drives the browser columns.
		renderMatrixColumns();
	}
}) : null;
// Shared search: the legacy card list filters via its own handler; the
// sidebar mirrors the same query.
if ($('dp-search')) $('dp-search').addEventListener('input', () => matrixSidebar?.setSearch?.($('dp-search').value));

/* ── Browser columns + top bar (M4 #14423) ────────────────────────────── */
const matrixColumns = $('mx-columns') ? createMatrixColumns({
	container: $('mx-columns'),
	emptyState: $('mx-columns-empty'),
	favoritesStore: matrixFavorites,
	recentsStore: matrixRecents,
	onSelectVersion: (env, column, row) => {
		// Same selection path as every other matrix surface: picker reselect
		// (add-mode honored) + recents write-through. R5 #14494: carry the
		// board's honest unavailability reason onto the selection so the live
		// view can name WHY the device is unavailable.
		env.unavailableReason = matrixPickerData.boardByEnvId?.get?.(env.envId)?.unavailableReason ?? null;
		if (devicePicker?.state) devicePicker.state.selectedDevice = env.device;
		devicePicker?.selectEnvironment?.(env);
		matrixRecents?.record?.(env);
	}
}) : null;

/** Derive + paint the browser columns for the sidebar's current selection. */
function renderMatrixColumns() {
	if (!matrixColumns || !matrixSidebar) return;
	const { device, osVersion } = matrixSidebar.getSelection();
	if (!device) {
		matrixColumns.setColumns([]);
		return;
	}
	const envs = matrixPickerData.environments ?? [];
	const columns = buildBrowserColumns(device, osVersion, envs, {
		favorites: matrixFavorites.list(),
		channelFor: channelForClient,
		boardByEnvId: matrixPickerData.boardByEnvId ?? new Map()
	});
	const current = activeTestEnvStore.get();
	matrixColumns.setColumns(columns, current?.envId ?? null);
}

// channelForClient (top-of-file import) mirrors the server ladder client-side
// (see browserChannels.js).

/* Top bar: target URL bound to the REAL run state — the QA launcher's URL
 * field is the canonical "next run target"; we prefill from the last session
 * target when present. Refresh reloads picker data + re-opens QA prefilled. */
if ($('mx-target-url')) {
	const urlInput = $('mx-target-url');
	urlInput.value = state.session?.targetUrl ?? '';
}
if ($('mx-refresh')) {
	$('mx-refresh').addEventListener('click', async () => {
		await refreshDevicePickerData();
		renderMatrixColumns();
		// Pre-open the QA launcher with the current target so Refresh is a
		// one-click "reload catalog + go run this URL".
		const url = $('mx-target-url')?.value?.trim();
		if (url) {
			const qa = $('qa-target-url');
			if (qa) qa.value = url;
		}
	});
}
// M5 (#14424): mobile collapse toggle for the sidebar (CSS-only visibility;
// the class flips on the shell, the button's aria state stays truthful).
if ($('mx-sidebar-toggle')) {
	const toggle = $('mx-sidebar-toggle');
	toggle.addEventListener('click', () => {
		const shell = toggle.closest('.mx-shell');
		if (!shell) return;
		const collapsed = shell.classList.toggle('mx-sidebar-collapsed');
		toggle.setAttribute('aria-expanded', String(!collapsed));
		toggle.textContent = collapsed ? '▸ Categories' : '▾ Categories';
	});
}

async function refreshDevicePickerData() {
	if (!devicePicker) return;
	devicePicker.setData({ environments: [], boardByEnvId: new Map(), dataState: 'loading' });
	matrixSidebar?.setData?.({ environments: [], boardByEnvId: new Map(), dataState: 'loading' });
	const environments = await api('/environments?active=true&limit=80000').then((p) => p.environments ?? []).catch(() => null);
	if (!Array.isArray(environments)) {
		// Catalog fetch failed: surface an honest error state, not empty data.
		devicePicker.setData({ environments: [], boardByEnvId: new Map(), dataState: 'error' });
		matrixSidebar?.setData?.({ environments: [], boardByEnvId: new Map(), dataState: 'error' });
		return;
	}
	let boardByEnvId = new Map();
	try {
		const board = await api('/device-runtime/devices').catch(() => null);
		for (const device of board?.devices ?? []) {
			// R1 #14490: board rows are flat per envId (one slot per environment).
			if (device?.envId) boardByEnvId.set(device.envId, {
				status: device.status,
				maximumLevel: device.maximumLevel ?? null,
				unavailableReason: device.unavailableReason ?? null
			});
		}
	} catch { /* board unavailable — badges fall back to neutral */ }
	devicePicker.setData({ environments, boardByEnvId, dataState: 'ready' });
	matrixSidebar?.setData?.({ environments, boardByEnvId, dataState: 'ready' });
	matrixPickerData.environments = environments;
	matrixPickerData.boardByEnvId = boardByEnvId;
	renderMatrixColumns();
}

// Hydrate the persisted selection once environments are known; data is
// refreshed again every time the picker opens (onClose).
void (async () => {
	if (!devicePicker) return;
	const environments = await api('/environments?active=true&limit=80000').then((p) => p.environments ?? []).catch(() => null);
	if (!Array.isArray(environments)) {
		// Boot fetch failed: keep the picker in its honest error state instead
		// of an empty catalog (which would read as "nothing configured").
		devicePicker.setData({ environments: [], boardByEnvId: new Map(), dataState: 'error' });
		return;
	}
	devicePicker.setData({ environments, boardByEnvId: new Map() });
	matrixSidebar?.setData?.({ environments, boardByEnvId: new Map(), dataState: 'ready' });
	const persisted = activeTestEnvStore.persistedEnvId();
	if (persisted) {
		const env = environments.find((e) => e.envId === persisted);
		if (env) devicePicker.hydrate(env);
		else activeTestEnvStore.clear();
	}
	// Mirror the hydrated selection into the sidebar (focus device + OS).
	const focus = resolvePickerFocus({ selection: activeTestEnvStore.get(), environments });
	matrixSidebar?.setSelection?.(focus.device, focus.osVersion);
	renderMatrixColumns();
	renderAllTestOnBlocks();
})();

/* ── Device Matrix drawer (Phase 10) ─────────────────────────────── */
const deviceDrawer = $('device-drawer') ? createDeviceDrawer({
	api, toast, fail,
	onRunEnvironment: (env) => startEnvironmentRun(env),
	onApplied: (created) => {
		if (created?.length && testCaseView) testCaseView.refresh?.();
	},
	onOpenPicker: () => devicePicker?.open?.(),
	elements: {
		drawer: $('device-drawer'),
		chip: $('device-chip'),
		chipChange: $('device-chip-change'),
		chipLabel: $('device-chip-env'),
		search: $('dd-search'),
		tabs: [...document.querySelectorAll('#device-drawer [data-dd-tab]')],
		sections: $('dd-sections'),
		detail: $('dd-detail'),
		detailBody: $('dd-detail-body'),
		selectionSummary: $('dd-selection-summary'),
		applyBtn: $('dd-apply'),
		clearSelection: $('dd-clear-selection'),
		savedList: $('dd-saved-list'),
		savedRefresh: $('dd-saved-refresh'),
		closeBtn: $('dd-close'),
		advancedToggle: $('dd-advanced-toggle'),
		advancedBody: $('dd-advanced-body')
	}
}) : null;

// Wire the live-view header's [Change] action (#14132).
// DX Phase 2 → #14132: the header [Change] opens THE picker (single selection
// surface). The CURRENT TEST DEVICE card is removed; device identity lives in
// the LIVE DEVICE VIEW header. Device details is reachable via Settings →
// Device Management.
(function wireDeviceChangeAction() {
	const change = document.getElementById('ldv-change-device');
	if (change) change.onclick = () => devicePicker?.open?.();
})();

// Paint the collapsed chip once environments are loaded (and refresh the
// saved list so Run/Set-default actions target real envIds).
// DX Phase 2: NO silent default device — if nothing was persisted, the chip
// stays empty and the header Change button invites the user to choose one.
void (async () => {
	if (!deviceDrawer) return;
	await deviceDrawer.refreshEnvironments();
	deviceDrawer.state.defaultEnvId = localStorage.getItem('qase.environmentId') ?? null;
	deviceDrawer.paintChip();
})();

cfg.testBtn.onclick = async () => {
	await probeModelEndpoint();
};

cfg.saveBtn.onclick = async () => {
	if (cfg.saveBtn.disabled) return;
	cfg.saveBtn.disabled = true;
	cfg.saveBtn.textContent = 'Saving…';
	try {
		const config = await api('/config', { method: 'PUT', body: JSON.stringify(readSettings()) });
		paintConfig(config);
		if (config.problem) {
			cfg.test.className = 'test-result bad';
			cfg.test.textContent = 'Preferences saved. Qase’s model service is not configured. Please contact your workspace administrator.';
			return;
		}
		cfg.dialog.close();
		toast(config.runsKeepingOldSettings > 0
			? `Saved. ${config.runsKeepingOldSettings} run(s) already going keep the old settings.`
			: 'Settings saved.', 'good');
	} catch (error) {
		cfg.test.className = 'test-result bad';
		cfg.test.textContent = error instanceof Error ? error.message : String(error);
	} finally {
		cfg.saveBtn.disabled = false;
		cfg.saveBtn.textContent = 'Save & return';
	}
};

/* ── Wiring ──────────────────────────────────────────────────────── */

el.composer.onsubmit = async event => {
	event.preventDefault();
	const text = el.composerInput.value.trim();
	if (!text) return;
	if (!state.sessionId) {
		await openQaStart();
		try {
			const normalized = normalizeWebsite(text);
			if (!normalized) throw new TypeError('A website URL is required');
			const target = new URL(normalized);
			if (!['http:', 'https:'].includes(target.protocol)) throw new TypeError('Unsupported target protocol');
			qaUi.targetUrl.value = target.href;
			syncQaSubmitState();
		} catch {
			setQaFormError('Choose the website first. You can send testing instructions after the run starts.');
		}
		return;
	}
	if (!ensureModelConfigured('Run message')) return;
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

// Collapse/expand the run summary. Pure UI: values already in state keep
// flowing to the mini row — nothing is refetched or recalculated.
el.runSummaryToggle?.addEventListener('click', () => {
	setRunSummaryCollapsed(!state.runSummaryCollapsed);
	renderMiniSummary();
});

el.composerInput.addEventListener('keydown', event => {
	if (event.key === 'Enter' && !event.shiftKey) {
		event.preventDefault();
		el.composer.requestSubmit();
	}
});

window.addEventListener('resize', fitStageFrame, { passive: true });

// The stage's own box changes without a window resize — pane-resizer drags,
// the plan/activity panel expanding when a run starts, tab switches, and the
// results/browser workspace view swap all reflow the grid rows. The window
// resize listener alone misses those, so a tall device frame kept its stale
// height and .stage{overflow:hidden} cropped its bottom edge. Re-fit on every
// real size change of the stage (and of the browser-chrome bar, which shifts
// the stage's top edge).
if (typeof ResizeObserver === 'function' && el.stage) {
	const refitStageFrame = () => fitStageFrame();
	const stageObserver = new ResizeObserver(refitStageFrame);
	stageObserver.observe(el.stage);
	const chromeBar = document.getElementById('browser-chrome');
	if (chromeBar) stageObserver.observe(chromeBar);
	// ResizeObserver callbacks are batched per frame; no further throttling needed.
}

el.stageToggle.onclick = toggleStageCollapse;
el.stage.addEventListener('click', event => {
	if (el.viewer.classList.contains('stage-collapsed') && stageHasContent()) {
		event.preventDefault();
		toggleStageCollapse();
	}
});
el.stage.addEventListener('keydown', event => {
	if (!el.viewer.classList.contains('stage-collapsed') || !stageHasContent() || (event.key !== 'Enter' && event.key !== ' ')) return;
	event.preventDefault();
	toggleStageCollapse();
});

$('empty-start')?.addEventListener('click', () => { void startRun(); });
$('empty-demo')?.addEventListener('click', openQaStartWithDemo);
el.progressFindings?.addEventListener('click', () => {
	activateDetailTab($('tab-findings'), true);
	if (state.session?.status === 'done' && pageRouter.started) void pageRouter.navigate({ name: 'results', runId: state.sessionId });
	else if (matchMedia('(max-width: 720px)').matches) setWorkspaceView('results');
	el.viewer.scrollIntoView({ block: 'nearest' });
});

el.newRun.onclick = openQaStart;
$('sidebar-new-run').onclick = openQaStart;
$('results-page-back')?.addEventListener('click', () => {
	if (state.sessionId) void pageRouter.navigate({ name: 'run', runId: state.sessionId });
});
$('results-page-all')?.addEventListener('click', () => { void pageRouter.navigate({ name: 'runs' }); });
$('results-page-new')?.addEventListener('click', openQaStart);
$('results-page-export')?.addEventListener('click', async event => {
	const button = event.currentTarget;
	if (button.disabled) return;
	button.disabled = true;
	try { await downloadReportPdf('qase-report.pdf'); }
	catch (error) { exportError(error, 'The PDF export failed.'); }
	finally { button.disabled = false; }
});
el.newSqa.onclick = openSqaStart;
el.newFounder.onclick = openFounderStart;
el.stopRun.onclick = async () => {
	const runId = state.sessionId;
	if (!runId || state.stopRequests.has(runId)) return;
	state.stopRequests.add(runId);
	setStatus(state.session.status);
	try {
		await api(`/sessions/${runId}/stop`, { method: 'POST' });
		// Reconcile with the saved state; acknowledgement alone does not mean stopped.
		const snapshot = await api(`/sessions/${runId}`);
		if (state.sessionId === runId) applySessionSnapshot(snapshot);
	} catch (error) {
		toast(`Could not stop this run. Try Stop again. ${error.message ?? ''}`, 'bad');
	} finally {
		state.stopRequests.delete(runId);
		if (state.sessionId === runId) setStatus(state.session.status);
	}
};
el.resumeRun.onclick = async () => {
	el.resumeRun.disabled = true;
	try {
		await api(`/sessions/${state.sessionId}/message`, {
			method: 'POST',
			body: JSON.stringify({ text: 'continue' })
		});
	} catch (error) {
		fail(error);
	} finally {
		el.resumeRun.disabled = false;
	}
};

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
	/* Escape closes the topmost open dialog (UI Fix Phase 4). Native <dialog>
	 * cancels on Escape already; this is a safety net for dialogs whose close
	 * is JS-driven (form method=dialog submit interception etc.). */
	if (event.key === 'Escape') {
		const top = [...document.querySelectorAll('dialog[open]')].pop();
		if (top && !top.matches(':modal')) top.close();
	}
});

const detailTabs = [...document.querySelectorAll('#tabs .tab')];

function setWorkspaceView(view) {
	if (!['runs', 'agent', 'browser', 'results'].includes(view)) view = 'agent';
	const nav = document.querySelector('.workspace-mobile-nav');
	const focusedPanel = document.activeElement?.closest('.panel');
	document.body.dataset.workspaceView = view;
	if (view === 'browser' && state.sessionId && matchMedia('(max-width: 720px)').matches) {
		state.stageCollapsePreferences.set(state.sessionId, false);
		renderStageCollapse();
	}
	for (const button of nav.querySelectorAll('button')) {
		button.setAttribute('aria-pressed', String(button.dataset.workspaceView === view));
	}
	if (matchMedia('(max-width: 720px)').matches && focusedPanel && getComputedStyle(focusedPanel).display === 'none') {
		nav.querySelector(`[data-workspace-view="${view}"]`).focus({ preventScroll: true });
	}
	requestAnimationFrame(fitStageFrame);
}

setWorkspaceView('agent');
for (const button of document.querySelectorAll('.workspace-mobile-nav button')) {
	button.addEventListener('click', () => setWorkspaceView(button.dataset.workspaceView));
}

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
	void loadEnvironments();

	const runs = await apiWithTimeout('/sessions', 15000).catch(() => []);
	const launchParameters = new URLSearchParams(window.location.search);
	const requestedRunId = launchParameters.get('run');
	let initialRoute = pageRouter.current();
	let selectedInitialRun = false;
	if (requestedRunId && RUN_ID_PATTERN.test(requestedRunId)) {
		try {
			const runId = requestedRunId.toLowerCase();
			await selectSession(runId, { updateRoute: false });
			selectedInitialRun = true;
			initialRoute = { name: 'run', runId };
			launchParameters.delete('run');
			const query = launchParameters.toString();
			window.history.replaceState({ qaseRoute: true, qasePushed: false }, '', `${window.location.pathname}${query ? `?${query}` : ''}${routeHash(initialRoute)}`);
		} catch {
			// A stale or cross-project launch handle cannot select a run. Fall back
			// to the user's own latest visible run without leaking whether it exists.
			launchParameters.delete('run');
			const query = launchParameters.toString();
			window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
		}
	}
	if (!selectedInitialRun && (initialRoute.name === 'run' || initialRoute.name === 'results')) {
		try {
			await selectSessionWithTimeout(initialRoute.runId, { updateRoute: false }, 20000);
			selectedInitialRun = true;
		} catch {
			initialRoute = { name: 'runs' };
			await pageRouter.navigate(initialRoute, { replace: true, applyRoute: false });
		}
	}
	if (!selectedInitialRun) {
		const remembered = localStorage.getItem('qase.session');
		const target = runs.find(run => run.id === remembered) ?? runs[0];
		if (target) {
			try {
				// #16228: an unreachable or corrupted remembered run must never kill
				// boot after the auth gate is hidden — that leaves a permanently
				// blank page with no way forward. Fall back to the runs list, the
				// same contract the URL-route paths above already honor.
				await selectSessionWithTimeout(target.id, { updateRoute: false }, 20000);
			} catch {
				localStorage.removeItem('qase.session');
				state.sessionId = undefined;
				// Honest notice, not silence: the workspace opens usable either way.
				setPageRouteNotice('Your last run could not be opened. Pick a run from the list or start a new test.');
				if (initialRoute.name === 'runs') {
					initialRoute = { name: 'runs' };
					await pageRouter.navigate(initialRoute, { replace: true, applyRoute: false });
				}
			}
			if (initialRoute.name === 'runs') {
				initialRoute = { name: state.session?.status === 'done' ? 'results' : 'run', runId: target.id };
				await pageRouter.navigate(initialRoute, { replace: true, applyRoute: false });
			}
		} else {
			// Fresh account: prepare the empty workspace without forcing a dialog on
			// direct links such as Account or Bugs.
			el.transcript.append(el.chatEmpty);
			el.chatEmpty.hidden = false;
			renderRunsEmptyState();
			if (initialRoute.name === 'runs') {
				initialRoute = { name: 'new-run' };
				await pageRouter.navigate(initialRoute, { replace: true, applyRoute: false });
			}
		}
	}
	await pageRouter.start();
	startRenderWatchdog();
	void refreshBugs();
	if (pageRouter.current().name === 'runs') el.composerInput.focus();
}

/**
 * #16228 permanent safety net: if the workspace finishes booting but the
 * running UI is inert (auth gate hidden, app not interactive, no pointer
 * events landing on workspace chrome), surface a recovery banner instead of
 * a silent blank page. Paint failures (GPU layer loss, corrupted layout
 * state) must never leave the user with no way forward.
 */
function startRenderWatchdog() {
	window.setTimeout(() => {
		try {
			const gate = el.authGate;
			const app = document.querySelector('.app');
			if (!gate || gate.hidden !== true || !app) return;
			// Full-page destinations intentionally hide the workspace panels.
			// Probe the current destination (or a legitimate open modal), and
			// accept compact sidebar rails rather than requiring >100px.
			if (renderProbeIds(document.body.dataset.page).some(id => hasInteractiveSurface($(id)))) return;
			if ([...document.querySelectorAll('dialog[open]')].some(hasInteractiveSurface)) return;
			const banner = document.createElement('div');
			banner.id = 'render-watchdog-banner';
			banner.setAttribute('role', 'alert');
			banner.style.cssText = 'position:fixed;inset:auto 0 0 0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;padding:12px 16px;background:#1c1c22;color:#f2f2f4;font:14px/1.4 system-ui,sans-serif;border-top:1px solid #3a3a44;flex-wrap:wrap';
			const text = document.createElement('span');
			text.textContent = 'The workspace did not render correctly.';
			const reload = document.createElement('button');
			reload.type = 'button';
			reload.textContent = 'Reload page';
			reload.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid #565666;background:#4b4bf4;color:#fff;cursor:pointer';
			reload.onclick = () => {
				sessionStorage.removeItem('qase.ui.reload');
				window.location.reload();
			};
			const runsLink = document.createElement('button');
			runsLink.type = 'button';
			runsLink.textContent = 'Go to runs list';
			runsLink.style.cssText = 'padding:6px 14px;border-radius:8px;border:1px solid #565666;background:transparent;color:#f2f2f4;cursor:pointer';
			runsLink.onclick = () => { banner.remove(); void pageRouter.navigate({ name: 'runs' }); };
			banner.append(text, reload, runsLink);
			document.body.append(banner);
			console.error('[qase] render watchdog: workspace booted but its primary view is not interactive/painted.',
				{ page: document.body.dataset.page, route: pageRouter.current()?.name });
		} catch { /* the watchdog itself must never throw */ }
	}, 10_000);
}

(async function boot() {
	await window.qaseEntryReady;
	// Password-reset deep link: /#reset-password?token=... opens the reset
	// card directly (arriving from an email link while signed out).
	function routeResetHash() {
		if (!window.location.hash.startsWith('#reset-password')) return false;
		showAuthCard('reset');
		el.resetPassword?.focus();
		return true;
	}
	if (routeResetHash()) return;
	window.addEventListener('hashchange', routeResetHash);
	// Test Execution Timer: one shared second-hand for every live timer view.
	startTimerInterval();
	el.feedbackForm?.addEventListener('submit', submitFeedback);
	el.feedbackClose?.addEventListener('click', closeFeedbackModal);
	el.feedbackCancel?.addEventListener('click', cancelEditFeedback);
	// Esc on a <dialog> fires `cancel` — keep the in-flight guard there too.
	el.feedbackModal?.addEventListener('cancel', event => {
		if (state.feedback.submitting) event.preventDefault();
	});
	el.feedbackEdit?.addEventListener('click', startEditFeedback);
	el.feedbackComments?.addEventListener('input', updateFeedbackSubmitEnabled);
	el.feedbackCategory?.addEventListener('change', updateFeedbackSubmitEnabled);
	try {
		const pilot = await api('/pilot-status').catch(() => undefined);
		if (pilot?.pilot) {
			state.pilotMode = true;
			renderPilotBanner();
		}
	} catch { /* pilot status is decorative */ }
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

/** One-time honest beta notice for pilot instances. */
function renderPilotBanner() {
	if (localStorage.getItem('qase.pilot-banner.dismissed') === '1') return;
	const banner = document.createElement('div');
	banner.className = 'pilot-banner';
	banner.setAttribute('role', 'note');
	const text = document.createElement('span');
	text.textContent = 'Qase pilot — you are testing a beta build. Runs may be slower and reports may contain errors. Your thumbs feedback goes straight to the team.';
	const dismiss = document.createElement('button');
	dismiss.type = 'button';
	dismiss.className = 'btn btn-ghost';
	dismiss.textContent = 'Got it';
	dismiss.onclick = () => {
		localStorage.setItem('qase.pilot-banner.dismissed', '1');
		banner.remove();
	};
	banner.append(text, dismiss);
	const app = document.querySelector('.app');
	app?.prepend(banner);
}

$('auth-show-password').onchange = event => { el.authPassword.type = event.target.checked ? 'text' : 'password'; };
const profileDialog = $('profile-dialog');
$('profile-close').onclick = () => pageRouter.leave({ name: 'runs' });
profileDialog.addEventListener('cancel', event => {
  event.preventDefault();
  pageRouter.leave({ name: 'runs' });
});
profileDialog.addEventListener('close', () => { $('password-form').reset(); });
async function refreshMemory() {
  const entries = await api('/memory');
  $('profile-memory').replaceChildren();
	  if (!entries.length) {
	    const empty = document.createElement('li');
	    empty.className = 'is-empty';
	    empty.textContent = 'No saved memory yet.';
	    $('profile-memory').append(empty);
	  }
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
async function showAccountPage() {
  const user = await api('/profile');
  $('profile-name').value = user.displayName; $('profile-timezone').value = user.profile.timezone; $('profile-email').textContent = user.email;
  $('recovery-codes-result').hidden = true; // codes are shown once per generation, never re-shown
  profileDialog.showModal(); await refreshMemory(); await refreshRecoveryStatus();
}
$('profile-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  state.user = await api('/profile', { method:'PUT', body:JSON.stringify({displayName:$('profile-name').value,profile:{timezone:$('profile-timezone').value}}) });
  $('profile-message').textContent = 'Profile saved.';
}); };
$('password-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  await api('/auth/password', { method:'POST', body:JSON.stringify({currentPassword:$('current-password').value,password:$('new-password').value}) });
  state.stream?.close(); window.location.reload();
}); };
// Recovery codes (#15727): generated only after confirming the current
// password; shown exactly once with copy/download. The plaintext codes exist
// only in this one response — never retrievable again from the server.
async function refreshRecoveryStatus() {
  try {
    const status = await api('/auth/recovery-codes');
    $('recovery-status').textContent = status?.unused > 0
      ? `${status.unused} unused recovery code${status.unused === 1 ? '' : 's'} remaining (of ${status.total} generated).`
      : 'No unused recovery codes. Generate a set to be able to regain access without email.';
  } catch { $('recovery-status').textContent = 'Recovery codes are not available on this instance.'; }
}
$('recovery-generate-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  const generated = await api('/auth/recovery-codes', { method:'POST', body:JSON.stringify({currentPassword:$('recovery-current-password').value}) });
  $('recovery-current-password').value = '';
  const list = $('recovery-codes-list'); list.replaceChildren();
  for (const code of generated.codes) {
    const item = document.createElement('li'); item.textContent = code; list.append(item);
  }
  // Keep the codes ONLY in the DOM + the download payload — dropping them
  // from module state so they can't leak into other handlers or telemetry.
  $('recovery-codes-result').dataset.generated = generated.generatedAt ?? '';
  const copy = $('recovery-copy'), download = $('recovery-download');
  copy.onclick = async () => { try { await navigator.clipboard.writeText(generated.codes.join('\n')); copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy all'; }, 1600); } catch { copy.textContent = 'Copy failed'; } };
  download.onclick = () => {
    const user = state.user?.email ?? 'account';
    const text = `Qase recovery codes\nAccount: ${user}\nGenerated: ${new Date(generated.generatedAt ?? Date.now()).toLocaleString()}\n\n${generated.codes.join('\n')}\n\nEach code works once to reset your password. Regenerating invalidates all previous codes. Store this file somewhere safe.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a'); link.href = url; link.download = 'qase-recovery-codes.txt'; link.click();
    URL.revokeObjectURL(url);
  };
  $('recovery-codes-result').hidden = false;
  await refreshRecoveryStatus();
  $('profile-message').textContent = 'Recovery codes generated. Save them now — they will not be shown again.';
}); };
$('memory-form').onsubmit = event => { event.preventDefault(); accountAction(event.submitter, async () => {
  await api('/memory', { method:'PUT', body:JSON.stringify({key:$('memory-key').value,value:$('memory-value').value}) });
  $('memory-form').reset(); await refreshMemory(); $('profile-message').textContent = 'Memory saved.';
}); };

/* Wire the picker host into the chip lists (DX Phase 4). Runs at the very end
 * of module evaluation, after devicePicker and runTargetDevices exist — the
 * earlier placement hit a temporal-dead-zone ReferenceError. */
if (devicePicker) {
	testCaseView?.deviceList?.setPickerHost?.(devicePicker);
	bulkRunView?.deviceList?.setPickerHost?.(devicePicker);
	runTargetDevices?.setPickerHost?.(devicePicker);
}
