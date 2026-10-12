/**
 * Phase 20 · Structured device runtime profiles.
 *
 * Ground truth for device-emulated execution: for every catalog platform the
 * runtime profile answers, honestly and from public vendor documentation:
 *  - input modalities (touch / mouse / keyboard / pen)
 *  - media capabilities (camera / microphone / screen share) and whether each
 *    is real hardware, virtual/synthetic, or unavailable in our local runtime
 *  - permission model per browser/OS (which permission names the browser
 *    supports and how DENY behaves)
 *  - navigation semantics (back gesture availability)
 *
 * NOTHING here invents hardware. `screenShareSupport` is honest per platform:
 * iOS Safari supports getDisplayMedia only from 16.4 and only for a small
 * subset — we record 'limited'; Windows/Chrome records 'supported' in the
 * provider sense (the browser API exists) but local emulation flags it
 * 'virtual' because no real monitor capture happens in a headless context.
 *
 * Execution levels (spec): SIMULATED = local Chromium emulation; VIRTUAL_DEVICE =
 * remote OS/browser runtime (e.g. BrowserStack VM); REAL_DEVICE = provider
 * attests a physical device session. Level is a *fact*, never inferred from a
 * device name or UA string.
 */

/** Canonical execution levels, ordered by fidelity. */
export const EXECUTION_LEVELS = Object.freeze({
	SIMULATED: 'SIMULATED',
	VIRTUAL_DEVICE: 'VIRTUAL_DEVICE',
	REAL_DEVICE: 'REAL_DEVICE'
});

export const EXECUTION_LEVEL_LABELS = Object.freeze({
	SIMULATED: 'Simulated',
	VIRTUAL_DEVICE: 'Virtual device',
	REAL_DEVICE: 'Real device'
});

/** Permission scenario values (request section 8). */
export const PERMISSION_DECISIONS = Object.freeze(['allow', 'deny', 'ask']);

/** Permission names a scenario can target. */
export const SCENARIO_PERMISSIONS = Object.freeze(['camera', 'microphone', 'notifications', 'geolocation']);

/** Orientation scenarios (request section 9). */
export const ORIENTATION_SCENARIOS = Object.freeze(['portrait', 'landscape', 'rotate-during-test']);

/**
 * Per-platform runtime capability profile. This is the honest answer to "what
 * can this platform's local emulation actually do" — it never claims hardware
 * the runtime does not have.
 *
 * @typedef {Object} PlatformRuntimeProfile
 * @property {string[]} input                Input modalities the platform supports.
 * @property {Object} media                  Camera/mic/screen-share support per platform.
 * @property {string[]} chromiumPermissions  Permission names Playwright grantPermissions understands for this platform's browsers.
 * @property {boolean}  backGesture          Whether platform-native back navigation exists (iOS/Android swipe-back, Windows Alt+Left in browser).
 */

const ANDROID_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'];
const APPLE_PERMISSIONS = ['camera', 'microphone', 'geolocation', 'notifications'];

/** @type {Record<string, PlatformRuntimeProfile>} */
export const PLATFORM_RUNTIME_PROFILES = Object.freeze({
	ios: Object.freeze({
		input: Object.freeze(['touch']),
		media: Object.freeze({
			camera: { supported: true, localRuntime: 'synthetic' },
			microphone: { supported: true, localRuntime: 'synthetic' },
			screenShare: { supported: 'limited', localRuntime: 'unavailable', note: 'iOS Safari supports getDisplayMedia only from 16.4 on iPads; iPhones do not support screen sharing to a page. Recorded NOT SUPPORTED, never PASS.' }
		}),
		chromiumPermissions: APPLE_PERMISSIONS,
		backGesture: true
	}),
	ipados: Object.freeze({
		input: Object.freeze(['touch', 'keyboard', 'pen']),
		media: Object.freeze({
			camera: { supported: true, localRuntime: 'synthetic' },
			microphone: { supported: true, localRuntime: 'synthetic' },
			screenShare: { supported: 'limited', localRuntime: 'unavailable', note: 'iPadOS 16.4+ Safari supports screen sharing; our local Chromium emulation does not present it as real. Recorded honestly.' }
		}),
		chromiumPermissions: APPLE_PERMISSIONS,
		backGesture: true
	}),
	macos: Object.freeze({
		input: Object.freeze(['mouse', 'keyboard']),
		media: Object.freeze({
			camera: { supported: true, localRuntime: 'synthetic' },
			microphone: { supported: true, localRuntime: 'synthetic' },
			screenShare: { supported: true, localRuntime: 'virtual', note: 'Chromium presents getDisplayMedia with a virtual desktop; never reported as a real monitor capture.' }
		}),
		chromiumPermissions: APPLE_PERMISSIONS,
		backGesture: true
	}),
	android: Object.freeze({
		input: Object.freeze(['touch']),
		media: Object.freeze({
			camera: { supported: true, localRuntime: 'synthetic' },
			microphone: { supported: true, localRuntime: 'synthetic' },
			screenShare: { supported: 'limited', localRuntime: 'virtual', note: 'Android Chrome supports getDisplayMedia; local emulation provides a virtual source, never a real device screen.' }
		}),
		chromiumPermissions: ANDROID_PERMISSIONS,
		backGesture: true
	}),
	windows: Object.freeze({
		input: Object.freeze(['mouse', 'keyboard', 'touch']),
		media: Object.freeze({
			camera: { supported: true, localRuntime: 'synthetic' },
			microphone: { supported: true, localRuntime: 'synthetic' },
			screenShare: { supported: true, localRuntime: 'virtual', note: 'Chrome/Edge getDisplayMedia returns a virtual frame; never reported as real monitor capture.' }
		}),
		chromiumPermissions: ANDROID_PERMISSIONS,
		backGesture: true
	})
});

/** Returns the runtime profile for a platform id; unknown platforms get an honest "no info" profile. */
export function platformRuntimeProfile(platformId) {
	return PLATFORM_RUNTIME_PROFILES[String(platformId ?? '').toLowerCase()] ?? null;
}

/**
 * Permission scenario normalization + validation (request section 8).
 * Values are whitelisted; unknown permission names or decisions are rejected
 * (never silently dropped) so the caller learns the scenario is wrong.
 */
export function normalizePermissionScenario(input) {
	if (input === undefined || input === null) return null;
	if (typeof input !== 'object' || Array.isArray(input)) {
		throw new Error('permissionScenario must be an object mapping permission names to allow/deny/ask.');
	}
	const source = input.scenario ?? input; // accept { camera: 'deny' } or { scenario: {...} }
	const result = {};
	for (const [name, decision] of Object.entries(source)) {
		if (!SCENARIO_PERMISSIONS.includes(name)) {
			throw new Error(`Unknown permission "${name}" in permissionScenario (allowed: ${SCENARIO_PERMISSIONS.join(', ')}).`);
		}
		if (!PERMISSION_DECISIONS.includes(decision)) {
			throw new Error(`Permission "${name}" decision must be one of: ${PERMISSION_DECISIONS.join(', ')}.`);
		}
		result[name] = decision;
	}
	return Object.keys(result).length ? result : null;
}

/**
 * Orientation scenario validation (request section 9). Rotate-during-test is
 * only valid on touch-capable devices — the validator takes the device type
 * from the resolved profile and rejects it for desktops.
 */
export function normalizeOrientationScenario(input, { deviceType } = {}) {
	if (input === undefined || input === null || input === '') return null;
	const value = String(input);
	if (!ORIENTATION_SCENARIOS.includes(value)) {
		throw new Error(`orientationScenario must be one of: ${ORIENTATION_SCENARIOS.join(', ')}.`);
	}
	if (value === 'rotate-during-test' && deviceType === 'desktop') {
		throw new Error('orientationScenario "rotate-during-test" is not valid for desktop devices (no touch/orientation hardware).');
	}
	return value;
}

/**
 * Deterministic user-agent strings per platform + OS version + browser.
 * These are the UA strings the *runtime actually sends* for a SIMULATED run —
 * they are real mobile UAs (matching the OS major), not desktop Chromium's.
 * A REAL_DEVICE / VIRTUAL_DEVICE run never uses this helper: the provider's
 * genuine UA is read from the live page and recorded as a runtime fact.
 *
 * #15439 Issue 3: brand-correct tokens — Firefox sends FxiOS/FxMS-style UAs,
 * Edge EdgiOS/Edg, Opera OPiOS/OPR, DuckDuckGo its own token. Previously
 * every non-Safari browser got a Chrome/CriOS UA, so the identity verifier
 * correctly flagged "browser mismatch" and honest non-Chrome configurations
 * were stamped BLOCKED.
 */
export function userAgentFor(platformId, osVersion, browserCode, browserVersion) {
	const os = String(osVersion ?? '').trim();
	const platform = String(platformId ?? '').toLowerCase();
	const browser = String(browserCode ?? '').toLowerCase();
	const major = os.split(/[.]/)[0] || '';
	// #15439: brand/version tokens carry the BROWSER version (FxiOS/141,
	// EdgiOS/141…), not the OS major — the identity verifier compares the
	// UA's browser version against environment.browserVersion.
	const browserMajor = String(browserVersion ?? '').split(/[.]/)[0] || '';

	const iOS_TOKENS = {
		safari: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver}.0 Mobile/15E148 Safari/604.1`,
		// Every non-Safari iOS browser is a WebKit wrapper; each brand sends
		// its own token ahead of the shared WebKit tail.
		chrome: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${ver}.0.0.0 Mobile/15E148 Safari/604.1`,
		edge: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver}.0 EdgiOS/${ver}.0.0.0 Mobile/15E148 Safari/604.1`,
		firefox: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/${ver}.0 Mobile/15E148 Safari/604.1`,
		opera: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) OPiOS/${ver}.0.0.0 Mobile/15E148 Safari/604.1`,
		// Real Brave iOS sends no brand token (plain WebKit wrapper UA); the
		// brandedBinary runtime fact is the identity authority for Brave.
		brave: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver}.0 Mobile/15E148 Safari/604.1 Brave/1.0`,
		duckduckgo: (token, osPart, ver) => `Mozilla/5.0 (${token}; CPU ${token === 'iPhone' ? 'iPhone OS' : 'OS'} ${osPart} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${ver}.0 Mobile/15E148 Safari/604.1 DuckDuckGo/7`
	};

	if (platform === 'ios' || platform === 'ipados') {
		const token = platform === 'ios' ? 'iPhone' : 'iPad';
		const osPart = os.replace('.', '_');
		// Safari/Version token = OS-major WebKit version; brand tokens
		// (CriOS/FxiOS/EdgiOS/OPiOS) = the browser's own version.
		const ver = browserMajor || '140';
		const safariVer = major || '18';
		const builder = iOS_TOKENS[browser] ?? iOS_TOKENS.safari;
		if (browser === 'safari') return builder(token, osPart, safariVer);
		return builder(token, osPart, ver);
	}
	if (platform === 'macos') {
		// Brand tokens carry the BROWSER major; Safari's Version token stays
		// tied to the OS WebKit version.
		const bMajor = browserMajor || '140';
		if (browser === 'safari') {
			return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${browserMajor || major || '18'}.0 Safari/605.1.15`;
		}
		if (browser === 'firefox') {
			return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${bMajor}.0) Gecko/20100101 Firefox/${bMajor}.0`;
		}
		const token = browser === 'edge' ? `Edg/${bMajor}.0.0.0`
			: browser === 'opera' ? `OPR/${bMajor}.0.0.0`
			: browser === 'brave' ? `Brave/${bMajor}` // Brave desktop strips its token from UAs; kept for identity honesty
			: '';
		return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bMajor}.0.0.0 Safari/537.36${token ? ' ' + token : ''}`;
	}
	if (platform === 'android') {
		const bMajor = browserMajor || '140';
		if (browser === 'firefox') {
			return `Mozilla/5.0 (Android ${os || '15'}; Mobile; rv:${bMajor}.0) Gecko/${bMajor}.0 Firefox/${bMajor}.0`;
		}
		if (browser === 'duckduckgo') {
			return `Mozilla/5.0 (Linux; Android ${os || '15'}; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/${bMajor}.0.0.0 Mobile Safari/537.36 DuckDuckGo/7`;
		}
		const edge = browser === 'edge' ? ` Edg/${bMajor}.0.0.0` : '';
		const opera = browser === 'opera' ? ` OPR/${bMajor}.0.0.0` : '';
		// Brave Android ships a Chrome-equivalent UA (brand token stripped) —
		// the runtime's brandedBinary fact remains the identity source.
		return `Mozilla/5.0 (Linux; Android ${os || '15'}; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bMajor}.0.0.0 Mobile Safari/537.36${edge}${opera}`;
	}
	if (platform === 'windows') {
		const windowsToken = '10.0'; // NT major is 10.0 for both Win10 and Win11
		const bMajor = browserMajor || '140';
		if (browser === 'firefox') {
			return `Mozilla/5.0 (Windows NT ${windowsToken}; Win64; x64; rv:${bMajor}.0) Gecko/20100101 Firefox/${bMajor}.0`;
		}
		const token = browser === 'edge' ? `Edg/${bMajor}.0.0.0`
			: browser === 'opera' ? `OPR/${bMajor}.0.0.0`
			: browser === 'brave' ? `Brave/${bMajor}`
			: '';
		return `Mozilla/5.0 (Windows NT ${windowsToken}; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${bMajor}.0.0.0 Safari/537.36${token ? ' ' + token : ''}`;
	}
	return null;
}

/**
 * Execution-level resolution fact base (spec §20/21): a level is only assigned
 * from what the runtime can PROVE.  `providerAttestation` is an object a
 * provider must supply for REAL_DEVICE (sessionEvidence proving a physical
 * device, e.g. BrowserStack `realMobile` + a device session id we can re-query).
 * Without an attestation the level is at most VIRTUAL_DEVICE (remote CDP) or
 * SIMULATED (local emulation).
 */
export function resolveExecutionLevel({ mode, realMobileAttested = false } = {}) {
	if (mode === 'browserstack' && realMobileAttested) return EXECUTION_LEVELS.REAL_DEVICE;
	if (mode === 'browserstack') return EXECUTION_LEVELS.VIRTUAL_DEVICE;
	if (mode === 'emulated') return EXECUTION_LEVELS.SIMULATED;
	return EXECUTION_LEVELS.SIMULATED; // 'default' (no environment) is local desktop Chromium
}
