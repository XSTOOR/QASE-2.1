/**
 * Run runtime plan: how a QA, SQA or Founder run executes the device and
 * browser the user selected.
 *
 * One resolver for all three modes, so a selection behaves the same whichever
 * mode runs it:
 *   - the ENGINE follows the selected browser (Chrome/Edge/Opera/Brave →
 *     Chromium, Firefox → Gecko, Safari → WebKit). On iPhone and iPad every
 *     browser is a WebKit wrapper (an App Store rule), so they all run WebKit.
 *   - a combination no runtime can execute (DuckDuckGo, a real device with no
 *     device farm configured) is refused before the run starts, never run on
 *     another browser behind the user's back;
 *   - a locally emulated device sends that device's real user agent (an
 *     iPhone gets an iPhone Safari/CriOS/FxiOS string, Windows Edge an Edg
 *     string), not desktop Chrome's;
 *   - an installed branded binary (real Chrome, Edge, Brave, Opera) is used
 *     when the registry verified one; a device farm is used when configured.
 */
import { resolveEngine, isEngineId } from './browserEngines.js';
import { resolveExecution, engineForBrowser } from './browserstackProvider.js';
import { userAgentFor, platformRuntimeProfile, resolveExecutionLevel } from './deviceRuntimeProfiles.js';
import { verifyRuntimeIdentity } from './runtimeIdentity.js';

const APPLE_MOBILE = new Set(['ios', 'ipados']);

/** The engine a selected environment really runs on, or null without one. */
export function engineForEnvironment(environment) {
	if (!environment) return null;
	if (APPLE_MOBILE.has(String(environment.platform ?? '').toLowerCase())) return 'webkit';
	return engineForBrowser(environment.browserCode);
}

export class RuntimeUnavailableError extends Error {
	constructor(message, code = 'RUNTIME_UNAVAILABLE', details = {}) {
		super(message);
		this.code = code;
		Object.assign(this, details);
	}
}

/** Permission names the scenario allows and the platform's browsers understand. */
function grantablePermissions(scenario, platform) {
	if (!scenario || typeof scenario !== 'object') return [];
	const supported = platformRuntimeProfile(platform)?.chromiumPermissions ?? [];
	return Object.entries(scenario).filter(([name, decision]) => decision === 'allow' && supported.includes(name)).map(([name]) => name);
}

/**
 * Resolve the plan for one run. Throws RuntimeUnavailableError when the
 * selection cannot execute here, with a reason the user can act on.
 */
export async function resolveRunRuntime({ environment, engine, permissionScenario } = {}, {
	executionResolver = resolveExecution, engineResolver = resolveEngine
} = {}) {
	const execution = await executionResolver(environment);
	if (execution.mode === 'blocked') {
		throw new RuntimeUnavailableError(execution.reason ?? 'No runtime can execute this environment.');
	}
	const platform = String(environment?.platform ?? '').toLowerCase();
	const engineId = engineForEnvironment(environment) ?? execution.executionEngine ?? (isEngineId(engine) ? engine : 'chromium');
	const remote = execution.mode === 'environment';
	// A desktop branded binary is never an iPhone/iPad browser.
	const brandedExecutablePath = !remote && engineId === 'chromium' && !APPLE_MOBILE.has(platform) ? execution.brandedExecutablePath ?? null : null;
	if (!remote && !brandedExecutablePath) {
		const runtime = await engineResolver(engineId);
		if (!runtime.available) throw new RuntimeUnavailableError(`The ${engineId} engine is not available: ${runtime.reason}`, 'ENGINE_UNAVAILABLE', { engineId, reason: runtime.reason });
	}
	const userAgent = environment && execution.mode === 'emulated'
		? userAgentFor(environment.platform, environment.osVersion, environment.browserCode, environment.browserVersion)
		: null;
	return {
		mode: execution.mode,
		engineId,
		remote,
		connectOptions: remote ? execution.connectOptions : null,
		brandedExecutablePath,
		userAgent,
		executionLevel: resolveExecutionLevel({ mode: remote ? 'browserstack' : execution.mode }),
		label: execution.label,
		permissions: grantablePermissions(permissionScenario ?? environment?.permissionScenario, platform),
		engineEquivalent: Boolean(execution.browserSupport?.engineEquivalent)
	};
}

/** Launch-time check for a run's selection; returns the engine to store on the session. */
export async function preflightRunRuntime(input, dependencies, label = 'The run') {
	try {
		return (await resolveRunRuntime(input, dependencies)).engineId;
	} catch (error) {
		if (error instanceof RuntimeUnavailableError) {
			const hint = error.code === 'ENGINE_UNAVAILABLE'
				? ' Install this browser on the QASE server (npm run install-browser) or select another browser.'
				: ' Choose an available test environment.';
			throw Object.assign(new Error(`${label} cannot start: ${error.message}${hint}`), { code: error.code, status: 422 });
		}
		throw error;
	}
}

/**
 * Compare what the browser really reported with the selection. Returns the
 * facts to store and a plain-language note when they disagree.
 */
export function checkRuntimeIdentity(environment, facts) {
	if (!environment || !facts) return { ok: true, note: null };
	const result = verifyRuntimeIdentity({ runtimeFacts: facts, environment });
	if (result.ok) return { ok: true, note: null, identity: result.identity };
	return { ok: false, identity: result.identity, note: `The browser that ran does not fully match the selected ${environment.device ?? 'device'} · ${environment.browser ?? environment.browserCode ?? 'browser'}: ${result.mismatches.join('; ')}.` };
}

const ENGINE_LABELS = { chromium: 'Chromium', firefox: 'Gecko', webkit: 'WebKit' };

/** How the conversation names the browser: the selected one, with the engine that runs it. */
export function runtimeName(environment, browser) {
	const major = String(browser?.version ?? '').split('.')[0];
	if (!environment?.browser) return browser?.engine === 'chromium' ? `Chrome ${major}` : `${browser?.engine} ${browser?.version}`;
	const engine = ENGINE_LABELS[browser?.engine] ?? browser?.engine;
	const level = browser?.plan?.remote ? 'device farm' : 'emulated';
	return `${environment.browser} ${environment.browserVersion ?? ''} on ${environment.os ?? environment.platform} ${environment.osVersion ?? ''} (${engine} engine, ${level})`.replace(/\s+/g, ' ').replace(' )', ')');
}
