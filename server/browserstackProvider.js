import { getDevice } from './environmentCatalog.js';
import { resolveBrowserSupport, BROWSER_SUPPORT_STATUS } from './browserSupportResolution.js';

/**
 * Execution provider for Apple compatibility environments.
 *
 * With BrowserStack credentials configured (BROWSERSTACK_USERNAME /
 * BROWSERSTACK_ACCESS_KEY) a run whose environment carries
 * `executionProvider: 'browserstack'` connects to BrowserStack's Playwright/CDP
 * endpoint using the environment's capability map. Without credentials — or for
 * environments whose provider is `local` — the run executes on local Chromium
 * with the environment's emulation hints (viewport, DPR, touch), clearly
 * labeled "emulated" so nobody mistakes it for real Safari/WebKit.
 *
 * Capabilities are taken from the environment's frozen `browserstackCapabilities`
 * object (validated at catalog-generation time) — this module never invents or
 * mutates capability fields.
 */

const BROWSERSTACK_CDP_ENDPOINT = 'https://cdp.browserstack.com/playwright';

/** @typedef {import('playwright').Browser} PlaywrightBrowser */

/**
 * Reads BrowserStack credentials from the given env-like source (defaults to
 * process.env). Returns null unless BOTH values are non-empty strings — a
 * half-configured integration must fall back to local emulation, never fail a
 * run with an opaque 401 from the CDP endpoint.
 */
export function browserstackCredentials(source = process.env) {
	const username = String(source.BROWSERSTACK_USERNAME ?? '').trim();
	const accessKey = String(source.BROWSERSTACK_ACCESS_KEY ?? '').trim();
	if (!username || !accessKey) return null;
	return { username, accessKey };
}

/**
 * Builds the BrowserStack CDP connect options for an environment: the endpoint,
 * basic-auth credentials, and the environment's capability map verbatim.
 * Returns null when the environment cannot execute on BrowserStack (no
 * capabilities — e.g. a hand-made local-only environment) or credentials are
 * missing.
 */
export function browserstackConnectOptions(environment, credentials) {
	if (!environment) return null;
	if (environment.executionProvider !== 'environment') return null;
	const capabilities = environment.runtimeCapabilities;
	if (!capabilities || typeof capabilities !== 'object') return null;
	if (!credentials) return null;
	return {
		endpointURL: BROWSERSTACK_CDP_ENDPOINT,
		httpCredentials: { username: credentials.username, password: credentials.accessKey },
		capabilities: capabilities
	};
}

/**
 * Local-emulation context options derived from an environment snapshot.
 * Mobile/tablet environments carry emulation hints in the catalog; macOS
 * environments (and environments without hints) fall back to a desktop
 * viewport, matching the pre-environment default behavior.
 */
export function environmentEmulationOptions(environment) {
	if (!environment) return undefined;
	if (environment.deviceType === 'desktop') {
		return { viewport: { width: 1440, height: 900 }, acceptDownloads: true };
	}
	// Generated environment records do not inline the hints — resolve them from
	// the frozen device catalog by name (macOS devices have no emulation).
	const hints = environment.emulation ?? getDevice(environment.device)?.emulation;
	if (!hints) return { viewport: { width: 1440, height: 900 }, acceptDownloads: true };
	return {
		viewport: { ...hints.viewport },
		deviceScaleFactor: hints.deviceScaleFactor,
		isMobile: hints.isMobile,
		hasTouch: hints.hasTouch,
		acceptDownloads: true
	};
}

/**
 * Resolves how a run should be executed for the given environment snapshot.
 * `mode` is 'browserstack' | 'emulated' | 'default' (no environment selected —
 * legacy behavior). Never throws: execution resolution is a decision, and the
 * only failure mode worth surfacing is "cannot use BrowserStack", which
 * downgrades to emulation with a recorded reason.
 */
/**
 * R3 #14492 · Engine honesty for local execution. The selected browser must
 * run on the engine family it actually belongs to — never Chrome-as-Firefox.
 * Chromium-family browsers (Chrome/Edge/Opera/Brave/DuckDuckGo) share the
 * Chromium engine; Firefox runs Gecko; Safari runs WebKit.
 */
export function engineForBrowser(browserCode) {
	const code = String(browserCode ?? '').toLowerCase();
	if (code === 'firefox') return 'firefox';
	if (code === 'safari') return 'webkit';
	if (['chrome', 'edge', 'opera', 'brave', 'duckduckgo'].includes(code)) return 'chromium';
	return null;
}

export async function resolveExecution(environment, credentials = browserstackCredentials()) {
	if (!environment) {
		return { mode: 'default', label: 'local browser (no environment)', capabilities: null, connectOptions: null };
	}
	// #14632 (NI01 Phase 2): browser-level executability gate. A browser no
	// execution provider can run (DuckDuckGo) BLOCKS here — reusing the same
	// honest-block machinery as REAL DEVICE UNAVAILABLE. It can never execute,
	// so it can never be recorded as PASSED.
	const support = await resolveBrowserSupport(environment.platform, environment.browserCode);
	if (support.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
		return {
			mode: 'blocked',
			label: `${environment.device} · ${environment.browser} ${environment.browserVersion} — NOT SUPPORTED`,
			reason: `${environment.browser} is NOT SUPPORTED — ${support.reason} (${support.provider})`,
			capabilities: null,
			connectOptions: null,
			browserSupport: support
		};
	}
	if (environment.executionProvider === 'environment' && credentials) {
		const connectOptions = browserstackConnectOptions(environment, credentials);
		if (connectOptions) {
			return {
				mode: 'environment',
				label: `${environment.device} · ${environment.os} ${environment.osVersion} · ${environment.browser} ${environment.browserVersion} — environment runtime`,
				capabilities: environment.runtimeCapabilities,
				connectOptions
			};
		}
	}
	// R3 #14492 · No silent fallback: a REAL_DEVICE / VIRTUAL_DEVICE request
	// with no configured remote runtime BLOCKS — it never quietly becomes a
	// local emulation. Only an explicit SIMULATED choice may run locally.
	const requested = environment.executionLevelRequested ?? null;
	if (environment.executionProvider === 'environment' && !credentials
		&& (requested === 'REAL_DEVICE' || requested === 'VIRTUAL_DEVICE')) {
		return {
			mode: 'blocked',
			label: `${environment.device} · ${environment.browser} ${environment.browserVersion} — REAL DEVICE UNAVAILABLE`,
			reason: 'REAL DEVICE UNAVAILABLE — no device-farm runtime is configured for this environment (BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY missing). Execution is blocked; choose Simulated explicitly or configure a runtime.',
			capabilities: null,
			connectOptions: null
		};
	}
	const device = getDevice(environment.device);
	const hints = device?.emulation;
	const engineId = engineForBrowser(environment.browserCode);
	// RT1 (#14680): REAL branded binary when the local registry has one —
	// Chrome/Brave/Opera launch their genuine binaries with the device
	// profile emulated around them. The support resolution above already
	// verified the binary; executablePath reaches browserBridge's launcher.
	const brandedBinary = support.branded && support.executablePath ? support.executablePath : null;
	const executionTypeLabel = brandedBinary
		? `REAL ${environment.browser ?? support.detectedVersion} binary (${support.detectedVersion})`
		: (support.engineEquivalent ? `engine-equivalent ${engineId}` : engineId ?? 'local');
	const label = `${environment.device} · ${environment.browser} ${environment.browserVersion} — local ${executionTypeLabel}`.replace(/\s+/g, ' ');
	return {
		mode: 'emulated',
		label,
		capabilities: null,
		connectOptions: null,
		// R3 #14492: the ACTUAL engine for the selected browser — firefox runs
		// the Firefox (Gecko) engine, safari the WebKit engine; never a
		// Chromium relabeled as another browser.
		executionEngine: engineId,
		// RT1 (#14680): the genuine branded executable to launch (null = the
		// bundled Playwright engine binary).
		brandedExecutablePath: brandedBinary,
		// #14632 (NI01 Phase 2): honest engine-equivalence marker — Opera/Brave/
		// Safari (and Edge without branded binaries) execute on the Chromium/
		// WebKit ENGINE; results must never read as the branded browser passing
		// on a real device.
		browserSupport: support,
		emulation: hints ?? { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: false, hasTouch: false }
	};
}

/**
 * Connects Playwright Chromium to BrowserStack for the resolved execution plan.
 * Kept separate from resolveExecution so tests can stub the connect step.
 */
export async function connectBrowserstack(chromium, connectOptions) {
	if (typeof chromium.connectOverCDP !== 'function') {
		throw new TypeError('connectBrowserstack requires a Playwright chromium API.');
	}
	return chromium.connectOverCDP(connectOptions.endpointURL, {
		httpCredentials: connectOptions.httpCredentials,
		capabilities: connectOptions.capabilities
	});
}
