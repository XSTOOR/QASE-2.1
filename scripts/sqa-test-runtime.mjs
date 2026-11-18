import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQA_STANDALONE_CAPABILITIES, standaloneProfileIdentity, standaloneResearchProfile } from '../server/sqaStandaloneQualification.js';
import { SQA_STANDALONE_STRATEGY } from '../server/sqaStandaloneStrategy.js';
import { resolveEngine } from '../server/browserEngines.js';

const root = fileURLToPath(new URL('../', import.meta.url));
export const SQA_TEST_BROWSERS = ['chromium', 'firefox', 'webkit'];

export function assertSqaTestBrowser(browser) {
	if (!SQA_TEST_BROWSERS.includes(browser)) throw new Error(`Unknown browser ${browser}; choose ${SQA_TEST_BROWSERS.join(', ')}.`);
	return browser;
}

export function assertSqaAcceptanceResult(result, browser, kind) {
	if (result.browser !== browser || result.modelCalls !== 0 || !result.browserVersion) throw new Error(`${kind}/${browser}: missing browser identity or unexpected model activity.`);
	if (kind === 'startup') {
		if (['startup', 'negativeControl', 'desktop', 'mobile'].some(key => result[key] !== 'passed') || result.isolated !== true) throw new Error(`startup/${browser}: incomplete isolated acceptance result.`);
	} else if (kind === 'launch') {
		if (['launcher', 'delayedDeviceRestore', 'explicitStart', 'desktop', 'mobile'].some(key => result[key] !== 'passed')
			|| result.launchDispatches !== 1 || !Array.isArray(result.javascriptErrors) || result.javascriptErrors.length) {
			throw new Error(`launch/${browser}: incomplete launcher acceptance result.`);
		}
	} else if (kind === 'evidence') {
		if (['browserJourney', 'restartPersistence', 'historicalMarkdown', 'historicalPdf'].some(key => result[key] !== 'passed')
			|| result.versions !== 2 || result.oldVersionPreserved !== true || result.injectionPrevented !== true || result.mobileOverflow !== false
			|| !Array.isArray(result.javascriptErrors) || result.javascriptErrors.length
			|| ['verified', 'unavailable', 'mismatch', 'external_unverified'].some(state => !result.evidenceStates?.includes(state))) {
			throw new Error(`evidence/${browser}: incomplete acceptance result.`);
		}
	} else throw new Error(`Unknown SQA acceptance kind: ${kind}`);
}

// Keep OS/browser discovery settings, without inheriting gateway keys, account
// credentials, database connections or the user's application configuration.
export function isolatedSqaEnvironment(environment = process.env) {
	const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|LANG|LC_.*|TZ|DISPLAY|LD_LIBRARY_PATH|XDG_RUNTIME_DIR|PLAYWRIGHT_BROWSERS_PATH|CI)$/i;
	return {
		...Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.test(key))),
		NODE_ENV: 'test', QASE_HOST: '127.0.0.1', QASE_RUN_STORE: 'local',
		QASE_EXECUTION_MODE: 'local', QASE_MAIL_MODE: 'mock',
		QASE_TELEGRAM_ENABLED: 'false', QASE_DRYTIS_INTEGRATION_ENABLED: 'false',
		QASE_AUTOGEN_TESTCASES: 'off', QASE_HEADLESS: 'true'
	};
}

export async function launchSqaTestBrowser(browser) {
	const engine = await resolveEngine(assertSqaTestBrowser(browser));
	if (!engine.available) throw new Error(`${browser}: ${engine.reason}`);
	return engine.type.launch({ headless: true, ...engine.launch });
}

export async function createSqaTestServer(directory, { authRequired = false, envFile, hybridQa = false, jevNavigation = false, qualifiedSqaLaunch = false } = {}) {
	await mkdir(directory, { recursive: true });
	const standalone = {};
	if (qualifiedSqaLaunch) {
		Object.assign(standalone, {
			QASE_SQA_STANDALONE_ENABLED: 'true',
			QASE_SQA_REASONER_API_KEY: 'sqa-launch-browser-fixture',
			QASE_SQA_SEARCH_URL: 'https://search.example.test/search',
			QASE_SQA_QUALIFICATION_FILE: path.resolve(directory, 'standalone-launch-fixture.json')
		});
		const profile = standaloneResearchProfile({}, standalone);
		await writeFile(standalone.QASE_SQA_QUALIFICATION_FILE, JSON.stringify({
			strategy: SQA_STANDALONE_STRATEGY, sdkVersion: profile.sdkVersion,
			profileIdentity: standaloneProfileIdentity(profile, standalone), checkedAt: Date.now(),
			jevCalls: 0, runId: 'launcher-test-only',
			capabilities: Object.fromEntries(SQA_STANDALONE_CAPABILITIES.map(name=>[name,{passed:true,evidenceRef:'launcher-fixture'}]))
		}),{mode:0o600});
	}

	const probe = createServer();
	await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
	const port = probe.address().port;
	await new Promise(resolve => probe.close(resolve));
	const base = `http://127.0.0.1:${port}`;
	let server;
	let log;
	async function stop() {
		if (server && server.exitCode === null && server.signalCode === null) {
			const exited = new Promise(resolve => server.once('exit', resolve));
			server.kill('SIGTERM');
			const stopped = await Promise.race([exited.then(() => true), new Promise(resolve => {
				const timer = setTimeout(() => resolve(false), 5000); timer.unref();
			})]);
			if (!stopped) { server.kill('SIGKILL'); await exited; }
		}
		if (log) await new Promise(resolve => log.end(resolve));
		server = undefined; log = undefined;
	}
	async function start() {
		if (server) throw new Error('Isolated SQA server is already started.');
		const logPath = path.join(directory, `server-${Date.now()}.log`);
		log = createWriteStream(logPath);
		const args = envFile
			? [path.join(root, 'scripts', 'start-local.mjs'), '--env-file', path.resolve(envFile)]
			: [path.join(root, 'server', 'index.js')];
		server = spawn(process.execPath, args, {
			cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...isolatedSqaEnvironment(), ...standalone, PORT: String(port), QASE_PUBLIC_URL: base, QASE_AUTH_REQUIRED: String(authRequired),
				...(hybridQa ? { QASE_HYBRID_QA_ENABLED: 'true', QASE_HYBRID_MAX_PAGES: '3', QASE_HYBRID_DURATION_MS: '480000' } : {}),
				...(jevNavigation ? { QASE_HYBRID_JEV_NAVIGATION_ENABLED: 'true' } : {}),
				...(envFile ? { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' } : {}) }
		});
		let launchError;
		server.once('error', error => { launchError = error; });
		server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
		try {
			// /readyz reports local services readiness. A model key is only needed to launch model-backed runs.
			const deadline = Date.now() + 45_000;
			let lastProbe = 'No HTTP response';
			while (Date.now() < deadline) {
				if (launchError) throw launchError;
				if (server.exitCode !== null || server.signalCode !== null) throw new Error(`Isolated SQA server exited before readiness. See ${logPath}`);
				try {
					const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1500) });
					lastProbe = `HTTP ${response.status}`;
					if (response.ok) break;
				} catch (error) { lastProbe = error.cause?.code ?? error.name; }
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			if (lastProbe !== 'HTTP 200') throw new Error(`Isolated SQA server did not become ready (${lastProbe}). See ${logPath}`);
			// Exercise the selected access mode before a browser test seeds or reads runs.
			const identity = await fetch(`${base}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
			const expected = authRequired ? 401 : 200;
			if (identity.status !== expected) {
				throw new Error(`Isolated SQA access check expected HTTP ${expected}, got ${identity.status}. See ${logPath}`);
			}
			if (!authRequired && !(await identity.json()).actorUserId) {
				throw new Error(`Isolated SQA access check did not receive an instance owner. See ${logPath}`);
			}
		} catch (error) { await stop(); throw error; }
	}
	return { base, start, stop };
}
