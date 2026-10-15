/**
 * Boot-time run recovery.
 *
 * When the process dies mid-run (container pause/restart) the run store marks
 * the session `interrupted` with `interruptedFromRun: true`. On boot, any such
 * run whose agent snapshot was persisted (see server/agent.js) is restored
 * into a fresh runtime and driven forward with a recovery instruction, so the
 * run completes instead of being stranded.
 *
 * Everything here is defensive by design: recovery must NEVER crash the boot,
 * must never resume a run more than a bounded number of times, and must always
 * run inside the original owner's actor context.
 */

const MAX_AUTO_RESUME_ATTEMPTS = 3;

/** Default dependency bundle for createRunResume(). */
const defaults = () => ({
	logger: {
		info: () => {},
		warn: () => {}
	},
	attemptDelayMs: 0,
	withRequestActor: actor => work => work(),
	loadSnapshot: () => null
});

/**
 * Factory so tests can inject a logger, actor runner, snapshot loader, and a
 * small attempt delay without touching timers or the filesystem.
 *
 * @param {object} overrides
 * @returns {{ isResumable, recoveryInstruction, resumeAll }}
 */
export function createRunResume(overrides = {}) {
	const deps = { ...defaults(), ...overrides };
	const { logger, attemptDelayMs, withRequestActor, loadSnapshot } = deps;

	/**
	 * A run is resumable only if it was actively running when the process died
	 * and has not exhausted its auto-resume budget or already reached a
	 * terminal/published state.
	 */
	function isResumable(session) {
		if (!session || typeof session !== 'object') return false;
		if (session.interruptedFromRun !== true) return false;
		if (session.status !== 'interrupted') return false;
		if ((session.autoResumeCount ?? 0) >= MAX_AUTO_RESUME_ATTEMPTS) return false;
		if (session.report?.publishedAt) return false;
		if (session.mode === 'sqa' && session.sqa?.finalizedAt) return false;
		if (session.mode === 'founder' && session.founder?.finalizedAt) return false;
		return true;
	}

	/**
	 * The instruction handed to the agent for the recovery turn. It points the
	 * agent at the original target, forbids repeating completed/irreversible
	 * steps, and directs it to finish and publish the final report.
	 */
	function recoveryInstruction(session, { transcriptDigest } = {}) {
		const targetUrl = session?.targetUrl || '(unknown target)';
		const parts = [
			`Your run was interrupted by a server restart. Target: ${targetUrl}`,
			'Do not repeat completed or irreversible steps.'
		];
		if (session?.mode === 'sqa') {
			parts.push('Preserve recorded control evidence and blocker decisions. Complete only the remaining scoped controls, then call finish_sqa_assessment to durably publish the final assessment.');
		} else if (session?.mode === 'founder') {
			parts.push('Preserve recorded observations, browser evidence, and plan progress. Complete only the remaining review work, then call finish_founder_review to durably publish the final report.');
		} else {
			parts.push('Continue from where your prior progress left off, verify remaining items, then publish the final report.');
		}
		// Without a restored snapshot the runtime starts empty: the digest tells
		// the agent what was already verified so it continues instead of redoing.
		if (transcriptDigest) parts.push(`Progress so far (do not redo):\n${transcriptDigest}`);
		return parts.join(' ');
	}

	/**
	 * Compact digest of the recorded transcript: assistant steps + tool
	 * activity, most recent last. Bounded so it cannot blow the context.
	 */
	function transcriptDigestFor(session, api) {
		const messages = Array.isArray(session?.messages) ? session.messages : [];
		const steps = messages
			.filter(m => m?.role === 'agent' && typeof m.text === 'string' && m.text.trim())
			.slice(-25)
			.map(m => `- ${m.text.trim().slice(0, 300)}`);
		const activity = Array.isArray(session?.activities) ? session.activities : [];
		const actions = activity
			.filter(a => a && typeof a.summary === 'string' && a.summary.trim())
			.slice(-25)
			.map(a => `- [${a.toolName ?? a.type ?? 'step'}] ${a.summary.trim().slice(0, 200)}`);
		return [...steps, ...actions].join('\n');
	}

	/**
	 * Scan persisted run snapshots, pick the most recent resumable candidate,
	 * restore its snapshot into a fresh runtime, and run exactly one recovery
	 * turn inside the owner's actor context. All failures are swallowed and
	 * logged — boot must continue regardless.
	 *
	 * @param {object} api host services: listSnapshots, get, ensureRuntime,
	 *   runTurn, addMessage, setStatus
	 * @returns {Promise<number>} how many runs were resumed (0 or 1)
	 */
	async function resumeAll(api) {
		let snapshots;
		try {
			snapshots = await api.listSnapshots();
		} catch (error) {
			logger.warn?.('runresume.list-failed', { error: String(error) });
			snapshots = [];
		}
		if (!Array.isArray(snapshots)) snapshots = [];

		// The crash that interrupted the run can also destroy the snapshot
		// directory itself (observed in production: corrupted volume left the
		// index empty). Any resumable interrupted session not covered by the
		// snapshot index becomes a candidate directly — it will resume from its
		// recorded transcript instead of a runtime snapshot.
		let indexedIds;
		try {
			indexedIds = new Set(snapshots.map(s => s?.sessionId).filter(Boolean));
			const sessions = await api.listInterrupted?.();
			for (const session of Array.isArray(sessions) ? sessions : []) {
				if (!isResumable(session) || indexedIds.has(session.id)) continue;
				snapshots.push({ sessionId: session.id, ownerUserId: session.ownerUserId, savedAt: 0 });
			}
		} catch (error) {
			logger.warn?.('runresume.scan-failed', { error: String(error) });
		}
		if (snapshots.length === 0) return 0;

		const candidates = [...snapshots]
			.filter(s => s && typeof s.sessionId === 'string')
			.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));

		for (const candidate of candidates) {
			// Capped candidates get one explanatory system message, once.
			const session = await api.get(candidate.sessionId).catch(() => null);
			if (session && session.status === 'interrupted' && session.interruptedFromRun === true
				&& (session.autoResumeCount ?? 0) >= MAX_AUTO_RESUME_ATTEMPTS
				&& !session.autoResumeCapNoted) {
				try {
					await api.addMessage(session, {
						role: 'system',
						text: `Auto-resume stopped after 3 attempts. Resume manually if this run is still needed.`
					});
					session.autoResumeCapNoted = true;
				} catch {
					// Messaging a capped session is best-effort.
				}
			}

			if (!isResumable(session)) continue;

			let snapshot = await Promise.resolve()
				.then(() => loadSnapshot(candidate.sessionId))
				.catch(() => null);
			if (!snapshot) {
				// The snapshot may not have survived the crash (e.g. the snapshot
				// directory itself was lost). A resumable session still carries its
				// recorded transcript, so resume with a fresh runtime seeded with
				// a progress digest instead of leaving the run stranded forever.
				logger.info?.('runresume.no-snapshot-transcript-resume', { runId: candidate.sessionId });
			}

			const { runtime } = await api.ensureRuntime(session).catch(error => {
				logger.warn?.('runresume.runtime-failed', { runId: candidate.sessionId, error: String(error) });
				return {};
			}) || {};
			if (!runtime || typeof runtime.restoreSessionSnapshot !== 'function') {
				if (!snapshot) {
					// No snapshot to restore AND runtime has no restore hook: the
					// runtime object on this codepath is inert — skip safely.
					logger.info?.('runresume.skipped-no-restore', { runId: candidate.sessionId });
					continue;
				}
				logger.info?.('runresume.skipped-no-restore', { runId: candidate.sessionId });
				continue;
			}

			if (snapshot) {
				try {
					runtime.restoreSessionSnapshot(snapshot);
				} catch (error) {
					// A corrupt snapshot degrades to a transcript-seeded resume
					// rather than stranding the run.
					logger.warn?.('runresume.restore-failed', { runId: candidate.sessionId, error: String(error) });
					snapshot = null;
				}
			}

			// Last-resort reconciliation: a tool executing when the process died
			// can never return, and an activity left "running" vetoes report
			// publication forever. Stores normally fail these on load; this sweep
			// guarantees it no matter how the session reached memory.
			if (typeof api.updateActivity === 'function' && Array.isArray(session?.activities)) {
				for (const activity of session.activities) {
					if (activity?.status !== 'running') continue;
					try {
						await api.updateActivity(session, activity.id, {
							status: 'failed',
							error: 'Interrupted by a server restart before this tool returned.'
						});
					} catch (error) {
						logger.warn?.('runresume.stale-activity-failed', { runId: candidate.sessionId, activityId: activity.id, error: String(error) });
					}
				}
			}

			// Exactly one recovery turn, inside the owner's actor context so
			// per-user model configuration, memory, and ownership resolve.
			session.autoResumeCount = (session.autoResumeCount ?? 0) + 1;
			session.interruptedFromRun = false;
			try {
				await withRequestActor({ actorUserId: candidate.ownerUserId })(async () => {
					await api.runTurn(session, {
						task: recoveryInstruction(session, {
							transcriptDigest: snapshot ? undefined : transcriptDigestFor(session, api)
						}),
						recovery: true,
						...(attemptDelayMs ? { attemptDelayMs } : {})
					});
				});
			} catch (error) {
				// A failed recovery attempt is logged, never thrown: boot must
				// not die because one session could not resume.
				logger.warn?.('runresume.turn-failed', { runId: session.id, error: String(error) });
			}
			logger.info?.('runresume.resumed', { runId: session.id });
			return 1;
		}
		return 0;
	}

	return { isResumable, recoveryInstruction, resumeAll };
}
