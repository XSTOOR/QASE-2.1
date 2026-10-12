import { closeBrowser, ensureRuntime, runTurn } from './agent.js';
import { getPublicConfig, saveConfig, testConnection, withUserConfiguration } from './config.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, secretNames, storeSecrets } from './secrets.js';
import {
	addActivity, addMessage, aggregateFindings, allSessions, bus, createSession, deleteSession, emit,
	getSession, dropLive, flushSessions, listSessions, liveEntries, liveFor, loadSessions,
	markExecutionStarted, markReportPhase, persistSoon, peekLive, setFindingStatus, setStatus,
	updateActivity, watchRunBus,
	loadFounderProjectState, writeFounderProjectState
} from './store.js';
import { createArtifactStore } from './artifactStore.js';
import { createEnvironmentService, createLocalEnvironmentBackend } from './environmentService.js';
import { createLocalDeviceCatalogBackend } from './localDeviceCatalog.js';
import { purgeRunWorkspace } from './workspaceLifecycle.js';
import { createLocalAuthService } from './auth.js';
import { currentRequestActor } from './requestActor.js';
import { collectEvidenceBundle } from './evidenceBundle.js';
import {
	closeFeedbackStore, createFeedback, deleteFeedback, feedbackStats,
	findFeedbackForRun, getFeedback, listFeedback, updateFeedback
} from './feedbackStore.js';

/**
 * Builds the non-persistence services around a run store. Both the rollback
 * file adapter and PostgreSQL adapter use this composition so the agent cannot
 * accidentally bypass the selected durable store. Authentication is injected
 * as a peer service so account data never enters the run aggregate.
 */
export function createRuntimeApplicationServices(runStore, options = {}) {
	async function inWorkspace(work, session) {
		const userId = session?.ownerUserId ?? currentRequestActor()?.actorUserId;
		if (!userId || !options.auth?.getSettings) return work();
		const settings = await options.auth.getSettings(userId);
		if (session) session.userMemory = await options.auth.listMemory(userId);
		return withUserConfiguration(settings, next => options.auth.saveSettings(userId, next), work);
	}
	const purgeWorkspace = options.purgeRunWorkspace ?? purgeRunWorkspace;
	// Phase 21: device runtime manager consulted by every run turn; may be absent.
	const deviceRuntime = options.deviceRuntime ?? null;
	// Phase 22: persisted evidence artifacts with execution-level metadata.
	const artifacts = options.artifactStore ?? createArtifactStore();
	// Device-matrix environment service (NIHARIKA). The runtime contract
	// (contracts.js) requires `environments`; compose a local backend-backed
	// instance so every local composition is contract-complete. Real startup
	// (serviceFactory) may override with its own configured instance.
	let environments = options.environments;
	if (!environments) {
		const catalogBackend = options.deviceCatalogBackend ?? createLocalDeviceCatalogBackend();
		environments = createEnvironmentService(
			createLocalEnvironmentBackend({ catalogBackend }),
			{ tenantContext: options.tenantContext ?? null }
		);
	}
	// subscribeGlobal exists only in local mode; PostgreSQL deployments
	// fan events out through their realtime transport instead.
	const subscribeGlobal = typeof runStore.subscribeGlobal === 'function'
		? runStore.subscribeGlobal.bind(runStore)
		: undefined;
	const services = {
		runs: runStore,
		// Feedback is store-backed in both adapters; the local implementation
		// (feedbackStore.js) ships with this composition, and the PostgreSQL
		// adapter overrides it below.
		feedback: options.feedbackStore ?? {
			create: input => createFeedback(input),
			get: getFeedback,
			list: options => listFeedback(options),
			update: (id, patch) => updateFeedback(id, patch),
			remove: deleteFeedback,
			stats: feedbackStats,
			forRun: (runId, submittedBy) => findFeedbackForRun(runId, submittedBy)
		},
		artifacts,
		environments,
		events: {
			publish: runStore.publish,
			subscribe: runStore.subscribe,
			...(subscribeGlobal ? { subscribeGlobal } : {})
		},
		configuration: {
			getPublic: () => inWorkspace(getPublicConfig),
			save: patch => inWorkspace(() => saveConfig(patch)),
			testConnection: patch => inWorkspace(() => testConnection(patch))
		},
		secrets: {
			clear: clearSecrets,
			names: secretNames,
			store: storeSecrets
		},
		reports: {
			buildMarkdown: buildReportMarkdown
		},
		agent: {
			closeBrowser: sessionId => closeBrowser(sessionId, runStore),
			async purgeArtifacts(sessionId) {
				const record = runStore.peekLive?.(sessionId);
				let disposalError;
				try {
					record?.controller?.abort();
					record?.dispose?.();
				} catch (error) {
					disposalError = error;
				} finally {
					runStore.dropLive?.(sessionId);
				}
				try {
					await purgeWorkspace(sessionId);
				} catch (workspaceError) {
					if (disposalError) {
						throw new AggregateError([disposalError, workspaceError], 'Run artifact cleanup failed.');
					}
					throw workspaceError;
				}
				if (disposalError) throw disposalError;
			},
			ensureRuntime: async session => inWorkspace(() => ensureRuntime(session, runStore), session),
			runTurn: (session, turnOptions, fallbackRuntime) => inWorkspace(() => runTurn(session, turnOptions, runStore, deviceRuntime ?? fallbackRuntime), session),
			getLiveState(sessionId) {
				const record = runStore.peekLive?.(sessionId);
				return {
					running: Boolean(record?.running),
					frame: record?.bridge?.getLastFrame?.()
				};
			},
			stop(sessionId) {
				const record = runStore.peekLive?.(sessionId);
				if (record?.running) {
					record.controller?.abort();
					return;
				}
				// No live turn to abort — but a browser runtime may still be
				// resident (crashed/recovered run, idle keep-open). A stop must
				// end ALL work for the session, so dispose the runtime and
				// release the browser instead of silently no-op'ing.
				record?.bridge?.stopFrames?.();
				record?.dispose?.();
				if (record) {
					delete record.runtime;
					delete record.bridge;
					delete record.dispose;
				}
			},
			async invalidateIdleRuntimes() {
				let kept = 0;
				const entries = typeof runStore.listLive === 'function'
					? runStore.listLive()
					: (await runStore.list({ limit: 100 })).map(summary => ({ id: summary.id, record: runStore.peekLive?.(summary.id) }));
				for (const { id, record } of entries) {
					if (currentRequestActor()?.actorUserId && !(await runStore.get(id))) continue;
					if (!record) continue;
					if (!record.runtime) continue;
					if (record.running) {
						kept++;
						continue;
					}
					record.dispose?.();
					delete record.runtime;
					delete record.bridge;
					delete record.dispose;
				}
				return kept;
			}
		},
		readiness: {
			async check() {
				const runs = await runStore.check();
				if (!options.auth?.check) return runs;
				const auth = await options.auth.check();
				return {
					...runs,
					ready: runs?.ready === true && auth?.ready === true,
					checks: { ...(runs?.checks ?? {}), auth: auth?.ready === true ? 'ready' : 'error' }
				};
			}
		},
		lifecycle: {
			close: async () => {
				await runStore.close?.();
				closeFeedbackStore();
				await options.auth?.close?.();
				await options.close?.();
			}
		}
	};
	if (options.auth) services.auth = options.auth;
	return services;
}

/**
 * Adapts the existing file-backed aggregate store to the asynchronous Phase 2
 * run contract. Methods remain behavior-compatible, but callers now await them
 * just as they will await PostgreSQL transactions.
 */
export function createLocalApplicationServices(options = {}) {
	let initialized = false;
	let closed = false;
	const ownerUserId = () => currentRequestActor()?.actorUserId ?? options.tenantContext?.actorUserId;
	// Phase 22: evidence artifacts shared by this run store and services.artifacts.
	const artifactStore = options.artifactStore ?? createArtifactStore();

	const runStore = {
		// #14649: raw run-bus emitter for non-session event sources (the matrix
		// orchestrator publishes progress keyed by matrix-run id through this).
		bus,
		async load() {
			loadSessions();
			initialized = true;
		},
		async create(title, options = {}) {
			const session = createSession(title, { ...options, ownerUserId: options.ownerUserId ?? ownerUserId() });
			if (options.eventType) {
				emit(session, options.eventType, options.eventPayload ?? {});
			}
			return session;
		},
		async get(id) {
			return getSession(id, ownerUserId());
		},
		async list(options) {
			return listSessions({ ...options, ownerUserId: ownerUserId() });
		},
		// Duration analytics for the in-memory store: computed from loaded
		// sessions so dev-without-Postgres still shows real numbers.
		async durationAnalytics({ targetUrl } = {}) {
			const completed = listSessions({ limit: 100, ownerUserId: ownerUserId() })
				.filter(candidate => {
					const session = getSession(candidate.id, undefined);
					if (!session?.startedAt || !session.completedAt) return false;
					if (targetUrl !== undefined && session.targetUrl !== targetUrl) return false;
					return true;
				})
				.map(candidate => getSession(candidate.id, undefined));
			// Active duration only: paused intervals are excluded.
			const active = session =>
				Math.max(0, (session.completedAt - session.startedAt) / 1000 - (session.pausedSeconds ?? 0));
			const durations = completed.map(active).sort((a, b) => a - b);
			const average = values => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined);
			const byTargetMap = new Map();
			for (const session of completed) {
				const entry = byTargetMap.get(session.targetUrl) ?? { runCount: 0, total: 0 };
				entry.runCount += 1;
				entry.total += active(session);
				byTargetMap.set(session.targetUrl, entry);
			}
			return {
				runCount: durations.length,
				minDurationSeconds: durations[0],
				maxDurationSeconds: durations[durations.length - 1],
				avgDurationSeconds: average(durations),
				medianDurationSeconds: durations.length
					? durations[Math.floor(durations.length / 2)]
					: undefined,
				avgSecondsPerItem: undefined,
				byTarget: [...byTargetMap.entries()].map(([url, entry]) => ({
					targetUrl: url,
					runCount: entry.runCount,
					avgDurationSeconds: entry.total / entry.runCount
				})),
				serverNow: Date.now()
			};
		},
		async targetDurationHistory(targetUrl, { limit = 20 } = {}) {
			return listSessions({ limit: 100, ownerUserId: ownerUserId() })
				.map(candidate => getSession(candidate.id, undefined))
				.filter(session => session?.startedAt && session.completedAt && session.targetUrl === targetUrl)
				.sort((a, b) => a.startedAt - b.startedAt)
				.slice(0, Math.min(100, Math.max(1, Number(limit) || 20)))
				.map(session => ({
					id: session.id,
					status: session.status,
					startedAt: session.startedAt,
					completedAt: session.completedAt,
					pausedAt: session.pausedAt,
					pausedSeconds: session.pausedSeconds ?? 0,
					durationSeconds: Math.max(0,
						(session.completedAt - session.startedAt) / 1000 - (session.pausedSeconds ?? 0))
				}));
		},
		/**
		 * Unscoped accessors for boot-time run recovery (runResume.js) and
		 * cross-user operator review (feedback review in app.js). The
		 * request-scoped list/get above filter by the current actor, which at
		 * boot is the default tenant actor — sessions owned by real users would
		 * be invisible and never resume. These deliberately bypass owner
		 * filtering; runResume re-enters each owner's actor context itself, and
		 * the operator endpoints re-apply their own role gate before calling.
		 */
		async listInterrupted() {
			return listSessions({ limit: 100, ownerUserId: undefined })
				.filter(session => session.status === 'interrupted')
				.map(summary => getSession(summary.id, undefined))
				.filter(Boolean);
		},
		async getAny(id) {
			return getSession(id, undefined);
		},
		/**
		 * Unscoped full-record list for coverage aggregation (Phase 7). list()
		 * caps at 100 and filters by owner; the coverage matrix needs every
		 * case×environment pair's latest run.
		 */
		async listAll() {
			return listSessions({ unbounded: true });
		},
		async delete(id) {
			return deleteSession(id, ownerUserId());
		},
		async commit(session, type, payload = {}) {
			emit(session, type, payload);
			return session;
		},
		async setFindingStatus(session, findingId, patch) {
			const finding = setFindingStatus(session, findingId, patch ?? {});
			emit(session, 'finding_status', { finding });
			return finding;
		},
		async aggregateFindings(options) {
			return aggregateFindings({ ...options, ownerUserId: options?.ownerUserId ?? ownerUserId() });
		},
		/** Persist execution-level facts (level/provider/runtime facts) on a run. */
		async persistExecutionFacts(runId, { executionLevel, executionProviderActual, runtimeFacts } = {}) {
			const session = getSession(runId, undefined);
			if (!session) return null;
			if (executionLevel !== undefined) session.executionLevel = executionLevel;
			if (executionProviderActual !== undefined) session.executionProviderActual = executionProviderActual;
			if (runtimeFacts !== undefined) session.runtimeFacts = runtimeFacts;
			persistSoon();
			emit(session, 'execution_facts', {
				executionLevel: session.executionLevel,
				executionProviderActual: session.executionProviderActual,
				runtimeFacts: session.runtimeFacts
			});
			return session;
		},
		/** Phase 22: persist a final-frame evidence artifact for the run. */
		async saveEvidenceArtifact(session, bridgeHandle) {
			// The agent passes { bridge } so runtime facts are available on it.
			const bridge = bridgeHandle?.getLastFrame ? bridgeHandle : bridgeHandle?.bridge;
			// RT5 (#14757): wire the session's video sink BEFORE any artifact
			// flow — videos finalized at context close flow into the same
			// per-session artifact store (stamped with execution metadata).
			if (bridge?.setVideoSink) {
				bridge.setVideoSink(async (bytes, meta) => {
					if (!bytes?.length) return null;
					return artifactStore.save(session, {
						type: 'video',
						fileName: meta.fileName,
						bytes,
						label: 'Session video recording (context-level, Chromium only)',
						bridgeExecution: bridge.execution ?? null
					});
				});
			}
			const frame = bridge?.getLastFrame?.();
			if (!frame?.base64) return null;
			return artifactStore.save(session, {
				type: 'screenshot',
				fileName: `final-frame-${session.id.slice(0, 8)}.jpg`,
				bytes: frame.base64,
				label: 'Final browser frame at end of run',
				bridgeExecution: bridge?.execution ?? null
			});
		},
		/**
		 * R4 #14493: persist the run's runtime-sourced evidence bundle —
		 * observed identity, console, network, security blocks — as a JSON
		 * artifact. Never fabricates: unobservable entries are recorded absent.
		 */
		async saveEvidenceBundle(session, bridgeHandle, { diagnostics = null } = {}) {
			const bridge = bridgeHandle?.getLastFrame ? bridgeHandle : bridgeHandle?.bridge;
			const { bundle } = collectEvidenceBundle({ session, bridge, diagnostics });
			return artifactStore.save(session, {
				type: 'evidence-bundle',
				fileName: `evidence-bundle-${session.id.slice(0, 8)}.json`,
				bytes: Buffer.from(JSON.stringify(bundle, null, 2), 'utf8'),
				label: 'Runtime evidence bundle (identity · console · network · security blocks)',
				bridgeExecution: bridge?.execution ?? null
			});
		},
		/** Project-level Founder Mode state (Phase 3), local file mirror. */
		async getFounderProjectState() {
			return loadFounderProjectState();
		},
		async saveFounderProjectState(state) {
			return writeFounderProjectState(state);
		},
		async addMessage(session, message) {
			return addMessage(session, message);
		},
		async addActivity(session, activity) {
			return addActivity(session, activity);
		},
		async updateActivity(session, id, patch) {
			return updateActivity(session, id, patch);
		},
		async setStatus(session, status, detail) {
			setStatus(session, status, detail);
		},
		markReportPhase,
		markExecutionStarted,
		publish: emit,
		subscribe(sessionId, listener) {
			bus.on(sessionId, listener);
			return () => bus.off(sessionId, listener);
		},
		/** Global run-bus subscription: observes events from every session. */
		subscribeGlobal(listener) {
			return watchRunBus(listener);
		},
		liveFor,
		peekLive,
		dropLive,
		listLive: liveEntries,
		check() {
			return {
				ready: initialized && !closed,
				checks: { localRunStore: initialized && !closed ? 'ready' : 'initializing' }
			};
		},
		async close() {
			flushSessions();
			closed = true;
		}
	};

	const auth = createLocalAuthService({
		tenantContext: options.tenantContext,
		file: options.authFile
	});
	return createRuntimeApplicationServices(runStore, {
		...options,
		auth: options.auth ?? auth,
		deviceRuntime: options.deviceRuntime
	});
}
