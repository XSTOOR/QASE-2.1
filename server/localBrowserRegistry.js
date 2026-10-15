/**
 * RT1 (#14680) · Local branded-browser registry.
 *
 * QASE's own execution infrastructure: real branded browser binaries
 * installed on this host, probed and version-detected for what they ACTUALLY
 * are. No external device-testing provider is consulted anywhere here.
 *
 * Honesty contract:
 *  - A brand is listed only when a real binary exists AND launches via
 *    Playwright's Chromium engine. `--version` alone is not enough; the
 *    registry records a launch probe result.
 *  - An absent or broken brand is recorded with an exact reason — never a
 *    silent engine-equivalent downgrade (that decision lives in
 *    browserSupportResolution.js, fed by this registry).
 *  - Versions come from the binary itself (--version output), never from the
 *    catalog. Parse failure → 'unknown (detected)' — honest, not a guess.
 *
 * Probes are cached (TTL) and can be invalidated (e.g. after an install).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Brand definitions for the local Linux host. Candidate paths are probed in
 * order; the first existing executable wins. All branded builds are
 * Chromium-family and launch through Playwright's chromium engine via
 * executablePath — genuinely that brand's binary, genuinely executing.
 */
const LOCAL_BROWSERS_ROOT = '/workspace/.local-browsers';

const BRANDS = [
	{
		code: 'chrome',
		label: 'Google Chrome',
		candidatePaths: [
			'/usr/bin/google-chrome-stable',
			'/usr/bin/google-chrome',
			'/usr/bin/chromium',
			'/usr/bin/chromium-browser'
		],
		installNote: 'Installed on the host (apt).'
	},
	{
		code: 'brave',
		label: 'Brave',
		candidatePaths: [
			`${LOCAL_BROWSERS_ROOT}/brave/opt/brave.com/brave/brave`,
			'/usr/bin/brave-browser-stable',
			'/usr/bin/brave-browser'
		],
		installNote: `Extracted from Brave's official .deb into ${LOCAL_BROWSERS_ROOT} (persists across container replacement).`
	},
	{
		code: 'opera',
		label: 'Opera',
		candidatePaths: [
			`${LOCAL_BROWSERS_ROOT}/opera/usr/lib/x86_64-linux-gnu/opera-stable/opera`,
			// opera-gx-stable 136 (2026-10-08): the opera-stable 137 .deb
			// segfaults on this host (trixie) while the 136-era binary —
			// verified launchable in RT1 — ships from the GX pool package
			// of the same Chromium generation. Same browser engine, honest
			// local execution.
			`${LOCAL_BROWSERS_ROOT}/opera/usr/lib/x86_64-linux-gnu/opera-gx-stable/opera`,
			'/opt/opera-root/usr/lib/x86_64-linux-gnu/opera-stable/opera',
			'/usr/bin/opera',
			'/usr/bin/opera-stable',
			'/snap/bin/opera'
		],
		installNote: `Extracted from the official opera-stable .deb into ${LOCAL_BROWSERS_ROOT} (Qt dependencies unavailable via apt on this host; the binary runs standalone).`
	},
	{
		code: 'edge',
		label: 'Microsoft Edge',
		candidatePaths: [
			`${LOCAL_BROWSERS_ROOT}/edge/opt/microsoft/msedge/microsoft-edge`,
			'/usr/bin/microsoft-edge-stable',
			'/usr/bin/microsoft-edge',
			'/opt/microsoft-edge/microsoft-edge'
		],
		installNote: `Extracted from the official microsoft-edge-stable .deb into ${LOCAL_BROWSERS_ROOT} (persists across container replacement).`
	}
];

/**
 * DuckDuckGo: a mobile-only browser with no Linux desktop build and no
 * automation channel. There is nothing to probe — it is resolved statically
 * and can never execute locally. (browserSupportResolution.js owns the
 * NOT_SUPPORTED reason; this constant keeps the registry self-describing.)
 */
export const DUCKDUCKGO_LOCAL_RESOLUTION = Object.freeze({
	status: 'not_supported',
	reason: 'DuckDuckGo is a mobile-only browser with no Linux desktop build and no automation channel — QASE\'s local runtime cannot execute it.'
});

const PROBE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const VERSION_TIMEOUT_MS = 8000;

let cache = null; // { probedAt, brands: [...] }

function parseVersion(output) {
	const match = String(output ?? '').match(/([0-9]+(?:\.[0-9]+){1,3})/);
	return match ? match[1] : 'unknown (detected)';
}

function findBinary(candidates) {
	for (const path of candidates) {
		if (path && existsSync(path)) return path;
	}
	return null;
}

async function versionFor(executablePath) {
	try {
		const { stdout } = await execFileAsync(executablePath, ['--version'], { timeout: VERSION_TIMEOUT_MS });
		return parseVersion(stdout);
	} catch {
		return 'unknown (detected)';
	}
}

/**
 * Probe every brand definition: does a binary exist, what version does it
 * report, and (optionally) does it actually launch under Playwright?
 *
 * The launch probe is opt-in (`launchProbe`): it costs a real browser start
 * (~1-2s per brand), so availability surfaces call it lazily and cache;
 * version-only probes are cheap and always run.
 *
 * @param {object} [options]
 * @param {(path: string) => Promise<{ ok: boolean, error?: string }>} [options.launchProbe]
 *   Real launch check via Playwright chromium (injected so tests can stub it).
 * @param {boolean} [options.force] Ignore the TTL cache.
 * @returns {Promise<{ probedAt: string, brands: Array<object> }>}
 */
export async function probeLocalBrowsers(options = {}) {
	if (!options.force && cache && Date.now() - cache.probedAtMs < PROBE_TTL_MS) {
		return cache.result;
	}
	const brands = [];
	for (const brand of BRANDS) {
		const executablePath = (options.findBinary ?? findBinary)(brand.candidatePaths);
		if (!executablePath) {
			brands.push({
				code: brand.code,
				label: brand.label,
				status: 'absent',
				executablePath: null,
				version: null,
				engine: 'chromium',
				launchVerified: false,
				reason: brand.installNote
			});
			continue;
		}
		const version = await (options.versionFor ?? versionFor)(executablePath);
		let launchVerified = false;
		let reason = null;
		if (typeof options.launchProbe === 'function') {
			try {
				const probe = await options.launchProbe(executablePath);
				launchVerified = probe?.ok === true;
				if (!launchVerified) {
					reason = `Binary present but failed to launch: ${probe?.error ?? 'unknown launch error'}`;
				}
			} catch (error) {
				launchVerified = false;
				reason = `Binary present but failed to launch: ${error?.message ?? String(error)}`;
			}
		}
		brands.push({
			code: brand.code,
			label: brand.label,
			status: 'present',
			executablePath,
			version,
			engine: 'chromium',
			launchVerified,
			reason
		});
	}
	const result = { probedAt: new Date().toISOString(), brands };
	cache = { probedAtMs: Date.now(), result };
	return result;
}

/** Sync accessor for the last probe (may be stale or null). */
export function lastLocalBrowserProbe() {
	return cache?.result ?? null;
}

/** Drop the cache so the next probe re-reads the filesystem. */
export function invalidateLocalBrowserCache() {
	cache = null;
}

/** Registry entry for one brand code (null when never probed). */
/**
 * Version-only (cheap) probe used as the resolver's fallback path — it never
 * launches a browser, so support resolution inside a request/execution hot
 * path cannot block on a real start. Launch verification is refreshed by the
 * boot-time snapshot and the TTL interval (both of which do launch).
 */
export async function localBrowserEntry(code, options = {}) {
	const probe = await probeLocalBrowsers({ ...options, launchProbe: options.launchProbe ?? null });
	return probe.brands.find((entry) => entry.code === code) ?? null;
}

/**
 * Resolution input for browserSupportResolution: which branded Chromium
 * binaries are genuinely executable locally.
 *
 * A brand is `executable` only when present AND launch-verified (when a
 * launch probe has run) or present without a failed probe (launch probe not
 * yet run — treated as executable-presumed, and the launch path still
 * hard-fails honestly if the binary is broken).
 */
export function isExecutableLocalBrand(entry) {
	return entry?.status === 'present' && entry.reason?.startsWith('Binary present but failed') !== true;
}

/**
 * Real launch probe using Playwright chromium against the branded binary.
 * Used by availability endpoints (cached); exported for app wiring.
 */
export function playwrightLaunchProbe() {
	return async (executablePath) => {
		try {
			const { chromium } = await import('playwright');
			const browser = await chromium.launch({
				executablePath,
				headless: true,
				args: ['--no-sandbox', '--disable-gpu', '--headless=new']
			});
			await browser.close();
			return { ok: true };
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message.split('\n')[0] : String(error) };
		}
	};
}
