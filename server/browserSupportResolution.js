/**
 * Browser capability resolution (2027.03.0, #14632 NI01 Phase 2; RT1 #14680).
 *
 * Single source of truth for whether a browser family / platform / version
 * combination can actually be EXECUTED by the connected runners — the honesty
 * contract the catalog reports and the run pipeline enforces. The catalog's
 * BROWSER_VERSIONS ladders are curated INVENTORY; this module decides
 * executability from what QASE's OWN local runtime can really do.
 *
 * RT1 (#14680): no external device-testing provider participates. The local
 * column is fed by the local browser registry — real branded binaries
 * (Chrome/Brave/Opera installed and launch-verified on this host) plus the
 * Playwright engine bundles. Branded-binary presence UPGRADES a brand from
 * engine-equivalent to SUPPORTED-branded; absence is reported honestly.
 *
 * Resolutions (RT1):
 *  - chrome        SUPPORTED locally — the REAL Google Chrome binary (151, launch-verified).
 *  - edge          SUPPORTED locally — REAL Microsoft Edge binary (124, launch-verified,
 *                  detected live by the registry — versions here are examples only).
 *  - brave         SUPPORTED locally — REAL Brave binary (154, launch-verified).
 *  - opera         SUPPORTED locally — REAL Opera binary (136, launch-verified).
 *  - firefox       SUPPORTED locally (Playwright Firefox, Gecko engine).
 *  - safari        ENGINE_EQUIVALENT locally (Playwright WebKit) — no macOS host, never branded Safari.
 *  - duckduckgo    NOT SUPPORTED — mobile-only, no Linux desktop build, no automation channel; visible in the catalog but can never execute or pass.
 *
 * All four branded binaries sit on this host and are probed/launch-verified
 * by the local browser registry; absent binaries degrade honestly to
 * engine-equivalent fallback with an explicit reason — never faked branded.
 */

import { localBrowserEntry, isExecutableLocalBrand, lastLocalBrowserProbe } from './localBrowserRegistry.js';

export const BROWSER_SUPPORT_STATUS = Object.freeze({
	SUPPORTED: 'supported',
	ENGINE_EQUIVALENT: 'engine_equivalent',
	NOT_SUPPORTED: 'not_supported'
});

/** Providers consulted for the resolution, in priority order. */
export const BROWSER_SUPPORT_PROVIDERS = Object.freeze(['local-playwright']);

/**
 * Baseline resolution per browser code for QASE's own runtime. `branded`
 * describes the real branded binary path (when the local registry has one);
 * `fallback` describes the bundled engine path. The resolver prefers a real
 * branded binary and never invents one.
 */
const BROWSER_RESOLUTIONS = {
	chrome: {
		fallback: { status: BROWSER_SUPPORT_STATUS.SUPPORTED, engine: 'chromium', reason: 'Runs on the bundled Playwright Chromium (SIMULATED — emulated device profile on the local engine).' }
	},
	brave: {
		fallback: { status: BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT, engine: 'chromium', reason: 'No Brave binary on this host — executed on the bundled Chromium engine, engine-equivalent (SIMULATED).' }
	},
	opera: {
		fallback: { status: BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT, engine: 'chromium', reason: 'No Opera binary on this host — executed on the bundled Chromium engine, engine-equivalent (SIMULATED).' }
	},
	edge: {
		fallback: { status: BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT, engine: 'chromium', reason: 'No branded Edge binary on this host — executed on the bundled Chromium engine, engine-equivalent (SIMULATED).' }
	},
	firefox: {
		fallback: { status: BROWSER_SUPPORT_STATUS.SUPPORTED, engine: 'firefox', reason: 'Runs on the bundled Playwright Firefox (Gecko engine) with the emulated device profile.' }
	},
	safari: {
		fallback: { status: BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT, engine: 'webkit', reason: 'Executed on the Playwright WebKit engine — engine-equivalent to Safari, not the branded browser (no macOS host; SIMULATED).' }
	},
	duckduckgo: {
		fallback: { status: BROWSER_SUPPORT_STATUS.NOT_SUPPORTED, engine: null, reason: 'DuckDuckGo is a mobile-only browser with no Linux desktop build and no automation channel — no local execution provider can run it.' }
	}
};

/**
 * Branded-binary upgrade text: names the real binary and its detected
 * version so every surface (picker, matrix, coverage) can prove it.
 */
function brandedResolution(entry) {
	return {
		status: BROWSER_SUPPORT_STATUS.SUPPORTED,
		engine: 'chromium',
		reason: `REAL ${entry.label} ${entry.version} binary executed locally on QASE's own runtime (device profile emulated; the browser itself is genuine).`,
		branded: true,
		executablePath: entry.executablePath,
		detectedVersion: entry.version
	};
}

/** Registry snapshot injected by the resolver caller (avoids async probes in hot paths). */
let registrySnapshot = null;

/**
 * Feed the resolver a live registry probe result. Called by app wiring at
 * boot and by availability refreshes; `null` falls back to version-only
 * presence checks via the registry's cached probe.
 */
export function setLocalRegistrySnapshot(snapshot) {
	registrySnapshot = snapshot && Array.isArray(snapshot.brands) ? snapshot : null;
}

async function entryFor(code) {
	if (registrySnapshot) {
		return registrySnapshot.brands.find((brand) => brand.code === code) ?? null;
	}
	try {
		return await localBrowserEntry(code);
	} catch {
		return null;
	}
}

/**
 * Resolve browser executability for a platform/browser combination.
 *
 * @param {object} input
 * @param {string} input.platformId ios | ipados | macos | android | windows
 * @param {string} input.browserCode chrome | edge | firefox | safari | opera | brave | duckduckgo
 * @param {object} [input.providers] legacy flag bag (browserstack ignored — no external providers participate)
 * @returns {{ status: string, reason: string, provider: string, engine: string|null, engineEquivalent: boolean, branded?: boolean, executablePath?: string, detectedVersion?: string }} resolution — never throws; unknown browsers resolve NOT SUPPORTED with a reason.
 */
export async function resolveBrowserSupport(platformId, browserCode, providers = {}) {
	const browser = BROWSER_RESOLUTIONS[String(browserCode ?? '').toLowerCase()];
	if (!browser) {
		return {
			status: BROWSER_SUPPORT_STATUS.NOT_SUPPORTED,
			reason: `Unknown browser "${browserCode}" — no execution provider claims it.`,
			provider: 'none',
			engine: null,
			engineEquivalent: false
		};
	}
	// DuckDuckGo never upgrades — there is no binary to probe.
	if (browser.fallback.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
		return {
			...browser.fallback,
			provider: 'local-playwright',
			engineEquivalent: false
		};
	}
	// Real branded binary path (chrome/brave/opera today; edge when installed).
	const entry = await entryFor(String(browserCode ?? '').toLowerCase());
	if (entry && isExecutableLocalBrand(entry)) {
		return {
			...brandedResolution(entry),
			provider: 'local-playwright',
			engineEquivalent: false
		};
	}
	// #15162: a failed launch probe is NOT proof of unsupportability — it is
	// one probe attempt on one host at one moment. The binary is present, so
	// the family stays AVAILABLE pre-run; launchVerified:false and the probe
	// note travel along, and a real launch failure surfaces during the run in
	// results/evidence — never as a pre-run availability status.
	if (entry && entry.status === 'present' && String(entry.reason ?? '').startsWith('Binary present but failed')) {
		return {
			status: BROWSER_SUPPORT_STATUS.SUPPORTED,
			reason: brandedResolution(entry).reason,
			provider: 'local-playwright',
			engine: 'chromium',
			branded: true,
			launchVerified: false,
			probeNote: entry.reason,
			engineEquivalent: false
		};
	}
	return {
		...browser.fallback,
		provider: 'local-playwright',
		engineEquivalent: browser.fallback.status === BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT
	};
}

/**
 * Synchronous variant for hot read paths (withExecutionMetadata et al.):
 * resolves from the injected registry snapshot or the registry's cached
 * probe WITHOUT launching anything. When no probe result is available at
 * all, branded codes resolve their fallback — the launch path still
 * hard-fails honestly if the binary is missing, and availability refreshes
 * feed the snapshot.
 */
export function resolveBrowserSupportSync(platformId, browserCode, providers = {}) {
	const browser = BROWSER_RESOLUTIONS[String(browserCode ?? '').toLowerCase()];
	if (!browser) {
		return {
			status: BROWSER_SUPPORT_STATUS.NOT_SUPPORTED,
			reason: `Unknown browser "${browserCode}" — no execution provider claims it.`,
			provider: 'none',
			engine: null,
			engineEquivalent: false
		};
	}
	if (browser.fallback.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
		return { ...browser.fallback, provider: 'local-playwright', engineEquivalent: false };
	}
	const entry = registrySnapshot?.brands?.find((brand) => brand.code === String(browserCode ?? '').toLowerCase())
		?? lastSnapshotEntry(String(browserCode ?? '').toLowerCase());
	if (entry && isExecutableLocalBrand(entry)) {
		return { ...brandedResolution(entry), provider: 'local-playwright', engineEquivalent: false };
	}
	// #15162: failed launch probe → still AVAILABLE pre-run (see async variant).
	if (entry && entry.status === 'present' && String(entry.reason ?? '').startsWith('Binary present but failed')) {
		return {
			status: BROWSER_SUPPORT_STATUS.SUPPORTED,
			reason: brandedResolution(entry).reason,
			provider: 'local-playwright',
			engine: 'chromium',
			branded: true,
			launchVerified: false,
			probeNote: entry.reason,
			engineEquivalent: false
		};
	}
	return {
		...browser.fallback,
		provider: 'local-playwright',
		engineEquivalent: browser.fallback.status === BROWSER_SUPPORT_STATUS.ENGINE_EQUIVALENT
	};
}

/** Registry cache read (no probing) — null when never probed. */
function lastSnapshotEntry(code) {
	return lastLocalBrowserProbe()?.brands?.find((brand) => brand.code === code) ?? null;
}

/** True when the combination can execute (supported or engine-equivalent). */
export async function isExecutableBrowser(platformId, browserCode, providers = {}) {
	return (await resolveBrowserSupport(platformId, browserCode, providers)).status !== BROWSER_SUPPORT_STATUS.NOT_SUPPORTED;
}

/** All browser resolutions for one platform (UI/report surface). */
export async function browserSupportReport(platformId, providers = {}) {
	const codes = ['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo'];
	const report = [];
	for (const code of codes) {
		report.push({ browser: code, ...(await resolveBrowserSupport(platformId, code, providers)) });
	}
	return report;
}
