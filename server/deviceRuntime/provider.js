/**
 * Phase 21 · Device Runtime Provider contract.
 *
 * A provider abstracts the execution substrate behind a uniform interface so
 * physical device labs, internal farms or approved remote infrastructure can
 * connect later without touching the manager or the agent. Every provider
 * reports its capability honestly; the manager NEVER infers a level from a
 * device name, UA string or viewport.
 */

/** Canonical execution levels (mirrors deviceRuntimeProfiles.js). */
export const EXECUTION_LEVELS = Object.freeze({
	SIMULATED: 'SIMULATED',
	VIRTUAL_DEVICE: 'VIRTUAL_DEVICE',
	REAL_DEVICE: 'REAL_DEVICE'
});

/** Availability states for the device status board. */
export const AVAILABILITY = Object.freeze({
	AVAILABLE: 'AVAILABLE',
	PREPARING: 'PREPARING',
	RUNNING: 'RUNNING',
	BUSY: 'BUSY',
	OFFLINE: 'OFFLINE',
	ERROR: 'ERROR',
	UNAVAILABLE: 'UNAVAILABLE'
});

/**
 * Capability descriptor — the provider's honest self-declaration.
 * @typedef {Object} ProviderCapabilities
 * @property {string[]} supportedLevels   What this provider can actually run.
 * @property {boolean}  canRotate         Whether orientation can change mid-test.
 * @property {string[]} permissionsSupported Permission names the provider can pre-set.
 * @property {boolean}  physicalDevices    Whether the provider attests physical hardware.
 * @property {boolean}  queueable          Whether sessions can wait for busy devices.
 */

/**
 * Validate that a provider implementation satisfies the interface contract.
 * Structural check only — behavior is verified by unit tests per provider.
 */
export function isValidProvider(provider) {
	if (!provider || typeof provider !== 'object') return false;
	const required = ['id', 'capabilities', 'create_session', 'get_device', 'start_session',
		'execute_test', 'capture_screenshot', 'capture_logs', 'collect_device_information', 'stop_session'];
	for (const method of required) {
		if (!(method in provider)) return false;
	}
	if (typeof provider.id !== 'string' || provider.id.length === 0) return false;
	const caps = provider.capabilities;
	// supportedLevels may be empty — the null provider's honest "supports nothing".
	if (!caps || !Array.isArray(caps.supportedLevels)) return false;
	for (const fn of required.slice(2)) {
		if (typeof provider[fn] !== 'function') return false;
	}
	return true;
}
