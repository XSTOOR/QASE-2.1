import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeFounderState } from './founderService.js';
import { normalizePendingSqaState } from './sqaService.js';
import { DEFAULT_DEVICE_ID, isDeviceId } from './deviceProfiles.js';

/**
 * In-memory session store with a JSON mirror on disk.
 *
 * A session owns everything the dashboard renders: the transcript, the activity
 * feed, findings, the test plan and the final report. Live state that cannot be
 * serialised — the agent runtime, the browser bridge, the abort controller — is
 * kept on a parallel `runtime` record that never reaches disk.
 */

const STATE_DIR = path.join(process.cwd(), '.qase');
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');

/** Live, non-serialisable per-session handles, keyed by session id. */
const live = new Map();

const sessions = new Map();
export const bus = new EventEmitter();
bus.setMaxListeners(0);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRYTIS_INTEGRATION_BYTES = 1_000_000;

let saveTimer;

function persistNow() {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(STATE_FILE, JSON.stringify([...sessions.values()], undefined, '\t'));
	} catch {
		// A dashboard that cannot write its history is still a usable dashboard.
	}
}

function persistSoon() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(persistNow, 250);
	saveTimer.unref?.();
}

/** Flushes pending local history before the process exits. */
export function flushSessions() {
	clearTimeout(saveTimer);
	saveTimer = undefined;
	persistNow();
}

export function loadSessions() {
	try {
		const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
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
			// Nothing survives a restart mid-run, so anything that was in flight is stale.
			if (session.status === 'running' || session.status === 'awaiting_input') {
				session.status = 'interrupted';
				session.pendingQuestion = undefined;
			}
			// Earlier versions stored reasoning as a message; it is live-only now.
			session.messages = (session.messages ?? []).filter(message => message.role !== 'thinking');
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
		messages: [],
		activities: [],
		findings: structuredClone(options.findings ?? []),
		todos: [],
		report: undefined,
		pendingQuestion: undefined,
		contextUsage: undefined,
		/** Names of secrets held for this session — never the values. */
		secretNames: []
	};
	if (options.drytisIntegration !== undefined) {
		session.drytisIntegration = structuredClone(options.drytisIntegration);
	}
	sessions.set(session.id, session);
	persistSoon();
	return session;
}

export function getSession(id) {
	return sessions.get(id);
}

export function listSessions({ limit = 100 } = {}) {
	const bounded = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 100;
	return [...sessions.values()]
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
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			findingCount: session.findings.length,
			messageCount: session.messages.length
		}));
}

export function deleteSession(id) {
	const record = live.get(id);
	record?.controller?.abort();
	record?.dispose?.();
	live.delete(id);
	const existed = sessions.delete(id);
	persistSoon();
	return existed;
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
	session.status = status;
	emit(session, 'status', { status, detail });
}
