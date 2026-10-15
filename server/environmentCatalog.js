/**
 * Apple device & browser compatibility catalog for QASE environments.
 *
 * This module is the single source of truth for the Apple environment matrix:
 * which devices exist (iPhone / iPad / macOS), which OS versions each supports,
 * which browsers are actually executable per platform (validated against
 * published vendor availability), and how Safari versions derive from
 * OS versions (Safari is never an independently installed browser).
 *
 * Everything here is frozen, deterministic data + pure functions — same pattern
 * as deviceProfiles.js. Browser/OS version lists are curated from vendors'
 * published platform lists and refreshed manually (see scripts/generate-environments.mjs
 * usage). Nothing in this module talks to the network or the database.
 *
 * Hard availability rules (expanded 2026-10, catalog 2026.10.1):
 *   - iOS / iPadOS: all seven App Store browsers generate environments —
 *     Safari + Chrome + Firefox + Edge + Opera + Brave + DuckDuckGo. Every
 *     iOS browser is required to use WebKit under the hood, so they are
 *     executable as distinct browser targets on real devices.
 *   - macOS: all seven browsers (Safari, Chrome, Firefox, Edge, Opera,
 *     Brave, DuckDuckGo).
 *   - Android: Chrome, Firefox, Edge, Opera, Brave, DuckDuckGo. Safari is
 *     NEVER generated — Apple does not ship Safari for Android.
 *   - Windows: Chrome, Firefox, Edge, Opera, Brave, DuckDuckGo. Safari is
 *     NEVER generated — Apple does not ship Safari for Windows.
 */

export const ENVIRONMENT_CATALOG_VERSION = '2027.03.0';

import { resolveBrowserSupport } from './browserSupportResolution.js';

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

export const PLATFORMS = [
	{ id: 'ios', label: 'iPhone', os: 'iOS', envCode: 'IOS', deviceType: 'mobile', isRealDevice: true },
	{ id: 'ipados', label: 'iPad', os: 'iPadOS', envCode: 'IPADOS', deviceType: 'tablet', isRealDevice: true },
	{ id: 'macos', label: 'macOS', os: 'macOS', envCode: 'MAC', deviceType: 'desktop', isRealDevice: false },
	{ id: 'android', label: 'Android', os: 'Android', envCode: 'AND', deviceType: 'mobile', isRealDevice: true },
	{ id: 'windows', label: 'Windows', os: 'Windows', envCode: 'WIN', deviceType: 'desktop', isRealDevice: false }
];

// ---------------------------------------------------------------------------
// Browsers and per-platform availability
// ---------------------------------------------------------------------------

/**
 * @typedef {{ code: string, name: string, envCode: string, independentlyVersioned: boolean,
 *             platforms: string[], note?: string }} BrowserDef
 * `platforms` lists the platforms where the browser is executable in QASE.
 * Browsers absent from a platform's list are kept here for UI explanation only.
 */
export const BROWSERS = [
	{
		code: 'safari', name: 'Safari', envCode: 'SAF', independentlyVersioned: false,
		platforms: ['ios', 'ipados', 'macos'],
		channels: ['stable'],
		note: 'Safari version is derived from the OS version (it ships with the OS), never chosen independently.'
	},
	{
		code: 'chrome', name: 'Chrome', envCode: 'CHR', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['canary', 'dev', 'beta', 'stable']
	},
	{
		code: 'firefox', name: 'Firefox', envCode: 'FF', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['nightly', 'beta', 'stable'],
		note: 'On iOS/iPadOS Firefox runs on the required WebKit engine; Android Firefox is scriptable via Gecko remote debugging.'
	},
	{
		code: 'edge', name: 'Edge', envCode: 'EDG', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['canary', 'dev', 'beta', 'stable'],
		note: 'On iOS/iPadOS Edge runs on the required WebKit engine.'
	},
	{
		code: 'opera', name: 'Opera', envCode: 'OPR', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['beta', 'stable'],
		note: 'On iOS/iPadOS Opera runs on the required WebKit engine.'
	},
	{
		code: 'brave', name: 'Brave', envCode: 'BRV', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['nightly', 'beta', 'stable'],
		note: 'Chromium-based; on iOS/iPadOS it runs on the required WebKit engine.'
	},
	{
		code: 'duckduckgo', name: 'DuckDuckGo', envCode: 'DDG', independentlyVersioned: true,
		platforms: ['ios', 'ipados', 'macos', 'android', 'windows'],
		channels: ['stable'],
		note: 'Privacy browser on all five platforms; on iOS/iPadOS it runs on the required WebKit engine.'
	}
];

/**
 * Curated major browser versions available per browser family.
 * 2026.10.2 (#14166): deepened to match the reference catalog UI — each family
 * carries the latest majors plus a back-catalog (roughly the visible ~15 rows
 * of the reference; the 'N more' links in that UI count sub-minors and betas
 * which the environment model does not enumerate — majors only).
 */
/**
 * 2026.10.12 (#15909): collapsed to exactly ONE major per family — the version
 * actually installed/launchable on this runtime. A single binary per brand is
 * what the local registry launches (localBrowserRegistry.js probes one
 * executable per family); advertising a version ladder inflated the generated
 * matrix to ~39k rows and launcher default selections to ~500 items per
 * family, which starved matrix runs before they visibly started. One version
 * per family keeps every offered configuration honest (available) and the
 * default queue small.
 *
 * The version per family tracks the runtime binary detected at build time:
 *   chrome 151 (google-chrome-stable 151.0.x), edge 124 (microsoft-edge
 *   124.0.x), opera 136 (opera-gx 136.0.x — plain opera-stable segfaults in
 *   this container, see webkit-gtk memory), brave 155, firefox 153 (Playwright
 *   Gecko bundle v1538 / Firefox 153.0). duckduckgo stays at its latest major
 *   (3) — mobile-only, honestly NOT_SUPPORTED on Linux by design.
 * Safari is not independently versioned (tracks the OS) and is unaffected.
 *
 * Re-expanding later is a data-only change here.
 */
export const BROWSER_VERSIONS = {
	chrome: ['151'],
	firefox: ['153'],
	edge: ['124'],
	opera: ['136'],
	brave: ['155'],
	duckduckgo: ['3']
};

/**
 * Release channel for a browser major version (2027.02.0 #14420).
 *
 * Channels are DISPLAY METADATA derived from the version's POSITION in the
 * browser's BROWSER_VERSIONS array — they never change envIds, never create
 * extra environment rows, and never claim a specific calendar current version.
 * Bumping the arrays re-labels automatically; no version number is hardcoded
 * as permanently current.
 *
 * Mapping (newest first): newest major = first pre-release channel, each
 * following major the next channel, until a 'stable' is reached; every older
 * major is also 'stable' (the back-catalog of previous stable releases).
 * Example with chrome [.. 153, 154, 155, 156] and channels
 * [canary, dev, beta, stable]: 156→canary, 155→dev, 154→beta, 153→stable,
 * 152 and older →stable.
 *
 * Unknown browser / version → 'stable' (safe default for catalog edits).
 */
export function channelForVersion(browserCode, version) {
	const browser = getBrowser(browserCode);
	if (!browser || !Array.isArray(browser.channels) || browser.channels.length === 0) return 'stable';
	const versions = BROWSER_VERSIONS[browser.code];
	if (!versions) return 'stable';
	const channelsLast = browser.channels[browser.channels.length - 1] ?? 'stable';
	if (versions.length === 1) {
		// #15909: single-version families advertise their SHIPPING channel —
		// the installed binary is a stable release, never canary/nightly.
		// Families whose channel list has no literal 'stable' (duckduckgo)
		// resolve to their last-listed release channel.
		return browser.channels.includes('stable') ? 'stable' : channelsLast;
	}
	const index = versions.indexOf(String(version));
	if (index < 0) return 'stable';
	// channels[] is newest-first; distanceFromNewest 0 = newest major.
	const distanceFromNewest = versions.length - 1 - index;
	if (distanceFromNewest < browser.channels.length - 1) {
		return browser.channels[distanceFromNewest];
	}
	return 'stable';
}

/**
 * Safari versions shipped per macOS release (major.minor of the newest Safari
 * available on that macOS). Curated — Safari on macOS is OS-bound.
 */
export const MACOS_SAFARI_VERSIONS = {
	'High Sierra': '11.1.2',
	Mojave: '12.1.2',
	Catalina: '13.1.3',
	'Big Sur': '14.1.2',
	Monterey: '16.6',
	Ventura: '17.6',
	Sonoma: '18.6',
	Sequoia: '26.2',
	Tahoe: '26.4'
};

/**
 * Safari version for a platform/OS-version pair.
 * - iOS/iPadOS: Safari tracks the OS minor (iOS 18.3 -> Safari 18.3; iOS 26.0 -> Safari 26).
 * - macOS: curated map in MACOS_SAFARI_VERSIONS.
 * Returns null when the OS version is unknown.
 */
export function safariVersionFor(platformId, osVersion) {
	if (platformId === 'ios' || platformId === 'ipados') {
		if (typeof osVersion !== 'string') return null;
		const match = /^(\d+(?:\.\d+)?)/.exec(osVersion.trim());
		if (!match) return null;
		return match[1];
	}
	if (platformId === 'macos') {
		const key = typeof osVersion === 'string' ? osVersion.trim() : '';
		if (MACOS_SAFARI_VERSIONS[key]) return MACOS_SAFARI_VERSIONS[key];
		// Case-insensitive fallback (legacy single-word keys) — multi-word
		// macOS names like 'Big Sur' match exactly above.
		const lower = key.toLowerCase();
		for (const [name, version] of Object.entries(MACOS_SAFARI_VERSIONS)) {
			if (name.toLowerCase() === lower) return version;
		}
		return null;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AppleDevice
 * @property {string} slug          Fixed ENV-ID slug (IP16PRO, IPADMINI, …). For
 *                                  macOS the "device" is the OS itself; slugs are
 *                                  MONTEREY/VENTURA/… and there is one device
 *                                  record per macOS version.
 * @property {string} name          Display name ("iPhone 16 Pro").
 * @property {string} runtimeDeviceName  Remote runtime device identifier.
 * @property {string} platformId    ios | ipados | macos
 * @property {string} deviceType    mobile | tablet | desktop
 * @property {string} screenSize    Human screen size, e.g. "6.3 inch".
 * @property {string[]} osVersions  Curated supported OS versions.
 * @property {boolean} isRealDevice Real hardware (true for iOS/iPadOS; false for macOS VMs).
 * @property {Object} [emulation]   Optional local-emulation hints (viewport etc.) for
 *                                  non-remote execution (Phase 5/6).
 */

/** iPhone catalog — every requested model with curated supported OS versions. */
const IPHONE_SCREEN = (inches) => `${inches} inch`;

/** @type {AppleDevice[]} */
export const APPLE_DEVICES = [
	// --- Legacy iPhones (2027.01.0 #14273) — honest support windows ---
	// iPhone 7 line caps at iOS 15; 8/X lines cap at iOS 16; XR/XS cap at 18.
	iphone('IP7', 'iPhone 7', '375×667', 2, IPHONE_SCREEN('4.7'), ['13.0', '14.0', '15.0']),
	iphone('IP7PLUS', 'iPhone 7 Plus', '414×736', 3, IPHONE_SCREEN('5.5'), ['13.0', '14.0', '15.0']),
	iphone('IP8', 'iPhone 8', '375×667', 2, IPHONE_SCREEN('4.7'), ['13.0', '14.0', '15.0', '16.0']),
	iphone('IP8PLUS', 'iPhone 8 Plus', '414×736', 3, IPHONE_SCREEN('5.5'), ['13.0', '14.0', '15.0', '16.0']),
	iphone('IPX', 'iPhone X', '375×812', 3, IPHONE_SCREEN('5.8'), ['13.0', '14.0', '15.0', '16.0']),
	iphone('IPXR', 'iPhone XR', '414×896', 2, IPHONE_SCREEN('6.1'), ['13.0', '14.0', '15.0', '16.0', '17.0', '18.3']),
	iphone('IPXS', 'iPhone XS', '375×812', 3, IPHONE_SCREEN('5.8'), ['13.0', '14.0', '15.0', '16.0', '17.0', '18.3']),
	iphone('IPXSMAX', 'iPhone XS Max', '414×896', 3, IPHONE_SCREEN('6.5'), ['13.0', '14.0', '15.0', '16.0', '17.0', '18.3']),
	iphone('IPSE1', 'iPhone SE (1st gen)', '375×667', 2, IPHONE_SCREEN('4.0'), ['13.0', '14.0', '15.0']),
	iphone('IPSE2', 'iPhone SE (2nd gen)', '375×667', 2, IPHONE_SCREEN('4.7'), ['13.0', '14.0', '15.0', '16.0', '17.0', '18.3']),
	iphone('IPSE3', 'iPhone SE (3rd gen)', '375×667', 2, IPHONE_SCREEN('4.7'), ['15.0', '16.0', '17.0', '18.3', '26.0']),

	// --- iPhone 11 family (A13; supports up to iOS 26) ---
	iphone('IP11', 'iPhone 11', '414×896', 2, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP11PRO', 'iPhone 11 Pro', '375×812', 3, IPHONE_SCREEN('5.8'), ['17.0', '18.3', '26.0']),
	iphone('IP11PROMAX', 'iPhone 11 Pro Max', '414×896', 2, IPHONE_SCREEN('6.5'), ['17.0', '18.3', '26.0']),

	// --- iPhone 12 family (A14; supports up to iOS 26) ---
	iphone('IP12', 'iPhone 12', '390×844', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP12MINI', 'iPhone 12 mini', '375×812', 3, IPHONE_SCREEN('5.4'), ['17.0', '18.3', '26.0']),
	iphone('IP12PRO', 'iPhone 12 Pro', '390×844', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP12PROMAX', 'iPhone 12 Pro Max', '428×926', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),

	// --- iPhone 13 family (A15; supports up to iOS 26) ---
	iphone('IP13', 'iPhone 13', '390×844', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP13MINI', 'iPhone 13 mini', '375×812', 3, IPHONE_SCREEN('5.4'), ['17.0', '18.3', '26.0']),
	iphone('IP13PRO', 'iPhone 13 Pro', '390×844', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP13PROMAX', 'iPhone 13 Pro Max', '428×926', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),

	// --- iPhone 14 family (A15/A16; supports up to iOS 26) ---
	iphone('IP14', 'iPhone 14', '390×844', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP14PLUS', 'iPhone 14 Plus', '428×926', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),
	iphone('IP14PRO', 'iPhone 14 Pro', '393×852', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP14PROMAX', 'iPhone 14 Pro Max', '430×932', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),

	// --- iPhone 15 family (A16/A17 Pro; shipped with iOS 17, supports iOS 26) ---
	iphone('IP15', 'iPhone 15', '393×852', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP15PLUS', 'iPhone 15 Plus', '430×932', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),
	iphone('IP15PRO', 'iPhone 15 Pro', '393×852', 3, IPHONE_SCREEN('6.1'), ['17.0', '18.3', '26.0']),
	iphone('IP15PROMAX', 'iPhone 15 Pro Max', '430×932', 3, IPHONE_SCREEN('6.7'), ['17.0', '18.3', '26.0']),

	// --- iPhone 16 family (A18/A18 Pro; shipped with iOS 18, no iOS 17) ---
	iphone('IP16', 'iPhone 16', '393×852', 3, IPHONE_SCREEN('6.1'), ['18.0', '18.3', '26.0']),
	iphone('IP16PLUS', 'iPhone 16 Plus', '430×932', 3, IPHONE_SCREEN('6.7'), ['18.0', '18.3', '26.0']),
	iphone('IP16PRO', 'iPhone 16 Pro', '402×874', 3, IPHONE_SCREEN('6.3'), ['18.0', '18.3', '26.0']),
	iphone('IP16PROMAX', 'iPhone 16 Pro Max', '440×956', 3, IPHONE_SCREEN('6.9'), ['18.0', '18.3', '26.0']),
	iphone('IP16E', 'iPhone 16e', '390×844', 3, IPHONE_SCREEN('6.1'), ['18.0', '18.3', '26.0']),

	// --- iPhone 17 family (ships with iOS 26 only) ---
	iphone('IP17', 'iPhone 17', '402×874', 3, IPHONE_SCREEN('6.3'), ['26.0']),
	iphone('IP17AIR', 'iPhone 17 Air', '420×912', 3, IPHONE_SCREEN('6.5'), ['26.0']),
	iphone('IP17PRO', 'iPhone 17 Pro', '402×874', 3, IPHONE_SCREEN('6.3'), ['26.0']),
	iphone('IP17PROMAX', 'iPhone 17 Pro Max', '440×956', 3, IPHONE_SCREEN('6.9'), ['26.0']),

	// --- iPad generational coverage (2027.01.0 #14273) ---
	// One row per hardware generation; runtimeDeviceName disambiguates. Older
	// generations carry factual OS caps (5th/6th gen: 16; Air 3: 16; mini 5: 17 …).
	ipad('IPAD5', 'iPad (5th Gen)', 'iPad (5th Gen)', '768×1024', 2, '9.7 inch', ['13.0', '14.0', '15.0', '16.0']),
	ipad('IPAD6', 'iPad (6th Gen)', 'iPad (6th Gen)', '768×1024', 2, '9.7 inch', ['13.0', '14.0', '15.0', '16.0']),
	ipad('IPAD7', 'iPad (7th Gen)', 'iPad (7th Gen)', '810×1080', 2, '10.2 inch', ['13.0', '14.0', '15.0', '16.0', '17.0']),
	ipad('IPAD8', 'iPad (8th Gen)', 'iPad (8th Gen)', '810×1080', 2, '10.2 inch', ['13.0', '14.0', '15.0', '16.0', '17.0', '18.3']),
	ipad('IPAD9', 'iPad (9th Gen)', 'iPad (9th Gen)', '810×1080', 2, '10.2 inch', ['14.0', '15.0', '16.0', '17.0', '18.3']),
	ipad('IPAD10', 'iPad (10th Gen)', 'iPad (10th Gen)', '820×1180', 2, '10.9 inch', ['15.0', '16.0', '17.0', '18.3', '26.0']),
	ipad('IPAD11', 'iPad (11th Gen)', 'iPad (11th Gen)', '820×1180', 2, '11.0 inch', ['17.0', '18.3', '26.0']),
	ipad('IPADAIR3', 'iPad Air (3rd Gen)', 'iPad Air (3rd Gen)', '810×1080', 2, '10.5 inch', ['13.0', '14.0', '15.0', '16.0']),
	ipad('IPADAIR4', 'iPad Air (4th Gen)', 'iPad Air (4th Gen)', '820×1180', 2, '10.9 inch', ['13.0', '14.0', '15.0', '16.0', '17.0']),
	ipad('IPADAIR5', 'iPad Air (5th Gen)', 'iPad Air (5th Gen)', '820×1180', 2, '10.9 inch', ['15.0', '16.0', '17.0', '18.3']),
	ipad('IPADAIR6', 'iPad Air (6th Gen)', 'iPad Air (6th Gen)', '820×1180', 2, '11.0 inch', ['17.0', '18.3', '26.0']),
	ipad('IPADAIR7', 'iPad Air (7th Gen)', 'iPad Air (7th Gen)', '820×1180', 2, '11.0 inch', ['17.0', '18.3', '26.0']),
	ipad('IPADMINI5', 'iPad mini (5th Gen)', 'iPad mini (5th Gen)', '744×1133', 2, '7.9 inch', ['13.0', '14.0', '15.0', '16.0', '17.0']),
	ipad('IPADMINI6', 'iPad mini (6th Gen)', 'iPad mini (6th Gen)', '744×1133', 2, '8.3 inch', ['15.0', '16.0', '17.0', '18.3']),
	ipad('IPADMINI', 'iPad mini (7th Gen)', 'iPad mini (7th Gen)', '744×1133', 2, '8.3 inch', ['17.0', '18.3', '26.0']),
	ipad('IPADPRO11-1', 'iPad Pro 11 (1st Gen)', 'iPad Pro 11 (1st Gen)', '834×1194', 2, '11.0 inch', ['13.0', '14.0', '15.0', '16.0', '17.0']),
	ipad('IPADPRO11-2', 'iPad Pro 11 (2nd Gen)', 'iPad Pro 11 (2nd Gen)', '834×1194', 2, '11.0 inch', ['14.0', '15.0', '16.0', '17.0']),
	ipad('IPADPRO11-3', 'iPad Pro 11 (3rd Gen)', 'iPad Pro 11 (3rd Gen)', '834×1194', 2, '11.0 inch', ['15.0', '16.0', '17.0', '18.3']),
	ipad('IPADPRO11', 'iPad Pro 11 (4th Gen)', 'iPad Pro 11 (4th Gen)', '834×1194', 2, '11.0 inch', ['16.0', '17.0', '18.3', '26.0']),
	ipad('IPADPRO11-5', 'iPad Pro 11 (5th Gen)', 'iPad Pro 11 (5th Gen)', '834×1194', 2, '11.0 inch', ['17.0', '18.3', '26.0']),
	ipad('IPADPRO129-1', 'iPad Pro 12.9 (3rd Gen)', 'iPad Pro 12.9 (3rd Gen)', '1024×1366', 2, '12.9 inch', ['13.0', '14.0', '15.0', '16.0', '17.0']),
	ipad('IPADPRO129-2', 'iPad Pro 12.9 (4th Gen)', 'iPad Pro 12.9 (4th Gen)', '1024×1366', 2, '12.9 inch', ['14.0', '15.0', '16.0', '17.0']),
	ipad('IPADPRO129-3', 'iPad Pro 12.9 (5th Gen)', 'iPad Pro 12.9 (5th Gen)', '1024×1366', 2, '12.9 inch', ['15.0', '16.0', '17.0', '18.3']),
	ipad('IPADPRO129', 'iPad Pro 12.9 (6th Gen)', 'iPad Pro 12.9 (6th Gen)', '1024×1366', 2, '12.9 inch', ['16.0', '17.0', '18.3']),
	ipad('IPADPRO13', 'iPad Pro 13 (M4)', 'iPad Pro 13 (M4)', '1032×1376', 2, '13.0 inch', ['17.0', '18.3', '26.0']),

	// --- macOS hardware models (2027.01.0 #14273) ---
	// Replaces one-pseudo-device-per-OS. Honest ranges: Apple Silicon
	// Monterey→Tahoe (per model launch floor); Intel lines cap at
	// Monterey/Ventura and keep High Sierra–Catalina reachable.
	macModel('MACMBA-M1', 'MacBook Air (M1)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia'], 13.3),
	macModel('MACMBA-M2', 'MacBook Air (M2)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 13.6),
	macModel('MACMBA-M3', 'MacBook Air (M3)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 13.6),
	macModel('MACMBA-M4', 'MacBook Air (M4)', ['Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 13.6),
	macModel('MACMBP13-M1', 'MacBook Pro 13 (M1)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia'], 13.3),
	macModel('MACMBP13-M2', 'MacBook Pro 13 (M2)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia'], 13.3),
	macModel('MACMBP14-M3', 'MacBook Pro 14 (M3)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 14.2),
	macModel('MACMBP14-M4', 'MacBook Pro 14 (M4)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 14.2),
	macModel('MACMBP16-M3', 'MacBook Pro 16 (M3)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 16.2),
	macModel('MACMBP16-M4', 'MacBook Pro 16 (M4)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], 16.2),
	macModel('MACMBP16-INT19', 'MacBook Pro 16 (Intel 2019)', ['High Sierra', 'Mojave', 'Catalina', 'Big Sur', 'Monterey'], 16.0),
	macModel('MACIMAC-INT', 'iMac (27-inch Intel 2020)', ['High Sierra', 'Mojave', 'Catalina', 'Big Sur', 'Monterey', 'Ventura'], 27.0),
	macModel('MACIMAC24-M1', 'iMac (24-inch M1)', ['Monterey', 'Ventura', 'Sonoma'], 24.0),
	macModel('MACIMAC-M4', 'iMac (24-inch M4)', ['Sonoma', 'Sequoia', 'Tahoe'], 24.0),
	macModel('MACMINI-M4', 'Mac mini (M4)', ['Sonoma', 'Sequoia', 'Tahoe'], null),
	macModel('MACSTUDIO-M2MAX', 'Mac Studio (M2 Max)', ['Monterey', 'Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], null),
	macModel('MACSTUDIO-M4MAX', 'Mac Studio (M4 Max)', ['Ventura', 'Sonoma', 'Sequoia', 'Tahoe'], null),
	macModel('MACPRO-M2U', 'Mac Pro (M2 Ultra)', ['Sonoma', 'Sequoia', 'Tahoe'], null)
];

// ---------------------------------------------------------------------------
// Android + Windows devices (Phase 9 cross-platform catalog)
// ---------------------------------------------------------------------------

/** @typedef {Object} GenericDevice — same shape as AppleDevice, plus manufacturer. */

function androidDevice(slug, name, manufacturer, runtimeDeviceName, osVersions, viewport = '390×844', deviceType = 'mobile') {
	const [width, height] = viewport.split('×').map(Number);
	return {
		slug, name, manufacturer,
		runtimeDeviceName,
		platformId: 'android',
		deviceType,
		screenSize: '—',
		osVersions,
		isRealDevice: true,
		// #14650 (NI02 Phase 2): tablets emulate with their own viewport, but
		// isMobile must stay false — a tablet context is not a phone context
		// (breakpoint, UA class, and layout assertions differ).
		emulation: {
			viewport: { width, height },
			deviceScaleFactor: 2.625,
			isMobile: deviceType !== 'tablet',
			hasTouch: true
		}
	};
}

function windowsDevice(slug, name, deviceType, osVersions = ['10', '11'], width = 1536, height = 864, hasTouch = deviceType === 'tablet') {
	return {
		slug, name, manufacturer: 'Microsoft',
		runtimeDeviceName: null,
		platformId: 'windows',
		deviceType,
		screenSize: `${width}×${height}`,
		osVersions,
		isRealDevice: false,
		emulation: { viewport: { width, height }, deviceScaleFactor: 1.25, isMobile: false, hasTouch }
	};
}

export const ANDROID_DEVICES = [
	// Samsung — Galaxy S21–S26, Note/A/Z series
	androidDevice('GALS21', 'Galaxy S21', 'Samsung', 'Samsung Galaxy S21', ['12', '13']),
	androidDevice('GALS22', 'Galaxy S22', 'Samsung', 'Samsung Galaxy S22', ['13', '14']),
	androidDevice('GALS23', 'Galaxy S23', 'Samsung', 'Samsung Galaxy S23', ['13', '14', '15']),
	androidDevice('GALS24', 'Galaxy S24', 'Samsung', 'Samsung Galaxy S24', ['14', '15']),
	androidDevice('GALS25', 'Galaxy S25', 'Samsung', 'Samsung Galaxy S25', ['15']),
	androidDevice('GALS26', 'Galaxy S26', 'Samsung', 'Samsung Galaxy S26', ['15', '16']),
	androidDevice('GALNOTE', 'Galaxy Note 20', 'Samsung', 'Samsung Galaxy Note 20', ['12', '13']),
	androidDevice('GALA54', 'Galaxy A54', 'Samsung', 'Samsung Galaxy A54', ['13', '14']),
	androidDevice('GALZFOLD', 'Galaxy Z Fold', 'Samsung', 'Samsung Galaxy Z Fold 5', ['13', '14', '15']),
	androidDevice('GALZFLIP', 'Galaxy Z Flip', 'Samsung', 'Samsung Galaxy Z Flip 5', ['13', '14', '15']),
	// Google Pixel 6–10, Pro variants, Fold
	androidDevice('PIXEL6', 'Pixel 6', 'Google', 'Google Pixel 6', ['12', '13', '14']),
	androidDevice('PIXEL7', 'Pixel 7', 'Google', 'Google Pixel 7', ['13', '14', '15']),
	androidDevice('PIXEL7PRO', 'Pixel 7 Pro', 'Google', 'Google Pixel 7 Pro', ['13', '14', '15']),
	androidDevice('PIXEL8', 'Pixel 8', 'Google', 'Google Pixel 8', ['14', '15']),
	androidDevice('PIXEL8PRO', 'Pixel 8 Pro', 'Google', 'Google Pixel 8 Pro', ['14', '15']),
	androidDevice('PIXEL9', 'Pixel 9', 'Google', 'Google Pixel 9', ['14', '15', '16']),
	androidDevice('PIXEL9PRO', 'Pixel 9 Pro', 'Google', 'Google Pixel 9 Pro', ['14', '15', '16']),
	androidDevice('PIXEL10', 'Pixel 10', 'Google', 'Google Pixel 10', ['15', '16']),
	androidDevice('PIXELFOLD', 'Pixel Fold', 'Google', 'Google Pixel Fold', ['14', '15']),
	// OnePlus 9–13, 13R
	androidDevice('OP9', 'OnePlus 9', 'OnePlus', 'OnePlus 9', ['12', '13']),
	androidDevice('OP10', 'OnePlus 10 Pro', 'OnePlus', 'OnePlus 10 Pro', ['12', '13', '14']),
	androidDevice('OP11', 'OnePlus 11', 'OnePlus', 'OnePlus 11', ['13', '14']),
	androidDevice('OP12', 'OnePlus 12', 'OnePlus', 'OnePlus 12', ['14', '15']),
	androidDevice('OP13', 'OnePlus 13', 'OnePlus', 'OnePlus 13', ['15']),
	androidDevice('OP13R', 'OnePlus 13R', 'OnePlus', 'OnePlus 13R', ['15']),
	// Motorola — Edge, Moto G, Razr
	androidDevice('MOTOEDGE', 'Motorola Edge 50', 'Motorola', 'Motorola Edge 50', ['13', '14', '15']),
	androidDevice('MOTOG', 'Moto G Power', 'Motorola', 'Moto G Power', ['12', '13', '14']),
	androidDevice('MOTORAZR', 'Motorola Razr', 'Motorola', 'Motorola Razr 40', ['13', '14', '15']),
	// Xiaomi / Redmi
	androidDevice('XIAOMI14', 'Xiaomi 14', 'Xiaomi', 'Xiaomi 14', ['13', '14', '15']),
	androidDevice('REDMINOTE', 'Redmi Note 13', 'Xiaomi', 'Redmi Note 13', ['13', '14']),
	// Oppo — Reno, Find, A
	androidDevice('OPPORENO', 'Oppo Reno 11', 'Oppo', 'Oppo Reno 11', ['13', '14']),
	androidDevice('OPPOFIND', 'Oppo Find X7', 'Oppo', 'Oppo Find X7', ['14', '15']),
	// Vivo — V, X, Y
	androidDevice('VIVOV', 'Vivo V30', 'Vivo', 'Vivo V30', ['14', '15']),
	androidDevice('VIVOX', 'Vivo X100', 'Vivo', 'Vivo X100', ['14', '15']),
	// Realme — GT, Number, C
	androidDevice('REALMEGT', 'Realme GT 6', 'Realme', 'Realme GT 6', ['14', '15']),
	androidDevice('REALMEC', 'Realme C67', 'Realme', 'Realme C67', ['13', '14']),
	// Nothing
	androidDevice('NOTHPHONE', 'Nothing Phone (2a)', 'Nothing', 'Nothing Phone (2a)', ['14', '15']),

	// --- 2027.01.0 (#14273) additions ---
	// Samsung fills: S Ultra variants, A/M series, Tab tablets, Z Fold/Flip 6
	androidDevice('GALS21U', 'Galaxy S21 Ultra', 'Samsung', 'Samsung Galaxy S21 Ultra', ['12', '13'], '384×824'),
	androidDevice('GALS22U', 'Galaxy S22 Ultra', 'Samsung', 'Samsung Galaxy S22 Ultra', ['12', '13', '14'], '384×824'),
	androidDevice('GALS23U', 'Galaxy S23 Ultra', 'Samsung', 'Samsung Galaxy S23 Ultra', ['13', '14', '15'], '384×824'),
	androidDevice('GALS24U', 'Galaxy S24 Ultra', 'Samsung', 'Samsung Galaxy S24 Ultra', ['14', '15'], '384×824'),
	androidDevice('GALS25U', 'Galaxy S25 Ultra', 'Samsung', 'Samsung Galaxy S25 Ultra', ['15'], '384×824'),
	androidDevice('GALA15', 'Galaxy A15', 'Samsung', 'Samsung Galaxy A15', ['13', '14'], '360×800'),
	androidDevice('GALA25', 'Galaxy A25', 'Samsung', 'Samsung Galaxy A25', ['13', '14'], '360×800'),
	androidDevice('GALA35', 'Galaxy A35', 'Samsung', 'Samsung Galaxy A35', ['14', '15'], '360×800'),
	androidDevice('GALA55', 'Galaxy A55', 'Samsung', 'Samsung Galaxy A55', ['14', '15'], '360×800'),
	androidDevice('GALM34', 'Galaxy M34', 'Samsung', 'Samsung Galaxy M34', ['13', '14'], '360×800'),
	androidDevice('GALM35', 'Galaxy M35', 'Samsung', 'Samsung Galaxy M35', ['14', '15'], '360×800'),
	androidDevice('GALM55', 'Galaxy M55', 'Samsung', 'Samsung Galaxy M55', ['14', '15'], '360×800'),
	androidDevice('GALTABS9', 'Galaxy Tab S9', 'Samsung', 'Samsung Galaxy Tab S9', ['13', '14', '15'], '800×1280', 'tablet'),
	androidDevice('GALTABS10', 'Galaxy Tab S10', 'Samsung', 'Samsung Galaxy Tab S10', ['14', '15'], '800×1280', 'tablet'),
	androidDevice('GALTABA9P', 'Galaxy Tab A9+', 'Samsung', 'Samsung Galaxy Tab A9+', ['13', '14'], '800×1280', 'tablet'),
	androidDevice('GALZFOLD6', 'Galaxy Z Fold 6', 'Samsung', 'Samsung Galaxy Z Fold 6', ['14', '15'], '968×896'),
	androidDevice('GALZFLIP6', 'Galaxy Z Flip 6', 'Samsung', 'Samsung Galaxy Z Flip 6', ['14', '15'], '373×844'),
	// Google fills: Pixel Pro/A/XL variants, Pixel Tablet
	androidDevice('PIXEL6PRO', 'Pixel 6 Pro', 'Google', 'Google Pixel 6 Pro', ['12', '13', '14'], '412×915'),
	androidDevice('PIXEL6A', 'Pixel 6a', 'Google', 'Google Pixel 6a', ['12', '13', '14'], '412×915'),
	androidDevice('PIXEL7A', 'Pixel 7a', 'Google', 'Google Pixel 7a', ['13', '14', '15'], '412×915'),
	androidDevice('PIXEL8A', 'Pixel 8a', 'Google', 'Google Pixel 8a', ['14', '15'], '412×915'),
	androidDevice('PIXEL9A', 'Pixel 9a', 'Google', 'Google Pixel 9a', ['15'], '412×1016'),
	androidDevice('PIXEL9PROXL', 'Pixel 9 Pro XL', 'Google', 'Google Pixel 9 Pro XL', ['14', '15', '16'], '412×1016'),
	androidDevice('PIXEL10PRO', 'Pixel 10 Pro', 'Google', 'Google Pixel 10 Pro', ['15', '16'], '412×1016'),
	androidDevice('PIXELTABLET', 'Pixel Tablet', 'Google', 'Google Pixel Tablet', ['13', '14', '15'], '1280×800', 'tablet'),
	// New manufacturers (2027.01.0 #14273)
	androidDevice('POCOX6', 'POCO X6', 'POCO', 'POCO X6', ['13', '14'], '393×873'),
	androidDevice('POCOF6', 'POCO F6', 'POCO', 'POCO F6', ['14', '15'], '393×873'),
	androidDevice('XPERIA1VI', 'Xperia 1 VI', 'Sony', 'Sony Xperia 1 VI', ['14', '15'], '412×915'),
	androidDevice('XPERIA5V', 'Xperia 5 V', 'Sony', 'Sony Xperia 5 V', ['13', '14', '15'], '412×915'),
	androidDevice('XPERIA10V', 'Xperia 10 V', 'Sony', 'Sony Xperia 10 V', ['13', '14'], '360×800'),
	androidDevice('ZENFONE10', 'Zenfone 10', 'Asus', 'Asus Zenfone 10', ['13', '14'], '360×800'),
	androidDevice('ZENFONE11', 'Zenfone 11 Ultra', 'Asus', 'Asus Zenfone 11 Ultra', ['14', '15'], '384×824'),
	androidDevice('ROGPHONE8', 'ROG Phone 8', 'Asus', 'Asus ROG Phone 8', ['14', '15'], '384×824'),
	androidDevice('LENOTABP12', 'Tab P12', 'Lenovo', 'Lenovo Tab P12', ['13', '14'], '1200×1840', 'tablet'),
	androidDevice('HUAWEIP60', 'P60', 'Huawei', 'Huawei P60', ['12'], '360×960'),
	androidDevice('HUAWEIMATE60', 'Mate 60 Pro', 'Huawei', 'Huawei Mate 60 Pro', ['12'], '460×2208'),
	androidDevice('HONORMAGIC6', 'Magic 6 Pro', 'Honor', 'Honor Magic 6 Pro', ['14'], '384×824'),
	androidDevice('HONOR90', 'Honor 90', 'Honor', 'Honor 90', ['13', '14'], '393×873'),
	// Extensions of existing manufacturers
	androidDevice('XIAOMI15', 'Xiaomi 15', 'Xiaomi', 'Xiaomi 15', ['15'], '393×873'),
	androidDevice('XIAOMI15P', 'Xiaomi 15 Pro', 'Xiaomi', 'Xiaomi 15 Pro', ['15'], '1440×3200'),
	androidDevice('REDMINOTE13P', 'Redmi Note 13 Pro', 'Xiaomi', 'Redmi Note 13 Pro', ['13', '14'], '393×873'),
	androidDevice('REDMINOTE14', 'Redmi Note 14', 'Xiaomi', 'Redmi Note 14', ['14', '15'], '393×873'),
	androidDevice('NOTHPHONE3A', 'Nothing Phone (3a)', 'Nothing', 'Nothing Phone (3a)', ['15'], '393×873')
];

export const WINDOWS_DEVICES = [
	windowsDevice('WINLAPTOP', 'Windows Laptop', 'desktop', ['7', '8', '8.1', '10', '11'], 1536, 864, false),
	windowsDevice('WINLAPTOP-T', 'Windows Touch Laptop', 'desktop', ['10', '11'], 1536, 864, true),
	windowsDevice('WINDESKTOP', 'Windows Desktop', 'desktop', ['7', '8', '8.1', '10', '11'], 1920, 1080, false),
	// 2027.03.0 (#14631) NI01: distinct resolution profiles for the same form
	// factor — laptop FHD and desktop QHD alongside the existing HD defaults.
	windowsDevice('WINLAPTOP-FHD', 'Windows Laptop (FHD)', 'desktop', ['10', '11'], 1920, 1080, false),
	windowsDevice('WINDESKTOP-QHD', 'Windows Desktop (QHD)', 'desktop', ['10', '11'], 2560, 1440, false),
	windowsDevice('WINTABLET', 'Windows Tablet', 'tablet', ['10', '11'], 1280, 800, true),
	// 2027.01.0 (#14273): 2-in-1 form factor + legacy OS reach. Windows Server
	// is deliberately absent — the execution infrastructure has no Server targets.
	windowsDevice('WIN2IN1', 'Windows 2-in-1', 'two-in-one', ['10', '11'], 1440, 900, true),
	// 2027.02.0 (#14420): Microsoft Surface hardware models — Win 10/11 only
	// where the hardware supports it (Pro 9/10 ship Win 11; Laptop 7 (Snapdragon)
	// and Laptop 6 caps at Win 11/10; Go 3 spans 10→11 with S-mode lineage).
	windowsDevice('SURFPRO9', 'Surface Pro 9', 'tablet', ['11'], 2880, 1920, true),
	windowsDevice('SURFPRO10', 'Surface Pro 10', 'tablet', ['11'], 2880, 1920, true),
	windowsDevice('SURFPRO11', 'Surface Pro 11', 'tablet', ['11'], 2880, 1920, true),
	windowsDevice('SURFLAP5', 'Surface Laptop 5', 'desktop', ['10', '11'], 2256, 1504, false),
	windowsDevice('SURFLAP6', 'Surface Laptop 6', 'desktop', ['11'], 2304, 1536, false),
	windowsDevice('SURFLAP7', 'Surface Laptop 7', 'desktop', ['11'], 2304, 1536, false),
	windowsDevice('SURFGO3', 'Surface Go 3', 'tablet', ['10', '11'], 1920, 1280, true)
];

/** All catalog devices across platforms (Apple unchanged, then Android, then Windows). */
export const ALL_DEVICES = [...APPLE_DEVICES, ...ANDROID_DEVICES, ...WINDOWS_DEVICES];

/** Manufacturer for a device slug — Apple devices are their own manufacturer. */
export function manufacturerFor(deviceOrSlug) {
	const device = typeof deviceOrSlug === 'string'
		? ALL_DEVICES.find((candidate) => candidate.slug === deviceOrSlug)
		: deviceOrSlug;
	if (!device) return null;
	return device.manufacturer ?? (device.platformId === 'ios' || device.platformId === 'ipados' ? 'Apple' : 'Apple');
}

function iphone(slug, name, viewport, dpr, screenSize, osVersions) {
	const [width, height] = viewport.split('×').map(Number);
	return {
		slug,
		name,
		runtimeDeviceName: name,
		platformId: 'ios',
		deviceType: 'mobile',
		manufacturer: 'Apple',
		screenSize: `${screenSize}`,
		osVersions,
		isRealDevice: true,
		emulation: { viewport: { width, height }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true }
	};
}

function ipad(slug, name, runtimeDeviceName, viewport, dpr, screenSize, osVersions) {
	const [width, height] = viewport.split('×').map(Number);
	return {
		slug,
		name,
		runtimeDeviceName,
		platformId: 'ipados',
		deviceType: 'tablet',
		manufacturer: 'Apple',
		screenSize: `${screenSize}`,
		osVersions,
		isRealDevice: true,
		emulation: { viewport: { width, height }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true }
	};
}

function mac(slug, name, version) {
	return {
		slug,
		name,
		runtimeDeviceName: null,
		platformId: 'macos',
		deviceType: 'desktop',
		manufacturer: 'Apple',
		screenSize: '—',
		osVersions: [name.replace('macOS ', '')],
		isRealDevice: false,
		emulation: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
		macOsVersion: version
	};
}

/**
 * macOS hardware model (2027.01.0 #14273). osVersions are macOS marketing
 * names ("Monterey"…); macOsVersion is derived per name so Safari version
 * resolution keeps working.
 */
function macModel(slug, name, osVersions, inches) {
	const VERSION_BY_NAME = {
		'High Sierra': '10.13', 'Mojave': '10.14', 'Catalina': '10.15',
		'Big Sur': '11', 'Monterey': '12', 'Ventura': '13',
		'Sonoma': '14', 'Sequoia': '15', 'Tahoe': '26'
	};
	return {
		slug,
		name,
		runtimeDeviceName: null,
		platformId: 'macos',
		deviceType: 'desktop',
		manufacturer: 'Apple',
		screenSize: inches ? `${inches} inch` : '—',
		osVersions,
		isRealDevice: false,
		emulation: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false },
		macOsVersions: osVersions.map((osName) => VERSION_BY_NAME[osName])
	};
}

const DEVICE_BY_NAME = new Map(ALL_DEVICES.map((device) => [device.name, device]));
const DEVICE_BY_SLUG = new Map(ALL_DEVICES.map((device) => [device.slug, device]));
const PLATFORM_BY_ID = new Map(PLATFORMS.map((platform) => [platform.id, platform]));
const BROWSER_BY_CODE = new Map(BROWSERS.map((browser) => [browser.code, browser]));

export function getPlatform(id) {
	return PLATFORM_BY_ID.get(id) ?? null;
}

export function getBrowser(code) {
	return BROWSER_BY_CODE.get(String(code ?? '').toLowerCase()) ?? null;
}

export function getDevice(nameOrSlug) {
	return DEVICE_BY_NAME.get(nameOrSlug) ?? DEVICE_BY_SLUG.get(nameOrSlug) ?? null;
}

// ---------------------------------------------------------------------------
// Combination validation
// ---------------------------------------------------------------------------

/**
 * Whether a (platform, device, osVersion, browser[, browserVersion]) combination
 * is executable in QASE. Returns { ok, reason } so callers can surface
 * a human-readable reason on rejection.
 */
export function isCombinationSupported(platformId, device, osVersion, browser, browserVersion) {
	const platform = PLATFORM_BY_ID.get(platformId);
	if (!platform) return { ok: false, reason: `Unknown platform "${platformId}"` };

	const deviceRecord = typeof device === 'string' ? getDevice(device) : device;
	if (!deviceRecord || deviceRecord.platformId !== platformId) {
		return { ok: false, reason: `Unknown or mismatched device "${device?.name ?? device}" for platform ${platform.label}` };
	}
	if (!deviceRecord.osVersions.includes(osVersion)) {
		// Windows accepts 'Windows 11' / 'Win 11' spellings — normalize then recheck.
		const windowsNormalized = platformId === 'windows'
			? String(osVersion).replace(/^.*?(\d+(?:\.\d+)*)\s*$/,'$1')
			: null;
		if (!(platformId === 'windows' && deviceRecord.osVersions.includes(windowsNormalized))) {
			return { ok: false, reason: `${deviceRecord.name} does not support OS version ${osVersion} (supported: ${deviceRecord.osVersions.join(', ')})` };
		}
	}

	const browserRecord = typeof browser === 'string' ? getBrowser(browser) : browser;
	if (!browserRecord) {
		return { ok: false, reason: `Unknown browser "${browser}"` };
	}
	if (!browserRecord.platforms.includes(platformId)) {
		return { ok: false, reason: `${browserRecord.name} is not supported on ${platform.label}${browserRecord.note ? ` — ${browserRecord.note}` : ''}` };
	}

	if (browserRecord.code === 'safari') {
		if (browserVersion !== undefined && browserVersion !== null) {
			const derived = safariVersionFor(platformId, osVersion);
			if (String(browserVersion) !== derived) {
				return { ok: false, reason: `Safari version is derived from the OS: ${platform.os} ${osVersion} ships Safari ${derived}, not ${browserVersion}` };
			}
		}
		return { ok: true };
	}

	if (!browserRecord.independentlyVersioned) {
		return { ok: false, reason: `${browserRecord.name} has no independently selectable version on this platform` };
	}
	const allowed = BROWSER_VERSIONS[browserRecord.code] ?? [];
	if (browserVersion !== undefined && browserVersion !== null && !allowed.includes(String(browserVersion))) {
		return { ok: false, reason: `${browserRecord.name} version ${browserVersion} is not available (available: ${allowed.join(', ')})` };
	}
	return { ok: true };
}

// ---------------------------------------------------------------------------
// ENV ID + environment generation
// ---------------------------------------------------------------------------

/** Normalize an OS version for use in an ENV ID (keeps dots, strips spaces): "18.3", "Sonoma". */
function osVersionToken(platformId, osVersion) {
	if (platformId === 'macos') {
		return osVersion.replace(/\s+/g, '').toUpperCase();
	}
	if (platformId === 'windows') {
		// 'Windows 11' -> WIN-11; '11' -> 11
		const match = /(\d+(?:\.\d+)*)\s*$/.exec(String(osVersion).trim());
		return match ? match[1] : String(osVersion).replace(/\s+/g, '');
	}
	return osVersion;
}

/**
 * Stable, lowercase, human-readable profile identifier (NI01 2027.03.0 #14631).
 * Deterministic from the same inputs as the ENV ID, so it is unique wherever
 * the ENV ID is unique: {device-slug-lower}-{os-token}-{browser}{version}.
 * Examples: iphone17promax-ios26-safari26, pixel9-android16-chrome140,
 * ipadpro13-ipados26-safari26, windows11-chrome140, macos-tahoe-safari26.
 * The ENV ID stays the source of truth for run linking; profileId is an
 * additive alias for reporting and matrix-run bookkeeping.
 */
const PROFILE_OS_TOKEN = {
	// "18.0" → ios18, "18.3" → ios183, "26.0" → ios26 — minor versions are
	// kept so sibling OS versions within a major stay distinct.
	ios: (osVersion) => `ios${profileOsDigits(osVersion)}`,
	ipados: (osVersion) => `ipados${profileOsDigits(osVersion)}`,
	android: (osVersion) => `android${profileOsDigits(osVersion)}`,
	windows: (osVersion) => {
		const match = /(\d+(?:\.\d+)*)\s*$/.exec(String(osVersion).trim());
		const token = profileOsDigits(match ? match[1] : osVersion);
		return `windows${token}`;
	},
	macos: (osVersion) => `macos-${String(osVersion).replace(/\s+/g, '-').toLowerCase()}`
};

function profileOsDigits(osVersion) {
	const parts = String(osVersion).trim().split('.');
	const major = parts[0];
	const minor = parts.slice(1).join('');
	return minor && minor !== '0' ? `${major}${minor}` : major;
}

export function buildProfileId(platformId, deviceSlug, osVersion, browserCode, browserVersion) {
	// Prefer the human device name (matches the agreed examples, e.g.
	// "iPhone 17 Pro Max" → iphone17promax); fall back to the raw slug for
	// devices outside the frozen catalog (custom environments).
	const knownDevice = DEVICE_BY_SLUG.get(deviceSlug);
	const deviceToken = String(knownDevice?.name ?? deviceSlug).toLowerCase().replace(/[^a-z0-9]+/g, '');
	const browserToken = `${String(browserCode).toLowerCase()}${String(browserVersion).split('.')[0]}`;
	const osToken = PROFILE_OS_TOKEN[platformId]?.(osVersion)
		?? `${String(osVersion).replace(/[^a-z0-9]+/g, '').toLowerCase()}`;
	return `${deviceToken}-${osToken}-${browserToken}`;
}

/**
 * Deterministic ENV ID: ENV-{PLAT}-{DEVICE_SLUG}-{OSVER}-{BROWSER3}-{BROWSER_MAJOR}.
 * 2027.01.0 (#14273): macOS devices are hardware models spanning multiple
 * macOS versions, so the OS token is now REQUIRED for uniqueness:
 * ENV-MAC-MACMBP16-M4-TAHOE-CHR-140. (Legacy one-device-per-OS pseudo-devices
 * omitted it because the slug itself encoded the OS — those are retired.)
 */
export function buildEnvId(platformId, deviceSlug, osVersion, browserEnvCode, browserVersion) {
	const plat = PLATFORM_BY_ID.get(platformId)?.envCode ?? '??';
	if (platformId === 'windows') {
		// Windows devices are generic form factors (Laptop/Desktop/Tablet/2-in-1)
		// and the OS version carries the distinguishing information:
		// ENV-WIN-11-CHR-141.
		return `ENV-${plat}-${osVersionToken(platformId, osVersion)}-${browserEnvCode}-${browserVersion}-${deviceSlug}`;
	}
	return `ENV-${plat}-${deviceSlug}-${osVersionToken(platformId, osVersion)}-${browserEnvCode}-${browserVersion}`;
}

/**
 * The full deterministic environment matrix. Pure — callers persist the result.
 * Only executable combinations are emitted.
 */
export function generateEnvironments() {
	const environments = [];
	for (const device of ALL_DEVICES) {
		const platform = PLATFORM_BY_ID.get(device.platformId);
		for (const osVersion of device.osVersions) {
			for (const browser of BROWSERS) {
				if (!browser.platforms.includes(device.platformId)) continue;
				if (browser.code === 'safari') {
					const safariVersion = safariVersionFor(device.platformId, osVersion);
					if (!safariVersion) continue;
					environments.push(buildEnvironment(device, platform, osVersion, browser, safariVersion, safariVersion));
				} else {
					for (const version of BROWSER_VERSIONS[browser.code] ?? []) {
						environments.push(buildEnvironment(device, platform, osVersion, browser, version, version));
					}
				}
			}
		}
	}
	return environments;
}

function buildEnvironment(device, platform, osVersion, browser, browserVersion, capabilityBrowserVersion) {
	const envId = buildEnvId(device.platformId, device.slug, osVersion, browser.envCode, browserVersion);
	const profileId = buildProfileId(device.platformId, device.slug, osVersion, browser.code, browserVersion);
	const capabilities = device.platformId === 'macos'
		? {
			browserName: browser.code,
			browserVersion: capabilityBrowserVersion,
			os: 'OS X',
			osVersion
		}
		: device.platformId === 'android'
			? {
				browserName: browser.code,
				browserVersion: capabilityBrowserVersion,
				os: 'android',
				osVersion,
				deviceName: device.runtimeDeviceName,
				realMobile: true
			}
			: device.platformId === 'windows'
				? {
					browserName: browser.code,
					browserVersion: capabilityBrowserVersion,
					os: 'Windows',
					osVersion
				}
				: device.platformId === 'ipados'
					? {
						browserName: browser.code,
						...(browser.code === 'safari' ? {} : { browserVersion: capabilityBrowserVersion }),
						os: 'ios',
						osVersion,
						deviceName: device.runtimeDeviceName,
						realMobile: true
					}
					: {
						browserName: browser.code,
						...(browser.code === 'safari' ? {} : { browserVersion: capabilityBrowserVersion }),
						os: 'ios',
						osVersion,
						deviceName: device.runtimeDeviceName,
						realMobile: true
					};
	return {
		envId,
		profileId,
		platform: device.platformId,
		platformLabel: platform.label,
		device: device.name,
		...(device.manufacturer ? { manufacturer: device.manufacturer } : {}),
		os: platform.os,
		osVersion,
		browser: browser.name,
		browserCode: browser.code,
		browserVersion: String(browserVersion),
		deviceType: device.deviceType,
		screenSize: device.screenSize,
		screenResolution: device.emulation?.viewport
			? `${device.emulation.viewport.width}x${device.emulation.viewport.height}`
			: null,
		orientation: device.deviceType === 'desktop' ? null : 'portrait',
		executionProvider: 'environment',
		isRealDevice: device.isRealDevice,
		active: true,
		runtimeCapabilities: capabilities
	};
}

/**
 * Documentation surface for the UI: why browsers are (un)available per platform.
 * RT1 (#14680): async — resolutions are registry-fed (real branded binaries).
 */
export async function availabilityReport(providers = {}) {
	// #14632 (NI01 Phase 2): platform membership stays the inventory view, and
	// each browser now carries its provider-derived EXECUTABILITY resolution
	// (supported / engine_equivalent / not_supported + reason). One source of
	// truth served by GET /api/environments/availability and joined by the UI.
	const supportByCode = Object.fromEntries(
		await Promise.all(
			['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo']
				.map(async (code) => [code, await resolveBrowserSupport('any', code, providers)])
		)
	);
	return PLATFORMS.map((platform) => ({
		platform: platform.id,
		platformLabel: platform.label,
		available: BROWSERS.filter((browser) => browser.platforms.includes(platform.id)).map((browser) => browser.name),
		unavailable: BROWSERS
			.filter((browser) => !browser.platforms.includes(platform.id))
			.map((browser) => ({ browser: browser.name, reason: browser.note ?? 'Not supported on this platform.' })),
		browserSupport: BROWSERS
			.filter((browser) => browser.platforms.includes(platform.id))
			.map((browser) => ({
				browser: browser.name,
				browserCode: browser.code,
				...supportByCode[browser.code]
			}))
	}));
}
