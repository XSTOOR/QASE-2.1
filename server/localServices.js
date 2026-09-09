import { closeBrowser, ensureRuntime, runTurn } from './agent.js';
import { getPublicConfig, saveConfig, testConnection } from './config.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, secretNames, storeSecrets } from './secrets.js';
import {
	addActivity, addMessage, bus, createSession, deleteSession, emit, getSession,
	dropLive, flushSessions, listSessions, liveEntries, liveFor, loadSessions, peekLive, setStatus, updateActivity
} from './store.js';
import { purgeRunWorkspace } from './workspaceLifecycle.js';
import { createLocalAuthService } from './auth.js';
import { currentRequestActor } from './requestActor.js';

/**
 * Builds the non-persistence services around a run store. Both the rollback
 * file adapter and PostgreSQL adapter use this composition so the agent cannot
 * accidentally bypass the selected durable store. Authentication is injected
 * as a peer service so account data never enters the run aggregate.
 */
export function createRuntimeApplicationServices(runStore, options = {}) {
	const purgeWorkspace = options.purgeRunWorkspace ?? purgeRunWorkspace;
	const services = {
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
				const record = runStore.peekLive?.(sessionId);
				return {
					running: Boolean(record?.running),
					frame: record?.bridge?.getLastFrame?.()
				};
			},
			stop(sessionId) {
				runStore.peekLive?.(sessionId)?.controller?.abort();
			},
			async invalidateIdleRuntimes() {
				let kept = 0;
				const entries = typeof runStore.listLive === 'function'
					? runStore.listLive()
					: (await runStore.list({ limit: 100 })).map(summary => ({ id: summary.id, record: runStore.peekLive?.(summary.id) }));
				for (const { record } of entries) {
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

	const runStore = {
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
		async delete(id) {
			return deleteSession(id, ownerUserId());
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
	return createRuntimeApplicationServices(runStore, { auth });
}
