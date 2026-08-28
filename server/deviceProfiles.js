/**
 * Device emulation profiles for Qase runs.
 *
 * A run marked as a mobile device does NOT resize the target site: it launches
 * the CleanSlate/Playwright Chromium context with a real mobile emulation
 * profile (User-Agent, viewport, deviceScaleFactor, isMobile, hasTouch),
 * exactly as Playwright's built-in device descriptors do. The site under test
 * therefore receives a genuine mobile request and pointer/touch semantics,
 * matching what a physical device would send.
 *
 * The catalogue is intentionally small and stable so it can be surfaced in the
 * dashboard as a fixed dropdown and stored in a session record without
 * versioning risk. Descriptors are copied verbatim from Playwright's registry
 * so that upstream tweaks (e.g. periodic UA bumps) do not silently change what
 * a "mobile" run means for us.
 */

export const DEFAULT_DEVICE_ID = 'desktop';

/** @typedef {{ id: string, label: string, kind: 'desktop'|'mobile'|'tablet', playwrightDevice?: string, viewport: { width: number, height: number }, userAgent?: string, deviceScaleFactor?: number, isMobile?: boolean, hasTouch?: boolean, defaultBrowserType?: string }} DeviceProfile */

/** @type {DeviceProfile[]} */
export const DEVICE_PROFILES = [
	{
		id: 'desktop',
		label: 'Desktop (1440×900)',
		kind: 'desktop',
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		isMobile: false,
		hasTouch: false
	},
	{
		id: 'iphone-15-pro',
		label: 'iPhone 15 Pro',
		kind: 'mobile',
		playwrightDevice: 'iPhone 15 Pro',
		viewport: { width: 393, height: 852 },
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'iphone-15-pro-max',
		label: 'iPhone 15 Pro Max',
		kind: 'mobile',
		playwrightDevice: 'iPhone 15 Pro Max',
		viewport: { width: 430, height: 932 },
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'iphone-se',
		label: 'iPhone SE',
		kind: 'mobile',
		playwrightDevice: 'iPhone SE',
		viewport: { width: 375, height: 667 },
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'pixel-8',
		label: 'Pixel 8 (Android)',
		kind: 'mobile',
		playwrightDevice: 'Pixel 7',
		viewport: { width: 412, height: 915 },
		userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
		deviceScaleFactor: 2.625,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'galaxy-s24',
		label: 'Galaxy S24 (Android)',
		kind: 'mobile',
		playwrightDevice: 'Galaxy S9+',
		viewport: { width: 384, height: 854 },
		userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
		deviceScaleFactor: 3,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'ipad-pro-11',
		label: 'iPad Pro 11"',
		kind: 'tablet',
		playwrightDevice: 'iPad Pro 11',
		viewport: { width: 834, height: 1194 },
		userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	},
	{
		id: 'ipad-mini',
		label: 'iPad Mini',
		kind: 'tablet',
		playwrightDevice: 'iPad Mini',
		viewport: { width: 768, height: 1024 },
		userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
		deviceScaleFactor: 2,
		isMobile: true,
		hasTouch: true
	}
];

const BY_ID = new Map(DEVICE_PROFILES.map(profile => [profile.id, profile]));

export function isDeviceId(value) {
	return typeof value === 'string' && BY_ID.has(value);
}

export function getDeviceProfile(id) {
	return BY_ID.get(id) ?? BY_ID.get(DEFAULT_DEVICE_ID);
}

/**
 * The subset of a device profile that is safe to persist and emit to clients.
 * The internal Playwright descriptor name is dropped because it is an
 * implementation detail; the label and viewport shape are useful for UI.
 */
export function publicDeviceProfile(id) {
	const profile = getDeviceProfile(id);
	return {
		id: profile.id,
		label: profile.label,
		kind: profile.kind,
		viewport: { ...profile.viewport },
		isMobile: Boolean(profile.isMobile),
		hasTouch: Boolean(profile.hasTouch)
	};
}

/**
 * Playwright newContext() options for this profile. Desktop returns undefined
 * so callers can keep the SDK's own defaults; mobile/tablet return the exact
 * shape Playwright's `devices[name]` produces, plus `acceptDownloads: true`
 * to match the SDK's baseline behavior.
 */
export function contextOptionsFor(id, options = {}) {
	const profile = getDeviceProfile(id);
	if (profile.kind === 'desktop') return undefined;
	const landscape = options.landscape === true;
	const viewport = landscape
		? { width: profile.viewport.height, height: profile.viewport.width }
		: { ...profile.viewport };
	return {
		viewport,
		userAgent: profile.userAgent,
		deviceScaleFactor: profile.deviceScaleFactor,
		isMobile: profile.isMobile,
		hasTouch: profile.hasTouch,
		acceptDownloads: true
	};
}

/**
 * A short, deterministic prompt appendix. Placed at the end of every mode's
 * operating brief so the agent knows the run is emulating a mobile device and
 * must use touch/tap semantics rather than desktop-only interactions.
 */
export function describeDeviceForPrompt(id, options = {}) {
	const profile = getDeviceProfile(id);
	if (profile.kind === 'desktop') return '';
	const landscape = options.landscape === true;
	const width = landscape ? profile.viewport.height : profile.viewport.width;
	const height = landscape ? profile.viewport.width : profile.viewport.height;
	const orientation = landscape ? 'landscape' : 'portrait';
	return `\n\n# Emulated device\n\nThis run is emulating **${profile.label}** in ${orientation}: viewport ${width}\u00d7${height}, deviceScaleFactor ${profile.deviceScaleFactor}, isMobile ${profile.isMobile}, hasTouch ${profile.hasTouch}. The target site receives a real mobile User-Agent and touch/pointer capabilities \u2014 this is not a resized desktop window. Test the site as it renders and behaves for a phone or tablet user: use tap/scroll gestures, expect mobile navigation menus (hamburger, bottom bar), verify responsive layout, viewport meta, tap-target sizing, orientation, and the mobile keyboard where applicable. Report defects that are specific to mobile as such, and never assume desktop-only affordances (hover, right-click, wide layout) are available.`;
}
