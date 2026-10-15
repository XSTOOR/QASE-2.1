/**
 * Phase 21 · Device Runtime Manager.
 *
 * Owns device availability, session lifecycle and the device queue. The
 * manager is the ONLY place a session's execution level is decided, and it
 * decides from provider attestations — never from device names, UA strings or
 * viewport emulation.
 *
 * Honest fallback contract: when the requested level is unavailable the
 * manager does NOT silently downgrade. It returns the explicit choices
 * [Queue Real Device] / [Run Virtual Device] / [Run Simulated] and waits for a
 * decision.
 */

import { randomUUID } from 'node:crypto';
import { EXECUTION_LEVELS, AVAILABILITY } from './provider.js';
import { NOT_AVAILABLE_FOR_REAL_EXECUTION } from './nullRealDeviceProvider.js';

let sessionCounter = 0;
function nextSessionId() {
	sessionCounter = (sessionCounter + 1) % 10000;
	return `QASE-DR-${String(sessionCounter).padStart(4, '0')}`;
}

/**
 * @param {Object} options
 * @param {Array}  options.providers  Provider instances (validated against the contract).
 */
export function createDeviceRuntimeManager({ providers = [], now = () => Date.now() } = {}) {
	const registered = providers.filter((provider) => {
		const ok = typeof provider?.id === 'string';
		if (!ok) console.warn('[deviceRuntime] rejecting invalid provider');
		return ok;
	});

	const providerForLevel = (level) => {
		for (const provider of registered) {
			if (provider.capabilities?.supportedLevels?.includes(level)) return provider;
		}
		return null;
	};

	/** Device key: one slot per environment identity. */
	const deviceKey = (environment) => `${environment?.envId ?? environment?.device ?? 'default'}`;

	/** @type {Map<string, {envId, status, currentSessionId, lastTestedAt, lastResult}>} */
	const devices = new Map();
	/** @type {Map<string, session>} */
	const sessions = new Map();
	/** @type {Array<{sessionId, deviceKey, resolve}>} FIFO queue per device. */
	const queues = new Map();

	function deviceState(environment) {
		const key = deviceKey(environment);
		if (!devices.has(key)) {
			devices.set(key, {
				envId: environment?.envId ?? key,
				device: environment?.device ?? null,
				platform: environment?.platform ?? null,
				osVersion: environment?.osVersion ?? null,
				browser: environment?.browser ?? null,
				status: AVAILABILITY.AVAILABLE,
				currentSessionId: null,
				lastTestedAt: null,
				lastResult: null,
				maximumLevel: maximumLevelFor(environment)
			});
		}
		return devices.get(key);
	}

	/** The best level any registered provider can honestly offer for this environment. */
	function maximumLevelFor(environment) {
		const order = [EXECUTION_LEVELS.SIMULATED, EXECUTION_LEVELS.VIRTUAL_DEVICE, EXECUTION_LEVELS.REAL_DEVICE];
		let best = null;
		for (const provider of registered) {
			for (const level of provider.capabilities?.supportedLevels ?? []) {
				// REAL_DEVICE needs this provider to attest THIS environment as physical.
				if (level === EXECUTION_LEVELS.REAL_DEVICE
					&& typeof provider.attestPhysicalDevice === 'function'
					&& !provider.attestPhysicalDevice(environment).physical) {
					continue;
				}
				if (!best || order.indexOf(level) > order.indexOf(best)) best = level;
			}
		}
		return best;
	}

	function queueFor(key) {
		if (!queues.has(key)) queues.set(key, []);
		return queues.get(key);
	}

	function queuePosition(sessionId) {
		for (const [key, entries] of queues.entries()) {
			const index = entries.findIndex((entry) => entry.sessionId === sessionId);
			if (index !== -1) return { deviceKey: key, position: index + 1, total: entries.length };
		}
		return null;
	}

	/**
	 * Request a session at a level. Never downgrades silently: an unavailable
	 * level returns { status: 'not_available', choices } describing the honest
	 * options the caller may offer the user.
	 */
	async function requestSession({ environment, requestedLevel, linkedRunId, linkedTestCaseId, allowQueue = true } = {}) {
		const level = requestedLevel ?? EXECUTION_LEVELS.SIMULATED;
		const provider = providerForLevel(level);

		if (!provider) {
			// No provider can honestly run at this level.
			const choices = [];
			if (providerForLevel(EXECUTION_LEVELS.REAL_DEVICE)) choices.push({ action: 'queue_real_device', label: 'Queue Real Device' });
			if (providerForLevel(EXECUTION_LEVELS.VIRTUAL_DEVICE)) choices.push({ action: 'run_virtual_device', label: 'Run Virtual Device' });
			if (providerForLevel(EXECUTION_LEVELS.SIMULATED)) choices.push({ action: 'run_simulated', label: 'Run Simulated' });
			return {
				status: 'not_available',
				notAvailable: NOT_AVAILABLE_FOR_REAL_EXECUTION,
				requestedLevel: level,
				choices,
				reason: `No connected provider supports ${level} execution.`,
				maximumLevel: maximumLevelFor(environment)
			};
		}

		const state = deviceState(environment);

		if (state.status === AVAILABILITY.BUSY) {
			if (allowQueue && provider.capabilities?.queueable) {
				const created = await provider.create_session({ environment, linkedRunId, linkedTestCaseId });
				const session = {
					sessionId: nextSessionId(),
					environment,
					level,
					providerId: provider.id,
					status: 'queued',
					queue: queueFor(deviceKey(environment)).length + 1,
					linkedRunId: linkedRunId ?? null,
					linkedTestCaseId: linkedTestCaseId ?? null,
					createdAt: new Date(now()).toISOString()
				};
				sessions.set(session.sessionId, session);
				queueFor(deviceKey(environment)).push({ sessionId: session.sessionId });
				return { status: 'queued', session, queuePosition: queuePosition(session.sessionId) };
			}
			return {
				status: 'busy',
				deviceBusy: true,
				currentSessionId: state.currentSessionId,
				choices: [
					{ action: 'queue', label: 'Queue for this device' },
					{ action: 'run_simulated', label: 'Run Simulated' }
				]
			};
		}

		const created = await provider.create_session({ environment, linkedRunId, linkedTestCaseId });
		if (created?.unavailable) {
			return { status: 'not_available', notAvailable: NOT_AVAILABLE_FOR_REAL_EXECUTION, reason: created.reason };
		}
		const session = {
			sessionId: nextSessionId(),
			environment,
			level,
			providerId: provider.id,
			status: 'created',
			linkedRunId: linkedRunId ?? null,
			linkedTestCaseId: linkedTestCaseId ?? null,
			createdAt: new Date(now()).toISOString(),
			...('attestation' in created ? { attestation: created.attestation } : {})
		};
		sessions.set(session.sessionId, session);

		// Claim the device and start immediately. A provider crash here must
		// never wedge the device BUSY: mark the session failed, release, and
		// advance the queue.
		state.status = AVAILABILITY.BUSY;
		state.currentSessionId = session.sessionId;
		try {
			const started = await provider.start_session(session);
			session.status = started.status ?? 'running';
			session.startedAt = new Date(now()).toISOString();
			return { status: 'started', session };
		} catch (error) {
			session.status = 'failed';
			session.reason = `Provider ${provider.id} failed to start: ${error?.message ?? 'unknown error'}`;
			session.endedAt = new Date(now()).toISOString();
			const release = await completeSession(session.sessionId, { result: 'failed' });
			return { status: 'failed', session, reason: session.reason, startedNext: release.startedNext };
		}
	}

	/** Release a device; auto-starts the next queued session if one waits. */
	async function completeSession(sessionId, { result } = {}) {
		const session = sessions.get(sessionId);
		if (!session) return { released: false, reason: 'unknown session' };
		const key = deviceKey(session.environment);
		const state = devices.get(key);

		session.status = result === 'failed' ? 'failed' : 'done';
		session.endedAt = new Date(now()).toISOString();
		if (state) {
			if (state.currentSessionId === sessionId) {
				state.currentSessionId = null;
				state.status = AVAILABILITY.AVAILABLE;
				state.lastTestedAt = session.endedAt;
				state.lastResult = result ?? 'done';
			}
		}

		// Auto-start the next queued session for this device.
		let startedNext = null;
		const queue = queueFor(key);
		while (queue.length) {
			const next = queue.shift();
			const nextSession = sessions.get(next.sessionId);
			if (!nextSession || nextSession.status === 'cancelled') continue;
			nextSession.status = 'running';
			nextSession.startedAt = new Date(now()).toISOString();
			nextSession.queue = 0;
			if (state) {
				state.status = AVAILABILITY.BUSY;
				state.currentSessionId = nextSession.sessionId;
			}
			const provider = registered.find((p) => p.id === nextSession.providerId);
			if (provider) {
				const started = await provider.start_session(nextSession);
				nextSession.status = started.status ?? nextSession.status;
			}
			startedNext = nextSession.sessionId;
			break;
		}
		return { released: true, startedNext };
	}

	/** Cancel: queued sessions leave cleanly; running sessions release the device. */
	async function cancelSession(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return { cancelled: false, reason: 'unknown session' };
		if (session.status === 'queued') {
			const key = deviceKey(session.environment);
			const queue = queueFor(key);
			const index = queue.findIndex((entry) => entry.sessionId === sessionId);
			if (index !== -1) queue.splice(index, 1);
			session.status = 'cancelled';
			return { cancelled: true, wasQueued: true };
		}
		if (session.status === 'running' || session.status === 'created') {
			session.status = 'cancelled';
			session.endedAt = new Date(now()).toISOString();
			const release = await completeSession(sessionId, { result: 'cancelled' });
			return { cancelled: true, wasRunning: true, startedNext: release.startedNext };
		}
		return { cancelled: false, reason: `session already ${session.status}` };
	}

	/**
	 * Agent bridge: honest pre-flight for a run. Returns the execution level
	 * actually achievable for the run's environment and — when a provider can
	 * start it — a device session. Never upgrades and never silently
	 * downgrades: the caller decides from { status, choices }.
	 */
	async function selectForRun(record) {
		const session = record?.session ?? record ?? {};
		const environment = session.environment
			?? session.environmentSnapshot
			?? record?.environment
			?? record?.environmentSnapshot
			?? null;
		if (!environment) return null;
		const requested = session.executionLevelRequested ?? null;
		// R3 #14492: a REAL/VIRTUAL request against an environment whose board
		// maximum is SIMULATED-only can never run at the requested level —
		// report 'not_available' with the honest reason instead of letting the
		// provider default the level down to SIMULATED.
		const boardMaximum = maximumLevelFor(environment);
		const realRequested = requested === EXECUTION_LEVELS.REAL_DEVICE || requested === EXECUTION_LEVELS.VIRTUAL_DEVICE;
		if (realRequested
			&& boardMaximum !== EXECUTION_LEVELS.REAL_DEVICE
			&& boardMaximum !== EXECUTION_LEVELS.VIRTUAL_DEVICE) {
			const state = deviceState(environment);
			return {
				status: 'not_available',
				requestedLevel: requested,
				maximumLevel: boardMaximum,
				notAvailable: NOT_AVAILABLE_FOR_REAL_EXECUTION,
				reason: state.unavailableReason ?? `No connected runtime supports ${requested} execution for this environment.`,
				choices: [
					...(providerForLevel(EXECUTION_LEVELS.SIMULATED)
						? [{ action: 'run_simulated', label: 'Run Simulated' }] : [])
				]
			};
		}
		const result = await requestSession({
			environment,
			requestedLevel: requested ?? EXECUTION_LEVELS.SIMULATED,
			linkedRunId: record?.session?.id ?? record?.runId ?? null,
			linkedTestCaseId: record?.session?.linkedTestCaseId ?? null,
			allowQueue: false
		});
		const level = result.session?.level
			?? maximumLevelFor(environment)
			?? EXECUTION_LEVELS.SIMULATED;
		const provider = providerForLevel(level);
		return {
			status: result.status,
			executionLevel: level,
			provider: provider?.id ?? 'none',
			deviceSession: result.session ?? null,
			choices: result.choices ?? null,
			runtimeFacts: null
		};
	}

	function getSession(sessionId) {
		const session = sessions.get(sessionId);
		if (!session) return null;
		const position = queuePosition(sessionId);
		return { ...session, queuePosition: position ? position.position : 0 };
	}

	function listSessions({ status } = {}) {
		return [...sessions.values()]
			.filter((session) => !status || session.status === status)
			.map((session) => ({ ...session, queuePosition: queuePosition(session.sessionId)?.position ?? 0 }))
			.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	}

	function deviceBoard() {
		return [...devices.values()].map((state) => ({
			envId: state.envId,
			device: state.device,
			platform: state.platform,
			osVersion: state.osVersion,
			browser: state.browser,
			status: state.status,
			unavailableReason: state.unavailableReason ?? null,
			maximumLevel: state.maximumLevel,
			currentSessionId: state.currentSessionId,
			queueLength: queueFor(deviceKey({ envId: state.envId })).length,
			lastTestedAt: state.lastTestedAt,
			lastResult: state.lastResult
		}));
	}

	/**
	 * Pre-register environments on the availability board so the UI can show
	 * Execution Type / Availability / queue length BEFORE the first session
	 * touches a device. Purely additive — deviceState() is a no-op for keys
	 * that already exist. Existing statuses (BUSY, lastTested…) are preserved.
	 *
	 * RT2 (#14704) honest availability baseline. The board reflects what the
	 * LOCAL runtime can really execute (RT1 binary registry + browser support
	 * resolution):
	 *  - an environment whose browser resolves supported / engine-equivalent
	 *    locally is AVAILABLE (its honest maximum level — SIMULATED for the
	 *    local emulation provider — is labeled as such, never as a device
	 *    farm; execution is a real local browser binary);
	 *  - an environment whose browser is NOT_SUPPORTED (DuckDuckGo) or whose
	 *    platform has no execution path is UNAVAILABLE with the exact reason;
	 *  - a provider-attested REAL_DEVICE/VIRTUAL_DEVICE environment keeps the
	 *    pre-RT2 semantics (AVAILABLE when connected, else OFFLINE naming the
	 *    missing capability).
	 *
	 * @param {Array} environments catalog rows
	 * @param {object} [options]
	 * @param {(platform:string, browserCode:string) => Promise<{status:string, reason?:string}>} [options.resolveBrowserSupport]
	 *   Injected (defaults to the real resolver) so tests can stub support.
	 */
	function seedBoard(environments = [], options = {}) {
		for (const environment of environments) {
			if (!environment?.envId) continue;
			const state = deviceState(environment);
			if (state.currentSessionId) continue; // live session wins — never rewrite
			const level = state.maximumLevel;
			const realRuntime = level === EXECUTION_LEVELS.REAL_DEVICE || level === EXECUTION_LEVELS.VIRTUAL_DEVICE;
			if (realRuntime) {
				// Provider-attested runtime: AVAILABLE already set by the provider
				// attestation path; leave it (dormant without a device farm).
				continue;
			}
			if (level === EXECUTION_LEVELS.SIMULATED) {
				// RT2: local simulated execution is REAL local-browser execution.
				// Availability follows the browser-support resolution: executable
				// locally → AVAILABLE; NOT_SUPPORTED → UNAVAILABLE with reason.
				const resolve = options.resolveBrowserSupport;
				if (typeof resolve !== 'function') continue;
				const support = resolve(environment.platform, environment.browserCode);
				const settled = support && typeof support.then === 'function'
					? support.catch(() => null)
					: Promise.resolve(support);
				settled.then((result) => {
					if (!result || state.currentSessionId) return;
					if (result.status === 'not_supported') {
						state.status = AVAILABILITY.UNAVAILABLE;
						state.unavailableReason = result.reason ?? 'Browser not executable on this runtime.';
					} else if (state.status === AVAILABILITY.AVAILABLE || state.status === AVAILABILITY.OFFLINE) {
						state.status = AVAILABILITY.AVAILABLE;
						state.unavailableReason = null;
					}
				}).catch(() => { /* keep prior status — resolution failures never flip a state */ });
				continue;
			}
			// No provider can offer ANY level for this environment (e.g. a
			// real-device provider without credentials) — honest OFFLINE naming
			// the missing capability; never AVAILABLE by default.
			if (state.status === AVAILABILITY.AVAILABLE) {
				state.status = AVAILABILITY.OFFLINE;
				state.unavailableReason = 'No execution runtime connected for this environment — register a provider to execute it.';
			}
		}
		return devices.size;
	}

	return {
		requestSession,
		selectForRun,
		completeSession,
		cancelSession,
		getSession,
		listSessions,
		deviceBoard,
		seedBoard,
		maximumLevelFor,
		providers: registered.map((provider) => ({ id: provider.id, capabilities: provider.capabilities }))
	};
}
