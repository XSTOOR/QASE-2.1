/**
 * #17932 — run watchdog + heartbeat monitor.
 *
 * Pre-existing failure: startTurn detached the turn with only a `.catch`, so
 * a turn that neither resolved nor rejected (a CleanSlate SDK stream that
 * stops yielding without ending, a browser tool that never returns, a gateway
 * trickling keep-alive chunks that perpetually re-arm the SDK's idle timeout)
 * left the session `running` forever.
 *
 * Every active turn now gets:
 *  - a heartbeat: any observable run event (stream part, tool start/result,
 *    usage commit) touches `beat()`;
 *  - a stall detector: no heartbeat for `stallMs` aborts the turn through the
 *    SAME AbortController the user's Stop button uses, so the existing
 *    decision cascade chooses the honest terminal state;
 *  - an absolute turn deadline: no turn may outlive `deadlineMs` regardless
 *    of heartbeats — a run can never remain indefinitely stuck;
 *  - a bounded grace window: after the turn settles, if the run has not
 *    reached a terminal status within `graceMs`, a fail-safe terminalizes it
 *    (never silently — always with a system message).
 *
 * All timers are unref'd so they never hold the process open.
 */

import { sanitizeErrorDetail } from './errorSanitizer.js';

// #17932: states that end the run outright. Resumable pauses (interrupted,
// awaiting_input, paused, idle) are deliberately NOT terminal — the run is
// waiting for a user, not wedged.
const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);
// The only statuses in which a settled turn means something went wrong: the
// cascade should have terminalized an active run. Paused/awaiting runs are
// parked intentionally and must never be touched by the fail-safe.
const ACTIVE_STATUSES = new Set(['running', 'queued']);

function numberFromEnv(name, fallback, { min = 0 } = {}) {
	const value = Number(process.env[name]);
	if (!Number.isFinite(value) || value < min) return fallback;
	return value;
}

// Bounded by design and overridable per deployment.
export const WATCHDOG_CONFIG = (() => {
	const config = {
	// Max time WITHOUT observable progress before the turn is considered
	// stalled. Generous: long generations still stream reasoning/chat parts,
	// which touch the heartbeat.
	stallMs: numberFromEnv('QASE_TURN_STALL_MS', 5 * 60_000, { min: 30_000 }),
	// Absolute ceiling on a single turn. Automatic continuations each get a
	// fresh turn (and a fresh watchdog), so long runs are unaffected.
	deadlineMs: numberFromEnv('QASE_TURN_DEADLINE_MS', 45 * 60_000, { min: 60_000 }),
	// Wait after turn settle for a terminal status before fail-safe.
	graceMs: numberFromEnv('QASE_WATCHDOG_GRACE_MS', 60_000, { min: 5_000 })
	};
	// Tests override the windows AFTER import via setWatchdogConfig().
	return config;
})();

/** Test seam: shorten the windows (also usable by tooling). */
export function setWatchdogConfig(overrides = {}) {
	Object.assign(WATCHDOG_CONFIG, overrides);
}

export function isTerminalStatus(status) {
	return TERMINAL_STATUSES.has(status);
}

/**
 * Attach a watchdog to one running turn.
 *
 * Aborts route through `controller` (the turn's own AbortController) so the
 * existing cascade classifies them as interruptions — recoverable, with
 * checkpoint snapshots — rather than the watchdog inventing a parallel
 * terminal path. The fail-safe only fires when the cascade demonstrably
 * failed to terminalize.
 */
export function watchTurn({ sessionId, controller, getStatus, getActiveStep, onStall, turnPromise, runStore }) {
	const startedAt = Date.now();
	let lastBeatAt = startedAt;
	let beatCount = 0;
	let settled = false;
	let stallFired = false;
	let stallTimer;
	let deadlineTimer;
	let graceTimer;

	const armStall = () => {
		clearTimeout(stallTimer);
		const silentFor = Date.now() - lastBeatAt;
		stallTimer = setTimeout(fireStall, Math.max(1, WATCHDOG_CONFIG.stallMs - silentFor));
		stallTimer.unref?.();
	};

	const beat = () => {
		lastBeatAt = Date.now();
		beatCount += 1;
		// Re-arm the stall window from this beat: progress legitimately
		// extends the turn (the absolute deadline still bounds it).
		if (!settled) armStall();
	};

	const describeStep = () => {
		const step = getActiveStep?.();
		if (!step) return 'no active step recorded';
		const age = Math.round((Date.now() - step.since) / 1000);
		return step.toolName ? `active step ${step.toolName} (${age}s)` : `active step (${age}s)`;
	};

	const fireStall = () => {
		if (settled || stallFired) return;
		stallFired = true;
		const silentFor = Math.round((Date.now() - lastBeatAt) / 1000);
		const reason = `No execution progress for ${silentFor}s while the run was active (${describeStep()}).`;
		console.warn(JSON.stringify({
			event: 'run_watchdog_stall', runId: sessionId, silentSeconds: silentFor,
			turnAgeSeconds: Math.round((Date.now() - startedAt) / 1000), ts: new Date().toISOString()
		}));
		try { onStall?.(reason); } catch { /* the monitor must never break the run */ }
		controller.abort();
	};

	const fireDeadline = () => {
		if (settled) return;
		const age = Math.round((Date.now() - startedAt) / 1000);
		console.warn(JSON.stringify({
			event: 'run_watchdog_deadline', runId: sessionId, turnAgeSeconds: age,
			heartbeats: beatCount, ts: new Date().toISOString()
		}));
		// Not a stall: the turn is producing work but exceeded any bounded
		// turn. Abort → cascade records `interrupted` with a checkpoint, from
		// which auto-resume continues WITHOUT duplicating completed actions
		// (continuation prompts explicitly skip finished work).
		controller.abort();
	};

	stallTimer = setTimeout(fireStall, WATCHDOG_CONFIG.stallMs);
	stallTimer.unref?.();
	if (WATCHDOG_CONFIG.deadlineMs > 0) {
		deadlineTimer = setTimeout(fireDeadline, WATCHDOG_CONFIG.deadlineMs);
		deadlineTimer.unref?.();
	}

	const failSafe = async (reason) => {
		const status = getStatus?.();
		// Only an ACTIVE run (running/queued) whose turn settled can be
		// wedged. Terminal runs are finished; paused / awaiting_input runs
		// are intentionally waiting on a human — never touched.
		if (!status || !ACTIVE_STATUSES.has(status)) return;
		console.error(JSON.stringify({
			event: 'run_watchdog_failsafe', runId: sessionId, status,
			reason: sanitizeErrorDetail(reason), ts: new Date().toISOString()
		}));
		try {
			await runStore.addMessage(sessionId, { role: 'system', text: `Run monitor: ${sanitizeErrorDetail(reason)}`, kind: 'error' });
			await runStore.setStatus(sessionId, 'error', sanitizeErrorDetail(reason));
		} catch (error) {
			console.error(JSON.stringify({
				event: 'run_watchdog_failsafe_failed', runId: sessionId,
				error: sanitizeErrorDetail(error), ts: new Date().toISOString()
			}));
		}
	};

	const settle = () => {
		if (settled) return;
		settled = true;
		clearTimeout(stallTimer);
		clearTimeout(deadlineTimer);
		graceTimer = setTimeout(() => {
			void failSafe('The agent turn ended without setting a final run status.');
		}, WATCHDOG_CONFIG.graceMs);
		graceTimer.unref?.();
	};

	Promise.resolve(turnPromise).then(settle, settle);

	return {
		beat,
		get state() {
			return {
				runId: sessionId, startedAt, lastBeatAt, beatCount,
				stallFired, settled,
				config: { ...WATCHDOG_CONFIG }
			};
		},
		dispose() {
			settled = true;
			clearTimeout(stallTimer);
			clearTimeout(deadlineTimer);
			clearTimeout(graceTimer);
		}
	};
}
