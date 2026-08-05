import { closeBrowser, ensureRuntime, runTurn } from './agent.js';
import { getPublicConfig, saveConfig, testConnection } from './config.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, secretNames, storeSecrets } from './secrets.js';
import {
	addMessage, bus, createSession, deleteSession, emit, getSession,
	listSessions, liveFor, loadSessions, setStatus
} from './store.js';

/**
 * Adapts the current file- and memory-backed implementation to the application
 * service contract. This preserves today's behavior while making the boundary
 * explicit for later infrastructure phases.
 */
export function createLocalApplicationServices() {
	let initialized = false;

	return {
		runs: {
			load() {
				loadSessions();
				initialized = true;
			},
			create: createSession,
			get: getSession,
			list: listSessions,
			delete: deleteSession,
			addMessage,
			setStatus
		},
		events: {
			publish: emit,
			subscribe(sessionId, listener) {
				bus.on(sessionId, listener);
				return () => bus.off(sessionId, listener);
			}
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
			closeBrowser,
			ensureRuntime,
			runTurn,
			getLiveState(sessionId) {
				const record = liveFor(sessionId);
				return {
					running: Boolean(record.running),
					frame: record.bridge?.getLastFrame?.()
				};
			},
			stop(sessionId) {
				liveFor(sessionId).controller?.abort();
			},
			invalidateIdleRuntimes() {
				let kept = 0;
				for (const summary of listSessions()) {
					const record = liveFor(summary.id);
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
			check() {
				return {
					ready: initialized,
					checks: { localRunStore: initialized ? 'ready' : 'initializing' }
				};
			}
		}
	};
}
