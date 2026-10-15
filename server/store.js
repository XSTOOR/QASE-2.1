import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeFounderState } from './founderService.js';
import { normalizePendingSqaState } from './sqaService.js';
import { DEFAULT_DEVICE_ID, isDeviceId } from './deviceProfiles.js';
import { isEngineId } from './browserEngines.js';
import { DEFAULT_ACTOR_USER_ID } from './tenancy.js';
import { clearSecrets, secretNames } from './secrets.js';
import { normalizeQaScopeSelection } from '../public/qaScopeCatalog.js';

/**
 * In-memory session store with a JSON mirror on disk.
 *
 * A session owns everything the dashboard renders: the transcript, the activity
 * feed, findings, the test plan and the final report. Live state that cannot be
 * serialised — the agent runtime, the browser bridge, the abort controller — is
 * kept on a parallel `runtime` record that never reaches disk.
 */

// Resolved lazily from the working directory at call time: tests (and embedded
// deployments) chdir into an isolated scratch directory AFTER this module was
// first imported, and the frozen-at-import constant made them read/write the
// ambient workspace's .qase state instead of their own.
function statePaths() {
	const stateDir = path.join(process.cwd(), '.qase');
	return { stateDir, stateFile: path.join(stateDir, 'sessions.json') };
}

/** Project-level Founder Mode state (Phase 3): one file per instance,
 *  matching the trusted single-tenant project context of local mode.
 *  Resolved lazily alongside statePaths() for the same chdir reasons. */
function founderProjectStatePaths() {
	const { stateDir } = statePaths();
	return { founderProjectStateFile: path.join(stateDir, 'founder-project-state.json') };
}

/** Live, non-serialisable per-session handles, keyed by session id. */
const live = new Map();

const sessions = new Map();
export const bus = new EventEmitter();
bus.setMaxListeners(0);
// EventEmitters route strictly by event name; the run bus uses session ids.
// Hook emit so a global subscriber (the keepalive) can observe every session.
const globalListeners = new Set();
const originalEmit = bus.emit.bind(bus);
bus.emit = (sessionId, event) => {
	for (const listener of globalListeners) {
		try { listener(sessionId, event); } catch { /* observer errors must not break the bus */ }
	}
	return originalEmit(sessionId, event);
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRYTIS_INTEGRATION_BYTES = 1_000_000;

/** Lifecycle of a tracked bug (finding). Every finding starts `open`. */
export const FINDING_STATUSES = ['open', 'in_progress', 'fixed', 'wont_fix'];
export const FINDING_STATUS_DEFAULT = 'open';
export const FINDING_NOTE_MAX = 500;

export function isFindingStatus(value) {
	return FINDING_STATUSES.includes(value);
}

/** Severity display order used by the bug table (most severe first). */
export const FINDING_SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/**
 * Returns a copy of the finding with the tracking fields defaulted: every
 * legacy finding (filed before statuses existed) reads back as `open` with a
 * status timestamp equal to its filing time. Never mutates the input.
 */
export function normalizeFindingStatus(finding) {
	if (!finding || typeof finding !== 'object') return finding;
	const status = isFindingStatus(finding.status) ? finding.status : FINDING_STATUS_DEFAULT;
	const note = typeof finding.statusNote === 'string' ? finding.statusNote.slice(0, FINDING_NOTE_MAX) : '';
	return {
		...finding,
		status,
		statusTs: Number.isFinite(finding.statusTs) ? finding.statusTs : (finding.ts ?? Date.now()),
		statusNote: note
	};
}

let saveTimer;

function persistNow() {
	let tmp;
	const { stateDir, stateFile } = statePaths();
	try {
		fs.mkdirSync(stateDir, { recursive: true });
		// Atomic-write pattern: write to a temp file then rename, so a crash
		// mid-write can never leave a truncated sessions.json behind. Include a
		// nonce because a killed/corrupted process can leave its old PID path as
		// a directory; PID reuse must never disable all future persistence.
		tmp = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(tmp, JSON.stringify([...sessions.values()], undefined, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, stateFile);
	} catch (error) {
		if (tmp) {
			try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
		}
		// A dashboard that cannot write its history is still a usable dashboard,
		// but surface it loudly so the operator notices data loss risk.
		console.error(`[qase-store] failed to persist sessions: ${error?.code ?? error?.message ?? 'unknown'}`);
	}
}

function persistSoon() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(persistNow, 250);
	saveTimer.unref?.();
}

export { persistSoon };

/** Flushes pending local history before the process exits. */
export function flushSessions() {
	clearTimeout(saveTimer);
	saveTimer = undefined;
	persistNow();
}

export function loadSessions() {
	const { stateFile } = statePaths();
	// Founder project-level state loads lazily via the founderProjectState
	// accessors below; sessions first.
	try {
		const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
		for (const session of Array.isArray(raw) ? raw : []) {
			session.mode = session.mode === 'sqa' || session.mode === 'founder' ? session.mode : 'qa';
			if (session.mode === 'qa') {
				delete session.sqa;
				delete session.founder;
			} else if (session.mode === 'sqa') {
				delete session.founder;
				session.sqa = normalizePendingSqaState(session.sqa);
			} else {
				delete session.sqa;
				session.founder = normalizeFounderState(session.founder);
			}
				session.device = isDeviceId(session.device) ? session.device : DEFAULT_DEVICE_ID;
				session.deviceLandscape = session.deviceLandscape === true;
				session.ownerUserId = typeof session.ownerUserId === 'string' ? session.ownerUserId : DEFAULT_ACTOR_USER_ID;
			// A running browser/model turn cannot survive a restart and is resumed
			// from its snapshot. A run waiting for a human answer is already at a
			// durable boundary: preserve that status and question so the dashboard
			// does not turn a legitimate approval wait into an interruption.
			const wasRunning = session.status === 'running';
			const wasWaiting = session.status === 'awaiting_input';
			if (wasRunning || wasWaiting) {
				session.interruptedFromRun = wasRunning;
				if (wasRunning) {
					session.status = 'interrupted';
					session.pendingQuestion = undefined;
				}
				// A tool executing when the process died can never return; leave it
				// marked "running" and it vetoes report publication forever.
				for (const activity of Array.isArray(session.activities) ? session.activities : []) {
					if (activity && activity.status === 'running') {
						activity.status = 'failed';
						activity.error = 'Interrupted by a server restart before this tool returned.';
					}
				}
			}
			// Rehydrate names only for resumable/waiting work. A crash between final
			// status persistence and vault cleanup is reconciled here on next boot.
			if (['done', 'error', 'idle'].includes(session.status)) {
				clearSecrets(session.id);
				session.secretNames = [];
			} else {
				session.secretNames = secretNames(session.id);
			}
			if (typeof session.autoResumeCount !== 'number' || session.autoResumeCount < 0) {
				session.autoResumeCount = 0;
			}
			// Earlier versions stored reasoning as a message; it is live-only now.
			session.messages = (session.messages ?? []).filter(message => message.role !== 'thinking');
			// Findings filed before lifecycle tracking existed read back as open.
			if (Array.isArray(session.findings)) {
				session.findings = session.findings.map(normalizeFindingStatus);
			}
			sessions.set(session.id, session);
		}
	} catch {
		// No history yet.
	}
}

export function createSession(title = 'New test run', options = {}) {
	if (!options || typeof options !== 'object' || Array.isArray(options)) {
		throw new TypeError('Run creation options must be an object.');
	}
	const id = options.id ?? randomUUID();
	if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
		throw new TypeError('Run ID must be a canonical UUID.');
	}
	if (sessions.has(id)) {
		const error = new Error(`Run ${id} already exists.`);
		error.code = 'QASE_RUN_ID_CONFLICT';
		throw error;
	}
	if (options.mode !== undefined && options.mode !== 'qa') {
		throw new TypeError('The run creation adapter currently accepts only QA mode initialization.');
	}
	if (options.device !== undefined && !isDeviceId(options.device)) {
		throw new TypeError('Run creation received an unknown device profile.');
	}
	if (options.deviceLandscape !== undefined && typeof options.deviceLandscape !== 'boolean') {
		throw new TypeError('Run creation received an invalid landscape flag.');
	}
	if (options.engine !== undefined && !isEngineId(options.engine)) {
		throw new TypeError('Run creation received an unknown browser engine.');
	}
	if (options.environmentId !== undefined && typeof options.environmentId !== 'string') {
		throw new TypeError('Run creation received an invalid environment id.');
	}
	if (options.environmentSnapshot !== undefined
		&& (!options.environmentSnapshot || typeof options.environmentSnapshot !== 'object' || Array.isArray(options.environmentSnapshot))) {
		throw new TypeError('Run creation received an invalid environment snapshot.');
	}
	// #14633 (NI02 Phase 1): matrix-run linkage — set when this session was
	// spawned by the matrix orchestrator so the run can be traced back.
	if (options.matrixRunId !== undefined && typeof options.matrixRunId !== 'string') {
		throw new TypeError('Run creation received an invalid matrix run id.');
	}
	if (options.testCaseId !== undefined && typeof options.testCaseId !== 'string') {
		throw new TypeError('Run creation received an invalid test case id.');
	}
	if (options.testCaseSnapshot !== undefined
		&& (!options.testCaseSnapshot || typeof options.testCaseSnapshot !== 'object' || Array.isArray(options.testCaseSnapshot))) {
		throw new TypeError('Run creation received an invalid test case snapshot.');
	}
	if (options.engine !== undefined && !isEngineId(options.engine)) {
		throw new TypeError('Run creation received an unknown browser engine.');
	}
	if (options.drytisIntegration !== undefined) {
		if (!options.drytisIntegration || typeof options.drytisIntegration !== 'object'
			|| Array.isArray(options.drytisIntegration)
			|| Buffer.byteLength(JSON.stringify(options.drytisIntegration), 'utf8') >= MAX_DRYTIS_INTEGRATION_BYTES) {
			throw new TypeError('Drytis integration state must be a bounded JSON object.');
		}
	}
	if (options.findings !== undefined && !Array.isArray(options.findings)) {
		throw new TypeError('Initial run findings must be an array.');
	}
	// Standard-QA test selection: validated at the API boundary
	// (appQaSelection.js). undefined = full coverage (legacy behavior).
	if (options.selectedTests !== undefined) {
		if (!Array.isArray(options.selectedTests)
			|| options.selectedTests.length === 0
			|| options.selectedTests.some(id => typeof id !== 'string')) {
			throw new TypeError('Run test selection must be a non-empty array of test ids.');
		}
	}
	// Security testing authorization: required whenever the selection includes
	// a security-category check (enforced at the API boundary).
	if (options.securityAuthorization !== undefined) {
		const auth = options.securityAuthorization;
		if (typeof auth !== 'object' || Array.isArray(auth)
			|| typeof auth.confirmed !== 'boolean'
			|| (auth.notes !== undefined && typeof auth.notes !== 'string')) {
			throw new TypeError('Security authorization must be { confirmed: boolean, notes?: string }.');
		}
	}
	// Coverage scope selection (Supported Coverage panel): normalized via the
	// shared qaScopeCatalog; undefined = full coverage (legacy behavior).
	if (options.scopeSelection !== undefined) {
		const normalized = normalizeQaScopeSelection(options.scopeSelection);
		if (normalized === undefined) {
			throw new TypeError('Run creation received an invalid scope selection.');
		}
	}
	const timestamp = Date.now();
	const session = {
		id,
		title,
		createdAt: timestamp,
		updatedAt: timestamp,
		status: 'idle',
		mode: 'qa',
		targetUrl: options.targetUrl,
		device: isDeviceId(options.device) ? options.device : DEFAULT_DEVICE_ID,
		deviceLandscape: options.deviceLandscape === true,
		engine: isEngineId(options.engine) ? options.engine : 'chromium',
		/** Analytics cohort ('pilot' for invite-admitted users) — read by the
		 *  run_started/run_finished status hook, which has no request context. */
		cohort: options.cohort === 'pilot' ? 'pilot' : undefined,
		/** Apple compatibility environment this run executes in (frozen snapshot). */
		environmentId: options.environmentId,
		environmentSnapshot: options.environmentSnapshot ? structuredClone(options.environmentSnapshot) : undefined,
		/** #14633 (NI02 Phase 1): matrix run that spawned this session, if any. */
		matrixRunId: options.matrixRunId,
		/** Test case this run executes (Phase 4; frozen snapshot). */
		testCaseId: options.testCaseId,
		testCaseSnapshot: options.testCaseSnapshot ? structuredClone(options.testCaseSnapshot) : undefined,
		engine: isEngineId(options.engine) ? options.engine : 'chromium',
		/** Analytics cohort ('pilot' for invite-admitted users) — read by the
		 *  run_started/run_finished status hook, which has no request context. */
		cohort: options.cohort === 'pilot' ? 'pilot' : undefined,
		/** Coverage values selected in the New QA Run dialog (whitelisted). */
		scopeSelection: normalizeQaScopeSelection(options.scopeSelection) ?? undefined,
		messages: [],
		activities: [],
		findings: (options.findings ?? []).map(normalizeFindingStatus),
		todos: [],
		report: undefined,
		pendingQuestion: undefined,
		/** Selected standard QA test ids; undefined = full coverage. */
		selectedTests: options.selectedTests ? [...options.selectedTests] : undefined,
		/** Security testing authorization for runs with security checks. */
		securityAuthorization: options.securityAuthorization
			? structuredClone(options.securityAuthorization)
			: undefined,
		contextUsage: undefined,
		/** Token usage recorded after each run: provider-reported or estimated. */
		tokenUsage: undefined,
		/** Phase 20: honest execution level actually used (SIMULATED/VIRTUAL_DEVICE/REAL_DEVICE), observed runtime facts. */
		executionLevel: options.executionLevel,
		executionProviderActual: options.executionProviderActual,
		runtimeFacts: options.runtimeFacts ? structuredClone(options.runtimeFacts) : undefined,
		/** Names of secrets held for this session — never the values. */
		secretNames: []
	};
	session.ownerUserId = options.ownerUserId ?? DEFAULT_ACTOR_USER_ID;
	if (options.drytisIntegration !== undefined) {
		session.drytisIntegration = structuredClone(options.drytisIntegration);
	}
	sessions.set(session.id, session);
	persistSoon();
	return session;
}

export function getSession(id, ownerUserId) {
	const session = sessions.get(id);
	return !ownerUserId || session?.ownerUserId === ownerUserId ? session : undefined;
}

export function listSessions({ limit = 100, ownerUserId, unbounded = false } = {}) {
	// Unbounded mode for coverage aggregation (listAll) — every full record,
	// no cap and no owner filter; the capped list() stays request-scoped.
	if (unbounded) {
		return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}
	const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
	return [...sessions.values()]
		.filter(session => !ownerUserId || session.ownerUserId === ownerUserId)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, bounded)
		.map(session => ({
			id: session.id,
			title: session.title,
			status: session.status,
			mode: session.mode === 'sqa' || session.mode === 'founder' ? session.mode : 'qa',
			targetUrl: session.targetUrl,
			device: isDeviceId(session.device) ? session.device : DEFAULT_DEVICE_ID,
			deviceLandscape: session.deviceLandscape === true,
			engine: isEngineId(session.engine) ? session.engine : 'chromium',
			// Test-case join key (Phase 11 bulk flows): last-run aggregation
			// and per-environment records map runs to cases without full loads.
			testCaseId: session.testCaseId ?? undefined,
			engine: isEngineId(session.engine) ? session.engine : 'chromium',
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			// Needed by boot-time recovery (runResume), which runs without a
			// request actor and must see runs owned by any user.
			ownerUserId: session.ownerUserId,
			startedAt: session.startedAt,
			completedAt: session.completedAt,
			pausedAt: session.pausedAt,
			pausedSeconds: session.pausedSeconds ?? 0,
			durationSeconds: activeDurationSeconds(session),
			findingCount: session.findings.length,
			messageCount: session.messages.length,
			...(session.report?.verdict ? { reportVerdict: session.report.verdict } : {}),
			// Plan progress for the sidebar card — derived, never stored.
			todoTotal: Array.isArray(session.todos) ? session.todos.length : 0,
			todoCompleted: Array.isArray(session.todos)
				? session.todos.filter(todo => todo?.status === 'completed').length
				: 0,
			tokenUsage: session.tokenUsage,
			executionLevel: session.executionLevel,
			executionProviderActual: session.executionProviderActual,
			// Environment join keys (Phase 23): let the UI map runs to devices
			// without loading each full session.
			environmentId: session.environmentId ?? session.environmentSnapshot?.envId ?? undefined,
			environmentSnapshot: session.environmentSnapshot
				? { envId: session.environmentSnapshot.envId, device: session.environmentSnapshot.device }
				: undefined
		}));
}

/**
 * All sessions, unscoped and capped only by memory — full records. Used by
 * coverage aggregation (Phase 7), which needs every case×environment pair's
 * latest run; request-scoped list() caps at 100 and filters by owner.
 */
export function allSessions() {
	return [...sessions.values()];
}

export function deleteSession(id, ownerUserId) {
	const session = sessions.get(id);
	if (!session || (ownerUserId && session.ownerUserId !== ownerUserId)) return false;
	const record = live.get(id);
	record?.controller?.abort();
	record?.dispose?.();
	live.delete(id);
	const existed = sessions.delete(id);
	persistSoon();
	return existed;
}

/**
 * Updates one finding's tracking lifecycle in place. Validates the status
 * enum and note length, stamps statusTs at the transition, and persists via
 * the caller's commit (so the change also broadcasts on the run bus).
 * An empty note string clears an existing note.
 */
export function setFindingStatus(session, findingId, { status, note } = {}) {
	const finding = (session.findings ?? []).find(candidate => candidate.id === findingId);
	if (!finding) {
		const error = new Error(`Finding ${findingId} does not exist on run ${session.id}.`);
		error.code = 'QASE_FINDING_NOT_FOUND';
		throw error;
	}
	if (!isFindingStatus(status)) {
		const error = new TypeError(`Finding status must be one of: ${FINDING_STATUSES.join(', ')}.`);
		error.code = 'QASE_FINDING_STATUS_INVALID';
		throw error;
	}
	let trimmedNote;
	if (note !== undefined && note !== null) {
		if (typeof note !== 'string') {
			const error = new TypeError('Finding status note must be a string.');
			error.code = 'QASE_FINDING_STATUS_INVALID';
			throw error;
		}
		trimmedNote = note.trim();
		if (trimmedNote.length > FINDING_NOTE_MAX) {
			const error = new RangeError(`Finding status note must be at most ${FINDING_NOTE_MAX} characters.`);
			error.code = 'QASE_FINDING_STATUS_INVALID';
			throw error;
		}
	} else {
		trimmedNote = finding.statusNote ?? '';
	}
	finding.status = status;
	finding.statusTs = Date.now();
	finding.statusNote = trimmedNote;
	return finding;
}

/**
 * Cross-run bug backlog for the standalone Bugs view. Aggregates every QA
 * finding across the owner's runs (SQA/Founder findings are assessments, not
 * tracked bugs), filtered by status/severity/run/free-text search, ordered
 * severity-major then newest first.
 */
export function aggregateFindings({ ownerUserId, status, severity, runId, search, limit } = {}) {
	return aggregateSessionFindings(sessions.values(), { ownerUserId, status, severity, runId, search, limit });
}

/**
 * Store-agnostic bug backlog aggregation: takes any iterable of run sessions
 * and returns the filtered, severity-ordered finding rows. Shared by the local
 * JSON store and the PostgreSQL in-memory aggregate view.
 */
export function aggregateSessionFindings(sessionIterable, { ownerUserId, status, severity, runId, search, limit } = {}) {
	if (status !== undefined && !isFindingStatus(status)) {
		const error = new TypeError('Invalid finding status filter.');
		error.code = 'QASE_FINDING_STATUS_INVALID';
		throw error;
	}
	if (severity !== undefined && !FINDING_SEVERITY_ORDER.includes(severity)) {
		const error = new TypeError('Invalid finding severity filter.');
		error.code = 'QASE_FINDING_SEVERITY_INVALID';
		throw error;
	}
	const bounded = Number.isSafeInteger(limit) ? Math.min(500, Math.max(1, limit)) : 200;
	const needle = typeof search === 'string' && search.trim() ? search.trim().toLowerCase() : undefined;
	const rows = [];
	for (const session of sessionIterable) {
		if (ownerUserId && session.ownerUserId !== ownerUserId) continue;
		if (session.mode !== 'qa') continue;
		for (const finding of (session.findings ?? []).map(normalizeFindingStatus)) {
			if (status !== undefined && finding.status !== status) continue;
			if (severity !== undefined && finding.severity !== severity) continue;
			if (runId !== undefined && session.id !== runId) continue;
			if (needle) {
				const haystack = `${finding.title ?? ''}\n${finding.category ?? ''}\n${finding.url ?? ''}`.toLowerCase();
				if (!haystack.includes(needle)) continue;
			}
			rows.push({
				id: finding.id,
				runId: session.id,
				runTitle: session.title,
				runStatus: session.status,
				targetUrl: session.targetUrl,
				title: finding.title,
				severity: finding.severity,
				category: finding.category,
				url: finding.url,
				expected: finding.expected,
				actual: finding.actual,
				steps: Array.isArray(finding.steps) ? finding.steps : [],
				evidence: finding.evidence,
				ts: finding.ts,
				status: finding.status,
				statusTs: finding.statusTs,
				statusNote: finding.statusNote
			});
		}
	}
	rows.sort((a, b) => {
		const bySeverity = FINDING_SEVERITY_ORDER.indexOf(a.severity) - FINDING_SEVERITY_ORDER.indexOf(b.severity);
		if (bySeverity !== 0) return bySeverity;
		return (b.ts ?? 0) - (a.ts ?? 0);
	});
	return rows.slice(0, bounded);
}

/** Live handles (runtime, bridge, abort controller) for a session. */
export function liveFor(id) {
	let record = live.get(id);
	if (!record) {
		record = {};
		live.set(id, record);
	}
	return record;
}

/** Read live handles without creating state for an already-deleted run. */
export function peekLive(id) {
	return live.get(id);
}

/** Remove one live handle record after its controller/runtime are disposed. */
export function dropLive(id) {
	return live.delete(id);
}

/** Snapshot only live runtime records; never hydrate or create durable runs. */
export function liveEntries() {
	return [...live.entries()].map(([id, record]) => ({ id, record }));
}

/** Events that exist only for the live view and are not worth a disk write. */
const EPHEMERAL = new Set(['frame', 'cursor', 'reasoning', 'message_delta', 'turn']);

/**
 * Applies a mutation and broadcasts it. Every state change in the app funnels
 * through here, so the SSE stream and the stored session can never disagree.
 */
export function emit(session, type, payload = {}) {
	if (!EPHEMERAL.has(type)) {
		session.updatedAt = Date.now();
		persistSoon();
	}
	bus.emit(session.id, { type, sessionId: session.id, ts: Date.now(), ...payload });
}

/** Subscribe to run-bus events from every session (used by the keepalive). */
export function watchRunBus(listener) {
	globalListeners.add(listener);
	return () => globalListeners.delete(listener);
}

export function addMessage(session, message) {
	const entry = { id: randomUUID(), ts: Date.now(), ...message };
	session.messages.push(entry);
	emit(session, 'message', { message: entry });
	return entry;
}

export function addActivity(session, activity) {
	const entry = { id: activity.id ?? randomUUID(), ts: Date.now(), status: 'done', ...activity };
	session.activities.push(entry);
	// The feed is a live view, not an audit log; old entries fall off the back.
	if (session.activities.length > 500) {
		session.activities.splice(0, session.activities.length - 500);
	}
	emit(session, 'activity', { activity: entry });
	return entry;
}

export function updateActivity(session, id, patch) {
	const entry = session.activities.find(candidate => candidate.id === id);
	if (!entry) {
		return undefined;
	}
	Object.assign(entry, patch);
	emit(session, 'activity', { activity: entry });
	return entry;
}

export function setStatus(session, status, detail) {
	applyStatusTiming(session, status);
	session.status = status;
	session.statusDetail = detail || undefined;
	// Compatibility aliases: keep the Phase-4 UI timer / analytics fields in
	// lockstep with the server-authoritative timing fields above.
	if (session.startedAt !== undefined && typeof session.runStartedAt !== 'number') {
		session.runStartedAt = session.startedAt;
	}
	if (session.completedAt !== undefined && typeof session.runCompletedAt !== 'number') {
		session.runCompletedAt = session.completedAt;
	}
	emit(session, 'status', { status, detail, timing: timingForEvent(session) });
}

/**
 * Server-authoritative run timing (Test Execution Timer).
 *
 * Timestamps are set here — once, at the moment of each transition — so every
 * persistence backend (Postgres repository or this JSON mirror) stores the same
 * authoritative values. `startedAt` and `completedAt` are write-once: repeat
 * transitions never reset or extend them.
 */
export function applyStatusTiming(session, status) {
	const now = Date.now();
	switch (status) {
		case 'queued':
			if (session.queuedAt === undefined) session.queuedAt = now;
			break;
		case 'running':
			// Environment setup starts the moment the run flips to running.
			if (session.startedAt === undefined) {
				session.startedAt = now;
				session.setupStartedAt = now;
			}
			// Resume from a user stop: close the pause interval and accumulate
			// it, so paused time is excluded from active execution time.
			if (session.pausedAt !== undefined) {
				session.pausedSeconds = (session.pausedSeconds ?? 0)
					+ Math.max(0, (now - session.pausedAt) / 1000);
				session.pausedAt = undefined;
			}
			break;
		case 'done':
			// Close any open pause interval before completing.
			if (session.pausedAt !== undefined) {
				session.pausedSeconds = (session.pausedSeconds ?? 0)
					+ Math.max(0, (now - session.pausedAt) / 1000);
				session.pausedAt = undefined;
			}
			if (session.completedAt === undefined) session.completedAt = now;
			if (session.reportStartedAt !== undefined && session.reportEndedAt === undefined) {
				session.reportEndedAt = now;
			}
			session.failureReason = undefined;
			break;
		case 'error':
			if (session.pausedAt !== undefined) {
				session.pausedSeconds = (session.pausedSeconds ?? 0)
					+ Math.max(0, (now - session.pausedAt) / 1000);
				session.pausedAt = undefined;
			}
			if (session.completedAt === undefined) session.completedAt = now;
			break;
		case 'interrupted':
			// Stuck / interrupted / server pause = PAUSED, not terminal: the
			// elapsed clock freezes at the interruption point and the run can
			// be recovered and resumed from exactly that value. Only an error
			// or an explicit cancel closes the timer.
			if (session.startedAt !== undefined && session.completedAt === undefined) {
				if (session.pausedAt === undefined) session.pausedAt = now;
			}
			break;
		case 'idle':
			// User stop = PAUSED, not cancelled. The elapsed clock freezes at
			// the pause point and resumes exactly when the run continues.
			// Cancellation is reserved for a future explicit permanent-cancel
			// action; the Stop button never cancels the timer.
			if (session.startedAt !== undefined && session.completedAt === undefined) {
				if (session.pausedAt === undefined) session.pausedAt = now;
			}
			break;
		default:
			break;
	}
}

/** Mark report-generation boundaries; called by the agent workflow. */
export function markReportPhase(session, phase) {
	const now = Date.now();
	if (phase === 'start') {
		if (session.reportStartedAt === undefined) session.reportStartedAt = now;
	} else if (phase === 'end' && session.reportStartedAt !== undefined) {
		if (session.reportEndedAt === undefined) session.reportEndedAt = now;
	}
}

/** Mark the boundary between environment setup and actual test execution. */
export function markExecutionStarted(session) {
	if (session.setupEndedAt === undefined && session.setupStartedAt !== undefined) {
		session.setupEndedAt = Date.now();
	}
}

/**
 * Timing payload attached to status events; `serverNow` lets clients correct
 * local clock skew so elapsed time is computed from server timestamps only.
 */
export function timingForEvent(session) {
	return {
		serverNow: Date.now(),
		startedAt: session.startedAt,
		completedAt: session.completedAt,
		queuedAt: session.queuedAt,
		setupStartedAt: session.setupStartedAt,
		setupEndedAt: session.setupEndedAt,
		reportStartedAt: session.reportStartedAt,
		reportEndedAt: session.reportEndedAt,
		cancelledAt: session.cancelledAt,
		pausedAt: session.pausedAt,
		pausedSeconds: session.pausedSeconds ?? 0,
		failureReason: session.failureReason
	};
}

/**
 * Active execution seconds, excluding paused intervals. For a running run
 * this is live; for a paused run it is frozen at the pause point.
 */
export function activeDurationSeconds(session, now = Date.now()) {
	if (session?.startedAt === undefined) return undefined;
	const pausedSeconds = session.pausedSeconds ?? 0;
	if (session.pausedAt !== undefined) {
		// Currently paused: elapsed is frozen at the pause point.
		return Math.max(0, Math.floor((session.pausedAt - session.startedAt) / 1000 - pausedSeconds));
	}
	const end = session.completedAt ?? now;
	return Math.max(0, Math.floor((end - session.startedAt) / 1000 - pausedSeconds));
}

/**
 * Project-level Founder Mode state (Phase 3), local-mode mirror of the
 * Postgres founder_project_state table: one record for the trusted
 * single-tenant project context of this instance.
 */
export function loadFounderProjectState() {
	try {
		const { founderProjectStateFile } = founderProjectStatePaths();
		const raw = JSON.parse(fs.readFileSync(founderProjectStateFile, 'utf8'));
		return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

export function writeFounderProjectState(state) {
	const { stateDir, founderProjectStateFile } = founderProjectStatePaths();
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(founderProjectStateFile, JSON.stringify(state));
	return state;
}
