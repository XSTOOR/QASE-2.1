import { hasUnresolvedPlaceholder, resolveSecrets } from './secrets.js';
import { createBrowserPolicy } from './browserPolicy.js';
import { contextOptionsFor, getDeviceProfile, DEFAULT_DEVICE_ID } from './deviceProfiles.js';
import { runMobileAudit } from './mobileAudit.js';

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

export function attachBrowserBridge(session, service, runStore, options = {}) {
	const policy = options.policy ?? createBrowserPolicy({ getTargetUrl: () => session.targetUrl });
	const deviceId = options.device ?? session.device ?? DEFAULT_DEVICE_ID;
	const deviceLandscape = options.deviceLandscape ?? session.deviceLandscape === true;
	const deviceProfile = getDeviceProfile(deviceId);
	const emulationOptions = contextOptionsFor(deviceId, { landscape: deviceLandscape });
	const bridge = {
		service,
		frameTimer: undefined,
		frameCapture: undefined,
		capturedInactiveFrame: false,
		subscribers: 0,
		lastFrame: undefined,
		securityBlocks: [],
		disposed: false
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
	service.snapshot = async (surface, options) => {
		const snapshot = await originalSnapshot(surface, options);
		const page = currentPage();
		if (!page || !Array.isArray(snapshot.elements)) {
			return snapshot;
		}

		try {
			// The same node list the snapshot enumerated, in the same order, so
			// an element's `eN` id indexes straight into these paths.
			const paths = await page.locator('body *:visible').evaluateAll(nodes => nodes.map(node => {
				if (node.id) {
					return `#${CSS.escape(node.id)}`;
				}
				const testId = node.getAttribute('data-testid') ?? node.getAttribute('data-test') ?? node.getAttribute('data-cy');
				if (testId) {
					return `[data-testid="${CSS.escape(testId)}"]`;
				}

				const steps = [];
				for (let element = node; element && element.nodeType === 1 && element.tagName !== 'HTML'; element = element.parentElement) {
					const tag = element.tagName.toLowerCase();
					if (element.id) {
						steps.unshift(`#${CSS.escape(element.id)}`);
						break;
					}
					const siblings = [...(element.parentElement?.children ?? [])]
						.filter(sibling => sibling.tagName === element.tagName);
					steps.unshift(siblings.length > 1
						? `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`
						: tag);
				}
				return steps.join(' > ');
			}));

			for (const element of snapshot.elements) {
				const index = Number(String(element.id ?? '').slice(1)) - 1;
				const path = paths[index];
				if (path) {
					element.selector = path;
				}
			}
		} catch {
			// A snapshot with the SDK's selectors beats no snapshot at all.
		}

		return snapshot;
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
	 * Real device emulation, not viewport resize.
	 *
	 * The CleanSlate SDK's ensureContext() launches Chromium and calls
	 * newContext({ viewport: 1440×900 }). When the run's device profile is a
	 * phone or tablet, we intercept immediately after that call: dispose the
	 * default context and re-create it on the same Browser with the profile's
	 * User-Agent, viewport, deviceScaleFactor, isMobile and hasTouch. The site
	 * under test therefore receives a genuine mobile request and touch input
	 * capability — not a resized desktop window.
	 */
	if (emulationOptions && typeof service.ensureContext === 'function') {
		const originalEnsureContext = service.ensureContext.bind(service);
		let emulationApplied = false;
		service.ensureContext = async () => {
			const context = await originalEnsureContext();
			if (emulationApplied || !service.browser) {
				return service.context ?? context;
			}
			if (context.pages().length === 0) {
				try {
					await context.close();
				} catch {
					// Falls back to overlaying options on the existing context.
				}
				try {
					const emulated = await service.browser.newContext(emulationOptions);
					service.context = emulated;
					emulationApplied = true;
					return emulated;
				} catch (error) {
					// If Playwright rejects the descriptor for any reason, keep the
					// SDK's default context rather than leaving the run without one.
					try {
						service.context = await service.browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
					} catch {}
					emulationApplied = true;
					return service.context ?? context;
				}
			}
			emulationApplied = true;
			return context;
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

	const viewportOf = page => page?.viewportSize() ?? { width: 1440, height: 900 };

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
	const settleNavigation = async (page, urlBefore) => {
		const deadline = Date.now() + NAV_SETTLE_MS;
		while (Date.now() < deadline) {
			if (page.isClosed()) {
				return;
			}
			if (page.url() !== urlBefore) {
				// It moved — let the new document get far enough to be readable.
				await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => undefined);
				return;
			}
			await sleep(100);
		}
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
			let target;
			const page = currentPage();
			const urlBefore = page?.url();
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
			const authorization = policy.authorizeAction(method, descriptor, session.messages);
			if (!authorization.allowed) {
				recordSecurityBlock(authorization, { method });
				return policy.asBlockedResult(authorization);
			}
			const securityMarker = bridge.securityBlocks.length;

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
				result = await original(surface, input);
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
					await settleNavigation(page, urlBefore);
					if (!page.isClosed()) {
						result.url = page.url();
						result.title = await page.title().catch(() => result.title);
						result.navigated = result.url !== urlBefore;
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
		const authorization = policy.authorizeAction('typeText', descriptor, session.messages);
		if (!authorization.allowed) {
			recordSecurityBlock(authorization, { method: 'typeText' });
			return policy.asBlockedResult(authorization);
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
		service.getDiagnostics = async (surface, diagnosticOptions = {}) => {
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
			return { ...result, securityBlocks, ...(mobileAudit ? { mobileAudit } : {}) };
		};
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
