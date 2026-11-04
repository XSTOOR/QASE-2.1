import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
		QASE_AUTOGEN_ENABLED: 'false', QASE_HEADLESS: 'true'
	};
}

export async function launchSqaTestBrowser(browser) {
	const engine = await resolveEngine(assertSqaTestBrowser(browser));
	if (!engine.available) throw new Error(`${browser}: ${engine.reason}`);
	return engine.type.launch({ headless: true, ...engine.launch });
}

export async function createSqaTestServer(directory, { authRequired = false, envFile } = {}) {
	await mkdir(directory, { recursive: true });
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
		log = createWriteStream(path.join(directory, `server-${Date.now()}.log`));
		const args = envFile
			? [path.join(root, 'scripts', 'start-local.mjs'), '--env-file', path.resolve(envFile)]
			: [path.join(root, 'server', 'index.js')];
		server = spawn(process.execPath, args, {
			cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...isolatedSqaEnvironment(), PORT: String(port), QASE_PUBLIC_URL: base, QASE_AUTH_REQUIRED: String(authRequired),
				...(envFile ? { NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1' } : {}) }
		});
		let launchError;
		server.once('error', error => { launchError = error; });
		server.stdout.pipe(log, { end: false }); server.stderr.pipe(log, { end: false });
		try {
			const deadline = Date.now() + 45_000;
			while (Date.now() < deadline) {
				if (launchError) throw launchError;
				if (server.exitCode !== null || server.signalCode !== null) throw new Error('Isolated SQA server exited before readiness; inspect its server log.');
				try {
					const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1500) });
					if (response.ok) return;
				} catch { /* still starting */ }
				await new Promise(resolve => setTimeout(resolve, 200));
			}
			throw new Error('Isolated SQA server did not become ready.');
		} catch (error) { await stop(); throw error; }
	}
	return { base, start, stop };
}
