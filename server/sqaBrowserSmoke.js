const MAX_KEYBOARD_STEPS = 12;
const MAX_REVERSE_STEPS = 3;
const MAX_VIEWPORTS = 3;
const MAX_NAVIGATION_LINKS = 4;

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

function boundedInteger(value, fallback, minimum, maximum) {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function normalizeViewports(input) {
	const defaults = [{ width: 390, height: 844 }, { width: 768, height: 1024 }];
	if (input === undefined) return defaults;
	if (!Array.isArray(input) || input.length === 0 || input.length > MAX_VIEWPORTS) {
		throw new TypeError(`viewports must contain 1-${MAX_VIEWPORTS} viewport sizes.`);
	}
	return input.map((viewport, index) => {
		const width = Number(viewport?.width);
		const height = Number(viewport?.height);
		if (!Number.isInteger(width) || !Number.isInteger(height)
			|| width < 320 || width > 2560 || height < 480 || height > 1600) {
			throw new TypeError(`viewports[${index}] must use integer width 320-2560 and height 480-1600.`);
		}
		return { width, height };
	});
}

async function focusedElement(page) {
	return page.evaluate(() => {
		const element = document.activeElement;
		if (!element || element === document.body || element === document.documentElement) return null;
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const rawName = element.getAttribute('aria-label')
			|| element.getAttribute('name')
			|| element.getAttribute('title')
			|| element.innerText
			|| element.getAttribute('placeholder')
			|| '';
		return {
			tag: element.tagName.toLowerCase(),
			id: element.id || null,
			role: element.getAttribute('role') || null,
			type: element.getAttribute('type') || null,
			name: String(rawName).replace(/\s+/g, ' ').trim().slice(0, 120) || null,
			tabIndex: element.tabIndex,
			visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
		};
	});
}

function focusKey(item) {
	if (!item) return 'none';
	return [item.tag, item.id, item.role, item.type, item.name].map(value => value ?? '').join('|');
}

async function statusSignals(page) {
	return page.evaluate(() => [...document.querySelectorAll('[role="status"],[role="alert"],output')]
		.filter(element => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		})
		.map(element => ({
			role: element.getAttribute('role') || element.tagName.toLowerCase(),
			text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
		}))
		.filter(item => item.text)
		.slice(0, 3));
}

async function validityState(field) {
	return field.evaluate(element => ({
		valid: element.checkValidity(),
		required: Boolean(element.required),
		type: element.type || null,
		failures: Object.entries({
			valueMissing: element.validity.valueMissing,
			typeMismatch: element.validity.typeMismatch,
			patternMismatch: element.validity.patternMismatch,
			tooShort: element.validity.tooShort,
			tooLong: element.validity.tooLong,
			rangeUnderflow: element.validity.rangeUnderflow,
			rangeOverflow: element.validity.rangeOverflow,
			stepMismatch: element.validity.stepMismatch,
			badInput: element.validity.badInput,
			customError: element.validity.customError
		}).filter(([, failed]) => failed).map(([name]) => name)
	}));
}

/**
 * Bounded, deterministic SQA browser checks that collapse repetitive driver
 * actions into one tool call. Results are sampled evidence, never a WCAG or
 * whole-product conformance claim.
 */
export function createSqaBrowserSmoke(page) {
	if (!page) throw new TypeError('SQA browser smoke checks require a live page.');
	return {
		async accessibility(input = {}) {
			const steps = boundedInteger(input.steps, 8, 1, MAX_KEYBOARD_STEPS);
			const reverseSteps = boundedInteger(input.reverseSteps ?? input.reverse_steps, 2, 0, MAX_REVERSE_STEPS);
			const startingFocus = await focusedElement(page);
			const focusSequence = [];
			for (let index = 0; index < steps; index++) {
				await page.keyboard.press('Tab');
				await settle(40);
				focusSequence.push({ direction: 'forward', step: index + 1, element: await focusedElement(page) });
			}
			for (let index = 0; index < reverseSteps; index++) {
				await page.keyboard.press('Shift+Tab');
				await settle(40);
				focusSequence.push({ direction: 'reverse', step: index + 1, element: await focusedElement(page) });
			}
			const forwardKeys = focusSequence
				.filter(item => item.direction === 'forward')
				.map(item => focusKey(item.element));
			return {
				success: true,
				action: 'accessibility',
				inputMethod: 'Playwright keyboard.press using real Tab and Shift+Tab input',
				steps,
				reverseSteps,
				startingFocus,
				focusSequence,
				uniqueForwardTargets: new Set(forwardKeys.filter(key => key !== 'none')).size,
				noFocusSteps: forwardKeys.filter(key => key === 'none').length,
				wrappedDuringSample: forwardKeys.length > 1 && new Set(forwardKeys).size < forwardKeys.length,
				limitation: 'Bounded keyboard and exposed-semantic smoke sample only; not a WCAG conformance audit.'
			};
		},

		async responsive(input = {}) {
			const viewports = normalizeViewports(input.viewports);
			const originalViewport = page.viewportSize();
			if (!originalViewport) {
				return {
					success: false,
					code: 'RESPONSIVE_SMOKE_UNAVAILABLE',
					error: 'The current browser context does not expose a resizable fixed viewport.'
				};
			}
			const samples = [];
			try {
				for (const viewport of viewports) {
					await page.setViewportSize(viewport);
					await settle(120);
					const audit = await page.evaluate(() => {
						const root = document.documentElement;
						const body = document.body;
						const documentWidth = Math.max(root?.scrollWidth ?? 0, body?.scrollWidth ?? 0);
						const interactive = [...document.querySelectorAll('a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[tabindex]')];
						const outside = interactive.flatMap(element => {
							const rect = element.getBoundingClientRect();
							const style = getComputedStyle(element);
							if (rect.width <= 0 || rect.height <= 0 || style.display === 'none' || style.visibility === 'hidden') return [];
							if (rect.left >= 0 && rect.right <= window.innerWidth) return [];
							return [{
								tag: element.tagName.toLowerCase(),
								id: element.id || null,
								name: String(element.getAttribute('aria-label') || element.innerText || element.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null,
								left: Math.round(rect.left), right: Math.round(rect.right)
							}];
						});
						return {
							viewport: { width: window.innerWidth, height: window.innerHeight },
							documentWidth,
							horizontalOverflowPx: Math.max(0, documentWidth - window.innerWidth),
							viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
							outsideViewportInteractiveCount: outside.length,
							outsideViewportInteractiveSample: outside.slice(0, 5)
						};
					});
					samples.push(audit);
				}
			} finally {
				await page.setViewportSize(originalViewport).catch(() => undefined);
				await settle(80);
			}
			return {
				success: true,
				action: 'responsive',
				inputMethod: 'Playwright page.setViewportSize on the live page',
				originalViewport,
				samples,
				restoredViewport: page.viewportSize(),
				limitation: 'Bounded viewport and horizontal-clipping smoke sample only; not full device coverage.'
			};
		},

		async navigation(input = {}) {
			if (!Array.isArray(input.links) || input.links.length === 0 || input.links.length > MAX_NAVIGATION_LINKS
				|| input.links.some(name => typeof name !== 'string' || !name.trim() || name.length > 120)) {
				throw new TypeError(`links must contain 1-${MAX_NAVIGATION_LINKS} exact accessible link names.`);
			}
			const originalUrl = page.url();
			const original = new URL(originalUrl);
			const samples = [];
			try {
				for (const requestedName of [...new Set(input.links.map(name => name.trim()))]) {
					const locator = page.getByRole('link', { name: requestedName, exact: true });
					const count = await locator.count();
					if (count !== 1) {
						samples.push({ name: requestedName, ok: false, reason: count === 0 ? 'link_not_found' : 'link_name_not_unique' });
						continue;
					}
					const metadata = await locator.first().evaluate(element => ({
						href: element.href,
						download: element.hasAttribute('download'),
						target: element.getAttribute('target')
					}));
					let target;
					try { target = new URL(metadata.href, originalUrl); } catch {
						samples.push({ name: requestedName, ok: false, reason: 'invalid_href' });
						continue;
					}
					if (!['http:', 'https:'].includes(target.protocol) || target.origin !== original.origin || metadata.download) {
						samples.push({ name: requestedName, href: target.href, ok: false, reason: 'not_same_origin_safe_navigation' });
						continue;
					}
					const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 15_000 });
					await settle(100);
					const observed = await page.evaluate(() => ({
						url: location.href,
						title: document.title,
						heading: String(document.querySelector('h1,h2')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null
					}));
					samples.push({
						name: requestedName,
						href: target.href,
						ok: true,
						status: response?.status() ?? null,
						...observed
					});
					if (page.url() !== originalUrl) {
						await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
						await settle(80);
					}
				}
			} finally {
				if (page.url() !== originalUrl) {
					await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
				}
			}
			return {
				success: true,
				action: 'navigation',
				originalUrl,
				samples,
				restoredUrl: page.url(),
				limitation: 'Bounded same-origin link-destination sample only; it does not cover every route or authenticated state.'
			};
		},

		async formValidation(input = {}) {
			if (typeof input.fieldLabel !== 'string' || !input.fieldLabel.trim() || input.fieldLabel.length > 120
				|| typeof input.submitName !== 'string' || !input.submitName.trim() || input.submitName.length > 120) {
				throw new TypeError('fieldLabel and submitName must be exact accessible names of at most 120 characters.');
			}
			const field = page.getByLabel(input.fieldLabel.trim(), { exact: true });
			if (await field.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_FIELD_UNAVAILABLE', error: 'The exact accessible field label was not found or was not unique.' };
			}
			const form = field.locator('xpath=ancestor::form[1]');
			if (await form.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_FORM_UNAVAILABLE', error: 'The labeled field is not inside one form.' };
			}
			const submit = form.getByRole('button', { name: input.submitName.trim(), exact: true });
			if (await submit.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_SUBMIT_UNAVAILABLE', error: 'The exact submit button was not found uniquely inside the field form.' };
			}
			const originalUrl = page.url();
			const original = new URL(originalUrl);
			const metadata = await form.evaluate(element => ({
				method: String(element.method || 'get').toLowerCase(),
				action: element.action || location.href,
				target: element.target || null
			}));
			const action = new URL(metadata.action, originalUrl);
			const fieldMetadata = await field.evaluate(element => ({
				type: element.type || 'text',
				required: Boolean(element.required),
				hasExistingValue: Boolean(element.value)
			}));
			if (metadata.method !== 'get' || action.origin !== original.origin || metadata.target === '_blank') {
				return { success: false, code: 'FORM_SMOKE_UNSAFE_SUBMISSION', error: 'Only same-origin GET forms without a new-window target are eligible for bounded automatic validation.' };
			}
			if (fieldMetadata.hasExistingValue) {
				return { success: false, code: 'FORM_SMOKE_NONEMPTY_FIELD', error: 'The selected field already contains a value; refusing to read, replace, or expose it.' };
			}
			if (fieldMetadata.type !== 'email') {
				return { success: false, code: 'FORM_SMOKE_UNSUPPORTED_FIELD', error: `The bounded generated cases currently support email fields, not ${fieldMetadata.type}.` };
			}
			const cases = [];
			const exercise = async (name, value) => {
				await field.fill(value);
				const beforeClick = await validityState(field);
				const urlBefore = page.url();
				await submit.click().catch(() => undefined);
				await settle(120);
				const urlAfter = page.url();
				cases.push({ name, validity: beforeClick, submissionBlocked: !beforeClick.valid && urlAfter === urlBefore, urlChanged: urlAfter !== urlBefore, statusSignals: await statusSignals(page) });
				if (urlAfter !== originalUrl) {
					await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
					await settle(80);
				}
			};
			try {
				await exercise('empty', '');
				await exercise('invalid_email', 'not-an-email');
				await exercise('valid_email', 'sqa@example.test');
				await exercise('invalid_after_valid', 'not-an-email');
			} finally {
				if (page.url() !== originalUrl) {
					await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => undefined);
				}
				const restored = page.getByLabel(input.fieldLabel.trim(), { exact: true });
				if (await restored.count() === 1) await restored.fill('').catch(() => undefined);
			}
			const validSignals = cases.find(item => item.name === 'valid_email')?.statusSignals ?? [];
			const recoverySignals = cases.find(item => item.name === 'invalid_after_valid')?.statusSignals ?? [];
			return {
				success: true,
				action: 'form_validation',
				field: { label: input.fieldLabel.trim(), type: fieldMetadata.type, required: fieldMetadata.required },
				form: { method: metadata.method, sameOrigin: true },
				cases,
				staleSuccessSignalAfterInvalid: validSignals.length > 0 && JSON.stringify(validSignals) === JSON.stringify(recoverySignals),
				restoredUrl: page.url(),
				limitation: 'Generated empty/invalid/valid email cases on one same-origin GET form only; no POST, account creation, message, or purchase action is attempted.'
			};
		}
	};
}

export const SQA_SMOKE_LIMITS = Object.freeze({
	maxKeyboardSteps: MAX_KEYBOARD_STEPS,
	maxReverseSteps: MAX_REVERSE_STEPS,
	maxViewports: MAX_VIEWPORTS,
	maxNavigationLinks: MAX_NAVIGATION_LINKS
});
