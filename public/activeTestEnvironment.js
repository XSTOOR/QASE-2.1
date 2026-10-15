/**
 * activeTestEnvironment — the ONE device/environment selection state.
 *
 * The user picks a DEVICE; the environment (os + browser + execution level +
 * resolution) is resolved automatically from the environment records. This
 * store is the single source of truth for that selection: components read
 * from it, they never keep their own selectedDevice/selectedBrowser values.
 *
 * Persists to localStorage ('qase.activeTestEnvironment') and keeps the
 * legacy 'qase.environmentId' key in sync so existing flows (presets,
 * startEnvironmentRun, drawer default) keep working.
 */

const LEGACY_ENV_KEY = 'qase.environmentId';

/**
 * Canonical view of a selected environment. `deviceId` mirrors `envId`
 * (an environment IS the device+os+browser combination) so downstream
 * consumers have one stable shape.
 */
export function resolveForEnvironment(env) {
	if (!env) return null;
	return Object.freeze({
		envId: env.envId ?? env.id ?? null,
		deviceId: env.envId ?? env.id ?? null,
		device: env.device ?? null,
		deviceType: env.deviceType ?? null,
		platform: env.platform ?? null,
		os: env.os ?? null,
		osVersion: env.osVersion ?? null,
		browser: env.browser ?? null,
		browserVersion: env.browserVersion != null ? String(env.browserVersion) : null,
		resolution: env.screenResolution ?? env.screenSize ?? null,
		orientation: env.orientation ?? env.orientationScenario ?? 'portrait',
		// #14132: the catalog carries the honest level in `executionType`
		// (e.g. "VIRTUAL_DEVICE"); `executionLevelRequested` is only set when a
		// user override chose one. Without the fallback a fresh selection loses
		// its exec badge ("NO DEVICE") in the header.
		executionType: env.executionLevelRequested
			?? env.runtimeAttestedLevel
			?? (env.executionType ? String(env.executionType).toLowerCase() : null),
		availability: env.runtimeStatus ?? env.availability ?? null,
		// R5 #14494: the board's honest unavailability reason travels with the
		// selection so the live view can show REAL DEVICE UNAVAILABLE + reason.
		unavailableReason: env.unavailableReason ?? null,
		runtimeSessionId: env.runtimeSessionId ?? null,
		selectedAt: env.selectedAt ?? null
	});
}

export function createActiveTestEnvironmentStore({ persistenceKey = 'qase.activeTestEnvironment', storage = globalThis.localStorage } = {}) {
	function readPersisted() {
		try {
			const raw = storage?.getItem?.(persistenceKey);
			return raw ? JSON.parse(raw) : null;
		} catch {
			return null;
		}
	}

	function persist(selection) {
		try {
			if (selection) {
				storage?.setItem?.(persistenceKey, JSON.stringify({ envId: selection.envId, browserCode: selection.browserCode ?? null }));
				if (selection.envId) storage?.setItem?.(LEGACY_ENV_KEY, selection.envId);
			} else {
				storage?.removeItem?.(persistenceKey);
				storage?.removeItem?.(LEGACY_ENV_KEY);
			}
		} catch {
			// Storage unavailable (private mode) — selection is session-only.
		}
	}

	let current = null;

	return {
		/** Hydrate the persisted envId so callers can resolve it against the env list. */
		persistedEnvId() {
			const p = readPersisted();
			return p?.envId ?? storage?.getItem?.(LEGACY_ENV_KEY) ?? null;
		},
		/** Set the selection from an environment record. Returns the resolved view. */
		setSelection(env) {
			current = resolveForEnvironment(env ? { ...env, selectedAt: new Date().toISOString() } : null);
			persist(current ? { envId: current.envId, browserCode: env?.browserCode ?? null } : null);
			return current;
		},
		/** Current selection (resolved view) or null. */
		get() {
			return current;
		},
		clear() {
			current = null;
			persist(null);
		}
	};
}
