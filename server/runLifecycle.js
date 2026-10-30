/**
 * #17932 — server-authoritative run lifecycle.
 *
 * The legacy status vocabulary (queued/running/awaiting_input/done/error/
 * interrupted/paused/idle/cancelled) is preserved verbatim for backward
 * compatibility with the UI, the matrix orchestrator and the persistence
 * layer. On top of it this module adds:
 *
 *  - an explicit transition table: invalid transitions (notably ANY
 *    transition out of a terminal state, e.g. done → running) are rejected
 *    server-side instead of silently overwriting;
 *  - a terminal OUTCOME record: why the run ended, distinguishing execution
 *    outcomes (completed/partial/blocked/failed/timed_out/cancelled) from
 *    review-generation failures (#17935). Derived for legacy sessions that
 *    predate the field.
 *
 * Mapping from the mandated vocabulary (CREATED…COMPLETED + PARTIAL etc.)
 * onto the existing statuses:
 *   CREATED/PLANNING  → queued/idle
 *   RUNNING           → running
 *   VALIDATING/REPORTING → running (phase recorded in `lifecycle.phase`)
 *   COMPLETED         → done  + outcome completed
 *   FAILED            → error + outcome failed
 *   BLOCKED           → error + outcome blocked   (awaiting_input stays interactive)
 *   PARTIAL           → done  + outcome partial
 *   TIMED_OUT         → error + outcome timed_out
 *   CANCELLED         → interrupted + outcome cancelled
 */

/** All statuses the system may set on a session. */
export const SESSION_STATUSES = ['idle', 'queued', 'running', 'awaiting_input', 'done', 'error', 'interrupted', 'paused', 'cancelled'];

/** Statuses that end a run. Once set, only `running` may follow (explicit resume). */
export const TERMINAL_STATUSES = ['done', 'error', 'cancelled'];

/** Statuses that pause a run but keep it resumable. */
export const PAUSING_STATUSES = ['awaiting_input', 'interrupted', 'paused', 'idle'];

/**
 * Allowed transitions. Left column = current, right = set of next statuses.
 * Terminal states may only re-enter via `running` (an explicit resume), never
 * flip between terminal outcomes — `done` cannot become `error` later.
 */
const TRANSITIONS = {
	idle: ['idle', 'queued', 'running', 'awaiting_input', 'error', 'cancelled'],
	queued: ['queued', 'running', 'error', 'cancelled', 'awaiting_input'],
	running: ['running', 'awaiting_input', 'done', 'error', 'interrupted', 'paused', 'cancelled'],
	awaiting_input: ['awaiting_input', 'running', 'queued', 'error', 'cancelled', 'interrupted', 'paused', 'done'],
	interrupted: ['interrupted', 'running', 'queued', 'error', 'cancelled', 'awaiting_input', 'done'],
	paused: ['paused', 'running', 'queued', 'error', 'cancelled', 'awaiting_input', 'done'],
	done: ['done', 'running'],
	error: ['error', 'running'],
	cancelled: ['cancelled', 'running']
};

export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.includes(status);
}

/**
 * Validate a status transition. Returns null when valid, otherwise a
 * human-readable rejection reason (used as the logged detail).
 */
export function invalidTransition(current, next) {
	if (!SESSION_STATUSES.includes(next)) {
		return `Invalid run status "${next}".`;
	}
	if (current === next) return null; // idempotent re-set (e.g. running → running)
	const allowed = TRANSITIONS[current];
	if (!allowed) return null; // unknown legacy current state: allow, first move normalizes it
	if (!allowed.includes(next)) {
		return `Invalid run status transition ${current} → ${next}.`;
	}
	return null;
}

/** Execution outcomes — WHY the run ended. Stored on session.lifecycle.outcome. */
export const RUN_OUTCOMES = ['completed', 'partial', 'blocked', 'failed', 'timed_out', 'cancelled', 'review_failed'];

/**
 * Derive the outcome for a terminal transition. Pure function so tests can
 * exercise every path.
 *
 * @returns {{outcome: string, reason?: string}|null} null when the transition is not terminal
 */
export function deriveOutcome(status, detail = '', context = {}) {
	if (status === 'done') {
		// #17988: a done run is only COMPLETED when the server-side completion
		// gate earned it. The gate (qaCompletionGate / finish tool) already
		// rejects pass verdicts with outstanding required scenarios, so a
		// published partial/blocked verdict IS the durable record that required
		// work never reached a verified terminal outcome.
		const verdict = String(context?.report?.verdict ?? '').toLowerCase();
		if (verdict === 'blocked') {
			return { outcome: 'blocked', reason: detail || 'Testing could not proceed; a blocking prerequisite was recorded.' };
		}
		if (verdict === 'partial' || context.incompleteCoverage === true) {
			return { outcome: 'partial', reason: detail || 'Required scenarios did not all reach a terminal outcome.' };
		}
		return { outcome: 'completed', reason: detail || undefined };
	}
	if (status === 'cancelled') {
		return { outcome: 'cancelled', reason: detail || 'Stopped by user.' };
	}
	if (status === 'error') {
		const text = String(detail ?? '');
		if (/\btimed?[-_ ]?out\b|deadline|no execution progress/i.test(text)) {
			return { outcome: 'timed_out', reason: text };
		}
		if (/\bblocked\b|permission|authorization|awaiting (?:user|approval)/i.test(text)) {
			return { outcome: 'blocked', reason: text };
		}
		return { outcome: 'failed', reason: text || undefined };
	}
	return null;
}

/**
 * Lifecycle document stored on the session (lazily created). Kept small and
 * additive; nothing existing reads it until the new UI does.
 */
export function lifecycleDocument(session) {
	session.lifecycle ??= { phase: 'CREATED', startedAt: undefined, endedAt: undefined, outcome: undefined, reason: undefined };
	return session.lifecycle;
}

/**
 * Record a lifecycle phase change (PLANNING / RUNNING / VALIDATING /
 * REPORTING / TERMINAL). Callers pass the emitted status so the phase and
 * the legacy status stay in lockstep.
 */
export function recordLifecyclePhase(session, status, detail) {
	const lifecycle = lifecycleDocument(session);
	switch (status) {
		case 'queued':
			lifecycle.phase = 'PLANNING';
			break;
		case 'running':
			if (lifecycle.phase !== 'RUNNING') lifecycle.phase = 'RUNNING';
			if (lifecycle.startedAt === undefined) lifecycle.startedAt = Date.now();
			break;
		case 'awaiting_input':
		case 'paused':
		case 'interrupted':
		case 'idle':
			lifecycle.phase = 'PAUSED';
			break;
		case 'done':
		case 'error':
		case 'cancelled': {
			const derived = deriveOutcome(status, detail, session);
			if (derived) {
				lifecycle.outcome = derived.outcome;
				lifecycle.reason = derived.reason;
			}
			lifecycle.endedAt = Date.now();
			lifecycle.phase = 'TERMINAL';
			break;
		}
		default:
			break;
	}
	return lifecycle;
}

/** Derive the outcome for a legacy session that predates lifecycle records. */
export function outcomeForLegacySession(session) {
	if (!session) return null;
	if (session.lifecycle?.outcome) return session.lifecycle.outcome;
	return deriveOutcome(session.status, session.failureReason ?? session.statusDetail ?? '', session);
}
