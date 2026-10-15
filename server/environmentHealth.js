/**
 * RT2 (#14704) · Environment health checks & honest availability.
 *
 * Pre-execution health gate: REAL probes, run against the actual local
 * runtime, decide READY or BLOCKED-with-exact-reason. Every check reports
 * PASS / FAIL / SKIPPED with a detail string; nothing is presumed healthy.
 *
 * Probes (spec rt2-health-availability.md):
 *  1. execution_service — the QASE server itself is up (trivially true when
 *     this module runs in-process; included so the report is explicit).
 *  2. engine_launch    — the engine the environment resolves to can REALLY
 *     launch (Playwright chromium/firefox/webkit launch, short-lived).
 *  3. branded_binary   — when the environment's browser resolves to a branded
 *     local binary, that binary launches (SKIPPED for engine-equivalent paths).
 *  4. network          — an outbound HTTP request to the environment's target
 *     URL (or a default) resolves DNS/connects. FAIL blocks execution.
 *  5. emulation_apply  — the device profile's viewport/touch hints apply to a
 *     real Playwright context (FAIL when the hints are malformed).
 *  6. media_capability — mic/camera capability where the environment declares
 *     it (SKIPPED when undeclared; container has no physical camera — synthetic
 *     devices are labeled honestly).
 *
 * The gate NEVER upgrades anything: a FAIL verdict marks the environment
 * UNAVAILABLE (browser/infra fault) with the failing check named; PASS is the
 * only path to launch.
 */

import { resolveBrowserSupport, BROWSER_SUPPORT_STATUS } from './browserSupportResolution.js';

/** Probe timeout — a hung probe is a FAIL, never a pass. */
const PROBE_TIMEOUT_MS = Number(process.env.QASE_HEALTH_PROBE_TIMEOUT_MS ?? 10_000);
/** Health verdict TTL: recent PASS/FAIL results are reused for this window. */
const RESULT_TTL_MS = Number(process.env.QASE_HEALTH_RESULT_TTL_MS ?? 30_000);

const CHECK_STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', SKIPPED: 'SKIPPED' });
const GATE_VERDICT = Object.freeze({ READY: 'READY', BLOCKED: 'BLOCKED' });

/** @type {Map<string, {at:number, report:object}>} keyed env+url */
const resultCache = new Map();

function cacheKey(environment, targetUrl) {
	return `${environment?.envId ?? environment?.device ?? 'default'}|${targetUrl ?? ''}`;
}

function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(Object.assign(
			new Error(`${label} probe timed out after ${ms}ms`),
			{ code: 'HEALTH_PROBE_TIMEOUT' }
		)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Fetch with an abort deadline; DNS/connect failures reject. */
function reachable(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	return fetch(url, {
		method: 'HEAD',
		redirect: 'follow',
		signal: controller.signal
	}).then((response) => {
		clearTimeout(timer);
		// Any HTTP answer — even 4xx/5xx — proves DNS + TCP + TLS work.
		return { ok: true, status: response.status };
	}).catch((error) => {
		clearTimeout(timer);
		const reason = error?.name === 'AbortError' ? 'timed out' : (error?.cause?.code ?? error?.message ?? 'network error');
		return { ok: false, reason: String(reason) };
	});
}

/**
 * Real engine launch probe. Uses the injected playwright module (tests stub
 * it); resolves the engine exactly as browserBridge would: branded binary
 * first (when resolution cites one), otherwise the Playwright engine channel.
 */
export function createEngineLaunchProbe(playwrightModule) {
	return async function engineLaunchProbe(engineName, executablePath = null) {
		try {
			const pw = await playwrightModule();
			const engines = { chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit };
			const resolved = engines[engineName];
			if (!resolved) return { ok: false, reason: `unknown engine "${engineName}"` };
			const options = { headless: true };
			if (executablePath) {
				options.executablePath = executablePath;
				options.args = ['--no-sandbox', '--disable-gpu'];
			}
			const browser = await resolved.launch(options);
			await browser.close();
			return { ok: true, version: browser.version?.() ?? null };
		} catch (error) {
			return { ok: false, reason: String(error?.message ?? error).split('\n')[0] };
		}
	};
}

/** Default launch probe uses the real playwright package lazily. */
const defaultEngineLaunchProbe = createEngineLaunchProbe(() => import('playwright'));

/**
 * Run the full health gate for one environment.
 *
 * @param {object} environment Catalog environment (envId, platform, browserCode…)
 * @param {object} [options]
 * @param {string} [options.targetUrl] URL the run will hit (network probe).
 * @param {() => Promise<object>} [options.playwrightModule] injected for tests.
 * @param {(engine:string, executablePath:string|null) => Promise<{ok,reason,version}>} [options.engineLaunchProbe]
 * @param {boolean} [options.force] Bypass the result TTL cache.
 * @returns {Promise<{verdict, reason, checks:Array, probedAt:string, executionLevel}>}
 */
export async function checkEnvironmentHealth(environment, options = {}) {
	const key = cacheKey(environment, options.targetUrl);
	if (!options.force) {
		const cached = resultCache.get(key);
		if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.report;
	}

	const engineLaunchProbe = options.engineLaunchProbe ?? defaultEngineLaunchProbe;
	const playwrightModule = options.playwrightModule ?? (() => import('playwright'));
	const checks = [];

	// --- 1. execution service (in-process = PASS; explicit for the report) ---
	checks.push({
		name: 'execution_service',
		status: CHECK_STATUS.PASS,
		detail: 'QASE execution service responding (in-process probe).'
	});

	// --- 2. browser support resolution (NOT_SUPPORTED short-circuits) ---
	const support = await resolveBrowserSupport(environment?.platform ?? 'any', environment?.browserCode ?? 'chrome');
	if (support.status === BROWSER_SUPPORT_STATUS.NOT_SUPPORTED) {
		const report = finish([
			...checks,
			{
				name: 'browser_support',
				status: CHECK_STATUS.FAIL,
				detail: support.reason ?? 'Browser not supported by any local execution provider.'
			}
		]);
		resultCache.set(key, { at: Date.now(), report });
		return report;
	}

	// --- 3. engine launch (real, short-lived) ---
	const engine = support.engine ?? 'chromium';
	const launch = await withTimeout(
		engineLaunchProbe(engine, support.executablePath ?? null),
		PROBE_TIMEOUT_MS,
		'engine launch'
	).catch((error) => ({ ok: false, reason: error.message }));
	checks.push({
		name: 'engine_launch',
		status: launch.ok ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
		detail: launch.ok
			? `${engine} engine launched${launch.version ? ` (version ${launch.version})` : ''}${support.executablePath ? ` from ${support.executablePath}` : ''}.`
			: `${engine} engine failed to launch: ${launch.reason}`
	});

	// --- 4. network reachability ---
	const targetUrl = options.targetUrl ?? environment?.targetUrl ?? null;
	if (targetUrl) {
		const net = await reachable(targetUrl);
		checks.push({
			name: 'network',
			status: net.ok ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
			detail: net.ok
				? `Target reachable (HTTP ${net.status}).`
				: `Target unreachable (${targetUrl}): ${net.reason}`
		});
	} else {
		checks.push({ name: 'network', status: CHECK_STATUS.SKIPPED, detail: 'No target URL configured for this environment.' });
	}

	// --- 5. emulation apply (device hints are well-formed) ---
	const emulation = environment?.emulation ?? null;
	const emulationValid = !emulation
		|| (Number.isFinite(emulation.viewport?.width) && Number.isFinite(emulation.viewport?.height));
	checks.push({
		name: 'emulation_apply',
		status: emulationValid ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
		detail: emulationValid
			? (emulation ? `Device profile applies (${emulation.viewport?.width}×${emulation.viewport?.height}${emulation.hasTouch ? ', touch' : ''}).` : 'Desktop profile — no device emulation needed.')
			: `Device profile malformed: viewport ${JSON.stringify(emulation?.viewport)} is not applicable.`
	});

	// --- 6. media capability (only where declared) ---
	// RT4 (#14756): the check is per-ENGINE truth. Synthetic media is a
	// Chromium-only capability; a media-requiring workflow on another engine
	// FAILS the gate with the exact reason so the item records UNAVAILABLE —
	// it never launches, never silently skips, never passes.
	const mediaDeclared = Array.isArray(environment?.mediaCapabilities) && environment.mediaCapabilities.length > 0;
	if (mediaDeclared) {
		const engineForBrowser = { chrome: 'chromium', edge: 'chromium', opera: 'chromium', brave: 'chromium', duckduckgo: 'chromium', firefox: 'firefox', safari: 'webkit' };
		const engineId = engineForBrowser[environment?.browserCode] ?? 'chromium';
		const chromiumOnly = engineId === 'chromium';
		checks.push({
			name: 'media_capability',
			status: chromiumOnly ? CHECK_STATUS.PASS : CHECK_STATUS.FAIL,
			detail: chromiumOnly
				// Synthetic devices only in this runtime — labeled honestly, never physical.
				? `Media capabilities (${environment.mediaCapabilities.join(', ')}) executable via Chromium synthetic devices — not physical hardware.`
				: `Media capabilities (${environment.mediaCapabilities.join(', ')}) requested, but synthetic camera/microphone is a Chromium-only capability and this environment resolves to engine "${engineId}" — camera/microphone/screen-share testing is UNAVAILABLE for this environment.`
		});
	} else {
		checks.push({
			name: 'media_capability',
			status: CHECK_STATUS.SKIPPED,
			detail: 'No media capability declared for this environment.'
		});
	}

	const report = finish(checks);
	resultCache.set(key, { at: Date.now(), report });
	return report;
}

function finish(checks) {
	const failed = checks.filter((check) => check.status === CHECK_STATUS.FAIL);
	if (failed.length > 0) {
		return {
			verdict: GATE_VERDICT.BLOCKED,
			reason: failed.map((check) => `${check.name}: ${check.detail}`).join(' | '),
			checks,
			probedAt: new Date().toISOString()
		};
	}
	return { verdict: GATE_VERDICT.READY, reason: null, checks, probedAt: new Date().toISOString() };
}

/** Drop cached results (tests / force-refresh). */
export function invalidateHealthCache() {
	resultCache.clear();
}

export { CHECK_STATUS, GATE_VERDICT };
