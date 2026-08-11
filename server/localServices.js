import { closeBrowser, ensureRuntime, runTurn } from './agent.js';
import { getPublicConfig, saveConfig, testConnection } from './config.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, secretNames, storeSecrets } from './secrets.js';
import {
	addActivity, addMessage, bus, createSession, deleteSession, emit, getSession,
	dropLive, flushSessions, listSessions, liveFor, loadSessions, peekLive, setStatus, updateActivity
} from './store.js';
import { purgeRunWorkspace } from './workspaceLifecycle.js';

/**
	* Builds the non-persistence services around a run store. Both the rollback
	* file adapter and PostgreSQL adapter use this composition so the agent cannot
	* accidentally bypass the selected durable store.
 */
export function createRuntimeApplicationServices(runStore, options = {}) {
	const purgeWorkspace = options.purgeRunWorkspace ?? purgeRunWorkspace;
	return {
		runs: runStore,
		events: {
			publish: runStore.publish,
			subscribe: runStore.subscribe
		},
		configuration: {
			getPublic: getPublicConfig,
			save: saveConfig,
			testConnection
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
			ensureRuntime: session => ensureRuntime(session, runStore),
			runTurn: (session, turnOptions) => runTurn(session, turnOptions, runStore),
			getLiveState(sessionId) {
				const record = runStore.liveFor(sessionId);
				return {
					running: Boolean(record.running),
					frame: record.bridge?.getLastFrame?.()
				};
			},
			stop(sessionId) {
				runStore.liveFor(sessionId).controller?.abort();
			},
			async invalidateIdleRuntimes() {
				let kept = 0;
				for (const summary of await runStore.list()) {
					const record = runStore.liveFor(summary.id);
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
			check: () => runStore.check()
		},
		lifecycle: {
			close: async () => {
				await runStore.close?.();
				await options.close?.();
			}
		}
	};
}

/**
 * Adapts the existing file-backed aggregate store to the asynchronous Phase 2
 * run contract. Methods remain behavior-compatible, but callers now await them
 * just as they will await PostgreSQL transactions.
 */
export function createLocalApplicationServices() {
	let initialized = false;
	let closed = false;

	const runStore = {
		async load() {
			loadSessions();
			initialized = true;
		},
		async create(title) {
			return createSession(title);
		},
		async get(id) {
			return getSession(id);
		},
		async list() {
			return listSessions();
		},
		async delete(id) {
			return deleteSession(id);
		},
		async commit(session, type, payload = {}) {
			emit(session, type, payload);
			return session;
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
		publish: emit,
		subscribe(sessionId, listener) {
			bus.on(sessionId, listener);
			return () => bus.off(sessionId, listener);
		},
		liveFor,
		peekLive,
		dropLive,
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

	return createRuntimeApplicationServices(runStore);
}
