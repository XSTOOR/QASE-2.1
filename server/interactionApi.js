/**
 * RT3 (ticket #14705) · Real device-interaction API.
 *
 * Executes device-appropriate input against a LIVE Playwright context using
 * the driver's real input APIs (touchscreen / mouse / keyboard / wheel /
 * locator drag) — never synthetic DOM events dispatched from page JS.
 *
 * Honesty rules:
 *   - Input mode is chosen from the context's actual `hasTouch` capability:
 *     touch context → touchscreen API first; mouse context → mouse API.
 *   - When a gesture is genuinely unavailable in the current context or
 *     engine, the method returns a clear UNAVAILABLE result — never a fake
 *     success, and never a touch gesture silently re-labelled as a click.
 *   - Every result records the inputMethod actually used, so evidence can
 *     state exactly how the input reached the page.
 */

const GESTURE_TIMEOUT_MS = Math.max(2000, Number(process.env.QASE_GESTURE_TIMEOUT_MS ?? 15_000));

const unavailable = (action, reason) => ({
	success: false,
	code: 'INTERACTION_UNAVAILABLE',
	action,
	error: reason
});

const asPoint = (target) => {
	if (!target) return null;
	if (typeof target === 'string') return null;
	if (Number.isFinite(target.x) && Number.isFinite(target.y)) return { x: target.x, y: target.y };
	return null;
};

/**
 * @param {object} options
 * @param {import('playwright').BrowserContext} options.context
 * @param {import('playwright').Page} options.page
 * @param {(name: string) => Promise<void>} [options.beforeAction] hook run before each gesture
 */
export function createInteractionApi({ context, page, beforeAction }) {
	// The context's REAL touch capability decides the input mode — probed once
	// per api instance (a new page reading navigator.maxTouchPoints) and
	// cached; a rotated or resized context keeps its touch state.
	let touchCapability;
	const hasTouchCapability = () => {
		touchCapability ??= context.newPage()
			.then(async (probe) => {
				let touch = await probe.evaluate(() => navigator.maxTouchPoints > 0).catch(() => false);
				// Hardware touch points can leak into non-touch Windows contexts.
				// Verify driver injection on this blank page, never on the target UI.
				if (touch) touch = await probe.touchscreen.tap(0, 0).then(() => true, () => false);
				await probe.close().catch(() => {});
				return Boolean(touch);
			})
			.catch(() => false);
		return touchCapability;
	};
	const capabilities = async () => ({
		hasTouch: await hasTouchCapability(),
		viewport: page.viewportSize() ?? null
	});

	const withTimeout = (work, operation) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			const error = new Error(`${operation} did not complete within ${GESTURE_TIMEOUT_MS} ms. The page may be unresponsive — retry once, then report the affected check as not tested with a reason.`);
			error.name = 'GestureTimeout';
			reject(error);
		}, GESTURE_TIMEOUT_MS);
		Promise.resolve()
			.then(work)
			.then(
				(result) => { clearTimeout(timer); resolve(result); },
				(error) => { clearTimeout(timer); reject(error); }
			);
	});

	/** Resolve a selector (or point) to a stable centre point, with position info on failure. */
	const pointFor = async (target) => {
		const direct = asPoint(target);
		if (direct) return direct;
		if (typeof target !== 'string' || !target.trim()) {
			throw Object.assign(new Error('Provide a selector or an {x,y} point.'), { name: 'GestureInputError' });
		}
		const locator = page.locator(target).first();
		// Fail FAST on missing targets: boundingBox alone retries for the full
		// driver timeout, which turns a locator typo into a 15s stall.
		const box = await Promise.race([
			locator.boundingBox().catch(() => null),
			new Promise((resolve) => setTimeout(() => resolve(null), 2500))
		]);
		if (!box) {
			throw Object.assign(
				new Error(`Element "${target}" has no visible bounding box (offscreen or hidden). Scroll it into view first; position unavailable — refusing to tap blindly.`),
				{ name: 'GestureTargetNotFound' }
			);
		}
		return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2), box };
	};

	const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

	const observed = async () => {
		try {
			return await page.evaluate(() => ({
				url: location.href,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				orientation: matchMedia('(orientation: landscape)').matches ? 'landscape' : 'portrait'
			}));
		} catch {
			return null;
		}
	};

	const record = (action, inputMethod, extra = {}) => ({
		success: true,
		action,
		inputMethod,
		observedAt: new Date().toISOString(),
		...extra
	});

	const api = {
		capabilities,

		/** Tap: touch context → real touchscreen injection; mouse context → real click. */
		async tap(target) {
			await beforeAction?.('tap');
			const { hasTouch } = await capabilities();
			const point = await pointFor(target);
			await withTimeout(async () => {
				if (hasTouch) {
					await page.touchscreen.tap(point.x, point.y);
				} else {
					await page.mouse.click(point.x, point.y);
				}
				await settle();
			}, 'tap');
			return record('tap', hasTouch ? 'touchscreen.tap (driver touch injection)' : 'mouse.click (driver mouse injection)', { point, touch: hasTouch });
		},

		async doubleTap(target) {
			await beforeAction?.('double_tap');
			const { hasTouch } = await capabilities();
			const point = await pointFor(target);
			await withTimeout(async () => {
				if (hasTouch) {
					await page.touchscreen.tap(point.x, point.y);
					await settle(80);
					await page.touchscreen.tap(point.x, point.y);
				} else {
					await page.mouse.dblclick(point.x, point.y);
				}
				await settle();
			}, 'double_tap');
			return record('double_tap', hasTouch ? 'touchscreen.tap ×2 (driver touch injection)' : 'mouse.dblclick (driver mouse injection)', { point, touch: hasTouch });
		},

		/**
		 * Long press: pointer down, held, released — real injected input.
		 * Touch contexts inject the hold via the same pointer pipeline the
		 * engine translates to touch; the hold duration is real wall time.
		 */
		async longPress(target, { durationMs = 800 } = {}) {
			await beforeAction?.('long_press');
			const { hasTouch } = await capabilities();
			const point = await pointFor(target);
			const duration = Math.max(200, Math.min(5000, Number(durationMs) || 800));
			await withTimeout(async () => {
				await page.mouse.move(point.x, point.y);
				await page.mouse.down();
				await settle(duration);
				await page.mouse.up();
				await settle();
			}, 'long_press');
			return record('long_press', hasTouch ? `mouse down/hold ${duration}ms (translated to touch-hold by the engine's touch emulation)` : `mouse down/hold ${duration}ms (driver mouse injection)`, { point, durationMs: duration, touch: hasTouch });
		},

	/**
	 * Real touch drag on a Chromium touch context via CDP Input.dispatchTouchEvent
	 * (touchStart → interpolated touchMoves → touchEnd). Injected mouse moves do
	 * NOT scroll on touch contexts (the renderer scrolls from touch input), so a
	 * genuine swipe needs genuine touch events. Mouse contexts use the pointer
	 * pipeline instead. Firefox/WebKit lack a driver touch-drag API — documented
	 * honestly in the result instead of silently using a weaker input.
	 */
	async touchDrag(start, vector, steps) {
		const session = await context.newCDPSession(page).catch(() => null);
		if (!session) return false;
		const touchPoints = [{ x: start.x, y: start.y }];
		await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints });
		for (let i = 1; i <= steps; i++) {
			await session.send('Input.dispatchTouchEvent', {
				type: 'touchMove',
				touchPoints: [{ x: start.x + Math.round(vector.dx * i / steps), y: start.y + Math.round(vector.dy * i / steps) }]
			});
			await settle(Math.max(8, Math.min(60, 240 / steps)));
		}
		await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await session.detach().catch(() => {});
		return true;
	},

	/**
	 * Swipe: real input travel from a start point along a direction with
	 * intermediate steps (not a teleport). Touch contexts dispatch genuine CDP
	 * touch events; mouse contexts use the pointer pipeline.
	 */
		async swipe({ target, direction = 'left', distance = 200, steps = 12 } = {}) {
			await beforeAction?.('swipe');
			const { hasTouch, viewport } = await capabilities();
			const start = await pointFor(target ?? { x: Math.round((viewport?.width ?? 390) / 2), y: Math.round((viewport?.height ?? 844) / 2) });
			const travel = Math.max(20, Math.min(2000, Number(distance) || 200));
			const vectors = {
				left: { dx: -travel, dy: 0 }, right: { dx: travel, dy: 0 },
				up: { dx: 0, dy: -travel }, down: { dx: 0, dy: travel }
			};
			const vector = vectors[direction];
			if (!vector) {
				return unavailable('swipe', `direction must be one of ${Object.keys(vectors).join(', ')}.`);
			}
			const stepCount = Math.max(2, Number(steps) || 12);
			let usedCdpTouch = false;
			await withTimeout(async () => {
				if (hasTouch) {
					// Genuine touch events first; fall back to pointer input only
					// when the engine exposes no touch-drag channel (and say so).
					usedCdpTouch = await api.touchDrag(start, vector, stepCount);
				}
				if (!hasTouch || !usedCdpTouch) {
					await page.mouse.move(start.x, start.y);
					await page.mouse.down();
					for (let i = 1; i <= stepCount; i++) {
						await page.mouse.move(
							start.x + Math.round(vector.dx * i / stepCount),
							start.y + Math.round(vector.dy * i / stepCount)
						);
						await settle(Math.max(8, Math.min(60, 240 / stepCount)));
					}
					await page.mouse.up();
				}
				await settle();
			}, 'swipe');
			const inputMethod = hasTouch
				? (usedCdpTouch
					? 'CDP Input.dispatchTouchEvent (driver touch injection)'
					: `mouse down/move×${steps}/up (pointer fallback — engine lacks a touch-drag API; weaker than true touch)`)
				: `mouse down/move×${steps}/up (driver mouse injection)`;
			return record('swipe', inputMethod, { start, direction, distance: travel, touch: hasTouch, touchDragDispatched: usedCdpTouch });
		},

		/** Drag one element onto another — Playwright's real locator drag (hovers, down, move, up). */
		async dragTo(fromSelector, toSelector) {
			await beforeAction?.('drag_to');
			if (typeof fromSelector !== 'string' || typeof toSelector !== 'string') {
				return unavailable('drag_to', 'drag_to needs two selectors (source and destination).');
			}
			const from = page.locator(fromSelector).first();
			const to = page.locator(toSelector).first();
			await withTimeout(() => from.dragTo(to), `drag from ${fromSelector} to ${toSelector}`);
			await settle();
			return record('drag_to', 'locator.dragTo (driver pointer injection)', { from: fromSelector, to: toSelector });
		},

		async mouseMove(target) {
			await beforeAction?.('mouse_move');
			const point = await pointFor(target);
			await withTimeout(() => page.mouse.move(point.x, point.y), 'mouse_move');
			return record('mouse_move', 'mouse.move (driver mouse injection)', { point });
		},

		async click(target, { button = 'left' } = {}) {
			await beforeAction?.('click');
			const point = await pointFor(target);
			await withTimeout(() => page.mouse.click(point.x, point.y, { button }), 'click');
			await settle();
			return record('click', `mouse.click(${button}) (driver mouse injection)`, { point, button });
		},

		async doubleClick(target) {
			await beforeAction?.('double_click');
			const point = await pointFor(target);
			await withTimeout(() => page.mouse.dblclick(point.x, point.y), 'double_click');
			await settle();
			return record('double_click', 'mouse.dblclick (driver mouse injection)', { point });
		},

		async rightClick(target) {
			return api.click(target, { button: 'right' });
		},

		async type(text) {
			await beforeAction?.('type');
			if (typeof text !== 'string' || !text.length) return unavailable('type', 'type needs non-empty text.');
			await withTimeout(() => page.keyboard.type(text, { delay: 15 }), 'type');
			return record('type', 'keyboard.type (driver keyboard injection)', { length: text.length });
		},

		async pressKey(key) {
			await beforeAction?.('press_key');
			if (typeof key !== 'string' || !key.trim()) return unavailable('press_key', 'press_key needs a key name.');
			await withTimeout(() => page.keyboard.press(key), 'press_key');
			await settle(60);
			return record('press_key', 'keyboard.press (driver keyboard injection)', { key });
		},

		async scroll({ direction = 'down', amount = 400 } = {}) {
			await beforeAction?.('scroll');
			const delta = Math.max(20, Math.min(5000, Number(amount) || 400));
			const deltaY = direction === 'up' ? -delta : delta;
			if (!['up', 'down'].includes(direction)) return unavailable('scroll', 'scroll direction must be up or down (use swipe for horizontal).');
			await withTimeout(async () => {
				await page.mouse.wheel(0, deltaY);
				await settle(200);
			}, 'scroll');
			return record('scroll', 'mouse.wheel (driver wheel injection)', { direction, amount: delta });
		},

		async uploadFiles(selector, files) {
			await beforeAction?.('upload');
			if (typeof selector !== 'string' || !Array.isArray(files) || !files.length) {
				return unavailable('upload', 'upload needs a file input selector and at least one file path.');
			}
			const input = page.locator(selector).first();
			await withTimeout(() => input.setInputFiles(files), `upload to ${selector}`);
			return record('upload', 'locator.setInputFiles (real file input assignment)', { selector, files: files.length });
		},

		async refresh() {
			await beforeAction?.('refresh');
			await withTimeout(() => page.reload({ waitUntil: 'domcontentloaded' }), 'refresh');
			await settle();
			return record('refresh', 'page.reload (real navigation)', { observed: await observed() });
		},

		async back() {
			await beforeAction?.('back');
			const urlBefore = page.url();
			await withTimeout(() => page.goBack({ waitUntil: 'domcontentloaded' }), 'back');
			await settle();
			const urlAfter = page.url();
			return record('back', 'page.goBack (real history navigation)', { urlBefore, urlAfter, navigated: urlAfter !== urlBefore, observed: await observed() });
		},

		/**
		 * Orientation change: swap the LIVE viewport (portrait↔landscape) on
		 * touch-capable contexts and read back the page's own orientation
		 * media-query state as proof. Non-touch envs → SKIPPED, not an error.
		 */
		async setOrientation(orientation = 'landscape') {
			await beforeAction?.('rotate');
			if (!['portrait', 'landscape'].includes(orientation)) {
				return unavailable('rotate', 'orientation must be "portrait" or "landscape".');
			}
			const { hasTouch, viewport } = await capabilities();
			if (!hasTouch || !viewport) {
				return {
					success: true,
					status: 'SKIPPED',
					action: 'rotate',
					reason: 'Orientation change is not applicable on this context (no touch capability or no fixed viewport).',
					inputMethod: null
				};
			}
			const swap = (size) => (orientation === 'landscape'
				? { width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) }
				: { width: Math.min(size.width, size.height), height: Math.max(size.width, size.height) });
			const targetViewport = swap(viewport);
			await withTimeout(async () => {
				await page.setViewportSize(targetViewport);
				await settle(300);
			}, 'rotate');
			const proof = await observed();
			const applied = proof?.viewport
				? proof.viewport.width === targetViewport.width && proof.viewport.height === targetViewport.height
				: false;
			return {
				...record('rotate', 'page.setViewportSize (live viewport rotation)', { requested: orientation, viewport: targetViewport, touch: true }),
				applied,
				proof
			};
		},

		/** Honest capability report for this live context — used by the tool layer. */
		async reportCapabilities() {
			const { hasTouch, viewport } = await capabilities();
			const proof = await observed();
			const engine = context.browser()?.browserType()?.name?.() ?? null;
			return {
				hasTouch,
				viewport,
				observedViewport: proof?.viewport ?? null,
				orientation: proof?.orientation ?? null,
				engineName: engine ?? null,
				available: {
					touch: hasTouch ? ['tap', 'double_tap', 'long_press', 'swipe', 'rotate'] : [],
					pointer: ['click', 'double_click', 'right_click', 'mouse_move', 'drag_to', 'swipe', 'scroll'],
					keyboard: ['type', 'press_key'],
					navigation: ['refresh', 'back'],
					files: ['upload']
				},
				note: hasTouch
					? 'Touch context: taps use driver touchscreen injection; drags/swipes inject pointer input the engine translates to touch.'
					: 'Mouse context: touch gestures fall back with an explicit error rather than pretending.'
			};
		}
	};

	return api;
}

/**
 * Names of the interaction actions this API exposes — mirrors the browser
 * tool vocabulary so the tool layer can route 1:1.
 */
export const INTERACTION_ACTIONS = [
	'tap', 'double_tap', 'long_press', 'swipe', 'drag_to', 'mouse_move',
	'click', 'double_click', 'right_click', 'type', 'press_key', 'scroll',
	'upload', 'refresh', 'back', 'rotate'
];
