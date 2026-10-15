/**
 * Multi-browser engine registry.
 *
 * Chromium is the primary engine and runs unchanged. Firefox runs headless
 * natively. Playwright's WPE headless WebKit build segfaults in containers
 * without a GPU/display (null-ip crash inside libWPEWebKit during view
 * creation — microsoft/playwright#13875, #42940); the bundled GTK MiniBrowser
 * works under Xvfb, so WebKit resolves to that executable when a display is
 * available.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

export const ENGINE_IDS = ['chromium', 'firefox', 'webkit'];

const registry = [
	{ id: 'chromium', label: 'Chromium (Chrome)', available: true, reason: null },
	{ id: 'firefox', label: 'Firefox', available: true, reason: null },
	{ id: 'webkit', label: 'WebKit (Safari engine)', available: true, reason: null }
];

let xvfb = null; // { proc, display, ready }

/**
 * Lazily start one Xvfb display for this process. Idempotent; kept as a plain
 * child process handle so it dies with the server (no nohup/&/disown).
 */
export async function ensureXvfb(display = ':77') {
	if (process.platform !== 'linux') return null;
	if (process.env.QASE_DISABLE_XVFB === 'true') return null;
	if (xvfb?.ready) return xvfb;
	const lockPath = `/tmp/.X${display.replace(':', '')}-lock`;
	if (existsSync(lockPath)) {
		xvfb = { proc: null, display, ready: true };
		return xvfb;
	}
	return await new Promise(resolve => {
		let settled = false;
		const proc = spawn('Xvfb', [display, '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
		// The display daemon must not hold the process open (test runner exits,
		// dev servers restart) — it stays alive only while the parent lives.
		proc.unref();
		const done = ok => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			xvfb = ok ? { proc, display, ready: true } : null;
			resolve(xvfb);
		};
		const timer = setTimeout(() => done(false), 4000);
		proc.on('exit', () => done(false));
		proc.on('error', () => done(false));
		setTimeout(() => done(existsSync(lockPath)), 1500);
	});
}

/**
 * Resolve an engine id to its playwright launcher. Returns
 * { id, type, launch: {...}, available, reason }.
 */
export async function resolveEngine(engineId = 'chromium', { platform = process.platform, exists = existsSync, ensureDisplay = ensureXvfb } = {}) {
	const id = ENGINE_IDS.includes(engineId) ? engineId : 'chromium';
	if (id === 'chromium') {
		return { id, type: chromium, launch: {}, available: true, reason: null };
	}
	if (id === 'firefox') {
		// Headless Firefox launches natively; the only unavailable case is a
		// missing browser bundle (e.g. `playwright install firefox` not run).
		if (!exists(firefox.executablePath())) {
			return { id, type: firefox, launch: {}, available: false, reason: 'The Firefox browser bundle is not installed on this server.' };
		}
		return {
			id, type: firefox,
			// OCSP/CRLite revocation fetches can hang or fail in server
			// containers with restricted egress; Firefox then refuses
			// VALID certificates with SSL_ERROR_BAD_CERT_DOMAIN-style
			// interstitials (observed on www.drytis.com: Chromium and
			// openssl both verify the chain clean). Soft-fail revocation
			// is the browser default posture for exactly this reason —
			// an unreachable OCSP responder must not masquerade as a
			// revoked cert. Chain/signature/expiry validation stays on.
			launch: {
				firefoxUserPrefs: {
					'security.OCSP.require': false,
					'security.pki.crlite_mode': 1,
					'security.OCSP.enabled': 1
				}
			},
			available: true, reason: null
		};
	}
	// Ask Playwright for its platform/version-specific executable. A Windows
	// installation has Playwright.exe, not a Linux minibrowser-gtk directory.
	const executable = webkit.executablePath();
	const gtk = join(dirname(executable), 'minibrowser-gtk');
	const useGtk = platform === 'linux' && exists(join(gtk, 'MiniBrowser')) && exists(join(gtk, 'lib'));
	if (!useGtk) {
		return {
			id, type: webkit, launch: {}, available: exists(executable),
			reason: exists(executable) ? null : 'The WebKit browser bundle is not installed on this server. Run: npx playwright install webkit'
		};
	}
	// Retain the Linux/container WPE crash workaround only where GTK exists.
	const display = await ensureDisplay();
	if (!display?.ready) {
		return { id, type: webkit, launch: {}, available: false, reason: 'No display available for the WebKit (Safari engine) browser.' };
	}
	return {
		id,
		type: webkit,
		launch: {
			executablePath: join(gtk, 'MiniBrowser'),
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				LANG: process.env.LANG,
				DISPLAY: display.display,
				LD_LIBRARY_PATH: `${gtk}/lib:${gtk}/sys/lib${process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : ''}`
			}
		},
		available: true,
		reason: null
	};
}

export function engineRegistry() {
	return registry.map(entry => ({ ...entry }));
}

/** Availability check used by the public registry endpoint. */
export async function engineRegistryResolved() {
	const resolved = [];
	for (const entry of registry) {
		const engine = await resolveEngine(entry.id);
		resolved.push({ id: entry.id, label: entry.label, available: engine.available, reason: engine.reason });
	}
	return resolved;
}

export function isEngineId(engineId) {
	return typeof engineId === 'string' && ENGINE_IDS.includes(engineId);
}
