import { runPresentationStatus } from './runPresentation.js';

/**
 * activeRuntimeEnvironment — the single source of truth for the live view.
 *
 * Every live-view component (device frame, browser chrome, environment card,
 * execution log blocks) reads the currently executing device/browser context
 * from the object this module resolves. No component keeps its own
 * device/browser fallback chains (they were the source of "wrong device"
 * rendering).
 *
 * Precedence (highest first):
 *   1. session.environmentSnapshot — the environment the run was bound to
 *   2. session.runtimeFacts — what the runtime ACTUALLY observed (attested)
 *   3. legacy session.device emulation profile id
 *   4. none
 *
 * Honesty rules:
 * - executionType is gated on runtime attestation, NEVER inferred from the
 *   device name (a run named "iPhone" is not a real iPhone).
 * - resolution comes from the environment/runtime data; nothing is invented.
 */

const EXECUTION_TYPES = Object.freeze(['real_device', 'virtual_device', 'simulated', 'none']);
const RUNTIME_STATUSES = Object.freeze(['queued', 'reserving', 'connecting', 'connected', 'running', 'blocked', 'completed', 'failed', 'device_unavailable', 'released']);
const DEVICE_KINDS = Object.freeze(['phone', 'tablet', 'desktop']);

const BROWSER_KEYS = Object.freeze([
	['safari', /^(safari|mobile safari)$/i],
	['chrome', /^(chrome|chromium|mobile chrome|headlesschrome)$/i],
	['firefox', /^(firefox|mobile firefox)$/i],
	['edge', /^(edge|edg|microsoft edge|mobile edge)$/i],
	['opera', /^(opera|opr|mobile opera)$/i],
	['brave', /^(brave|brave chrome)$/i],
	['duckduckgo', /^(duckduckgo|duckduckgo mobile)$/i]
]);

/** Map an arbitrary browser string onto a stable browser key. */
export function browserKeyFor(browser) {
	const value = String(browser ?? '').trim();
	if (!value) return 'other';
	for (const [key, pattern] of BROWSER_KEYS) {
		if (pattern.test(value)) return key;
	}
	// Substring pass for compounds like "Chrome 154 Beta".
	const lower = value.toLowerCase();
	for (const [key, pattern] of BROWSER_KEYS) {
		if (pattern.source.replace(/\\\//g, '').length && lower.includes(key)) return key;
	}
	return 'other';
}

/** Parse "1179x2556" (or WxH@DPR) into {width,height}; null when absent. */
export function parseResolution(value) {
	if (typeof value !== 'string') return null;
	const match = /^\s*(\d{2,5})\s*[x×*]\s*(\d{2,5})/i.exec(value.trim());
	if (!match) return null;
	const width = Number(match[1]);
	const height = Number(match[2]);
	if (!width || !height) return null;
	return { width, height };
}

/** Resolve orientation from explicit env value, else from W/H proportions. */
export function orientationFor({ orientation, resolution } = {}) {
	if (orientation === 'landscape') return 'landscape';
	if (orientation === 'portrait') return 'portrait';
	if (resolution && Number.isFinite(resolution.width) && Number.isFinite(resolution.height)) {
		return resolution.width > resolution.height ? 'landscape' : 'portrait';
	}
	return 'portrait';
}

/** Map deviceType + platform onto a frame category. */
export function deviceKindFor({ deviceType, platform } = {}) {
	const type = String(deviceType ?? '').toLowerCase();
	if (type === 'tablet') return 'tablet';
	if (type === 'desktop' || type === 'laptop') return 'desktop';
	if (type === 'mobile' || type === 'phone') return 'phone';
	// Legacy emulation profiles: platform is the best signal we have.
	if (['macos', 'windows'].includes(String(platform ?? '').toLowerCase())) return 'desktop';
	return 'phone';
}

/**
 * Map run status (+ optional device-runtime status / board availability)
 * onto the live-view runtime status vocabulary.
 */
export function runtimeStatusFor({ sessionStatus, deviceSessionStatus, availability } = {}) {
	const avail = String(availability ?? '').toUpperCase();
	if (avail === 'OFFLINE' || avail === 'NOT_EXECUTABLE') return 'device_unavailable';
	const ds = String(deviceSessionStatus ?? '').toLowerCase();
	if (ds === 'queued') return 'queued';
	if (ds === 'created') return 'connecting';
	if (ds === 'blocked') return 'blocked';
	if (ds === 'released') return 'released';
	if (ds === 'failed' || ds === 'cancelled') return 'failed';
	const status = String(sessionStatus ?? '').toLowerCase();
	if (status === 'queued' || status === 'starting') return 'queued';
	if (status === 'resuming') return 'connecting';
	if (status === 'awaiting_input') return 'connected';
	if (status === 'blocked') return 'blocked';
	if (status === 'running') return 'running';
	if (status === 'done') return 'completed';
	if (['error', 'interrupted', 'cancelled', 'failed'].includes(status)) return 'failed';
	return 'queued';
}

/**
 * Honest execution type. REAL only when runtime facts attest it.
 * `env.executionProvider === 'browserstack'` claims real, but only
 * runtimeFacts.executionLevel confirms what actually executed.
 */
export function executionTypeFor({ runtimeFacts, environment } = {}) {
	const level = String(runtimeFacts?.executionLevel ?? '').toLowerCase();
	if (level === 'real_device') return 'real_device';
	if (level === 'virtual_device') return 'virtual_device';
	if (level === 'simulated') return 'simulated';
	// No attested level: a run bound to a real-device environment is at most
	// SIMULATED from the UI's perspective until the runtime proves otherwise.
	return environment ? 'simulated' : 'none';
}

function attested(runtimeFacts) {
	if (!runtimeFacts) return false;
	const att = runtimeFacts.attestation;
	if (att && typeof att === 'object') return att.verified === true || Boolean(att.verifiedAt || att.runtimeSessionId);
	return Boolean(runtimeFacts.runtimeSessionId);
}

/**
 * Build a runtime-environment view for the ACTIVE TEST ENVIRONMENT selection
 * (the store), used when no run is actively executing so the preview header/
 * frame reflect the user's chosen device instead of a stale session snapshot.
 * Mirrors resolveActiveRuntimeEnvironment's output shape.
 */
export function viewForSelection(selection) {
	if (!selection) return null;
	const resolution = parseResolution(selection.resolution);
	const kind = deviceKindFor({ deviceType: selection.deviceType, platform: selection.platform });
	return Object.freeze({
		device: selection.device ?? 'Unknown device',
		deviceId: selection.envId ?? null,
		manufacturer: null,
		model: selection.device ?? null,
		deviceType: kind,
		os: selection.os ?? null,
		osVersion: selection.osVersion ?? null,
		browser: selection.browser ?? null,
		browserVersion: selection.browserVersion ?? null,
		browserKey: browserKeyFor(selection.browser ?? null),
		resolution,
		orientation: orientationFor({ orientation: selection.orientation, resolution }),
		executionType: selection.executionType ? String(selection.executionType).toLowerCase() : 'none',
		executionTypeAttested: false,
		runtimeSessionId: selection.runtimeSessionId ?? null,
		// R5 #14494: an OFFLINE/UNAVAILABLE/NOT_EXECUTABLE selection renders as
		// honestly unavailable in the live view (panel + reason), not as queued.
		runtimeStatus: ['OFFLINE', 'UNAVAILABLE', 'NOT_EXECUTABLE']
			.includes(String(selection.availability ?? '').toUpperCase())
			? 'device_unavailable'
			: 'queued',
		unavailableReason: selection.unavailableReason ?? null,
		label: selection.device ?? null,
		targetUrl: null,
		source: 'selection'
	});
}

/**
 * Resolve the active runtime environment view-model for a session snapshot.
 * Returns null only when there is genuinely nothing to show.
 */
export function resolveActiveRuntimeEnvironment({ session, environments = null, runtimeBoard = null } = {}) {
	if (!session) return null;
	const env = session.environmentSnapshot ?? session.environment ?? null;
	const facts = session.runtimeFacts ?? session.deviceFacts ?? null;

	let device = null;
	let source = 'none';
	if (env) {
		device = env.device ?? null;
		source = 'environmentSnapshot';
	}
	if (facts?.deviceName && !device) {
		device = facts.deviceName;
		source = 'runtimeFacts';
	}
	if (!device) {
		// Legacy emulation profile: resolve label via the app's device list.
		const legacyId = session.device ?? session.deviceName ?? null;
		if (legacyId) {
			const entry = environments?.find?.((p) => p.id === legacyId) ?? null;
			device = entry?.label ?? String(legacyId);
			source = 'legacyDevice';
		}
	}
	if (!device && !env && !facts) return null;

	const resolution =
		parseResolution(env?.screenResolution) ??
		(facts?.viewport?.width && facts?.viewport?.height
			? { width: facts.viewport.width, height: facts.viewport.height }
			: null);

	const deviceType = env?.deviceType ?? null;
	const kind = deviceKindFor({ deviceType, platform: env?.platform ?? facts?.platform });
	const browser = env?.browser ?? null;
	const orientation = orientationFor({ orientation: env?.orientation, resolution });

	const boardEntry = runtimeBoard && env?.envId
		? (runtimeBoard.find?.((row) => row.envId === env.envId) ?? null)
		: null;
	const runtimeStatus = runtimeStatusFor({
		sessionStatus: runPresentationStatus(session),
		deviceSessionStatus: session.deviceSessionStatus ?? null,
		availability: boardEntry?.status ?? null
	});

	return Object.freeze({
		device: device ?? 'Unknown device',
		deviceId: env?.envId ?? session.environmentId ?? null,
		// R3 #14492: the board's honest unavailability reason (e.g. "No
		// real-device runtime connected — register a device-farm provider…")
		// travels to the unavailable panel instead of a generic message.
		unavailableReason: boardEntry?.unavailableReason ?? null,
		manufacturer: env?.platformLabel ?? null,
		model: env?.device ?? null,
		deviceType: kind,
		os: env?.os ?? facts?.platform ?? null,
		osVersion: env?.osVersion ?? null,
		browser,
		browserVersion: env?.browserVersion ? String(env.browserVersion) : null,
		browserKey: browserKeyFor(browser ?? facts?.userAgent ?? null),
		resolution,
		orientation,
		executionType: executionTypeFor({ runtimeFacts: facts, environment: env }),
		executionTypeAttested: attested(facts),
		runtimeSessionId: facts?.runtimeSessionId ?? session.deviceSessionId ?? null,
		runtimeStatus,
		label: env?.label ?? device ?? null,
		targetUrl: session.targetUrl ?? null,
		source
	});
}

export const ACTIVE_RUNTIME_DEVICE_KINDS = DEVICE_KINDS;
export const ACTIVE_RUNTIME_EXECUTION_TYPES = EXECUTION_TYPES;
export const ACTIVE_RUNTIME_STATUSES = RUNTIME_STATUSES;
