/**
 * Browser layer for the QA engine.
 *
 * One Playwright browser per run, one context per viewport profile. The layer
 * owns three safety properties:
 *   1. Scope: top-level navigation stays on the target origin (plus any
 *      operator-allowed origins); off-site navigations are aborted and noted.
 *   2. Read-only interaction: while the engine is interacting (clicking,
 *      typing, submitting) every non-GET request is blocked unless the owner
 *      explicitly authorized test writes. GraphQL *queries* stay allowed so
 *      single-page apps keep rendering.
 *   3. Observation: console errors, page errors, failed requests, response
 *      headers and dialogs are captured per page for the detectors.
 *
 * It also streams JPEG frames to the dashboard's live view.
 */
import { resolveEngine } from '../browserEngines.js';
import { contextOptionsFor } from '../deviceProfiles.js';
import { environmentEmulationOptions } from '../browserstackProvider.js';
import { OBSERVER_SCRIPT } from './detectors/pageAudit.js';
import { createBrowserPolicy } from '../browserPolicy.js';

/**
 * The agent cursor: a pointer drawn inside the page (closed shadow root,
 * pointer-events none, invisible to elementFromPoint and to text detectors) so
 * the live preview shows where the agent is about to act. It glides to the
 * target, shows a short label, ripples on click and fades when idle.
 */
const CURSOR_SCRIPT = `(() => {
	if (window.__qaseCursor) return;
	let host, root, dot, tag, ring, hideTimer, x = -40, y = -40;
	function mount() {
		if (host?.isConnected) return true;
		if (!document.documentElement) return false;
		host = document.createElement('qase-cursor');
		host.setAttribute('data-qase-ignore', '');
		host.setAttribute('aria-hidden', 'true');
		host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
		root = host.attachShadow({ mode: 'closed' });
		root.innerHTML = '<style>' +
			'.c{position:fixed;left:0;top:0;transition:transform .42s cubic-bezier(.2,.8,.2,1),opacity .3s;opacity:0;will-change:transform}' +
			'.c svg{display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))}' +
			'.t{position:absolute;left:20px;top:20px;white-space:nowrap;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.02em;color:#ffffff;background:#1E40AF;padding:5px 7px;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:280px;overflow:hidden;text-overflow:ellipsis}' +
			'.r{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid #1E40AF;opacity:0;pointer-events:none}' +
			'.r.go{animation:p .55s ease-out}' +
			'@keyframes p{0%{opacity:.9;transform:var(--at) scale(.3)}100%{opacity:0;transform:var(--at) scale(1.5)}}' +
			'</style><div class="r"></div><div class="c"><svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2.5l15 8.6-6.6 1.6 3.9 7-2.6 1.4-3.9-7-4.8 4.6z" fill="#1E40AF" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg><div class="t">QASE</div></div>';
		dot = root.querySelector('.c'); tag = root.querySelector('.t'); ring = root.querySelector('.r');
		document.documentElement.appendChild(host);
		return true;
	}
	window.__qaseCursor = (nx, ny, label, click) => {
		if (!mount()) return;
		x = nx; y = ny;
		dot.style.opacity = '1';
		dot.style.transform = 'translate(' + (x - 4) + 'px,' + (y - 3) + 'px)';
		tag.textContent = label || 'QASE';
		tag.style.display = label === '' ? 'none' : 'block';
		if (click) {
			ring.style.setProperty('--at', 'translate(' + x + 'px,' + y + 'px)');
			ring.classList.remove('go'); void ring.offsetWidth; ring.classList.add('go');
		}
		clearTimeout(hideTimer);
		hideTimer = setTimeout(() => { if (dot) dot.style.opacity = '0'; }, 2600);
	};
	window.__qaseCursorHide = () => { clearTimeout(hideTimer); if (dot) { dot.style.transition = 'none'; dot.style.opacity = '0'; void dot.offsetWidth; dot.style.transition = ''; } };
})();`;

/** Runs in every new page of a signed-in context: puts back the sign-in tab's sessionStorage. */
function RESTORE_SESSION_STORAGE(snapshot) {
	try {
		if (location.origin !== snapshot.origin) return;
		for (const [key, value] of Object.entries(snapshot.items)) if (sessionStorage.getItem(key) === null) sessionStorage.setItem(key, value);
	} catch { /* storage disabled */ }
}

export const VIEWPORTS = Object.freeze({
	desktop: { name: 'desktop', label: 'Desktop 1440×900', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
	tablet: { name: 'tablet', label: 'Tablet 820×1180', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
	mobile: { name: 'mobile', label: 'Mobile 390×844', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
		userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' }
});

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_EVENTS = 400;

function isGraphQlQuery(request) {
	if (request.method() !== 'POST') return false;
	const body = request.postData() ?? '';
	if (!/"query"\s*:/.test(body)) return false;
	return !/\bmutation\b/.test(body);
}

export function allowedOrigins(targetUrl, env = process.env) {
	const origins = new Set();
	try { origins.add(new URL(targetUrl).origin); } catch { /* invalid target is handled by the engine */ }
	for (const entry of String(env.QASE_BROWSER_ALLOWED_ORIGINS ?? '').split(',').map(item => item.trim()).filter(Boolean)) origins.add(entry);
	return origins;
}

function originAllowed(url, origins) {
	let parsed;
	try { parsed = new URL(url); } catch { return false; }
	if (['about:', 'data:', 'blob:'].includes(parsed.protocol)) return true;
	for (const origin of origins) {
		if (origin === parsed.origin) return true;
		const wildcard = origin.match(/^(https?):\/\/\*\.(.+)$/);
		if (wildcard && parsed.protocol === `${wildcard[1]}:` && parsed.hostname.endsWith(`.${wildcard[2]}`)) return true;
	}
	return false;
}

/** The session's own device/environment becomes the "primary" profile. */
export function primaryProfile(session) {
	const environment = session.environmentSnapshot;
	const emulation = environment ? environmentEmulationOptions(environment) : contextOptionsFor(session.device ?? 'desktop', { landscape: session.deviceLandscape === true });
	if (!emulation?.viewport) return { ...VIEWPORTS.desktop };
	return {
		name: emulation.isMobile ? 'device' : 'desktop',
		label: `${environment?.device ?? session.device ?? 'Device'} ${emulation.viewport.width}×${emulation.viewport.height}`,
		viewport: emulation.viewport,
		deviceScaleFactor: emulation.deviceScaleFactor ?? 1,
		isMobile: Boolean(emulation.isMobile),
		hasTouch: Boolean(emulation.hasTouch),
		userAgent: emulation.userAgent
	};
}

export async function createQaBrowser({ session, allowWrites = false, publishFrame, onBlocked, env = process.env, headless = env.QASE_HEADLESS !== 'false' } = {}) {
	const engine = await resolveEngine(session.engine ?? 'chromium');
	if (!engine.available) throw Object.assign(new Error(engine.reason ?? `The ${engine.id} browser is not available.`), { code: 'ENGINE_UNAVAILABLE' });
	const browser = await engine.type.launch({ headless, ...engine.launch });
	const origins = allowedOrigins(session.targetUrl, env);
	const showCursor = env.QASE_AGENT_CURSOR !== 'false';
	// The existing browser policy keeps private-network (SSRF) protection and
	// scheme rules identical to every other QASE mode. Verdicts are cached per origin.
	const policy = createBrowserPolicy({ getTargetUrl: () => session.targetUrl, environment: env });
	const verdicts = new Map();
	const policyAllows = async (url, topLevel = false) => {
		let parsed;
		try { parsed = new URL(url); } catch { return false; }
		if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return true;
		const key = `${topLevel ? 'nav' : 'req'}:${parsed.origin}`;
		if (!verdicts.has(key)) verdicts.set(key, (topLevel ? policy.evaluateNavigation(url) : policy.evaluateRequest(url)).then(result => result.allowed !== false).catch(() => false));
		return verdicts.get(key);
	};
	const contexts = new Map();
	let interacting = 0;
	let writesAllowedUntil = 0;
	let storageState;
	let sessionSnapshot; // { origin, items } — sessionStorage is per tab and never part of storageState
	const contextKeys = new WeakMap();
	let activePage;
	let frameTimer;
	let lastFrameKey;
	let lastFrame;
	// Every refusal is counted so detectors and the explorer can tell harness
	// side-effects (a blocked write or sign-in redirect) from real site defects.
	const blockedCounts = { write_blocked: 0, offsite_navigation: 0, policy: 0 };
	const recentBlocked = [];
	const noteBlocked = event => {
		blockedCounts[event.kind] = (blockedCounts[event.kind] ?? 0) + 1;
		recentBlocked.push({ ...event, ts: Date.now() });
		if (recentBlocked.length > 50) recentBlocked.shift();
		onBlocked?.(event);
	};

	// anonymous: never carries the signed-in state (authorization checks).
	// isolated: a private context the caller owns (offline/network emulation).
	async function context(profile, { reducedMotion, colorScheme, anonymous = false, isolated = false } = {}) {
		const key = `${profile.name}:${reducedMotion ?? 'no-preference'}:${colorScheme ?? 'light'}:${anonymous ? 'anon' : 'user'}`;
		if (!isolated && contexts.has(key)) return contexts.get(key);
		const created = await browser.newContext({
			viewport: profile.viewport,
			deviceScaleFactor: profile.deviceScaleFactor,
			isMobile: engine.id === 'firefox' ? undefined : profile.isMobile,
			hasTouch: profile.hasTouch,
			// Headless Chromium announces itself as "HeadlessChrome", which some sign-in
			// pages and firewalls reject; desktop profiles use the regular Chrome string.
			...(profile.userAgent ? { userAgent: profile.userAgent } : engine.id === 'chromium' ? { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(browser.version()).split('.')[0]}.0.0.0 Safari/537.36` } : {}),
			reducedMotion: reducedMotion ?? 'no-preference',
			colorScheme: colorScheme ?? 'light',
			...(storageState && !anonymous ? { storageState } : {}),
			serviceWorkers: 'block',
			acceptDownloads: false,
			ignoreHTTPSErrors: false
		});
		contextKeys.set(created, key);
		await created.addInitScript(OBSERVER_SCRIPT);
		if (showCursor) await created.addInitScript(CURSOR_SCRIPT);
		if (sessionSnapshot && !anonymous) await created.addInitScript(RESTORE_SESSION_STORAGE, sessionSnapshot);
		await created.route('**/*', async route => {
			const request = route.request();
			try {
				// request.frame() throws for some navigations (e.g. form POSTs before commit); treat those as top-level.
				const topLevel = request.isNavigationRequest() && (() => { try { return request.frame() === request.frame().page().mainFrame(); } catch { return true; } })();
				// A blocked top-level navigation answers 204 No Content, so the tab stays on
				// the current page (with its state) instead of showing a browser error page.
				const refuse = () => topLevel ? route.fulfill({ status: 204, body: '' }) : route.abort('blockedbyclient');
				if (topLevel && !originAllowed(request.url(), origins)) {
					noteBlocked({ kind: 'offsite_navigation', url: request.url(), method: request.method() });
					return await refuse();
				}
				if (!await policyAllows(request.url(), false)) {
					noteBlocked({ kind: 'policy', url: request.url(), method: request.method() });
					return await refuse();
				}
				if (!allowWrites && Date.now() > writesAllowedUntil && !SAFE_METHODS.has(request.method()) && (interacting > 0 || request.isNavigationRequest()) && !isGraphQlQuery(request)) {
					noteBlocked({ kind: 'write_blocked', url: request.url(), method: request.method(), navigation: request.isNavigationRequest() });
					return await refuse();
				}
				return await route.continue();
			} catch {
				// Never leave a request unrouted. A write we could not classify is blocked.
				if (!allowWrites && !SAFE_METHODS.has(request.method())) await route.abort('blockedbyclient').catch(() => {});
				else await route.continue().catch(() => {});
			}
		});
		if (!isolated) contexts.set(key, created);
		return created;
	}

	/** Opens a page with observation hooks. Returns { page, log }. */
	async function openPage(profile, options = {}) {
		const ctx = await context(profile, options);
		const page = await ctx.newPage();
		const log = { console: [], pageErrors: [], failedRequests: [], responses: [], dialogs: [], websockets: [], mainResponse: undefined };
		const push = (list, item) => { if (list.length < MAX_EVENTS) list.push(item); };
		page.on('console', message => {
			if (['error', 'warning'].includes(message.type())) push(log.console, { type: message.type(), text: message.text().slice(0, 1000), location: message.location()?.url, ts: Date.now() });
		});
		page.on('pageerror', error => push(log.pageErrors, { message: String(error?.message ?? error).slice(0, 1000), stack: String(error?.stack ?? '').slice(0, 2000), ts: Date.now() }));
		page.on('requestfailed', request => {
			const failure = request.failure()?.errorText ?? 'failed';
			if (failure.includes('ERR_BLOCKED_BY_CLIENT') || failure.includes('NS_ERROR_ABORT') || /blocked/i.test(failure)) return;
			push(log.failedRequests, { url: request.url(), method: request.method(), resourceType: request.resourceType(), failure, ts: Date.now() });
		});
		page.on('response', response => {
			const request = response.request();
			push(log.responses, { url: response.url(), status: response.status(), method: request.method(), resourceType: request.resourceType(), ts: Date.now() });
		});
		page.on('dialog', dialog => {
			push(log.dialogs, { type: dialog.type(), message: dialog.message().slice(0, 500), ts: Date.now() });
			dialog.dismiss().catch(() => {});
		});
		page.on('popup', popup => popup.close().catch(() => {}));
		page.on('websocket', socket => {
			const entry = { url: socket.url().slice(0, 300), frames: 0, errors: [], closedAt: undefined, openedAt: Date.now() };
			push(log.websockets, entry);
			socket.on('framereceived', () => { entry.frames++; });
			socket.on('framesent', () => { entry.frames++; });
			socket.on('socketerror', error => { if (entry.errors.length < 5) entry.errors.push(String(error).slice(0, 200)); });
			socket.on('close', () => { entry.closedAt = Date.now(); });
		});
		activePage = page;
		// Isolated pages own their context: closing the page closes it.
		if (options.isolated) page.once('close', () => { ctx.close().catch(() => {}); });
		return { page, log };
	}

	/** Navigates and waits for a settled render. Returns the main response or undefined. */
	async function goto(page, url, log, { timeoutMs = 30000, quietMs } = {}) {
		let response;
		try {
			response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
		} catch (error) {
			if (log) log.navigationError = String(error.message).split('\n')[0].slice(0, 300);
			throw error;
		}
		await settle(page, quietMs ? { quietMs } : undefined);
		if (log && response) {
			let headers = {};
			try { headers = await response.allHeaders(); } catch { /* headers unavailable */ }
			log.mainResponse = { url: response.url(), status: response.status(), headers };
		}
		return response;
	}

	/** Waits briefly for network quiet and fonts/images, never failing. */
	async function settle(page, { quietMs = 2500 } = {}) {
		await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
		// Sites with analytics or long-polling never reach network idle; the wait is capped.
		await page.waitForLoadState('networkidle', { timeout: quietMs + 1000 }).catch(() => {});
		await page.evaluate(() => document.fonts?.ready?.then(() => true)).catch(() => {});
		await page.waitForTimeout(300).catch(() => {});
	}

	/** Runs `work` with non-GET requests blocked (unless writes are authorized). */
	/**
	 * Moves the agent cursor to a locator (or a point) and labels the action.
	 * Purely visual; never throws, and costs ~0.4 s so viewers can follow it.
	 */
	async function pointAt(page, target, label, { click = true } = {}) {
		if (!showCursor || !page || page.isClosed()) return;
		try {
			let box = target && typeof target.boundingBox === 'function' ? await target.boundingBox({ timeout: 1500 }) : target;
			if (!box) return;
			const x = Math.round(box.x + (box.width ?? 0) / 2);
			const y = Math.round(box.y + Math.min((box.height ?? 0) / 2, 24));
			await page.evaluate(([px, py, text]) => window.__qaseCursor?.(px, py, text, false), [x, y, String(label ?? '').slice(0, 60)]);
			await page.waitForTimeout(420);
			if (click) await page.evaluate(([px, py, text]) => window.__qaseCursor?.(px, py, text, true), [x, y, String(label ?? '').slice(0, 60)]);
		} catch { /* the cursor is cosmetic */ }
	}

	/** Hides the cursor before evidence screenshots, so reviewers never see it. */
	async function hideCursor(page) {
		if (showCursor && page && !page.isClosed()) await page.evaluate(() => window.__qaseCursorHide?.()).catch(() => {});
	}

	async function interact(work) {
		interacting++;
		try { return await work(); }
		finally { setTimeout(() => { interacting = Math.max(0, interacting - 1); }, 1500); }
	}

	/** Permits writes for a bounded window (the test-account sign-in submit only). */
	async function permitWritesFor(windowMs, work) {
		writesAllowedUntil = Date.now() + windowMs;
		try { return await work(); }
		finally { writesAllowedUntil = 0; }
	}

	/** Later contexts start signed in; existing contexts are closed and recreated on demand. */
	/**
	 * Adopts a signed-in session for every later page. `state` carries cookies,
	 * localStorage and IndexedDB; `sessionStorage` (one origin's items) is restored
	 * into each new tab, because many single-page apps keep their tokens there.
	 * `keep` is the context that actually signed in: it stays open and is reused,
	 * so pages for that profile run in the exact browser state that logged in.
	 */
	async function useSignedInState(state, { sessionStorage, keep } = {}) {
		storageState = state || undefined;
		sessionSnapshot = state && sessionStorage?.origin && Object.keys(sessionStorage.items ?? {}).length ? sessionStorage : undefined;
		const keepKey = keep && state ? contextKeys.get(keep) : undefined;
		for (const ctx of contexts.values()) if (ctx !== keep || !keepKey) await ctx.close().catch(() => {});
		contexts.clear();
		if (keepKey) {
			contexts.set(keepKey, keep);
			if (sessionSnapshot) await keep.addInitScript(RESTORE_SESSION_STORAGE, sessionSnapshot).catch(() => {});
		}
	}

	function startFrames(intervalMs = Number(env.QASE_FRAME_INTERVAL_MS) || 700) {
		stopFrames();
		frameTimer = setInterval(async () => {
			const page = activePage;
			if (!page || page.isClosed()) return;
			try {
				const bytes = await page.screenshot({ type: 'jpeg', quality: Number(env.QASE_FRAME_QUALITY) || 55, timeout: 1500, animations: 'allow' });
				const base64 = bytes.toString('base64');
				const key = `${base64.length}:${base64.slice(-64)}`;
				if (key === lastFrameKey) return;
				lastFrameKey = key;
				lastFrame = { base64, mimeType: 'image/jpeg', url: page.url(), title: await page.title().catch(() => ''), viewport: page.viewportSize(), ts: Date.now() };
				publishFrame?.(lastFrame);
			} catch { /* frames across navigations fail; the next tick recovers */ }
		}, intervalMs);
		frameTimer.unref?.();
	}

	function stopFrames() {
		if (frameTimer) clearInterval(frameTimer);
		frameTimer = undefined;
	}

	async function close() {
		stopFrames();
		for (const ctx of contexts.values()) await ctx.close().catch(() => {});
		contexts.clear();
		await browser.close().catch(() => {});
	}

	return {
		pointAt,
		hideCursor,
		engine: engine.id,
		version: browser.version(),
		origins,
		inScope: url => originAllowed(url, origins),
		policyAllows,
		/** fetch() for server-side probes, restricted by the same policy. */
		guardedFetch: fetchImpl => async (url, init) => {
			if (!await policyAllows(String(url), false)) throw new Error(`Blocked by browser safety policy: ${new URL(String(url)).origin}`);
			return fetchImpl(url, init);
		},
		context, openPage, goto, settle, interact, permitWritesFor, useSignedInState,
		signedIn: () => Boolean(storageState),
		startFrames, stopFrames,
		getLastFrame: () => lastFrame,
		/** Counts of refused requests by kind, and the most recent refusals. */
		blocked: () => ({ ...blockedCounts }),
		recentBlocked: (sinceTs = 0) => recentBlocked.filter(event => event.ts >= sinceTs),
		setActivePage: page => { activePage = page; },
		close
	};
}
