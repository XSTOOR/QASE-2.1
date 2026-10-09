import { hasUnresolvedPlaceholder, resolveSecrets } from './secrets.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeOs from 'node:os';
import { createBrowserPolicy, classifyDestructiveAction } from './browserPolicy.js';
import { contextOptionsFor, getDeviceProfile, DEFAULT_DEVICE_ID } from './deviceProfiles.js';
import { runMobileAudit } from './mobileAudit.js';
import { inspectFormValidation } from './browserFormAudit.js';
import { resolveEngine, ensureXvfb, ENGINE_IDS } from './browserEngines.js';

/** RT4: the Xvfb display id ensureXvfb manages (":77"). */
function xvfbDisplay() {
	return ':77';
}

/** RT4: extra Chromium launch flags — synthetic media + real virtual-desktop capture. */
const RT4_MEDIA_LAUNCH_ARGS = Object.freeze([
	'--enable-usermedia-screen-capturing',
	'--allow-http-screen-capture',
	'--auto-select-desktop-capture-source=Entire screen'
]);
import { SYNTHETIC_MEDIA_ARGS, installMediaObserver, inspectMedia, setMicrophonePermission, setMediaPermission, probeMicrophone, probeCamera, probeScreenShare, inspectCallControls, mediaProbeVerdict, syntheticMediaCapability, exerciseMeetingControls, verifyPermissionRecovery } from './browserMedia.js';
import {
	SECURITY_CHECK_IDS, XSS_CANARY,
	checkResponseHeaders, checkCookies, checkXssReflection, checkSqlErrorSignature, checkMixedContent
} from './securityChecks.js';
import { browserstackCredentials, connectBrowserstack, environmentEmulationOptions, resolveExecution } from './browserstackProvider.js';
import { createInteractionApi } from './interactionApi.js';
import {
	userAgentFor,
	resolveExecutionLevel,
	platformRuntimeProfile,
	EXECUTION_LEVELS
} from './deviceRuntimeProfiles.js';

/**
 * Makes the agent's browser watchable.
 *
 * The SDK's Node browser service drives Playwright, and Playwright screenshots
 * do not contain a mouse pointer — so a naive "stream the screenshots" panel
 * shows results without ever showing the act. This bridge wraps the service's
 * interaction methods: before each one it resolves where the action is about to
 * land, publishes that point, pauses long enough for the eye to follow, and
 * only then calls through. The dashboard draws the cursor and the target
 * highlight itself, on top of the frame stream, so nothing is injected into the
 * page under test and the element indices the agent snapshots stay untouched.
 *
 * The same seam is where credential placeholders become real keystrokes.
 */

const FRAME_INTERVAL_MS = Number(process.env.QASE_FRAME_INTERVAL_MS ?? 320);
const FRAME_QUALITY = Number(process.env.QASE_FRAME_QUALITY ?? 55);
const CURSOR_DWELL_MS = Number(process.env.QASE_CURSOR_DWELL_MS ?? 420);
/** How long to let a click's navigation land before reporting where we are. */
const NAV_SETTLE_MS = Number(process.env.QASE_NAV_SETTLE_MS ?? 1600);

// Playwright starts the video recorder lazily when the first page is created.
// A context can therefore be created successfully even when its bundled
// FFmpeg executable is missing. Remember that host capability once detected so
// later sessions do not repeat the same failed recorder startup.
let localChromiumVideoUnsupportedReason = null;

export function isVideoRecordingDependencyError(error) {
	const message = String(error?.message ?? error ?? '');
	return /ffmpeg/i.test(message)
		|| /recordvideo|record video|video recording/i.test(message)
		|| /video[^\n]*(?:executable|codec)[^\n]*(?:missing|not found|doesn'?t exist|enoent)/i.test(message);
}

/**
 * Create a context and prove it can create a page before the agent starts.
 * If Playwright's optional video dependency is unavailable, discard that
 * context and recreate it without recording. The returned probe page is real
 * and ready for runtime-fact collection.
 */
export async function createContextWithVideoFallback(browser, requestedOptions, { skipVideoReason = null } = {}) {
	const contextOptions = { ...requestedOptions };
	let fallbackReason = skipVideoReason ? String(skipVideoReason) : null;
	if (fallbackReason) delete contextOptions.recordVideo;

	const fallbackWithoutVideo = async (error, failedContext = null) => {
		fallbackReason = String(error?.message ?? error).split('\n')[0];
		await failedContext?.close?.().catch(() => {});
		delete contextOptions.recordVideo;
		const context = await browser.newContext(contextOptions);
		const probePage = await context.newPage();
		return { context, probePage, videoActive: false, fallbackReason, contextOptions };
	};

	let context;
	try {
		context = await browser.newContext(contextOptions);
	} catch (error) {
		if (!contextOptions.recordVideo || !isVideoRecordingDependencyError(error)) throw error;
		return fallbackWithoutVideo(error);
	}

	try {
		const probePage = await context.newPage();
		return {
			context,
			probePage,
			videoActive: Boolean(contextOptions.recordVideo),
			fallbackReason,
			contextOptions
		};
	} catch (error) {
		if (!contextOptions.recordVideo || !isVideoRecordingDependencyError(error)) {
			await context.close?.().catch(() => {});
			throw error;
		}
		return fallbackWithoutVideo(error, context);
	}
}

/**
 * Submits a benign probe value through the page's own GET search-like form.
 * Returns the resulting URL, or undefined when no usable form exists. The
 * form's own action decides the destination — the browser policy stays in
 * charge of every request.
 */
async function submitCanaryThroughForms(page, value) {
	try {
		const form = await page.evaluate(probe => {
			const candidates = [...document.querySelectorAll('form')]
				.filter(node => node.checkVisibility?.() !== false)
				.filter(node => {
					const method = (node.getAttribute('method') || 'get').toLowerCase();
					if (method !== 'get') return false;
					const input = node.querySelector('input[type="text"], input[type="search"], input:not([type])');
					return Boolean(input);
				});
			const chosen = candidates[0];
			if (!chosen) return undefined;
			const input = chosen.querySelector('input[type="text"], input[type="search"], input:not([type])');
			return { action: chosen.action || location.href, name: input.name };
		}, value);
		if (!form?.name) return undefined;
		const target = new URL(form.action, page.url());
		target.searchParams.set(form.name, value);
		await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
		await page.waitForLoadState('networkidle').catch(() => undefined);
		return page.url();
	} catch {
		return undefined;
	}
}

/**
 * Inspects the current DOM for the canary: `reflected` = present anywhere;
 * `escaped` = present as text (textContent) but never as raw markup, and no
 * probe element (img/onerror) actually exists in the document.
 */
async function inspectReflection(page, canary) {
	return page.evaluate(marker => {
		// Strip quotes from the marker: HTML serialization escapes attribute
		// quotes, so even an unescaped reflection shows "qz7&quot;'..." — the
		// bare marker must never contain a character the serializer would mangle.
		const markerText = marker.slice(0, marker.indexOf('<')).replace(/["']/g, '');
		const reflected = document.documentElement.outerHTML.includes(markerText) || document.body.innerText.includes(markerText);
		if (!reflected) return { reflected: false, escaped: false };
		const executable = [...document.querySelectorAll('img')].some(img => img.getAttribute('src') === 'x' && img.hasAttribute('onerror'));
		const textOnly = document.body.innerText.includes(markerText) && !executable;
		return { reflected: true, escaped: textOnly };
	}, canary).catch(() => ({ reflected: false, escaped: false }));
}

export function selectSnapshotElements(elements, requestedLimit) {
	const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 150;
	return [...elements.filter(element => element.interactive), ...elements.filter(element => !element.interactive)].slice(0, limit);
}

/**
 * Bounds one browser operation. A wedged browser-service call (dead renderer,
 * hung MCP round-trip) must never strand a run in 'running' with no way back —
 * Stop only breaks the model stream, not an awaited tool promise. On timeout
 * the agent receives a retryable error result it can act on instead of
 * silence. Accepts a thunk or an already-started promise so both call shapes
 * are safe.
 */
export function withBrowserOperationTimeout(work, timeoutMs, operation = 'browser operation') {
	const run = typeof work === 'function' ? () => Promise.resolve().then(work) : () => Promise.resolve(work);
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return run();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new Error(`${operation} timed out after ${timeoutMs} ms. The browser may be unresponsive — retry once, then report the affected check as not tested with a reason.`);
			error.name = 'BrowserOperationTimeout';
			error.timedOut = true;
			reject(error);
		}, timeoutMs);
		run().then(
			result => { clearTimeout(timer); resolve(result); },
			error => { clearTimeout(timer); reject(error); }
		);
	});
}

/** Back-compat alias for the snapshot-bound tests and callers. */
export function withSnapshotTimeout(work, timeoutMs) {
	return withBrowserOperationTimeout(work, timeoutMs, 'browser_snapshot');
}

/**
 * Methods that move the pointer somewhere the user should see it move.
 * `navigates` marks the ones that can change the page, and whose reported URL
 * therefore has to wait for the router.
 */
const POINTER_ACTIONS = {
	click: { verb: 'click', settle: 120, navigates: true },
	hover: { verb: 'hover', settle: 60 },
	fill: { verb: 'fill', settle: 120 },
	check: { verb: 'check', settle: 120 },
	select: { verb: 'select', settle: 120 },
	uploadFiles: { verb: 'upload', settle: 120 },
	pressKey: { verb: 'key', settle: 60, navigates: true },
	scroll: { verb: 'scroll', settle: 60 }
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function attachBrowserBridge(session, service, runStore, options = {}) {
	const policy = options.policy ?? createBrowserPolicy({ getTargetUrl: () => session.targetUrl });
	const deviceId = options.device ?? session.device ?? DEFAULT_DEVICE_ID;
	const deviceLandscape = options.deviceLandscape ?? session.deviceLandscape === true;
	const deviceProfile = getDeviceProfile(deviceId);
	const environment = options.environment ?? session.environmentSnapshot;
	// An environment snapshot overrides the legacy device-profile emulation:
	// BrowserStack envs execute remotely via CDP; every other env (or no env)
	// runs local Chromium with the environment's emulation hints.
	let execution = options.execution ?? null;
	if (!execution) {
		execution = await resolveExecution(environment, options.browserstackCredentials ?? browserstackCredentials());
	}
	// Phase 20: structured runtime profile + honest execution level + the
	// emulation's UA (real mobile UA for the selected OS/browser — not desktop
	// Chromium's). Only the SIMULATED path uses userAgentFor; a remote runtime
	// records the page's genuine UA instead.
	const runtimeProfile = platformRuntimeProfile(environment?.platform);
	// R3 #14492: an execution plan may be explicitly BLOCKED (real-device
	// request with no configured runtime). Surface it honestly — the bridge
	// never launches a fallback browser for it.
	const executionLevel = resolveExecutionLevel({ mode: execution.mode });
	const emulatedUserAgent = execution.mode === 'emulated' && environment
		? userAgentFor(environment.platform, environment.osVersion, environment.browserCode)
		: null;
	const permissionScenario = environment?.permissionScenario ?? null;
	const orientationScenario = environment?.orientationScenario ?? null;
	const emulationOptions = execution.mode === 'emulated'
		? environmentEmulationOptions(environment)
		: contextOptionsFor(deviceId, { landscape: deviceLandscape });
	const bridge = {
		service,
		execution: {
			...execution,
			level: executionLevel,
			levelLabel: executionLevel,
			provider: execution.mode === 'environment' ? 'environment' : 'local',
			runtimeProfile,
			emulatedUserAgent,
			// R3 #14492: the ACTUAL engine that will run the selected browser
			// (chromium/firefox/webkit) — null for remote/environment runs.
			executionEngine: execution.executionEngine ?? null,
			// RT4 (#14756): the engine ACTUALLY launched (lazily recorded at
			// launch; media capability gates read it — a branded-binary
			// fallback to bundled Chromium keeps the capability honest).
			launchedEngineId: null
		},
		frameTimer: undefined,
		runtimeFacts: undefined,
		frameCapture: undefined,
		capturedInactiveFrame: false,
		subscribers: 0,
		lastFrame: undefined,
		securityBlocks: [],
		destructiveLedger: new Set(Array.isArray(session.executedDestructiveActions) ? session.executedDestructiveActions : []),
		disposed: false
	};
	let syntheticMedia = false;
	// RT5 (#14757): session video evidence. The context records (Chromium
	// only); collectSessionVideo harvests the finalized webm at close and
	// hands it to saveVideoArtifact (wired by the session layer to the
	// artifact store). Absent recording → no artifact, honestly noted.
	let sessionVideoMeta = null;
	let saveVideoArtifact = async (bytes, meta) => {
		sessionVideoMeta = { ...meta, savedAt: new Date().toISOString() };
	};
	const collectSessionVideo = async () => {
		if (bridge.execution?.videoRecording === 'UNSUPPORTED' || !bridge.execution?.videoRecording) return null;
		try {
			const dir = videoDir();
			const context = service.context;
			if (!context) return null;
			// Closing the context finalizes every video file.
			await context.close().catch(() => {});
			const entries = await nodeFs.promises.readdir(dir).catch(() => []);
			const videos = [];
			for (const name of entries) {
				if (!name.endsWith('.webm')) continue;
				const full = nodePath.join(dir, name);
				const bytes = await nodeFs.promises.readFile(full).catch(() => null);
				if (bytes && bytes.length > 0) {
					videos.push({ name, bytes });
					await nodeFs.promises.rm(full, { force: true }).catch(() => {});
				}
			}
			if (!videos.length) return null;
			// Single-context session model: keep the largest (most complete)
			// recording — Playwright writes one file per closed video page.
			const latest = videos.sort((a, b) => b.bytes.length - a.bytes.length)[0];
			await saveVideoArtifact(latest.bytes, {
				fileName: `session-video-${session.id.slice(0, 8)}.webm`,
				size: latest.bytes.length
			});
			bridge.execution = { ...bridge.execution, videoRecording: 'SAVED', videoArtifact: sessionVideoMeta };
			return sessionVideoMeta;
		} catch {
			bridge.execution = { ...bridge.execution, videoRecording: 'FAILED' };
			return null;
		}
	};
	// Session layer override: app.js wires this to the artifact store.
	bridge.setVideoSink = (sink) => { saveVideoArtifact = sink; };
	bridge.getVideoRecordingState = () => bridge.execution?.videoRecording ?? null;
	const videoDir = () => videoDirForSession(session.id);

	// RT5 (#14757): per-session temp dir for Playwright video output.
	function videoDirForSession(sessionId) {
		const dir = nodePath.join(nodeOs.tmpdir(), `qase-video-${sessionId}`);
		nodeFs.mkdirSync(dir, { recursive: true });
		return dir;
	}	// Abort race for in-flight interactions: stop() must unwind a browser
	// action within the abort window instead of waiting out Playwright's
	// default 30s action timeout.
	let activeAbortSignal = null;

	const raceAbort = promise => {
		if (!activeAbortSignal) return promise;
		const signal = activeAbortSignal;
		if (signal.aborted) {
			return Promise.reject(abortError());
		}
		const aborted = new Promise((_, reject) => {
			const onAbort = () => {
				clearTimeout(timer);
				reject(abortError());
			};
			const timer = setTimeout(() => signal.removeEventListener('abort', onAbort), 5000);
			signal.addEventListener('abort', onAbort, { once: true });
		});
		return Promise.race([promise, aborted]);
	};

	const abortError = () =>
		Object.assign(new Error('The browser action was interrupted by a stop request.'), { name: 'AbortError' });

	bridge.setAbortSignal = signal => {
		activeAbortSignal = signal ?? null;
	};

	/*
	 * Snapshots hand back selectors that actually identify one element.
	 *
	 * The SDK falls back to the bare tag name when an element has no id and no
	 * test id, so every link on a page is described to the agent as `a` and
	 * every button as `button`. The agent picks one, clicks `a`, and lands on
	 * the first anchor in the document — usually the logo in the top-left. It
	 * then reports the link it meant to click as broken, which is how a working
	 * page ends up with a navigation defect against it.
	 *
	 * Each element gets a unique structural path instead. Nothing is written to
	 * the page: the path is computed from the tree as it already stands.
	 */
	const originalSnapshot = service.snapshot.bind(service);
	// A hung MCP snapshot (or the DOM pass below) must never wedge a run in
	// 'running' forever — bound the whole operation like every other browser
	// call (see withBrowserOperationTimeout). On timeout the agent gets a
	// retryable error instead of silence, which it already knows how to
	// handle ("inspect the resulting state and retry once with a different
	// verified locator; then continue the plan").
	const SNAPSHOT_TIMEOUT_MS = Math.max(5000, Number(process.env.QASE_SNAPSHOT_TIMEOUT_MS ?? 30_000));
	service.snapshot = async (surface, options) => {
		const work = (async () => {
			const snapshot = await originalSnapshot(surface, options);
			const page = currentPage();
			if (!page || !Array.isArray(snapshot.elements)) {
				return snapshot;
			}

			try {
				// The same node list the snapshot enumerated, in the same order, so
				// an element's `eN` id indexes straight into these paths.
				const elements = await page.locator('body *:visible').evaluateAll(nodes => nodes.flatMap((node, index) => {
					const rect = node.getBoundingClientRect();
					if (rect.width < 1 || rect.height < 1) return [];
					let selector;
					if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) selector = `#${CSS.escape(node.id)}`;
					for (const attribute of ['data-testid', 'data-test', 'data-cy']) {
						const value = node.getAttribute(attribute);
						if (!selector && value) {
							const candidate = `[${attribute}="${CSS.escape(value)}"]`;
							if (document.querySelectorAll(candidate).length === 1) selector = candidate;
						}
					}
					const steps = [];
					for (let element = selector ? undefined : node; element && element.nodeType === 1 && element.tagName !== 'HTML'; element = element.parentElement) {
						const tag = element.tagName.toLowerCase();
						if (element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1) {
							steps.unshift(`#${CSS.escape(element.id)}`);
							break;
						}
						const siblings = [...(element.parentElement?.children ?? [])]
							.filter(sibling => sibling.tagName === element.tagName);
						steps.unshift(siblings.length > 1
							? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
							: tag);
					}
					return [{
						id: `e${index + 1}`, tagName: node.tagName.toLowerCase(), selector: selector || steps.join(' > '),
						interactive: node.matches('a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="switch"],[role="checkbox"],[role="radio"],[role="tab"],[role="slider"],[role="combobox"],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[onclick]'),
						testId: node.getAttribute('data-testid') || undefined,
						role: node.getAttribute('role') || undefined,
						name: node.getAttribute('aria-label') || node.getAttribute('title') || undefined,
						text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined,
						ariaLabel: node.getAttribute('aria-label') || undefined,
						placeholder: node.getAttribute('placeholder') || undefined,
						href: node.href || undefined, type: node.getAttribute('type') || undefined,
						checked: 'checked' in node ? Boolean(node.checked) : undefined,
						disabled: 'disabled' in node ? Boolean(node.disabled) : undefined,
						boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
					}];
				}));
				snapshot.elements = selectSnapshotElements(elements, options?.limit);
				snapshot.elementCoverage = { total: elements.length, returned: snapshot.elements.length, omitted: elements.length - snapshot.elements.length };
				snapshot.guidance = 'Controls are listed before layout elements. Use the supplied unique selector or a semantic locator; coordinates are viewport-relative and become stale after scrolling. If an action has no effect, inspect the resulting state and retry once with a different verified locator. Then record the observed defect or unresolved coverage and continue the plan; do not repeat the same attempt or claim untested checks passed.';
			} catch {
				// A snapshot with the SDK's selectors beats no snapshot at all.
			}

			return snapshot;
		})();
		return await withSnapshotTimeout(work, SNAPSHOT_TIMEOUT_MS);
	};
	/*
	 * Locators resolve to visible elements only.
	 *
	 * Real pages carry duplicates of the same link — one in the desktop header,
	 * one in a collapsed mobile menu, one in a template that is never shown. The
	 * SDK's locator takes them in DOM order, so the agent aims at a link the user
	 * cannot see: the click either lands on nothing or fails strict mode, and the
	 * agent concludes the link is broken when it works perfectly.
	 */
	const originalLocator = service.locator.bind(service);
	service.locator = async (page, input) => {
		const locator = await originalLocator(page, input);
		try {
			const visible = locator.filter({ visible: true });
			// Only prefer the filtered set when it actually matches something,
			// so asserting on a deliberately hidden element still works.
			return await visible.count() > 0 ? visible : locator;
		} catch {
			return locator;
		}
	};

	/** The live Playwright page, or undefined if no browser has been opened yet. */
	const currentPage = () => {
		const page = service.activePage;
		return page && !page.isClosed() ? page : undefined;
	};

	/*
	 * Signing in has to survive the browser being closed.
	 *
	 * Browsers are shut down when a run goes idle so Chromium does not pile up,
	 * but disposing one throws away its cookies and local storage. Without this,
	 * an agent that logged in half an hour ago comes back to a fresh browser,
	 * gets bounced to the login page, and carries on reasoning about the
	 * signed-in app it can no longer see — which reads exactly like it is making
	 * things up.
	 *
	 * The session is captured on the way out and replayed on the way in.
	 */
	let knownContext;
	const protectedContexts = new WeakSet();

	const recordSecurityBlock = (decision, detail = {}) => {
		const entry = {
			code: decision.code,
			message: decision.message,
			requiresConfirmation: Boolean(decision.requiresConfirmation),
			topLevel: Boolean(detail.topLevel),
			method: detail.method,
			resourceType: detail.resourceType,
			ts: Date.now()
		};
		bridge.securityBlocks.push(entry);
		if (bridge.securityBlocks.length > 100) {
			bridge.securityBlocks.splice(0, bridge.securityBlocks.length - 100);
		}
		runStore.publish(session, 'browser_policy', { browserPolicy: entry });
		return entry;
	};

	/**
	 * Applies request policy to every context, including popups. Public
	 * third-party assets remain available; private/reserved destinations and
	 * out-of-scope top-level navigations are aborted before bytes leave Chrome.
	 */
	const installNetworkPolicy = async context => {
		if (!context || protectedContexts.has(context)) return;
		if (typeof context.addInitScript === 'function') await context.addInitScript(installMediaObserver);
		// SDK-created tabs register diagnostics; window.open popups did not.
		context.on?.('page', page => service.registerPage?.(page));
		if (policy.isProduction && typeof context.addInitScript === 'function') {
			// Playwright routing cannot observe requests intercepted by a Service
			// Worker. A new Qase browser context has no existing registrations, so
			// disabling registration before the first target navigation closes that
			// bypass while leaving local/development PWA testing unchanged.
			await context.addInitScript(() => {
				const container = globalThis.navigator?.serviceWorker;
				if (!container) return;
				const blocked = () => Promise.reject(new DOMException(
					'Service worker registration is disabled by Qase browser safety policy.',
					'SecurityError'
				));
				try {
					Object.defineProperty(Object.getPrototypeOf(container), 'register', {
						value: blocked,
						configurable: false,
						writable: false
					});
				} catch {
					try { container.register = blocked; } catch { /* read-only in this browser */ }
				}
			});
			recordSecurityBlock({
				code: 'BROWSER_SERVICE_WORKERS_DISABLED',
				message: 'Service worker registration is disabled in production so network policy cannot be bypassed.'
			}, { resourceType: 'serviceworker' });
		}
		await context.route('**/*', async route => {
			const request = route.request();
			let topLevel = false;
			try {
				topLevel = request.isNavigationRequest() && !request.frame().parentFrame();
			} catch {
				// Service-worker requests have no frame and are subresources.
			}

			let decision;
			try {
				decision = await policy.evaluateRequest(request.url(), { topLevel });
			} catch {
				decision = {
					allowed: false,
					code: 'BROWSER_POLICY_EVALUATION_FAILED',
					message: 'Browser safety could not validate this network destination.'
				};
			}
			if (decision.allowed) {
				await route.continue();
				return;
			}
			recordSecurityBlock(decision, {
				topLevel,
				method: request.method(),
				resourceType: request.resourceType()
			});
			await route.abort('blockedbyclient').catch(() => undefined);
		});
		if (typeof context.routeWebSocket === 'function') {
			await context.routeWebSocket('**/*', async socket => {
				let decision;
				try {
					decision = await policy.evaluateRequest(socket.url(), { topLevel: false });
				} catch {
					decision = {
						allowed: false,
						code: 'BROWSER_POLICY_EVALUATION_FAILED',
						message: 'Browser safety could not validate this WebSocket destination.'
					};
				}
				if (decision.allowed) {
					socket.connectToServer();
					return;
				}
				recordSecurityBlock(decision, { method: 'CONNECT', resourceType: 'websocket' });
				await socket.close({ code: 1008, reason: 'Blocked by browser safety policy' }).catch(() => undefined);
			});
		}
		protectedContexts.add(context);
	};

	bridge.suspend = async () => {
		const page = currentPage();
		try {
			if (service.context) {
				bridge.saved = {
					storage: await service.context.storageState(),
					url: page && !/^about:/.test(page.url()) ? page.url() : bridge.saved?.url
				};
			}
		} catch {
			// A browser that died on its own takes its state with it.
		}
		stopFrames();
		// RT5 (#14757): collect the recorded video when the context closes.
		// Playwright finalizes the webm only after context/browser close —
		// page.video().path() throws until then, so close first, then harvest
		// every video file from the recording dir. Saved as a callback the
		// session layer wires to the artifact store (kept honest: absent when
		// recording was unsupported or the browser died mid-run).
		await collectSessionVideo();
		try {
			await service.dispose();
		} catch {
			// Already gone.
		}
		knownContext = undefined;
	};

	/** Replays cookies, local storage and the last location into a fresh context. */
	const restoreSession = async () => {
		const context = service.context;
		if (!context || context === knownContext) {
			return;
		}
		knownContext = context;

		const saved = bridge.saved;
		if (!saved) {
			return;
		}

		try {
			if (saved.storage?.cookies?.length) {
				await context.addCookies(saved.storage.cookies);
			}
			for (const origin of saved.storage?.origins ?? []) {
				await context.addInitScript(seed => {
					if (location.origin !== seed.origin) {
						return;
					}
					for (const item of seed.items) {
						try {
							localStorage.setItem(item.name, item.value);
						} catch {
							// Storage disabled for this origin.
						}
					}
				}, { origin: origin.origin, items: origin.localStorage ?? [] });
			}

			// Put the agent back where it was, so its next action makes sense.
			const page = currentPage();
			if (saved.url && page) {
				await page.goto(saved.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
			}
			await runStore.commit(session, 'browser', {
				browser: { url: currentPage()?.url(), action: 'restored' }
			});
		} catch {
			// Best effort — a failed restore is no worse than not trying.
		} finally {
			bridge.saved = undefined;
		}
	};


	/*
	 * One isolated Chromium context per run, with synthetic native media and
	 * the selected device profile. Apply options on every relaunch so restoring
	 * an idle mobile run cannot silently turn it into desktop emulation.
	 */
		if (typeof service.ensureContext === 'function') {
			let creatingContext;
			const launchEnv = {}; // RT4: DISPLAY when a virtual screen is used
		service.ensureContext = async () => {
			if (service.context) return service.context;
			if (creatingContext) return creatingContext;
			creatingContext = (async () => {
				const headless = process.env.CLEANSLATE_BROWSER_HEADLESS === undefined
					? service.options?.headless ?? true : process.env.CLEANSLATE_BROWSER_HEADLESS !== 'false';
				// RT4 (#14756): screen-share (getDisplayMedia) is unsupported in
				// headless Chromium regardless of flags. When a virtual display is
				// available (ensureXvfb), launch headful on it so the virtual
				// desktop capture pipeline is REAL (still a virtual screen —
				// labeled honestly, never claimed as physical).
				if (headless && (await ensureXvfb())?.ready) {
					launchEnv.DISPLAY = xvfbDisplay();
				}
				// R3 #14492: a blocked execution plan never launches a browser —
				// the run fails honestly with the unavailable reason instead of
				// silently emulating.
				if (execution.mode === 'blocked') {
					// #14632: the prefix must describe the actual block reason —
					// a NOT SUPPORTED browser (DuckDuckGo) is not a device problem.
					const prefix = execution.browserSupport?.status === 'not_supported'
						? 'NOT SUPPORTED'
						: 'REAL DEVICE UNAVAILABLE';
					const error = new Error(`${prefix}: ${execution.reason ?? 'No runtime is configured for this environment.'}`);
					error.code = 'RUNTIME_UNAVAILABLE';
					throw error;
				}
				// Multi-engine: the session's engine decides the browser type.
				// R3 #14492: with an environment selected, the ENGINE follows the
				// selected BROWSER (Chrome/Edge/Opera/Brave/DDG → Chromium,
				// Firefox → Gecko, Safari → WebKit) — the selected browser is the
				// browser actually executing, never a Chromium relabeled.
				// Chromium keeps synthetic-media args; secondary engines launch
				// plainly (synthetic media is a Chromium-only capability).
				const envEngine = execution.executionEngine;
				const engineId = execution.mode === 'emulated' && envEngine
					? envEngine
					: ENGINE_IDS.includes(session.engine) ? session.engine : 'chromium';
				const engine = await resolveEngine(engineId);
				if (!engine.available) {
					const error = new Error(`ENGINE_UNAVAILABLE: ${engine.reason}`);
					error.code = 'ENGINE_UNAVAILABLE';
					throw error;
				}
				if (execution.mode === 'environment') {
					// Remote real device / desktop via BrowserStack CDP. The
					// capability map comes from the environment snapshot; no
					// local launch, no synthetic media (that is local-only).
					service.browser = await connectBrowserstack(engine.type, execution.connectOptions);
					try {
						service.context = service.browser.contexts()[0] ?? await service.browser.newContext();
						syntheticMedia = false;
						await installNetworkPolicy(service.context);
						// Remote runtime facts: read the genuine UA/viewport from the
						// provider's page — REAL_DEVICE/VIRTUAL_DEVICE facts are never
						// synthesized locally.
						try {
							const probe = await service.context.newPage();
							bridge.runtimeFacts = await probe.evaluate(() => ({
								userAgent: navigator.userAgent,
								viewport: { width: window.innerWidth, height: window.innerHeight },
								devicePixelRatio: window.devicePixelRatio,
								maxTouchPoints: navigator.maxTouchPoints,
								platform: navigator.platform
							}));
							await probe.close().catch(() => {});
						} catch {
							bridge.runtimeFacts = null;
						}
						return service.context;
					} catch (error) {
						await service.browser.close().catch(() => {});
						service.browser = undefined;
						service.context = undefined;
						throw error;
					}
				}
				const launch = { headless };
				if (engine.id === 'chromium') {
					// RT4 (#14756): synthetic media args are supplemented with the
					// auto-select capture source so getDisplayMedia presents the
					// local virtual desktop without an unanswerable picker dialog.
					launch.args = [...SYNTHETIC_MEDIA_ARGS, ...RT4_MEDIA_LAUNCH_ARGS];
					if (launchEnv.DISPLAY) {
						launch.headless = false;
						launch.env = { ...launch.env, DISPLAY: launchEnv.DISPLAY, PATH: process.env.PATH, HOME: process.env.HOME };
					}
					// RT1 (#14680): REAL branded binary first. When the registry
					// verified a genuine Chrome/Brave/Opera binary for this
					// environment's browser, launch THAT — the device profile is
					// emulated around it, but the browser itself is real. An
					// explicit CLEANSLATE_BROWSER_EXECUTABLE override still wins,
					// then the bundled Playwright Chromium.
					const bundledExecutable = engine.type.executablePath();
					const brandedExecutable = execution.brandedExecutablePath ?? null;
					const executablePath = process.env.CLEANSLATE_BROWSER_EXECUTABLE?.trim()
						|| brandedExecutable
						|| bundledExecutable;
					// Launch ourselves because the SDK exposes no argument hook.
					// Native getUserMedia can only receive synthetic devices in this process.
					try {
						service.browser = await engine.type.launch({ ...launch, ...engine.launch, executablePath });
					} catch (error) {
						if (executablePath === bundledExecutable) throw error;
						// A branded binary that fails at launch falls back ONLY to
						// the bundled engine when it was the branded pick, and the
						// failure is recorded in runtime facts — the run never
						// claims the branded browser it did not get.
						if (brandedExecutable && executablePath === brandedExecutable) {
							service.browser = await engine.type.launch({ ...launch, ...engine.launch, executablePath: bundledExecutable });
							bridge.execution = { ...bridge.execution, brandedBinaryLaunchError: String(error?.message ?? error).split('\n')[0] };
						} else {
							throw error;
						}
					}
				} else {
					service.browser = await engine.type.launch({ ...launch, ...engine.launch });
				}
				try {
					// Phase 20: the emulated context applies the environment's
					// real mobile UA on top of the catalog emulation hints, so the
					// site under test receives a genuine mobile request (not
					// desktop Chromium with a resized viewport).
					const contextOptions = {
						...(emulationOptions ?? { viewport: { width: 1440, height: 900 }, acceptDownloads: true }),
						...(emulatedUserAgent ? { userAgent: emulatedUserAgent } : {}),
						...(policy.isProduction ? { serviceWorkers: 'block' } : {})
					};
					// Orientation scenario: landscape swaps the emulation viewport.
					if (orientationScenario === 'landscape' && contextOptions.viewport) {
						contextOptions.viewport = {
							width: Math.max(contextOptions.viewport.width, contextOptions.viewport.height),
							height: Math.min(contextOptions.viewport.width, contextOptions.viewport.height)
						};
					}
					// RT5 (#14757): context-level video recording. Playwright only
					// accepts recordVideo at context creation — the file lands in a
					// temp dir and is collected at context close (suspend/dispose).
					// Playwright may not discover a missing FFmpeg binary until the
					// first page is created. The startup probe below catches that late
					// failure and recreates the context without video before any agent
					// tool runs.
					const localChromium = service.browser.browserType().name() === 'chromium';
					if (!contextOptions.recordVideo
						&& localChromium
						&& !localChromiumVideoUnsupportedReason) {
						contextOptions.recordVideo = { dir: videoDir(), size: contextOptions.viewport ?? undefined };
					}
					const prepared = await createContextWithVideoFallback(service.browser, contextOptions, {
						skipVideoReason: localChromium ? localChromiumVideoUnsupportedReason : null
					});
					service.context = prepared.context;
					if (prepared.fallbackReason) {
						if (localChromium) localChromiumVideoUnsupportedReason ??= prepared.fallbackReason;
						bridge.execution = {
							...bridge.execution,
							videoRecording: 'UNSUPPORTED',
							videoUnsupportedReason: prepared.fallbackReason
						};
					} else if (prepared.videoActive) {
						bridge.execution = { ...(bridge.execution ?? {}), videoRecording: 'ACTIVE' };
					}
					// Permission scenario: allow → grant; deny/ask left to CDP or
					// the natural prompt. Never silently coerced.
					if (permissionScenario && service.context.grantPermissions) {
						const grantable = Object.entries(permissionScenario)
							.filter(([, decision]) => decision === 'allow')
							.map(([name]) => name)
							.filter((name) => runtimeProfile?.chromiumPermissions?.includes(name));
						if (grantable.length) {
							await service.context.grantPermissions(grantable).catch(() => {});
						}
					}
					syntheticMedia = engine.id === 'chromium';
					bridge.execution.launchedEngineId = engine.id;
					await installNetworkPolicy(service.context);
					// Runtime facts: read back what the browser ACTUALLY got —
					// the UA the page sees and the viewport in use — so the run
					// record can store observed truth, not wishful hints.
					try {
						const probe = prepared.probePage;
						bridge.runtimeFacts = await probe.evaluate(() => ({
							userAgent: navigator.userAgent,
							viewport: { width: window.innerWidth, height: window.innerHeight },
							devicePixelRatio: window.devicePixelRatio,
							maxTouchPoints: navigator.maxTouchPoints,
							platform: navigator.platform
						}));
						await probe.close().catch(() => {});
					} catch {
						await prepared.probePage?.close?.().catch(() => {});
						bridge.runtimeFacts = null;
					}
					// RT1 (#14680): record which REAL binary executed. When a
					// branded binary was launch-verified, name it and its
					// detected version — the emulated UA alone does not prove
					// the browser identity, and a launch fallback (bundled
					// engine after a branded-binary failure) is recorded
					// honestly rather than passed off as the brand.
					if (bridge.runtimeFacts) {
						const branded = execution.brandedExecutablePath ?? null;
						bridge.runtimeFacts.brandedBinary = branded ? {
							path: branded,
							brand: environment?.browserCode ?? null,
							detectedVersion: execution.browserSupport?.detectedVersion ?? null,
							fallbackUsed: Boolean(bridge.execution?.brandedBinaryLaunchError)
						} : null;
						bridge.runtimeFacts.executionLevel = bridge.execution?.level ?? null;
						bridge.runtimeFacts.provider = 'local';
					}
					return service.context;
				} catch (error) {
					await service.browser.close().catch(() => {});
					service.browser = undefined;
					service.context = undefined;
					syntheticMedia = false;
					throw error;
				}
			})().finally(() => { creatingContext = undefined; });
			return creatingContext;
		};
	}

	// Every browser tool goes through ensurePage, which is where a relaunched
	// browser is first observable.
	const originalEnsurePage = service.ensurePage.bind(service);
	service.ensurePage = async () => {
		const page = await originalEnsurePage();
		await installNetworkPolicy(service.context);
		await restoreSession();
		return currentPage() ?? page;
	};

	// Lazy facts reader: the context exists only after the first browser tool,
	// so callers (agent) pull facts when they need them instead of caching at
	// turn start. Reads live from the real page — never from catalog hints.
	bridge.readRuntimeFacts = async () => {
		try {
			const page = service.activePage ?? service.context?.pages?.()[0];
			if (page) {
				const facts = await page.evaluate(() => ({
					userAgent: navigator.userAgent,
					viewport: { width: window.innerWidth, height: window.innerHeight },
					devicePixelRatio: window.devicePixelRatio,
					maxTouchPoints: navigator.maxTouchPoints,
					platform: navigator.platform,
					orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait'
				}));
				// RT3 (#14705): orientation changes made through the interaction
				// API are reflected here (the live viewport IS the rotated one).
				if (facts) bridge.runtimeFacts = { ...(bridge.runtimeFacts ?? {}), ...facts };
				return facts;
			}
		} catch {
			// Fall through to the cached context-creation facts.
		}
		return bridge.runtimeFacts ?? null;
	};

	/*
	 * RT3 (#14705): real device-interaction API. Lazy — the interaction api
	 * needs the live context, which exists only after the first browser tool.
	 * Every gesture goes through the driver's real input injection (see
	 * interactionApi.js) and its result carries the inputMethod actually used.
	 */
	bridge.interact = async (action, input = {}) => {
		await service.ensurePage();
		const context = service.context;
		const page = currentPage();
		if (!context || !page) {
			return { success: false, code: 'INTERACTION_UNAVAILABLE', action, error: 'No live browser context yet — open the target page first.' };
		}
		const { createInteractionApi: createApi } = { createInteractionApi };
		bridge.interactionApi ??= createApi({
			context,
			page,
			beforeAction: (verb) => {
				publishCursor(verb, null, input);
			}
		});
		const api = bridge.interactionApi;
		if (action === 'capabilities') return { success: true, action, report: await api.reportCapabilities() };
		const method = {
			tap: input => api.tap(input.target),
			double_tap: input => api.doubleTap(input.target),
			long_press: input => api.longPress(input.target, { durationMs: input.durationMs }),
			swipe: input => api.swipe(input),
			drag_to: input => api.dragTo(input.from, input.to),
			mouse_move: input => api.mouseMove(input.target),
			click: input => api.click(input.target, { button: input.button }),
			double_click: input => api.doubleClick(input.target),
			right_click: input => api.rightClick(input.target),
			type: input => api.type(input.text),
			press_key: input => api.pressKey(input.key),
			scroll: input => api.scroll(input),
			upload: input => api.uploadFiles(input.target, input.files),
			refresh: () => api.refresh(),
			back: () => api.back(),
			rotate: input => api.setOrientation(input.orientation)
		}[action];
		if (!method) {
			return { success: false, code: 'INTERACTION_UNKNOWN_ACTION', action, error: 'Unknown interaction action.' };
		}
		let result;
		try {
			result = await raceAbort(() => method(input));
		} catch (error) {
			const honest = {
				GestureTimeout: 'The gesture did not complete in the interaction budget. Retry once with a fresh snapshot; then report the affected check as not tested with a reason.',
				GestureTargetNotFound: error.message,
				GestureInputError: error.message
			}[error?.name];
			if (honest) return { success: false, code: 'INTERACTION_FAILED', action, error: honest };
			throw error;
		}
		if (action === 'rotate' && result?.status !== 'SKIPPED') {
			// Record the rotation in runtime facts immediately.
			await runStore.commit(session, 'browser_interaction', {
				browserInteraction: { action: 'rotate', requested: input.orientation, applied: result.applied, viewport: result.viewport }
			}).catch(() => {});
		} else if (result?.success) {
			await runStore.commit(session, 'browser_interaction', {
				browserInteraction: { action, inputMethod: result.inputMethod, point: result.point ?? null }
			}).catch(() => {});
		}
		return result;
	};

	bridge.media = async (input = {}) => {
		const actions = ['inspect', 'set_permission', 'probe', 'probe_camera', 'probe_screen_share', 'call_controls', 'meeting_controls', 'meeting_recovery'];
		if (!actions.includes(input.action)) return { success: false, error: `Choose one of: ${actions.join(', ')}.` };
		if (input.action === 'set_permission' && !['granted', 'denied', 'prompt'].includes(input.permission)) return { success: false, error: 'Choose granted, denied or prompt permission.' };
		if (input.action === 'set_permission' && input.target && !['microphone', 'camera', 'screen_capture'].includes(input.target)) return { success: false, error: 'target must be microphone, camera or screen_capture.' };
		await service.ensurePage();
		const page = currentPage();
		const decision = await policy.evaluateNavigation(page.url());
		if (!decision.allowed) return policy.asBlockedResult(decision);
		try {
			// RT4 (#14756): capability is per-ENGINE truth, not a launch flag.
			// Non-Chromium engines report UNAVAILABLE with a verbatim reason —
			// never a simulated pass, never a silent skip.
			const engineId = bridge.execution?.launchedEngineId ?? bridge.execution?.executionEngine ?? 'chromium';
			const capability = syntheticMediaCapability(engineId);
			const mediaActions = ['probe', 'probe_camera', 'probe_screen_share', 'set_permission'];
			if (!capability.available && mediaActions.includes(input.action)) {
				const result = {
					success: true,
					action: input.action,
					synthetic: false,
					origin: new URL(page.url()).origin,
					capability: 'UNAVAILABLE',
					reason: capability.reason,
					limitations: 'Synthetic browser capture is Chromium-only in this runtime; this engine cannot execute the media workflow. Recorded as a coverage gap — never as a pass.'
				};
				await runStore.commit(session, 'browser_media', { browserMedia: result });
				return result;
			}
			if (input.action === 'set_permission') {
				await setMediaPermission(service.context, page, input.permission, input.target ?? 'microphone');
			}
			const before = await inspectMedia(page);
			const result = { success: true, synthetic: true, action: input.action, origin: new URL(page.url()).origin, permission: before.permission };
			if (input.action === 'probe') {
				if (before.permission === 'prompt') return { ...result, success: false, code: 'BROWSER_MICROPHONE_PERMISSION_REQUIRED', error: 'Set microphone permission to granted or denied before probing; browser permission prompts are not DOM dialogs.' };
				result.probe = await probeMicrophone(page, input.durationMs);
				result.verdict = mediaProbeVerdict(result.probe, capability);
			}
			if (input.action === 'probe_camera') {
				if (before.cameraPermission === 'prompt') return { ...result, success: false, code: 'BROWSER_CAMERA_PERMISSION_REQUIRED', error: 'Set camera permission (target camera) to granted or denied before probing; browser permission prompts are not DOM dialogs.' };
				result.probe = await probeCamera(page, { durationMs: input.durationMs });
				result.verdict = mediaProbeVerdict(result.probe, capability);
				result.limitations = 'Synthetic Chromium camera device only — a real frame pipeline is verified, but this is not physical camera hardware.';
			}
			if (input.action === 'probe_screen_share') {
				result.probe = await probeScreenShare(page, { durationMs: input.durationMs });
				result.verdict = mediaProbeVerdict(result.probe, capability);
				result.limitations = 'Virtual desktop capture (Chromium auto-select over the local Xvfb screen) — a real frame pipeline is verified, but this is never a physical monitor capture.';
			}
			if (input.action === 'call_controls') {
				result.callControls = await inspectCallControls(page);
				result.limitations = 'Reads the application-owned stream state on the page — mute/unmute/camera toggles must be exercised through the app UI to change it.';
			}
			if (input.action === 'meeting_controls') {
				result.meeting = await exerciseMeetingControls(page, { joinSelector: input.joinSelector, controls: input.controls });
				result.limitations = result.meeting.limitations;
			}
			if (input.action === 'meeting_recovery') {
				// Real permission transition: the same CDP path the production
				// set_permission action uses, driven through deny → request →
				// grant → retry against the page's own media request control.
				const permissionSetter = async (setting) => {
					for (const target of (Array.isArray(input.targets) && input.targets.length ? input.targets : ['camera', 'microphone'])) {
						await setMediaPermission(service.context, page, setting, target);
					}
				};
				result.recovery = await verifyPermissionRecovery(page, permissionSetter, {
					requestSelector: input.requestSelector,
					targets: Array.isArray(input.targets) && input.targets.length ? input.targets : ['camera', 'microphone']
				});
				result.limitations = 'Denial and re-grant were applied through the browser permission layer (CDP); the page\'s own controls decided whether the call actually recovers — NOT_RECOVERED is a genuine page defect.';
			}
			result.observed = await inspectMedia(page);
			if (!result.limitations) {
				result.limitations = 'Synthetic browser capture only. A successful probe does not prove the application used its microphone, transmitted audio, or reached another participant. Inspect application requests and UI mute/stop behavior separately.';
			}
			await runStore.commit(session, 'browser_media', { browserMedia: result });
			return result;
		} catch (error) {
			return { success: false, synthetic: true, code: 'BROWSER_MEDIA_CHECK_FAILED', error: `Media check could not complete (${error.name || 'Error'}). Inspect browser diagnostics and retry after the page settles.` };
		}
	};

	bridge.testMeetingLink = async (input = {}) => {
		await service.ensurePage();
		const page = currentPage();
		let link;
		try {
			const locator = input.selector ? page.locator(input.selector) : page.locator('a[href]');
			const matches = await locator.evaluateAll((nodes, expected) => nodes
				.filter(node => node.tagName === 'A' && node.getClientRects().length && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && (!expected || node.href === expected))
				.map(node => ({ url: node.href, text: (node.innerText || '').trim().slice(0, 160) })), input.url ?? null);
			if (matches.length !== 1) return { success: false, code: 'BROWSER_MEETING_LINK_NOT_UNIQUE', error: 'Select one visible meeting anchor from the current page snapshot, or provide its exact href.' };
			link = matches[0];
		} catch {
			return { success: false, code: 'BROWSER_MEETING_LINK_NOT_FOUND', error: 'The meeting link could not be resolved from the current page.' };
		}
		const decision = await policy.allowObservedMeetingLink(link.url, page.url());
		if (!decision.allowed) return policy.asBlockedResult(decision);
		const sourceTabId = service.idFor?.(page);
		try {
			const opened = await service.newTab('ide', { url: link.url });
			if (opened.success === false) return opened;
			const destination = new URL(currentPage().url());
			const result = {
				success: true, action: 'meeting_link_prejoin', sourceTabId, tabId: opened.tabId,
				url: `${destination.origin}${destination.pathname}`, title: opened.title,
				joined: false, synthetic: syntheticMedia,
				limitations: 'Only the observed link and landing page were opened. Inspect the snapshot for invalid/expired links, authentication, lobby and media UI; navigation success alone is not a meeting pass.'
			};
			await runStore.commit(session, 'browser_meeting', { browserMeeting: result });
			return result;
		} catch (error) {
			return { success: false, code: 'BROWSER_MEETING_NAVIGATION_FAILED', error: `The observed meeting link could not load (${error.name || 'Error'}). Check diagnostics; do not report a meeting pass.` };
		}
	};

	const viewportOf = page => page?.viewportSize() ?? { width: 1440, height: 900 };

	/**
	 * Host-driven security suite (ticket #12959). Runs deterministic checks
	 * against the current page: response headers + cookies from live state, XSS
	 * reflection through the page's own forms (benign canary), SQL error
	 * signatures after a benign quote payload, mixed content from diagnostics.
	 * The network policy stays in charge of destinations — probes use the
	 * page's own form and URL, never a new origin.
	 */
	bridge.runSecurityChecks = async ({ checks } = {}) => {
		await service.ensurePage();
		const page = currentPage();
		const pageUrl = page.url();
		const decision = await policy.evaluateNavigation(pageUrl);
		if (!decision.allowed) return policy.asBlockedResult(decision);

		const wanted = new Set(Array.isArray(checks) && checks.length ? checks : SECURITY_CHECK_IDS);
		const results = [];

		// Main-document response + cookies from live browser state.
		let mainResponse;
		try {
			const response = await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });
			mainResponse = response ?? undefined;
		} catch { /* keep whatever state we had */ }
		const headerObject = {};
		for (const [key, value] of (mainResponse?.headers?.() ? Object.entries(mainResponse.headers()) : [])) {
			headerObject[key] = value;
		}
		if (wanted.has('csp') || wanted.has('hsts') || wanted.has('x_frame_options')
			|| wanted.has('x_content_type_options') || wanted.has('referrer_policy')) {
			results.push(...checkResponseHeaders({
				url: pageUrl,
				status: mainResponse?.status?.(),
				headers: headerObject
			}).filter(result => wanted.has(result.id)));
		}
		if (wanted.has('cookie_flags')) {
			let cookies = [];
			try { cookies = await service.context.cookies(pageUrl); } catch { /* page may have navigated */ }
			const documentCookie = await page.evaluate(() => document.cookie).catch(() => '');
			results.push(...checkCookies({ url: pageUrl, cookies, documentCookie }));
		}

		// XSS reflection: submit the canary through the page's own search-like form.
		if (wanted.has('xss_reflection')) {
			const probeUrl = await submitCanaryThroughForms(page, XSS_CANARY);
			if (probeUrl) {
				const reflection = await inspectReflection(page, XSS_CANARY);
				results.push(checkXssReflection({ url: probeUrl, ...reflection }));
			} else {
				results.push({
					id: 'xss_reflection', title: 'xss_reflection', category: 'security', severity: 'info',
					status: 'info', url: pageUrl,
					evidence: 'No text input form found to submit the reflection canary.',
					remediation: undefined
				});
			}
		}

		// SQL error signatures: benign quote payload through the same forms.
		if (wanted.has('sqli_error_signature')) {
			const quoteUrl = await submitCanaryThroughForms(page, "'\" --qase");
			if (quoteUrl) {
				const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200_000) ?? '').catch(() => '');
				results.push(checkSqlErrorSignature({ url: quoteUrl, responseText: bodyText }));
			} else {
				results.push({
					id: 'sqli_error_signature', title: 'sqli_error_signature', category: 'security', severity: 'info',
					status: 'info', url: pageUrl,
					evidence: 'No text input form found to submit the benign quote payload.',
					remediation: undefined
				});
			}
		}

		// Mixed content from the diagnostics the page already produced.
		if (wanted.has('mixed_content')) {
			const diagnostics = await service.getDiagnostics('ide', {}).catch(() => undefined);
			const requests = (diagnostics?.network ?? []).map(entry => ({ url: entry.url }));
			results.push(...checkMixedContent({ url: pageUrl, requests }));
		}

		const report = {
			success: true,
			url: pageUrl,
			checkedAt: Date.now(),
			results,
			limitations: 'Benign, deterministic checks only: header presence, cookie flags, reflection escaping, database error signatures, mixed content. No destructive or time-based payloads; absence of findings is not a full penetration test.'
		};
		await runStore.commit(session, 'security', { securityReport: report });
		return report;
	};

	/**
	 * Where the action is about to land, in viewport coordinates. Falls back to
	 * null rather than guessing: a missing highlight is better than a wrong one.
	 */
	const resolveTarget = async input => {
		const page = currentPage();
		if (!page || !input || typeof input !== 'object') {
			return undefined;
		}
		if (typeof input.x === 'number' && typeof input.y === 'number') {
			return { x: input.x, y: input.y };
		}
		if (!service.hasLocator?.(input)) {
			return undefined;
		}
		try {
			const locator = await service.locator(page, input);
			const box = await locator.first().boundingBox({ timeout: 1500 });
			if (!box) {
				return undefined;
			}
			return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
		} catch {
			// Ambiguous, detached or off-screen — the action itself will report it.
			return undefined;
		}
	};

	const describe = input => {
		if (!input || typeof input !== 'object') {
			return undefined;
		}
		return input.name || input.text || input.label || input.placeholder ||
			input.testId || input.selector || input.role || input.elementId;
	};

	const readElementDescriptor = async locator => locator.first().evaluate(element => ({
		text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
		ariaLabel: element.getAttribute('aria-label') || undefined,
		title: element.getAttribute('title') || undefined,
		name: element.getAttribute('name') || undefined,
		testId: element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy') || undefined,
		id: element.id || undefined,
		className: typeof element.className === 'string' ? element.className.slice(0, 160) : undefined,
		role: element.getAttribute('role') || undefined,
		tagName: element.tagName?.toLowerCase(),
		type: element.getAttribute('type') || undefined,
		destination: element.href || element.formAction || element.form?.action || undefined
	}));

	/** Reads only labels/attributes — never a field value or typed secret. */
	const resolveActionDescriptor = async input => {
		const page = currentPage();
		const descriptor = {
			url: page?.url() ?? session.targetUrl,
			label: describe(input),
			selector: input?.selector,
			testId: input?.testId,
			name: input?.name,
			key: input?.key
		};
		if (!page) return descriptor;
		try {
			if (input && service.hasLocator?.(input)) {
				return { ...descriptor, ...await readElementDescriptor(await service.locator(page, input)) };
			}
			if (typeof input?.x === 'number' && typeof input?.y === 'number') {
				const located = await page.locator(`body`).evaluate((_body, point) => {
					const hit = document.elementFromPoint(point.x, point.y);
					const element = hit?.closest?.('button, a, input, select, textarea, [role], [tabindex]') ?? hit;
					if (!element) return undefined;
					return {
						text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
						ariaLabel: element.getAttribute('aria-label') || undefined,
						title: element.getAttribute('title') || undefined,
						name: element.getAttribute('name') || undefined,
						testId: element.getAttribute('data-testid') || undefined,
						id: element.id || undefined,
						className: typeof element.className === 'string' ? element.className.slice(0, 160) : undefined,
						role: element.getAttribute('role') || undefined,
						tagName: element.tagName?.toLowerCase(),
						type: element.getAttribute('type') || undefined,
						destination: element.href || element.formAction || element.form?.action || undefined
					};
				}, { x: input.x, y: input.y });
				return { ...descriptor, ...located };
			}
			const focused = page.locator(':focus');
			if (await focused.count() > 0) {
				return { ...descriptor, ...await readElementDescriptor(focused) };
			}
		} catch {
			// The explicit input description still provides a useful policy label.
		}
		return descriptor;
	};

	const publishCursor = (verb, target, input) => {
		const page = currentPage();
		runStore.publish(session, 'cursor', {
			cursor: {
				verb,
				x: target?.x,
				y: target?.y,
				box: target?.box,
				label: describe(input),
				viewport: viewportOf(page)
			}
		});
	};

	/**
	 * Waits for a click to actually land somewhere.
	 *
	 * Playwright's click resolves the moment the event is dispatched, so a
	 * client-side router has not run yet and the URL read straight afterwards is
	 * still the old one. Without this the agent clicks a working link, reads the
	 * unchanged URL, and reports a navigation bug that does not exist.
	 */
	const settleNavigation = async (page, urlBefore, pagesBefore = []) => {
		const deadline = Date.now() + NAV_SETTLE_MS;
		while (Date.now() < deadline) {
			for (const candidate of [...(service.context?.pages?.() ?? [])].reverse()) {
				if (pagesBefore.includes(candidate) || candidate.isClosed() || await candidate.opener?.() !== page) continue;
				if (/^about:/.test(candidate.url())) continue;
				await candidate.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined);
				const decision = await policy.evaluateNavigation(candidate.url());
				if (decision.allowed) {
					service.registerPage?.(candidate);
					service.activePage = candidate;
					return candidate;
				}
			}
			if (page.isClosed()) {
				return currentPage();
			}
			if (page.url() !== urlBefore) {
				// It moved — let the new document get far enough to be readable.
				await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined);
				return page;
			}
			await sleep(100);
		}
		return page;
	};

	/**
	 * Wraps one interaction: telegraph the move, act, then flash the hit.
	 * Everything about the visualisation is best-effort — a bridge that throws
	 * would break a test run over a cosmetic concern.
	 */
	const wrap = (method, { verb, settle, navigates }) => {
		const original = service[method]?.bind(service);
		if (!original) {
			return;
		}
		service[method] = async (surface, input) => {
			await service.ensurePage();
			let target;
			const page = currentPage();
			const pagesBefore = service.context?.pages?.() ?? [];
			const urlBefore = page?.url();
			let clickLocator;
			// Resolve presence and uniqueness before descriptor enrichment. Reading an
			// element descriptor also auto-waits, so doing that first would retain the
			// driver's 30-second missing-selector stall that this preflight replaces.
			if (method === 'click' && page && input && service.hasLocator?.(input)) {
				try {
					clickLocator = await service.locator(page, input);
					await clickLocator.first().waitFor({ state: 'visible', timeout: 2_500 });
				} catch (error) {
					if (error?.name === 'TimeoutError' || /timed?\s*out/i.test(String(error?.message ?? ''))) {
						return { success: false, code: 'BROWSER_TARGET_NOT_FOUND', matches: 0, error: 'No visible element matched this locator within 2.5 seconds. Take one fresh snapshot and try one different verified locator; then record the blocker and continue.' };
					}
					return { success: false, code: 'BROWSER_TARGET_NOT_ACTIONABLE', error: `The browser could not evaluate this locator (${error?.name || 'LocatorError'}). Take one fresh snapshot and use a valid unique locator; then record the blocker and continue.` };
				}
				try {
					const matches = await clickLocator.count();
					if (matches > 1) {
						return { success: false, code: 'BROWSER_TARGET_AMBIGUOUS', matches, error: `${matches} visible elements match this locator. Use a unique selector from a fresh snapshot; do not retry the same ambiguous locator.` };
					}
				} catch (error) {
					return { success: false, code: 'BROWSER_TARGET_NOT_ACTIONABLE', error: `The browser could not evaluate this locator (${error?.name || 'LocatorError'}). Take one fresh snapshot and use a valid unique locator; then record the blocker and continue.` };
				}
			}
			const descriptor = await resolveActionDescriptor(input);
			const canSubmit = method === 'click' ||
				(method === 'pressKey' && /^(?:Enter|NumpadEnter|Space)$/i.test(String(input?.key ?? '')));
			if (navigates && canSubmit && descriptor.destination) {
				const navigation = await policy.evaluateNavigation(descriptor.destination);
				if (!navigation.allowed) {
					recordSecurityBlock(navigation, { topLevel: true, method });
					return policy.asBlockedResult(navigation);
				}
			}
			// Mechanical no-repeat guard. Prompt-level "do not redo"
			// instructions are advisory; a recovery turn that re-plans from
			// scratch could re-send a message or re-purchase. Every executed
			// destructive action is ledgered by category + target, and an
			// identical re-execution in the same session is refused with a
			// verify-instead instruction. Checked against the PERSISTED ledger
			// (session record) BEFORE the policy grant: a fresh bridge after a
			// crash-restart has no grant left, so the policy would otherwise
			// demand a new confirmation — and a "yes" there would re-execute.
			const ledgerRisk = classifyDestructiveAction(method, descriptor);
			if (ledgerRisk) {
				const ledgerKey = `${ledgerRisk.category}::${String(descriptor.text ?? descriptor.ariaLabel ?? descriptor.label ?? descriptor.name ?? descriptor.destination ?? input?.text ?? input?.selector ?? '')}`.slice(0, 300).toLowerCase();
				if (bridge.destructiveLedger.has(ledgerKey)) {
					return {
						success: false,
						code: 'ACTION_ALREADY_EXECUTED',
						error: `This destructive ${ledgerRisk.category} action was already executed in this session. Do NOT repeat it. Verify the result instead (snapshot, URL, or confirmation state), then continue the assessment.`
					};
				}
				bridge.pendingLedgerKey = ledgerKey;
			}
			const authorization = policy.authorizeAction(method, descriptor, session.messages);
			if (!authorization.allowed) {
				recordSecurityBlock(authorization, { method });
				return policy.asBlockedResult(authorization);
			}
			if (authorization.confirmationUsed && bridge.pendingLedgerKey) {
				// Mirror the ledger into the session record so it survives a
				// crash-restart: the bridge is rebuilt by ensureRuntime on
				// resume, but the recovered turn must still see what was
				// already executed. Bounded: the Set guard above prevents
				// duplicates, and the 300-char key cap bounds each entry.
				bridge.destructiveLedger.add(bridge.pendingLedgerKey);
				if (!Array.isArray(session.executedDestructiveActions)) session.executedDestructiveActions = [];
				if (!session.executedDestructiveActions.includes(bridge.pendingLedgerKey)) {
					session.executedDestructiveActions.push(bridge.pendingLedgerKey);
					void runStore.commit(session, 'browser', {
						browser: { action: 'destructive_executed', category: ledgerRisk.category }
					}).catch(() => undefined);
				}
			}
			bridge.pendingLedgerKey = undefined;
			const securityMarker = bridge.securityBlocks.length;

			// Fail deterministic locator problems before Playwright spends its full
			// action timeout retrying. The model gets a precise recovery instruction
			// and can continue the assessment instead of circling the same overlay.
			if (clickLocator) {
				try {
					await clickLocator.click({ trial: true, timeout: 2_500 });
				} catch (error) {
					if (/intercept(?:s|ing)? pointer events|another element.*receives|obscur|overlay/i.test(String(error?.message ?? ''))) {
						return { success: false, code: 'BROWSER_TARGET_OBSCURED', error: `The target is not actionable because an overlay or another element is intercepting it. Close the visible overlay using a unique control, or record the blocker and continue. (${error?.name || 'ActionabilityError'})` };
					}
					return { success: false, code: 'BROWSER_TARGET_NOT_ACTIONABLE', error: `The target is visible but not currently actionable (${error?.name || 'ActionabilityError'}). Inspect its disabled or unstable state once, then record the blocker and continue.` };
				}
			}

			try {
				target = await resolveTarget(input);
				publishCursor(verb, target, input);
				if (target) {
					await sleep(CURSOR_DWELL_MS);
				}
			} catch {
				// Fall through to the real action.
			}

			let result;
			try {
				result = await raceAbort(original(surface, input));
			} catch (error) {
				const navigationBlock = bridge.securityBlocks.slice(securityMarker).find(entry => entry.topLevel);
				if (navigationBlock) {
					return policy.asBlockedResult({
						allowed: false,
						code: navigationBlock.code,
						message: navigationBlock.message
					});
				}
				throw error;
			}

			try {
				publishCursor(`${verb}:done`, target, input);
				if (settle) {
					await sleep(settle);
				}
				// Correct the reported location once the page has caught up, so
				// the model judges the click on where it actually ended up.
				if (navigates && page && urlBefore !== undefined) {
					const landed = await settleNavigation(page, urlBefore, pagesBefore);
					if (landed && !landed.isClosed()) {
						result.url = landed.url();
						result.title = await landed.title().catch(() => result.title);
						result.navigated = result.url !== urlBefore || landed !== page;
						if (landed !== page) {
							result.openedTab = true;
							result.tabId = service.idFor?.(landed);
						}
					}
				}
			} catch {
				// Ignore.
			}
			const navigationBlock = bridge.securityBlocks.slice(securityMarker).find(entry => entry.topLevel);
			if (navigationBlock) {
				return policy.asBlockedResult({
					allowed: false,
					code: navigationBlock.code,
					message: navigationBlock.message
				});
			}
			return result;
		};
	};

	for (const [method, options] of Object.entries(POINTER_ACTIONS)) {
		wrap(method, options);
	}

	/*
	 * browser_wait clamp. The SDK schema promises "capped at 30000" for both
	 * ms and timeoutMs but the driver passes them straight to Playwright, so a
	 * model-supplied oversized value stalls the run indefinitely. Enforce the
	 * documented bound here, where every implementation detail is visible.
	 */
	const originalWait = service.wait?.bind(service);
	if (originalWait) {
		const clampWaitInput = input => {
			if (!input || typeof input !== 'object') return input;
			const clamped = { ...input };
			if (clamped.ms !== undefined) clamped.ms = Math.max(0, Math.min(30_000, Number(clamped.ms) || 0));
			if (clamped.timeoutMs !== undefined) clamped.timeoutMs = Math.max(0, Math.min(30_000, Number(clamped.timeoutMs) || 0));
			return clamped;
		};
		service.wait = (surface, input) => originalWait(surface, clampWaitInput(input));
	}

	// Credential placeholders become real values here, at the last moment before
	// the keystrokes reach the page, and never anywhere the model can observe.
	const originalFill = service.fill.bind(service);
	service.fill = async (surface, input) => {
		if (hasUnresolvedPlaceholder(session.id, input?.value)) {
			return {
				success: false,
				error: `No stored credential matches the placeholder in that value. Ask the user with ask_question before filling this field.`
			};
		}
		return originalFill(surface, { ...input, value: resolveSecrets(session.id, input?.value ?? '') });
	};

	const originalType = service.typeText.bind(service);
	service.typeText = async (surface, text) => {
		if (hasUnresolvedPlaceholder(session.id, text)) {
			return {
				success: false,
				error: `No stored credential matches the placeholder in that text. Ask the user with ask_question first.`
			};
		}
		const descriptor = await resolveActionDescriptor();
		// Same mechanical no-repeat guard as wrap(): the ledger check precedes
		// the policy gate so a post-restart approval cannot re-execute a
		// destructive action taken via typed text.
		const ledgerRisk = classifyDestructiveAction('typeText', descriptor);
		if (ledgerRisk) {
			const ledgerKey = `typeText::${String(descriptor.text ?? descriptor.ariaLabel ?? descriptor.label ?? descriptor.name ?? '')}`.slice(0, 300).toLowerCase();
			if (bridge.destructiveLedger.has(ledgerKey)) {
				return {
					success: false,
					code: 'ACTION_ALREADY_EXECUTED',
					error: `This destructive ${ledgerRisk.category} action was already executed in this session. Do NOT repeat it. Verify the result instead (snapshot, URL, or confirmation state), then continue the assessment.`
				};
			}
			const authorization = policy.authorizeAction('typeText', descriptor, session.messages);
			if (!authorization.allowed) {
				recordSecurityBlock(authorization, { method: 'typeText' });
				return policy.asBlockedResult(authorization);
			}
			if (authorization.confirmationUsed) {
				bridge.destructiveLedger.add(ledgerKey);
				if (!Array.isArray(session.executedDestructiveActions)) session.executedDestructiveActions = [];
				if (!session.executedDestructiveActions.includes(ledgerKey)) {
					session.executedDestructiveActions.push(ledgerKey);
					void runStore.commit(session, 'browser', {
						browser: { action: 'destructive_executed', category: ledgerRisk.category }
					}).catch(() => undefined);
				}
			}
		}
		return originalType(surface, resolveSecrets(session.id, text));
	};

	// Navigation is worth showing even though no pointer is involved.
	for (const method of ['open', 'openInAgentManager', 'navigateBack', 'navigateForward', 'reload', 'newTab']) {
		const original = service[method]?.bind(service);
		if (!original) {
			continue;
		}
		service[method] = async (...args) => {
			const requestedUrl = method === 'newTab' ? args[1]?.url :
				(method === 'open' || method === 'openInAgentManager' ? args[0] : undefined);
			if (requestedUrl) {
				const decision = await policy.evaluateNavigation(requestedUrl);
				if (!decision.allowed) {
					recordSecurityBlock(decision, { topLevel: true, method });
					return policy.asBlockedResult(decision);
				}
			}
			// newTab otherwise creates its context directly, bypassing ensurePage.
			if (method === 'newTab') await service.ensurePage();
			const securityMarker = bridge.securityBlocks.length;
			let result;
			try {
				result = await original(...args);
			} catch (error) {
				const navigationBlock = bridge.securityBlocks.slice(securityMarker).find(entry => entry.topLevel);
				if (navigationBlock) {
					return policy.asBlockedResult({
						allowed: false,
						code: navigationBlock.code,
						message: navigationBlock.message
					});
				}
				throw error;
			}
			const navigationBlock = bridge.securityBlocks.slice(securityMarker).find(entry => entry.topLevel);
			if (navigationBlock) {
				return policy.asBlockedResult({
					allowed: false,
					code: navigationBlock.code,
					message: navigationBlock.message
				});
			}
			await runStore.commit(session, 'browser', {
				browser: { url: result?.url, title: result?.title, loading: result?.loading, action: method }
			});
			startFrames();
			return result;
		};
	}

	// Make policy-enforced network failures distinguishable from defects in the
	// target application. Otherwise the agent could report a broken asset when
	// Qase deliberately blocked that asset from reaching a private address.
	const originalDiagnostics = service.getDiagnostics?.bind(service);
	if (originalDiagnostics) {
		// getDiagnostics reaches into the live page (state(), plus the form and
		// mobile audits below). A dead renderer wedges page.title() forever, so
		// bound the whole operation like every other browser call.
		service.getDiagnostics = (surface, diagnosticOptions = {}) =>
			withBrowserOperationTimeout(async () => {
				const result = await originalDiagnostics(surface, diagnosticOptions);
				const securityBlocks = bridge.securityBlocks.map(entry => ({ ...entry }));
				if (diagnosticOptions.clear) bridge.securityBlocks.length = 0;
				// A live mobile/tablet run gets a bounded DOM-only audit attached so the
				// agent sees viewport-meta, overflow, and tap-target evidence alongside
				// console/network. Desktop runs skip the audit entirely.
				let mobileAudit;
				if (deviceProfile?.kind && deviceProfile.kind !== 'desktop') {
					mobileAudit = await runMobileAudit(currentPage());
				}
				const formValidation = await inspectFormValidation(currentPage());
				return { ...result, securityBlocks, ...(mobileAudit ? { mobileAudit } : {}), ...(formValidation ? { formValidation } : {}) };
			}, SNAPSHOT_TIMEOUT_MS, 'browser_diagnostics');
	}

	const sameFrame = (left, right) => Boolean(left && right &&
		left.base64 === right.base64 &&
		left.mimeType === right.mimeType &&
		left.url === right.url &&
		left.title === right.title &&
		left.loading === right.loading &&
		left.viewport?.width === right.viewport?.width &&
		left.viewport?.height === right.viewport?.height);

	/**
	 * Captures one JPEG of the live page and pushes it to whoever is watching.
	 *
	 * Screenshot work may take longer than the frame interval on a busy worker.
	 * Sharing the in-flight promise prevents the timer from building an
	 * unbounded screenshot backlog. Identical frames are retained locally but
	 * not republished, since replaying the same JPEG cannot change the preview.
	 */
	const captureFrame = () => {
		if (bridge.frameCapture) return bridge.frameCapture;
		const page = currentPage();
		if (!page || bridge.disposed) return Promise.resolve();

		bridge.frameCapture = (async () => {
			try {
				const shot = await service.screenshot('ide', { quality: FRAME_QUALITY });
				if (bridge.disposed) return;
				const frame = {
					base64: shot.base64,
					mimeType: shot.mimeType,
					url: shot.url,
					title: shot.title,
					loading: shot.loading,
					viewport: viewportOf(page),
					ts: Date.now()
				};
				if (sameFrame(bridge.lastFrame, frame)) return;
				bridge.lastFrame = frame;
				runStore.publish(session, 'frame', { frame });
			} catch {
				// A screenshot taken across a navigation throws; the next tick recovers.
			}
		})().finally(() => {
			bridge.frameCapture = undefined;
		});
		return bridge.frameCapture;
	};

	function startFrames() {
		if (bridge.frameTimer || bridge.disposed) {
			return;
		}
		void captureFrame();
		bridge.frameTimer = setInterval(() => {
			// Once a run pauses or finishes, keep one final frame and then stop
			// spending browser CPU until it resumes. The timer remains inexpensive
			// so resuming a run does not require a separate lifecycle signal.
			const active = !session.status || session.status === 'running';
			if (active) {
				bridge.capturedInactiveFrame = false;
				void captureFrame();
			} else if (!bridge.capturedInactiveFrame) {
				bridge.capturedInactiveFrame = true;
				void captureFrame();
			}
		}, FRAME_INTERVAL_MS);
		bridge.frameTimer.unref?.();
	}

	function stopFrames() {
		clearInterval(bridge.frameTimer);
		bridge.frameTimer = undefined;
		bridge.capturedInactiveFrame = false;
	}

	bridge.startFrames = startFrames;
	bridge.stopFrames = stopFrames;
	bridge.captureFrame = captureFrame;
	bridge.getLastFrame = () => bridge.lastFrame;
	bridge.getSecurityBlocks = () => [...bridge.securityBlocks];
	bridge.hasPage = () => Boolean(currentPage());
	bridge.dispose = () => {
		bridge.disposed = true;
		stopFrames();
	};

	return bridge;
}
