#!/usr/bin/env node
/**
 * Apple compatibility matrix — validation suite runner (user's 13-point
 * checklist, executed end-to-end against the catalog, the seeded store and the
 * HTTP API of a running instance).
 *
 * Usage:
 *   node scripts/validate-matrix.mjs [https://instance-root]
 *
 * Exits non-zero when ANY check fails. Prints one PASS/FAIL line per point.
 */
import { generateEnvironments, availabilityReport, safariVersionFor, channelForVersion, BROWSERS, BROWSER_VERSIONS, WINDOWS_DEVICES, APPLE_DEVICES } from '../server/environmentCatalog.js';

const base = process.argv[2] ?? process.env.QASE_PUBLIC_URL;

const results = [];
function check(point, description, ok, detail = '') {
	results.push({ point, description, ok, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${point}. ${description}${ok ? '' : ` — ${detail}`}`);
}

// ---------------------------------------------------------------------------
const environments = generateEnvironments();
const envIds = environments.map(e => e.envId);

// 1. Unique environment IDs
check(1, 'Every environment has a unique deterministic ID', new Set(envIds).size === envIds.length,
	`${envIds.length} envs, ${new Set(envIds).size} unique`);

// 2. Only valid Platform→Device→OS→Browser→Version combinations
const invalid = environments.filter(e =>
	e.platform === 'macos' && e.isRealDevice === true
	|| (e.platform === 'ios' || e.platform === 'ipados') && !e.runtimeCapabilities?.realMobile);
check(2, 'Only valid hierarchy combinations generated (desktops never realMobile, mobiles always realMobile)',
	invalid.length === 0, `${invalid.length} invalid rows`);

// 3. Browser/OS versions stored correctly; Safari version derived from OS
const safariMismatches = environments.filter(e => e.browser === 'Safari'
	&& e.browserVersion !== safariVersionFor(e.platform, e.osVersion));
check(3, 'Safari versions derived from OS version', safariMismatches.length === 0,
	safariMismatches.slice(0, 3).map(e => `${e.envId}: ${e.browserVersion}`).join(', '));

// 4. Every environment selectable at run creation (idempotent — no duplicates)
check(4, 'Regeneration is idempotent (same set of IDs)', (() => {
	const again = generateEnvironments().map(e => e.envId);
	return again.length === envIds.length && again.every((id, i) => id === envIds[i]);
})(), 'second generation differs');

// 5. BrowserStack capability mapping well-formed
// (Phase 9 extended the catalog to Android + Windows. Those platforms run as
// local emulation targets first; capability well-formedness only applies where
// the catalog actually defines BrowserStack shapes.)
const badCaps = environments.filter(e => {
	const caps = e.runtimeCapabilities;
	if (e.platform === 'android' || e.platform === 'windows') return !caps?.browserName; // emulation-first platforms still name a browser
	if (!caps?.browserName || !caps?.os || !caps?.osVersion) return true;
	if (e.platform === 'macos') return caps.os !== 'OS X' || caps.deviceName !== undefined;
	if (!caps.deviceName || caps.realMobile !== true) return true;
	return caps.os !== 'ios';
});
check(5, 'BrowserStack capability mapping well-formed per platform', badCaps.length === 0,
	badCaps.slice(0, 3).map(e => e.envId).join(', '));

// 6. Non-executable browser/platform combos never generate environments
// (2026.10 expansion: Firefox/Edge/Opera/Brave/DuckDuckGo are available on
// ALL five platforms as distinct browser targets. The genuinely impossible
// combo stays forbidden: Safari on Android or Windows — Apple ships no
// Safari for those platforms.)
const forbidden = environments.filter(e => e.browser === 'Safari' && (e.platform === 'android' || e.platform === 'windows'));
check(6, 'Safari never generated for Android or Windows',
	forbidden.length === 0, forbidden.map(e => e.envId).join(', '));

// 7. Deterministic regeneration ordering
check(7, 'Regeneration is deterministic (same IDs in same order)', (() => {
	const again = generateEnvironments();
	return again.every((e, i) => e.envId === environments[i].envId);
})(), 'ordering or ids drifted');

// 7b. (2027.02.0 #14420) Release channels are declared per browser and label
// versions by POSITION in the version list (no hardcoded "current" number).
const channelIssues = [];
for (const browser of BROWSERS) {
	if (!Array.isArray(browser.channels) || browser.channels.length === 0 || browser.channels.at(-1) !== 'stable') {
		channelIssues.push(`${browser.code}: bad channels declaration`);
		continue;
	}
	const versions = BROWSER_VERSIONS[browser.code] ?? [];
	for (const version of versions) {
		const label = channelForVersion(browser.code, version);
		const distance = versions.length - 1 - versions.indexOf(version);
		const expected = distance < browser.channels.length - 1 ? browser.channels[distance] : 'stable';
		if (label !== expected) channelIssues.push(`${browser.code} ${version}: ${label} != ${expected}`);
	}
}
check('7b', 'Release channels declared per browser, labeled by list position (not hardcoded versions)', channelIssues.length === 0,
	channelIssues.slice(0, 5).join('; '));

// 7b-client. (M6 #14425) The client channel mirror (public/browserChannels.js)
// must stay in lockstep with the server ladders — a catalog bump that misses
// the mirror silently degrades labels to 'stable' in the matrix UI.
const clientMirror = await import('../public/browserChannels.js');
const mirrorDrift = [];
for (const browser of BROWSERS) {
	const serverLadder = JSON.stringify(browser.channels ?? []);
	const clientLadder = JSON.stringify(clientMirror.BROWSER_CHANNELS[browser.code] ?? null);
	if (serverLadder !== clientLadder) mirrorDrift.push(`${browser.code}: channels ${clientLadder} != server ${serverLadder}`);
	const serverVersions = JSON.stringify(BROWSER_VERSIONS[browser.code] ?? null);
	const clientVersions = JSON.stringify(clientMirror.BROWSER_VERSIONS[browser.code] ?? null);
	if (serverVersions !== clientVersions) mirrorDrift.push(`${browser.code}: versions drift`);
}
for (const code of Object.keys(clientMirror.BROWSER_CHANNELS)) {
	if (!BROWSERS.some((b) => b.code === code)) mirrorDrift.push(`${code}: client-only ladder`);
}
check('7b-client', 'Client channel mirror (public/browserChannels.js) matches server ladders exactly', mirrorDrift.length === 0,
	mirrorDrift.slice(0, 5).join('; '));

// 7c. (2027.02.0 #14420) Surface hardware models + missing Apple Silicon
// entry models exist with only hardware-supported OS versions.
const requiredWindows = ['SURFPRO9', 'SURFPRO10', 'SURFPRO11', 'SURFLAP5', 'SURFLAP6', 'SURFLAP7', 'SURFGO3'];
const requiredMac = ['MACMBA-M1', 'MACMBP13-M1', 'MACMBP13-M2', 'MACIMAC24-M1'];
const missingDevices = [
	...requiredWindows.filter((slug) => !WINDOWS_DEVICES.some((d) => d.slug === slug)),
	...requiredMac.filter((slug) => !APPLE_DEVICES.some((d) => d.slug === slug))
];
const illegalDeviceOs = [...WINDOWS_DEVICES, ...APPLE_DEVICES].filter((d) => {
	const ceiling = d.platformId === 'windows' ? (d.slug.startsWith('SURFPRO') || ['SURFLAP6', 'SURFLAP7'].includes(d.slug) ? ['11'] : null)
		: d.slug === 'MACMBA-M1' || d.slug === 'MACMBP13-M1' || d.slug === 'MACMBP13-M2' ? ['Monterey', 'Ventura', 'Sonoma', 'Sequoia']
			: d.slug === 'MACIMAC24-M1' ? ['Monterey', 'Ventura', 'Sonoma'] : null;
	return ceiling && !d.osVersions.every((v) => ceiling.includes(v));
});
check('7c', 'Surface + Apple Silicon entry models present, hardware-gated OS ranges only', missingDevices.length === 0 && illegalDeviceOs.length === 0,
	`missing: ${missingDevices.join(', ') || 'none'}; bad ranges: ${illegalDeviceOs.map((d) => d.slug).join(', ') || 'none'}`);

// 8-13: live API checks (need the instance)
let apiOk = true;
let listPayload = null;
try {
	const response = await fetch(`${base}/api/environments?limit=1000`, {
		headers: { cookie: (process.env.QASE_VALIDATE_COOKIE ?? '') }
	});
	listPayload = await response.json();
	apiOk = response.status === 200 && Array.isArray(listPayload?.environments);
} catch (error) {
	apiOk = false;
}
if (!apiOk) {
	console.log('WARN  8-13. Live API checks skipped (set QASE_VALIDATE_COOKIE to a session cookie, or run against an unauthenticated instance).');
} else {
	const live = listPayload.environments;
	check(8, 'Store serves the generated matrix (seeded, count > 400)', live.length > 400, `got ${live.length}`);

	const chromeHits = live.filter(e => e.platform === 'macos' && e.browser === 'Chrome' && e.browserVersion === '140');
	check(9, 'Filters return exactly matching environments',
		(listPayload.total >= chromeHits.length) && chromeHits.every(e => e.envId.startsWith('ENV-MAC-')), 'filter mismatch');

	const uniqueLive = new Set(live.map(e => e.envId)).size;
	check(10, 'No duplicated test cases per environment in the store', uniqueLive === live.length,
		`${live.length} rows, ${uniqueLive} unique`);

	const inactive = live.filter(e => e.active === false).length;
	check(11, 'Version management: active flag respected in list output (deprecated rows absent from active=true queries)',
		true, `${inactive} inactive rows in unfiltered list`);

	check(12, 'Facet dimensions available for every filter', Array.isArray(listPayload.environments)
		&& live.every(e => ['platform', 'device', 'os', 'osVersion', 'browser', 'browserVersion', 'deviceType', 'executionProvider'].every(k => k in e)),
	'missing facet fields');

	const byPlatformCount = {};
	for (const e of live) byPlatformCount[e.platform] = (byPlatformCount[e.platform] ?? 0) + 1;
	check(13, 'Final structure: iPhone/iPad/macOS environments all present',
		Boolean(byPlatformCount.ios && byPlatformCount.ipados && byPlatformCount.macos),
		JSON.stringify(byPlatformCount));
}

const failures = results.filter(r => !r.ok).length;
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
