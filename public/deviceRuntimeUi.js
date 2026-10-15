/**
 * Device runtime UI helpers (Phase 23).
 *
 * Pure, DOM-free helpers that map the /api/device-runtime/devices board and
 * /api/device-runtime/sessions payloads onto display state, plus the honest
 * fallback-option resolution used by the one-click run flow.
 *
 * The honesty rules mirror the server's Device Runtime Manager:
 * - availability is what the manager reports, never guessed;
 * - REAL DEVICE is only ever offered when a provider attests it;
 * - a fallback is an explicit user choice, never a silent downgrade.
 */

export const AVAILABILITY_META = Object.freeze({
	AVAILABLE: { label: 'Available', dot: 'ok', title: 'Device is free and can start a session now.' },
	PREPARING: { label: 'Preparing', dot: 'busy', title: 'Runtime is preparing (engine launching, health checks running).' },
	RUNNING: { label: 'Running', dot: 'busy', title: 'A session is executing on this profile right now.' },
	BUSY: { label: 'Busy', dot: 'busy', title: 'A session is running on this device; new requests queue.' },
	OFFLINE: { label: 'Real device offline', dot: 'offline', title: 'No real-device runtime is connected for this environment — execution is blocked until a device-farm provider is registered.' },
	ERROR: { label: 'Error', dot: 'offline', title: 'This profile\'s runtime reported an error — see the reason for details.' },
	UNAVAILABLE: { label: 'Unavailable', dot: 'offline', title: 'This browser/OS combination cannot execute on this runtime — see the reason.' },
	NOT_EXECUTABLE: { label: 'Not executable', dot: 'offline', title: 'No provider can execute on this combination.' }
});

/** Display meta for a device-board status; unknown statuses render offline. */
export function availabilityMeta(status) {
	return AVAILABILITY_META[status] ?? AVAILABILITY_META.OFFLINE;
}

/**
 * Human label for the best level any provider honestly offers:
 * REAL_DEVICE → "Real device", VIRTUAL_DEVICE → "Virtual device",
 * SIMULATED → "Simulated", null/unknown → "Not executable (real)".
 */
export function executionTypeLabel(maximumLevel) {
	if (maximumLevel === 'REAL_DEVICE') return 'Real device';
	if (maximumLevel === 'VIRTUAL_DEVICE') return 'Virtual device';
	if (maximumLevel === 'SIMULATED') return 'Simulated';
	return 'Not executable (real)';
}

function labelFor(level) {
	if (level === 'REAL_DEVICE') return 'a real device';
	if (level === 'VIRTUAL_DEVICE') return 'a virtual device';
	if (level === 'SIMULATED') return 'simulated';
	return String(level);
}

/**
 * Resolve the honest fallback choices for a one-click run, given the device
 * board entry (or null) and the requested level. Returns:
 *   { available, reason, requestedLevel, maximumLevel,
 *     options: [{ action, level, label, description }] }
 *
 * `available` is true only when the requested level can start right now.
 * When it cannot, `options` carries the explicit downgrades/queue choice the
 * USER picks — the UI must present them, never select one silently.
 * REAL_DEVICE is only offered when the board's maximumLevel attests it.
 */
export function fallbackOptionsFor(boardEntry, requestedLevel = 'REAL_DEVICE') {
	const maximumLevel = boardEntry?.maximumLevel ?? null;
	const status = boardEntry?.status ?? 'OFFLINE';
	if (maximumLevel === requestedLevel && status === 'AVAILABLE') {
		return { available: true, requestedLevel, maximumLevel, options: [] };
	}
	const busySession = boardEntry?.currentSessionId ?? null;
	const busy = status === 'BUSY';
	const options = [];
	if (status === 'BUSY') {
		options.push({
			action: 'queue',
			level: requestedLevel,
			label: `Queue ${labelFor(requestedLevel).replace(/^a /, '')}`,
			description: 'The device is busy — your run starts automatically when it frees up.'
		});
	}
	if (maximumLevel === 'REAL_DEVICE') {
		options.push({ action: 'run_real', level: 'REAL_DEVICE', label: 'Run on Real Device', description: 'A connected provider attests this physical device.' });
	}
	if (maximumLevel === 'VIRTUAL_DEVICE' || maximumLevel === 'REAL_DEVICE') {
		options.push({ action: 'run_virtual_device', level: 'VIRTUAL_DEVICE', label: 'Run Virtual Device', description: 'Runs in a virtual device environment.' });
	}
	// SIMULATED is always honest — the local provider simulates every combo.
	options.push({ action: 'run_simulated', level: 'SIMULATED', label: 'Run Simulated', description: 'Runs locally with device-profile emulation. Clearly labeled SIMULATED everywhere.' });
	return {
		available: false,
		busy,
		busySessionId: busy ? busySession : null,
		reason: maximumLevel !== requestedLevel
			? `No provider can run ${labelFor(requestedLevel)} for this combination right now.`
			: `The device is ${availabilityMeta(status).label.toLowerCase()}.`,
		requestedLevel,
		maximumLevel,
		options
	};
}

/**
 * One-line queue description for a device session:
 * "Queued · position 2" / "Running now" / "Finished" / "Failed" / "Cancelled".
 */
export function describeQueue(session) {
	if (!session) return null;
	if (session.status === 'queued') return `Queued · position ${session.queuePosition ?? '?'}`;
	if (session.status === 'running') return 'Running now';
	if (session.status === 'done') return 'Finished';
	if (session.status === 'failed') return 'Failed';
	if (session.status === 'cancelled') return 'Cancelled';
	return session.status;
}

/**
 * Join the device board with environments by envId. Returns Map envId → entry.
 */
export function boardByEnvId(devices = []) {
	return new Map(devices.map((entry) => [entry.envId, entry]));
}

/**
 * Last-run info per envId from a runs list (newest first): Map envId →
 * { at, result, executionLevel }. Skips runs without an environment.
 */
export function lastRunByEnv(runs = []) {
	const map = new Map();
	for (const run of runs) {
		const envId = run.environmentId ?? run.environmentSnapshot?.envId;
		if (!envId || map.has(envId)) continue;
		map.set(envId, {
			at: run.completedAt ?? run.updatedAt ?? run.createdAt ?? null,
			result: run.report?.verdict ?? run.status ?? null,
			executionLevel: run.runtimeFacts?.executionLevel ?? run.executionLevel ?? null
		});
	}
	return map;
}

/** Format an epoch-ms or ISO timestamp as a short local date-time, or '—'. */
export function formatWhen(value) {
	if (!value) return '—';
	const numeric = /^\d+$/.test(String(value));
	const date = value instanceof Date ? value : new Date(numeric ? Number(value) : value);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
