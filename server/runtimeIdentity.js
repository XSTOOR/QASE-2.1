/**
 * Phase R2 (#14491) · Runtime identity verification.
 *
 * Compares the runtime facts observed from the LIVE page (UA, viewport, DPR,
 * touch, platform) against the environment the user selected. The runtime is
 * authoritative: any mismatch between what the user picked and what the
 * runtime reports BLOCKs the run — never a silent fallback, never a
 * Chrome-reported-as-Firefox, never an emulated Chromium presented as REAL.
 *
 * Engine truth (spec constraint 6): on iOS/iPadOS every non-Safari browser is
 * a WebKit wrapper app. The UA says e.g. "CriOS/140 ... Safari/604.1" — the
 * browser APP is Chrome 140 but the ENGINE is WebKit, not Blink. Identity
 * verification therefore checks brand + engine separately and never claims an
 * independent desktop engine on Apple platforms.
 */

const BROWSER_SIGNATURES = [
	// Order matters: most-specific tokens first. "Edg/" must precede "Chrome/",
	// "CriOS"/"FxiOS"/"EdgiOS" must precede "Safari" (WebKit wrappers all end
	// with a Safari/ token on iOS).
	{ code: 'edge', brands: ['Edg/', 'EdgiOS', 'Edge/'] },
	{ code: 'opera', brands: ['OPR/', 'OPiOS', 'Opera'] },
	{ code: 'duckduckgo', brands: ['DuckDuckGo'] },
	{ code: 'brave', brands: ['Brave'] },
	{ code: 'firefox', brands: ['Firefox/', 'FxiOS'] },
	{ code: 'chrome', brands: ['Chrome/', 'CriOS'] },
	{ code: 'safari', brands: ['Safari/'] }
];

/** Parse the runtime's UA into { browserCode, browserVersion, engine, platformHint }. */
export function parseUserAgent(ua) {
	if (!ua || typeof ua !== 'string') return null;
	let browserCode = null;
	let browserVersion = null;
	for (const sig of BROWSER_SIGNATURES) {
		for (const brand of sig.brands) {
			const index = ua.indexOf(brand);
			if (index === -1) continue;
			// Safari/ has a WebKit build number, not a product version — take
			// the preceding Version/x.y token when present.
			const match = ua.slice(index).match(new RegExp(`${brand.replace(/[/*]/g, '\\$&')}([0-9]+(?:\\.[0-9]+)?)`));
			if (sig.code === 'safari') {
				const versionToken = ua.match(/Version\/([0-9]+(?:\.[0-9]+)?)/);
				browserCode = 'safari';
				browserVersion = versionToken ? versionToken[1] : (match ? match[1] : null);
			} else {
				browserCode = sig.code;
				browserVersion = match ? match[1] : null;
			}
			break;
		}
		if (browserCode) break;
	}
	// Engine: the rendering core that actually drew the page.
	let engine = null;
	if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) || (/Safari/.test(ua) && /iPhone|iPad|iPadOS/.test(ua))) engine = 'WebKit';
	else if (/Firefox\//.test(ua)) engine = 'Gecko';
	else if (/Chrome\/|Chromium|Edg\//.test(ua)) engine = 'Blink';
	else if (/Safari\//.test(ua)) engine = 'WebKit';
	let platformHint = null;
	if (/iPhone/.test(ua)) platformHint = 'ios';
	else if (/iPad/.test(ua)) platformHint = 'ipados';
	else if (/Android/.test(ua)) platformHint = 'android';
	else if (/Windows NT/.test(ua)) platformHint = 'windows';
	else if (/Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua)) platformHint = 'macos';
	return { browserCode, browserVersion, engine, platformHint };
}

/**
 * Verify observed runtime facts against the selected environment.
 * @returns {{ ok: boolean, mismatches: string[], identity: object }} identity
 *   carries the RUNTIME-AUTHORITATIVE values (observed browser brand/version,
 *   engine, platform) for the report — never the catalog's claim.
 */
export function verifyRuntimeIdentity({ runtimeFacts, environment } = {}) {
	const identity = {
		observedUserAgent: runtimeFacts?.userAgent ?? null,
		browserCode: null,
		browserVersion: null,
		engine: null,
		platform: null,
		viewport: runtimeFacts?.viewport ?? null,
		devicePixelRatio: runtimeFacts?.devicePixelRatio ?? null,
		maxTouchPoints: runtimeFacts?.maxTouchPoints ?? null
	};
	if (!runtimeFacts?.userAgent) {
		return { ok: false, mismatches: ['runtime identity not observable (no user agent reported)'], identity };
	}
	const parsed = parseUserAgent(runtimeFacts.userAgent);
	if (!parsed) {
		return { ok: false, mismatches: ['runtime user agent could not be parsed'], identity };
	}
	identity.browserCode = parsed.browserCode;
	identity.browserVersion = parsed.browserVersion;
	identity.engine = parsed.engine;
	identity.platform = parsed.platformHint;
	identity.browserVersionAuthoritative = true;

	// RT1 (#14680): when a REAL branded binary executed locally, its fact
	// block names the binary and its detected version. Headless branded
	// builds report plain HeadlessChrome UAs (no brand token), so the
	// branded-binary fact is the authoritative identity for brand+version in
	// that case — recorded as such, never silently trusted from the catalog.
	const branded = runtimeFacts?.brandedBinary ?? null;
	if (branded && !branded.fallbackUsed) {
		identity.brandedBinary = branded;
		identity.browserCode = branded.brand ?? identity.browserCode;
		identity.browserVersion = branded.detectedVersion ?? identity.browserVersion;
	}

	const mismatches = [];
	const selectedCode = String(environment?.browserCode ?? environment?.browser ?? '').toLowerCase();
	const selectedVersion = environment?.browserVersion ? String(environment.browserVersion).split('.')[0] : null;
	const selectedPlatform = String(environment?.platform ?? '').toLowerCase();

	// Browser brand: the browser actually executing must BE the selected one.
	if (selectedCode && identity.browserCode && identity.browserCode !== selectedCode) {
		mismatches.push(`browser mismatch: selected ${selectedCode}, runtime reports ${identity.browserCode}`);
	}
	// Browser version: runtime-authoritative — compare MAJOR only (runtimes
	// report full versions like 141.0.7390.65 against a catalog major).
	if (selectedVersion && identity.browserVersion
		&& String(identity.browserVersion).split('.')[0] !== selectedVersion.split('.')[0]) {
		mismatches.push(`browser version mismatch: selected ${selectedVersion}, runtime reports ${identity.browserVersion}`);
	}
	// Platform family.
	if (selectedPlatform && parsed.platformHint && parsed.platformHint !== selectedPlatform) {
		mismatches.push(`platform mismatch: selected ${selectedPlatform}, runtime reports ${parsed.platformHint}`);
	}
	// Engine honesty on Apple mobile: a non-Safari browser there is a WebKit
	// wrapper — acceptable ONLY if the identity says WebKit. Any claim of an
	// independent engine on iOS/iPadOS is a mismatch.
	if (['ios', 'ipados'].includes(selectedPlatform) && selectedCode && selectedCode !== 'safari' && parsed.engine !== 'WebKit') {
		mismatches.push(`engine mismatch: ${selectedCode} on ${selectedPlatform} must run the WebKit engine, runtime reports ${parsed.engine}`);
	}
	return { ok: mismatches.length === 0, mismatches, identity };
}
