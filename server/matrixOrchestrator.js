/**
 * Matrix run orchestrator (2027.03.0, #14633 NI02 Phase 1).
 *
 * Drives an existing matrix run: for each PENDING item, launch the standard
 * session machinery (the same path POST /api/sessions + message uses), tag the
 * session with matrixRunId, and record honest per-item outcomes. Sequential
 * execution — the local agent's closeOtherBrowsers makes one-browser-at-a-time
 * the de-facto contract; distributed mode can later drain items via the
 * execution queue instead.
 */

import { BROWSER_SUPPORT_STATUS, resolveBrowserSupport } from './browserSupportResolution.js';
import { checkEnvironmentHealth } from './environmentHealth.js';
import { fixtureExpectation } from './defectFixtures.js';
import os from 'node:os';
// Pipeline Phase 3 (#15493): unattended-run question policy — honor
// ALREADY-RESOLVED authorization, never fabricate credentials, never
// auto-approve destructive actions.
import {
	deriveQuestionPolicy,
	autoAnswerFor,
	blockedReasonFor,
	MAX_AUTO_ANSWERS_PER_ITEM
} from './matrixQuestionPolicy.js';

// Concurrency is runtime-configured (see configuredParallelism at the bottom);
// local mode keeps one browser at a time (closeOtherBrowsers contract).

/**
 * @param {object} services { runs, agent, matrix, deviceRuntime }
 * @param {object} hooks { startSession(session, matrixRun, item) -> Promise<session>,
 *                         sendTask(session, matrixRun) -> Promise<void>,
 *                         emit(matrixRunId, payload) }
 */
export function createMatrixOrchestrator(services, hooks) {
	const running = new Map(); // matrixRunId -> in-flight execution promise
	const cancelledRuns = new Set(); // #15043 (B1): cancel flags per run
	// Pipeline Phase 4 (#15496): GLOBAL admission gate. The worker pool inside
	// one run is per-run; several runs (or one run's batches) starting together
	// must share ONE budget of concurrently-executing items across ALL runs —
	// each executing item holds a browser process (~300–500 MB RSS). This is
	// the single mechanism (the old dead MAX_MATRIX_CONCURRENT constant is
	// gone); the budget is environment-clamped in configuredParallelism().
	let slotsUsed = 0; // synchronous check-and-reserve counter across all runs
	const waitQueue = []; // slot handoff queue (oldest waiter first)
	const MAX_IN_FLIGHT = configuredParallelism();
	// Stale-run sweep: any run left `running` by a dead process (container
	// restart, crash) is transitioned to error before this orchestrator runs.
	// Same logic as the boot-time resumeRecovery() — both entry points use it.
	async function sweepStaleRuns() {
		await resumeRecovery().catch((error) => {
			console.error('[matrix] stale-run sweep failed', error);
		});
	}

	/**
	 * Start a matrix run: PENDING items execute; NOT_RUN / NOT_SUPPORTED /
	 * UNAVAILABLE / BLOCKED items keep their honest state — they NEVER launch.
	 */
	function start(matrixRunId, options = {}) {
		if (running.has(matrixRunId)) {
			return { ok: false, error: `Matrix run ${matrixRunId} is already running.` };
		}
		const execution = executeRun(matrixRunId, options).catch((error) => {
			// Never leave an in-flight item as PASS-ready or dangling RUNNING.
			console.error('[matrix] orchestration failure', matrixRunId, error);
		}).finally(() => running.delete(matrixRunId));
		running.set(matrixRunId, execution);
		return { ok: true };
	}

	/** Resume-scan: see resumeRecovery below. Exposed for boot wiring. */
	function startResumeRecovery() {
		return resumeRecovery().catch((error) => {
			console.error('[matrix] resume recovery failed', error);
		});
	}

	/**
	 * #14633 (NI02 Phase 1) resume scan: a container restart kills in-flight
	 * orchestration. Any matrix run left in `running` state — or any item left
	 * RUNNING — is marked ERROR "interrupted" so no dangling state can be
	 * mistaken for a live execution or a pass. Idempotent; call once on boot
	 * (or after attach) before any new matrix run starts.
	 *
	 * #14942 hotfix: NEVER touch runs this process is actively orchestrating —
	 * executeRun() previously called the sweep on every start, so starting run
	 * B stamped concurrently-live run A (and A's QUEUED items, which wait
	 * behind the one-browser-at-a-time contract) as `error` while its workers
	 * kept executing. Only a run that is neither in this process's `running`
	 * map nor executing an item can genuinely be stale.
	 */
	async function resumeRecovery() {
		const runs = await services.matrix.list();
		for (const run of runs ?? []) {
			if (running.has(run.id)) continue; // live in THIS process — not stale
			const items = run.items ?? [];
			if (run.status === 'running') {
				await services.matrix._setStatus(run.id, 'error', {});
			}
			const interrupted = items.filter((item) => item.status === 'RUNNING');
			// #16159: QUEUED items stranded by a restart could NEVER resume in
			// this process — POST /start only accepts PENDING items and the
			// worker pool only exists while a run is being orchestrated here.
			// Recovery re-schedules them instead of leaving them Queued forever:
			// the run re-enters `running` and a fresh drain executes them.
			const strandedQueued = items.filter((item) => item.status === 'QUEUED');
			if (!interrupted.length && !strandedQueued.length && run.status !== 'running') continue;
			for (const item of interrupted) {
				await services.matrix.updateItem(run.id, item.id, {
					status: 'ERROR',
					error: 'Interrupted — the server restarted before this profile finished.',
					finishedAt: new Date().toISOString(),
					durationMs: null
				});
				// Pipeline Phase 4 (#15496): browser sweep on recovery. A
				// restart orphaned this item's child session; its browser
				// runtime died with the process, but if the store reports a
				// live session record, dispose it so no half-state lingers.
				if (item.sessionId) {
					try {
						await services.agent?.stop?.(item.sessionId);
					} catch {
						// best-effort sweep — never block recovery
					}
				}
			}
			if (strandedQueued.length) {
				// Re-mark as PENDING so executeRun() schedules them again.
				for (const item of strandedQueued) {
					await services.matrix.updateItem(run.id, item.id, { status: 'PENDING' });
				}
				await services.matrix._setStatus(run.id, 'running', { error: null });
				// Fire-and-forget resume of the run's remaining work. Use
				// start() so the running map guards against double-entry.
				const resumed = start(run.id, { resumedAfterRestart: true });
				if (resumed.ok) {
					hooks.emit?.(run.id, { type: 'matrix_run_started', matrixRunId: run.id, resumed: true });
				}
			}
		}
	}

	function isActive(matrixRunId) {
		return running.has(matrixRunId);
	}

	/**
	 * #15043 (B1): cancel a running (or pending) run. Queued/pending items are
	 * immediately CANCELLED; an in-flight item finishes its current turn and
	 * keeps its honest outcome. Safe to call when not running.
	 */
	async function cancel(matrixRunId) {
		cancelledRuns.add(matrixRunId);
		try {
			const result = await services.matrix.cancel(matrixRunId, {});
			hooks.emit?.(matrixRunId, { type: 'matrix_run_cancelled', matrixRunId, cancelled: result.cancelled });
			return result;
		} catch (error) {
			console.error('[matrix] cancel failed', matrixRunId, error);
			return { run: null, cancelled: 0 };
		}
	}

	/**
	 * #15043 (B1): retry a single terminal item (FAILED/ERROR/BLOCKED/CANCELLED).
	 * Bounded at MAX_ITEM_RETRIES; the previous verdict is cleared so a fresh
	 * outcome must arrive from a real execution.
	 */
	async function retryItem(matrixRunId, itemId) {
		const run = await services.matrix.get(matrixRunId);
		if (!run) return { ok: false, error: `Unknown matrix run "${matrixRunId}".` };
		const item = (run.items ?? []).find((candidate) => candidate.id === itemId);
		if (!item) return { ok: false, error: `Unknown matrix item "${itemId}".` };
		if (!['FAILED', 'ERROR', 'BLOCKED', 'CANCELLED'].includes(item.status)) {
			return { ok: false, error: `Item is ${item.status}; only failed/error/blocked/cancelled items can be retried.` };
		}
		if ((item.retryCount ?? 0) >= MAX_ITEM_RETRIES) {
			return { ok: false, error: `Retry limit reached (${MAX_ITEM_RETRIES}).` };
		}
		await services.matrix.updateItem(matrixRunId, itemId, {
			status: 'QUEUED',
			reason: null,
			error: null,
			sessionId: null,
			verdict: null,
			findings: [],
			artifactRefs: [],
			startedAt: null,
			finishedAt: null,
			durationMs: null,
			retryCount: (item.retryCount ?? 0) + 1
		});
		// Re-kick execution if the run is not already running; if it is, the
		// worker pool picks the queued item up on its next loop.
		if (!running.has(matrixRunId) && run.status !== 'running') {
			cancelledRuns.delete(matrixRunId);
			start(matrixRunId);
		}
		hooks.emit?.(matrixRunId, { type: 'matrix_item', itemId, ordinal: item.ordinal, status: 'QUEUED' });
		return { ok: true };
	}

	async function executeRun(matrixRunId, options = {}) {
		// #14649: sweep runs a previous process left `running` (container
		// restart mid-flight) so this run cannot collide with zombie state.
		// A run resumed BY that sweep (options.resumedAfterRestart) has
		// already been set running deliberately — skip both the sweep (it
		// would loop back into recovery) and the already-running guard.
		if (!options.resumedAfterRestart) {
			await sweepStaleRuns();
		}
		const run = await services.matrix.get(matrixRunId);
		if (!run) throw new Error(`Unknown matrix run "${matrixRunId}"`);
		if (run.status === 'running' && !options.resumedAfterRestart) {
			throw new Error(`Matrix run ${matrixRunId} is already running.`);
		}
		await services.matrix._setStatus(matrixRunId, 'running', { startedAt: run.startedAt ?? new Date().toISOString() });
		hooks.emit?.(matrixRunId, { type: 'matrix_run_started', matrixRunId });

		// #15043 (B1): PENDING items become QUEUED (explicitly scheduled); the
		// worker pool then claims QUEUED items. Honest pre-terminal states
		// (NOT_RUN / NOT_SUPPORTED / UNAVAILABLE / BLOCKED / CANCELLED / ERROR)
		// NEVER launch.
		const schedulable = run.items.filter((item) => item.status === 'PENDING' || item.status === 'QUEUED');
		for (const item of schedulable) {
			if (item.status === 'PENDING') {
				await services.matrix.updateItem(matrixRunId, item.id, { status: 'QUEUED' });
			}
		}
		await drainQueued(matrixRunId, run);

		// #14942 hotfix: `done` may only mean every item reached a terminal
		// state. Queued work that never launched (run cancelled mid-drain,
		// worker exhaustion, earlier corruption) is an honest coverage gap,
		// not a pass — surface it as an errored run instead.
		const finalRun = await services.matrix.get(matrixRunId);
		const counts = statusCounts(finalRun.items);
		const unfinished = (counts.QUEUED ?? 0) + (counts.PENDING ?? 0) + (counts.RUNNING ?? 0);
		if (cancelledRuns.has(matrixRunId) || finalRun.status === 'cancelled') {
			// cancel() already set status/timing; just announce completion.
			// (Keep the cancellation marker until the run fully settles.)
			hooks.emit?.(matrixRunId, { type: 'matrix_run_done', matrixRunId, counts, cancelled: true });
			return;
		}
		if (unfinished > 0) {
			await services.matrix._setStatus(matrixRunId, 'error', {
				finishedAt: new Date().toISOString(),
				counts,
				error: `${unfinished} configuration(s) never reached a terminal state (queued/pending/running) — execution did not complete.`
			});
			hooks.emit?.(matrixRunId, { type: 'matrix_run_done', matrixRunId, counts, errored: true });
			return;
		}
		await services.matrix._setStatus(matrixRunId, 'done', { finishedAt: new Date().toISOString(), counts });
		hooks.emit?.(matrixRunId, { type: 'matrix_run_done', matrixRunId, counts });
	}

	/** Worker pool over QUEUED items; cancellation stops claiming new work.
	 *  Pipeline Phase 4 (#15496): workers claim through the GLOBAL admission
	 *  gate — total RUNNING items across ALL runs never exceeds the
	 *  environment-clamped budget. Slot accounting is SYNCHRONOUS
	 *  (check-and-reserve in one tick) so two workers can never race past
	 *  the budget between an await and a Set.add. Each claim waits for a
	 *  slot when the budget is exhausted by sibling runs. */
	async function drainQueued(matrixRunId, run) {
		const claim = async () => {
			const current = await services.matrix.get(matrixRunId);
			const next = (current.items ?? []).find(
				(item) => item.status === 'QUEUED' && !claimed.has(item.id)
			);
			if (!next) return null;
			claimed.add(next.id);
			return next;
		};
		const claimed = new Set();
		const acquireSlot = () => {
			if (slotsUsed < MAX_IN_FLIGHT) {
				slotsUsed += 1;
				return Promise.resolve();
			}
			return new Promise((resolve) => {
				// Waiter takes the slot when handed off — the releaser does
				// NOT decrement (the slot transfers, ownership and all), so
				// slotsUsed always equals live holders. Leak-free by
				// construction: every acquire is matched by exactly one
				// release-or-handoff.
				waitQueue.push(resolve);
			});
		};
		const releaseSlot = () => {
			const next = waitQueue.shift();
			if (next) {
				next(); // slot transfers to the waiter — counter unchanged
			} else {
				slotsUsed -= 1;
			}
		};
		const worker = async () => {
			for (;;) {
				if (cancelledRuns.has(matrixRunId)) return;
				const item = await claim();
				if (!item) return;
				await acquireSlot();
				if (cancelledRuns.has(matrixRunId)) {
					// Cancelled while waiting for a slot — do not start it.
					releaseSlot();
					return;
				}
				try {
					await executeItem(run, item);
				} finally {
					releaseSlot();
				}
			}
		};
		await Promise.all(
			Array.from({ length: Math.max(1, Math.min(configuredParallelism(), 16)) }, () => worker())
		);
	}

	async function executeItem(run, item) {
		const startedAt = new Date().toISOString();
		const mark = async (patch) => {
			await services.matrix.updateItem(run.id, item.id, {
				...patch,
				updatedAt: new Date().toISOString()
			});
			hooks.emit?.(run.id, { type: 'matrix_item', itemId: item.id, ordinal: item.ordinal, status: patch.status ?? item.status });
		};

		// The session created for this item — hoisted so the finally block can
		// close its browser no matter how the item ended (null until launch).
		let itemSession = null;

		try {
			// #16159: the pre-RUNNING phase (browser-support resolution, health
			// gate, session creation) previously had NO deadline while already
			// holding a global execution slot — a hang here blocked every
			// sibling item and the whole board showed Queued forever. Bound it
			// (default 120s, env-tunable); a blow-through is an honest ERROR,
			// not a silent stall.
			const PRELAUNCH_TIMEOUT_MS = (() => {
				const raw = Number(process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S ?? 120);
				if (!Number.isFinite(raw) || raw <= 0) return 120_000;
				// An explicit operator override is honoured down to 1s (tests rely
				// on short timeouts); an unset/absurd value gets the safe default
				// with the 15s floor.
				if (process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S !== undefined) {
					return Math.max(1, Math.min(600, Math.floor(raw))) * 1000;
				}
				return Math.min(600, Math.max(15, Math.floor(raw))) * 1000;
			})();
			const prelaunch = (async () => {
				// Capability gate re-resolved at execution time — credentials may
				// have changed since creation. Falls back to the frozen
				// creation-time verdict (item.browserSupport) when present.
				const support = await resolveBrowserSupport(item.platform, item.browserCode);
				if (support.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED
					|| item.browserSupport?.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
					return { unsupported: support.reason ?? item.browserSupport?.reason ?? null };
				}
				// RT2 (#14704): pre-execution health gate. REAL probes (engine
				// launch, network, emulation) run before any session starts; a
				// failed check blocks the item with the exact reason — never
				// launched, never Passed.
				if (hooks.checkEnvironmentHealth) {
					const environment = await (services.environments?.get?.(item.environmentId) ?? null);
					const health = await hooks.checkEnvironmentHealth(environment ?? item, { targetUrl: run.targetUrl ?? null });
					if (health?.verdict === 'BLOCKED') {
						return { blocked: `Health check blocked execution: ${health.reason}`, healthChecks: health.checks };
					}
				}
				return { ok: true };
			})();
			let gate;
			{
				// Cancellable race: if the gate resolves first, the timer is
				// cleared so no stray 120s timer keeps the process alive.
				let timerExpired = false;
				let onTimer;
				let timer;
				const timeoutPromise = new Promise((_resolve, reject) => {
					onTimer = () => { timerExpired = true; reject(new Error('PRELAUNCH_TIMEOUT')); };
					timer = setTimeout(onTimer, PRELAUNCH_TIMEOUT_MS);
					if (typeof timer?.unref === 'function') timer.unref();
				});
				try {
					gate = await Promise.race([prelaunch, timeoutPromise]);
				} catch (error) {
					if (timerExpired) {
						await mark({
							status: 'ERROR',
							error: `Pre-launch checks did not complete within ${Math.round(PRELAUNCH_TIMEOUT_MS / 1000)}s (browser support / environment health / session creation).`,
							finishedAt: new Date().toISOString(),
							durationMs: Date.now() - Date.parse(startedAt)
						});
						return;
					}
					throw error;
				} finally {
					clearTimeout(timer);
				}
			}
			if (gate?.ok !== true) {
				if (gate?.unsupported !== undefined) {
					await mark({ status: 'NOT_SUPPORTED', reason: gate.unsupported, finishedAt: startedAt });
					return;
				}
				if (gate?.blocked) {
					await mark({
						status: 'UNAVAILABLE',
						reason: gate.blocked,
						healthChecks: gate.healthChecks,
						finishedAt: new Date().toISOString(),
						durationMs: 0
					});
					return;
				}
			}
			// REAL_DEVICE / VIRTUAL_DEVICE requests without a configured remote
			// runtime BLOCK — the existing agent path enforces this; the item
			// records the honest outcome rather than emulating silently.
			await mark({ status: 'RUNNING', startedAt });

			// #16159 follow-up (review WARN-1): session creation is ALSO inside
			// the bounded pre-launch window — a hung startSession (e.g. fork
			// EAGAIN under PID pressure) held a global slot forever.
			{
				let sessionTimerExpired = false;
				let sessionTimer;
				const sessionTimeout = new Promise((_resolve, reject) => {
					sessionTimer = setTimeout(() => { sessionTimerExpired = true; reject(new Error('PRELAUNCH_TIMEOUT')); }, PRELAUNCH_TIMEOUT_MS);
					if (typeof sessionTimer?.unref === 'function') sessionTimer.unref();
				});
				try {
					// Review WARN-1 (#16159): if the race times out but the
					// losing startSession promise later resolves, its session
					// (and browser) would leak — dispose it on late arrival.
					// Guard on sessionTimerExpired (NOT itemSession): this
					// wrapper runs inside the race's microtask chain, before
					// the await assigns itemSession, so a null check would
					// double-close every normally-created session.
					const sessionPromise = Promise.resolve(hooks.startSession(run, item)).then(
						(lateSession) => {
							if (sessionTimerExpired) {
								Promise.resolve(hooks.closeSessionBrowser?.(lateSession)).catch(() => undefined);
							}
							return lateSession;
						}
					);
					itemSession = await Promise.race([sessionPromise, sessionTimeout]);
				} catch (error) {
					if (sessionTimerExpired) {
						await mark({
							status: 'ERROR',
							error: `Session creation did not complete within ${Math.round(PRELAUNCH_TIMEOUT_MS / 1000)}s.`,
							finishedAt: new Date().toISOString(),
							durationMs: Date.now() - Date.parse(startedAt)
						});
						return;
					}
					throw error;
				} finally {
					clearTimeout(sessionTimer);
				}
			}
			const session = itemSession;
			await mark({ sessionId: session.id });
			await hooks.sendTask(session, run);

			// Poll until the session reaches a terminal state (the agent turn is
			// fire-and-forget inside startTurn). Timeout → ERROR, other items run.
			// Pipeline Phase 3 (#15493): awaiting_input may be resumed in place
			// when the run's authorization already covers the question — the
			// loop reuses the SAME session (no relaunch) and every auto-answer
			// is recorded on the item as evidence.
			let autoAnswers = item.autoAnswers ?? 0;
			let autoAnswerEvidence = [...(item.autoAnswerEvidence ?? [])];
			let outcome = await waitForSession(session.id, options => options);
			while (outcome.status === 'awaiting_input') {
				const question = outcome.pendingQuestion ?? null;
				const policy = deriveQuestionPolicy(run.securityAuthorization, run);
				const auto = autoAnswerFor(policy, question);
				if (!auto || autoAnswers >= MAX_AUTO_ANSWERS_PER_ITEM || !hooks.resumeSession) break;
				autoAnswers += 1;
				autoAnswerEvidence.push({
					at: new Date().toISOString(),
					question: String(question?.question ?? ''),
					answer: auto.answer,
					basis: auto.basis
				});
				await mark({ autoAnswers, autoAnswerEvidence });
				const resumed = await hooks.resumeSession(session, auto.answer);
				if (resumed === false) break;
				outcome = await waitForSession(session.id, options => options);
			}
			const finishedAt = new Date().toISOString();
			const durationMs = Date.now() - Date.parse(startedAt);

			if (outcome.status === 'error' || outcome.status === 'interrupted') {
				await mark({ status: 'ERROR', error: outcome.detail ?? outcome.status, finishedAt, durationMs });
				return;
			}
			if (outcome.status === 'awaiting_input') {
				// The workflow paused for a human answer that no policy
				// covers — it did not finish, so the honest state is BLOCKED
				// (needs input), never PASSED. The question text travels on
				// the item so the results board shows WHY.
				const question = outcome.pendingQuestion ?? null;
				await mark({
					status: 'BLOCKED',
					error: blockedReasonFor(question ?? { question: '' }),
					question: question ? String(question.question ?? '').slice(0, 2000) : null,
					finishedAt, durationMs
				});
				return;
			}
			const verdict = outcome.report?.verdict ?? null;
			const status = verdict === 'pass' ? 'PASSED'
				: verdict === 'pass_with_issues' ? 'PASSED'
				: verdict === 'fail' ? 'FAILED'
				: verdict === 'blocked' ? 'BLOCKED'
				// Matrix has no partial state: incomplete scope is never PASSED.
				: verdict === 'partial' ? 'BLOCKED'
				: outcome.status === 'done' ? 'PASSED' : null;
			if (!status) {
				await mark({ status: 'ERROR', error: `Unexpected session state "${outcome.status}" without report verdict.`, finishedAt, durationMs });
				return;
			}
			// #14650 (NI02 Phase 2): evidence per profile — runner identity,
			// execution level actually used (never the requested one), and
			// artifact refs (screenshots/videos the session actually produced).
			// Missing artifacts stay absent — never fabricated.
			const artifacts = hooks.collectArtifacts
				? (await hooks.collectArtifacts(session, item).catch(() => []))
				: [];
			// #14650 (NI02 Phase 2): known-defect fixture verification per
			// profile. The shared workflow runs first; fixtures are then
			// probed under this profile's own emulated context. NOT_VERIFIED
			// when the probe cannot run — never a guess, never fabricated.
			let fixtureVerdicts = [];
			if (Array.isArray(hooks.verifyFixtures) && hooks.verifyFixtures.length > 0) {
				const environment = await hooks.resolveEnvironment(item);
				fixtureVerdicts = await Promise.all(hooks.verifyFixtures.map(async (fixture) => {
					const verdict = await hooks.runFixtureVerification({ fixture, environment });
					return {
						fixtureId: fixture.id,
						// `expected` prefers the verdict's own resolution (the
						// app wiring resolves the FULL fixture — with its
						// predicate — there); falls back to the summary-level
						// expectation when the hook did not provide one.
						expected: verdict.expected ?? fixtureExpectation(fixture, environment),
						...verdict
					};
				}));
			}
			await mark({
				status,
				verdict,
				finishedAt,
				durationMs,
				executionLevel: outcome.runtimeFacts?.executionLevel ?? outcome.executionLevel ?? null,
				executionProvider: outcome.runtimeFacts?.provider ?? outcome.executionProviderActual ?? null,
				fixtureVerdicts,
				runtimeFacts: outcome.runtimeFacts ? {
					userAgent: outcome.runtimeFacts.userAgent ?? null,
					viewport: outcome.runtimeFacts.viewport ?? null,
					devicePixelRatio: outcome.runtimeFacts.devicePixelRatio ?? null,
					executionLevel: outcome.runtimeFacts.executionLevel ?? null,
					provider: outcome.runtimeFacts.provider ?? null
				} : null,
				artifactRefs: artifacts.map((meta) => ({
					artifactId: meta.artifactId,
					type: meta.type,
					contentType: meta.contentType,
					bytes: meta.bytes,
					capturedAt: meta.capturedAt,
					label: meta.label ?? null
				})),
				findings: (outcome.findings ?? []).map((finding) => ({
					title: finding.title,
					severity: finding.severity,
					category: finding.category,
					url: finding.url ?? finding.pageUrl ?? null,
					expected: finding.expected ?? null,
					actual: finding.actual ?? null,
					// RT5 (#14757): the EXACT environment the finding occurred
					// on — runtime-detected identity, not the catalog label.
					environment: {
						profileId: item.profileId,
						device: item.device,
						os: item.os,
						osVersion: item.osVersion,
						browser: item.browser,
						browserVersion: item.browserVersion,
						// Runtime-detected truth when present (the launched
						// engine/brand + observed UA); falls back to the
						// item-level execution facts.
						executionLevel: outcome.runtimeFacts?.executionLevel ?? item.executionLevel ?? null,
						executionProvider: outcome.runtimeFacts?.provider ?? item.executionProvider ?? null,
						launchedEngine: outcome.runtimeFacts?.launchedEngineId ?? null,
						userAgent: outcome.runtimeFacts?.userAgent ?? null,
						viewport: outcome.runtimeFacts?.viewport ?? null,
						brandedBinary: outcome.runtimeFacts?.brandedBinary ?? null
					},
					sessionId: session.id,
					matrixRunId: run.id
				}))
			});
		} catch (error) {
			const finishedAt = new Date().toISOString();
			const message = error?.code === 'RUNTIME_UNAVAILABLE'
				? `Blocked: ${error.message}`
				: (error instanceof Error ? error.message : String(error));
			const status = error?.code === 'RUNTIME_UNAVAILABLE' ? 'BLOCKED' : 'ERROR';
			await mark({ status, error: message, finishedAt, durationMs: Date.now() - Date.parse(startedAt) });
		} finally {
			// Pipeline Phase 3 (#15493): browser hygiene — every item closes its
			// child session's browser on the way out, terminal OR error. The
			// app wiring maps this to agent.closeBrowser (suspend semantics:
			// conversation survives, Chromium process does not linger). Guarded
			// so cleanup can never mask the item's real outcome.
			try {
				await hooks.closeSessionBrowser?.(itemSession);
			} catch (cleanupError) {
				console.warn('[matrix] browser cleanup failed:', cleanupError?.message ?? cleanupError);
			}
		}
	}

	/** Poll the run store until the session is terminal (or timeout → throws).
	 * #16225: the orchestrator is a SYSTEM actor, not a request. runs.get() is
	 * owner-scoped (AsyncLocalStorage actor → tenantContext fallback), so a
	 * boot-resumed run — or any fire-and-forget path that escapes the request
	 * context — read OTHER owners' sessions as undefined and stamped every
	 * item "Session … disappeared" while the orphaned session kept running,
	 * leaking its browser and RAM (OOM loop on prod, 2026-10-13). Peek the
	 * store unscoped instead: the orchestrator already holds the item's own
	 * sessionId from its own startSession call — no cross-owner data moves. */
	async function peekSessionUnscoped(sessionId) {
		if (typeof services.runs.peek === 'function') return services.runs.peek(sessionId);
		if (typeof services.runs.getAny === 'function') return services.runs.getAny(sessionId);
		if (typeof services.runs.getUnscoped === 'function') return services.runs.getUnscoped(sessionId);
		return services.runs.get(sessionId);
	}
	async function waitForSession(sessionId, _ignored) {
		const deadline = Date.now() + MAX_ITEM_MS;
		for (;;) {
			const session = await peekSessionUnscoped(sessionId);
			if (!session) throw new Error(`Session ${sessionId} disappeared during matrix run.`);
			if (['done', 'error', 'interrupted', 'awaiting_input'].includes(session.status)) {
				return session;
			}
			if (Date.now() > deadline) {
				// Pipeline Phase 4 (#15496): kill-on-timeout. A hung item must
				// not leak its browser process: abort the turn and dispose the
				// runtime (the local agent's stop does both), THEN surface the
				// timeout — the browser-process hygiene finally-block below
				// still runs as the second line of defense.
				try {
					await services.agent?.stop?.(sessionId);
				} catch (stopError) {
					console.warn(`[matrix] timeout kill failed for session ${sessionId}:`, stopError?.message ?? stopError);
				}
				throw Object.assign(new Error(`Matrix item timed out after ${Math.round(MAX_ITEM_MS / 1000)}s.`), { code: 'MATRIX_ITEM_TIMEOUT' });
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	return { start, cancel, retryItem, isActive, resumeRecovery: startResumeRecovery };
}

const MAX_ITEM_RETRIES = 2;

const POLL_INTERVAL_MS = 2000;
// #14276: a thorough QA agent pass on a real target routinely takes 10–20
// minutes; the old fixed 8-minute ceiling meant nearly every item died as
// an honest-but-useless timeout. Configurable via QASE_MATRIX_ITEM_TIMEOUT_S,
// default 20 minutes, clamped 60s–3600s.
const MAX_ITEM_MS = (() => {
	const raw = Number(process.env.QASE_MATRIX_ITEM_TIMEOUT_S ?? 20 * 60);
	if (!Number.isFinite(raw)) return 20 * 60 * 1000;
	return Math.min(3600, Math.max(60, Math.floor(raw))) * 1000;
})();

// #14649 + Pipeline Phase 4 (#15496): concurrency is configurable via
// QASE_MATRIX_PARALLEL and clamped by the environment ceiling — each parallel
// item holds one live browser process (~300–500 MB RSS realistic), so the
// budget is min(configured, cpuCores−2, memoryBudget). Defaults to 2 (safe on
// small containers); absurd values are clamped and the effective value is
// logged ONCE per process (not per run).
let parallelismLogged = false;
function configuredParallelism() {
	const raw = Number(process.env.QASE_MATRIX_PARALLEL ?? 2);
	let configured = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
	const cores = (os.availableParallelism?.() ?? os.cpus()?.length ?? 4);
	const coreBudget = Math.max(1, cores - 2);
	// Memory budget: reserve ~1.5 GB for the app itself, then one browser
	// per ~600 MB of remaining RAM, floor 1, cap 8.
	const totalMb = Math.round(((os.totalmem?.() ?? 6 * 1024 ** 3) / (1024 ** 2)));
	const memBudget = Math.max(1, Math.min(8, Math.floor((totalMb - 1536) / 600)));
	const effective = Math.min(configured, coreBudget, memBudget, 8);
	if (effective !== configured) {
		if (!parallelismLogged) {
			console.warn(`[matrix] QASE_MATRIX_PARALLEL=${configured} clamped to ${effective} by environment (cores=${cores}, mem=${totalMb}MB) — each parallel item holds a browser process.`);
			parallelismLogged = true;
		}
		configured = effective;
	}
	return configured;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function statusCounts(items) {
	const counts = { PASSED: 0, FAILED: 0, NOT_RUN: 0, UNAVAILABLE: 0, NOT_SUPPORTED: 0, BLOCKED: 0, ERROR: 0, PENDING: 0, RUNNING: 0, QUEUED: 0, CANCELLED: 0 };
	for (const item of items ?? []) {
		if (counts[item.status] !== undefined) counts[item.status] += 1;
	}
	return counts;
}
