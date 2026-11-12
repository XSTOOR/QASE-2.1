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

export async function statusSignals(page) {
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

export async function validityState(field) {
	return field.evaluate(element => ({
		valid: element.validity.valid,
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

async function inspectFormEligibility(page) {
	return page.evaluate(() => {
		const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
		const visible = element => {
			const rect = element.getBoundingClientRect();
			const style = getComputedStyle(element);
			return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
		};
		const accessibleName = element => {
			const ariaLabel = normalize(element.getAttribute('aria-label'));
			if (ariaLabel) return ariaLabel;
			const labelledBy = normalize((element.getAttribute('aria-labelledby') ?? '').split(/\s+/)
				.filter(Boolean).map(id => document.getElementById(id)?.textContent ?? '').join(' '));
			if (labelledBy) return labelledBy;
			const labels = normalize([...(element.labels ?? [])].map(label => label.textContent ?? '').join(' '));
			if (labels) return labels;
			if (element instanceof HTMLInputElement && element.type === 'submit') return normalize(element.value);
			return normalize(element.textContent);
		};
		const forms = [...document.forms];
		const allEmailFields = forms.flatMap(form => [...form.querySelectorAll('input[type="email"]')]);
		const names = allEmailFields.map(accessibleName);
		const candidates = [];
		const rejectionCodes = new Set();
		let labeledEmptyEmailFields = 0;
		for (const [formIndex, form] of forms.entries()) {
			let action;
			try { action = new URL(form.action || location.href, location.href); }
			catch { rejectionCodes.add('invalid_action'); continue; }
			const method = String(form.method || 'get').toLowerCase();
			const target = form.getAttribute('target') || document.querySelector('base[target]')?.target || '_self';
			const safeForm = method === 'get' && !form.noValidate && action.origin === location.origin && target.toLowerCase() === '_self';
			if (!safeForm) rejectionCodes.add('unsafe_form');
			const submits = [...form.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"]')]
				.filter(element => element.form === form && !element.disabled && !element.formNoValidate && visible(element)
					&& !element.matches('[formmethod],[formaction],[formtarget]'))
				.map(element => accessibleName(element)).filter(Boolean);
			for (const field of form.querySelectorAll('input[type="email"]')) {
				const fieldLabel = accessibleName(field);
				if (!fieldLabel) { rejectionCodes.add('unlabeled_email'); continue; }
				if (field.form !== form || !field.willValidate || !visible(field)) { rejectionCodes.add('unavailable_email'); continue; }
				if (field.value) { rejectionCodes.add('nonempty_email'); continue; }
				labeledEmptyEmailFields++;
				if (names.filter(name => name === fieldLabel).length !== 1) { rejectionCodes.add('nonunique_email_label'); continue; }
				const submitName = submits.find(name => submits.filter(candidate => candidate === name).length === 1);
				if (!submitName) { rejectionCodes.add('missing_unique_submit'); continue; }
				if (!safeForm) continue;
				candidates.push({ formIndex, fieldLabel, submitName });
			}
		}
		return {
			formsScanned: forms.length,
			emailFields: allEmailFields.length,
			labeledEmptyEmailFields,
			eligibleForms: candidates.length,
			candidates: candidates.slice(0, 5),
			rejectionCodes: [...rejectionCodes]
		};
	});
}

export async function safeSubmitter(submit, field, expectedUrl) {
	const element = await field.elementHandle({ timeout: 3_000 });
	try {
		return await submit.evaluate((button, { field, expectedUrl }) => {
			const form = field.form;
			if (!form || !field.willValidate || form.noValidate || button.formNoValidate
				|| button.form !== form || button.type !== 'submit' || button.disabled
				|| button.matches('[formmethod],[formaction],[formtarget]') || form.method !== 'get'
				|| location.href !== expectedUrl) return false;
			const target = form.getAttribute('target') || document.querySelector('base[target]')?.target || '_self';
			const action = new URL(form.action || location.href, location.href);
			return target.toLowerCase() === '_self' && action.origin === location.origin
				&& (['http:', 'https:'].includes(action.protocol) || (location.href === 'about:blank' && action.href === 'about:blank'));
		}, { field: element, expectedUrl }, { timeout: 3_000 });
	} finally {
		await element.dispose();
	}
}

/** Inspect common field constraints without firing input handlers or submitting. */
async function sampleNativeTextConstraints(page) {
	return page.evaluate(() => [...document.querySelectorAll('form input,form textarea')]
		.filter(field => ['text', 'search', 'url', 'textarea'].includes(field.type)
			&& field.willValidate && field.getClientRects().length && !field.value)
		.slice(0, 8).map(field => {
			const clone = field.cloneNode(false);
			const label = field.getAttribute('aria-label') || [...(field.labels ?? [])].map(item => item.textContent).join(' ') || null;
			const cases = [['empty', ''], ['sample_text', 'Qase sample idea'], ['cleared', '']].map(([name, value]) => {
				clone.value = value;
				return { name, valid: clone.validity.valid, valueMissing: clone.validity.valueMissing,
					typeMismatch: clone.validity.typeMismatch, patternMismatch: clone.validity.patternMismatch };
			});
			return { label: label?.trim().slice(0, 120), type: field.type, required: field.required,
				hasValidationConstraint: Boolean(field.required || field.pattern || field.type === 'url' || field.minLength > 0), cases };
		}));
}

function isFragmentNavigation(from, to) {
	return from.href !== to.href && Boolean(to.hash)
		&& from.origin === to.origin && from.pathname === to.pathname && from.search === to.search;
}

/**
 * Bounded, deterministic SQA browser checks that collapse repetitive driver
 * actions into one tool call. Results are sampled evidence, never a WCAG or
 * whole-product conformance claim.
 */
export function createSqaBrowserSmoke(page, { protectInputs, navigate = work => work() } = {}) {
	if (!page) throw new TypeError('SQA browser smoke checks require a live page.');
	const open = url => navigate(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }), url);
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
					const response = await open(target.href);
					await settle(100);
					const observed = await page.evaluate(() => ({
						url: location.href,
						title: document.title,
						heading: String(document.querySelector('h1,h2')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) || null
					}));
					const status = response?.status() ?? null;
					const sameOrigin = new URL(observed.url).origin === original.origin;
					const ok = sameOrigin && (response?.ok()
						?? (isFragmentNavigation(original, target) && observed.url === target.href));
					samples.push({
						name: requestedName,
						href: target.href,
						ok,
						status,
						...(!ok && { reason: sameOrigin && status >= 400 ? 'http_error' : 'destination_unverified' }),
						...observed
					});
					if (page.url() !== originalUrl) {
						await open(originalUrl);
						await settle(80);
					}
				}
			} finally {
				if (page.url() !== originalUrl) {
					await open(originalUrl).catch(() => undefined);
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
			const suppliedField = typeof input.fieldLabel === 'string' && input.fieldLabel.trim();
			const suppliedSubmit = typeof input.submitName === 'string' && input.submitName.trim();
			if (Boolean(suppliedField) !== Boolean(suppliedSubmit)
				|| (suppliedField && (input.fieldLabel.length > 120 || input.submitName.length > 120))) {
				throw new TypeError('Provide both fieldLabel and submitName exact accessible names, or omit both for deterministic form discovery.');
			}
			const inspection = await inspectFormEligibility(page);
			if (!suppliedField && inspection.eligibleForms === 0) {
				const nativeConstraintSamples = await sampleNativeTextConstraints(page);
				const { candidates: _candidates, ...inspectionSummary } = inspection;
				const blockerReason = inspection.formsScanned === 0
					? 'Deterministic form preflight found no forms on the current public page, so the bounded email validation workflow is unavailable.'
					: inspection.emailFields === 0
						? `Deterministic form preflight inspected ${inspection.formsScanned} form(s) and found no email field. The bounded validation workflow requires one empty labeled email field on a same-origin GET form.`
						: `Deterministic form preflight inspected ${inspection.formsScanned} form(s) and ${inspection.emailFields} email field(s), but found no empty, uniquely labeled email field with a unique submit control on a safe same-origin GET form.`;
				return {
					success: true,
					action: 'form_validation',
					eligible: false,
					outcome: 'unavailable',
					code: 'FORM_SMOKE_NO_ELIGIBLE_FORM',
					blockerReason,
					inspection: inspectionSummary,
					nativeConstraintSamples,
					validationRecoveryEstablished: false,
					cases: [],
					limitation: nativeConstraintSamples.length
						? 'Text/search/URL/textarea constraints sampled on detached copies only; no original value was exposed or changed, no app handler was exercised and no form was submitted. Optional unconstrained text is not an invalid-input defect. Application validation/recovery remains unverified.'
						: 'No form was submitted and no field value was read or changed.'
				};
			}
			const selected = suppliedField
				? { fieldLabel: input.fieldLabel.trim(), submitName: input.submitName.trim() }
				: inspection.candidates[0];
			const field = page.getByLabel(selected.fieldLabel, { exact: true });
			if (await field.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_FIELD_UNAVAILABLE', error: 'The exact accessible field label was not found or was not unique.' };
			}
			const form = field.locator('xpath=ancestor::form[1]');
			if (await form.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_FORM_UNAVAILABLE', error: 'The labeled field is not inside one form.' };
			}
			const submit = form.getByRole('button', { name: selected.submitName, exact: true });
			if (await submit.count() !== 1) {
				return { success: false, code: 'FORM_SMOKE_SUBMIT_UNAVAILABLE', error: 'The exact submit button was not found uniquely inside the field form.' };
			}
			const originalUrl = page.url();
			const unsafe = () => ({ success: false, code: 'FORM_SMOKE_UNSAFE_SUBMISSION', error: 'Form smoke requires a same-origin GET form, a current-page target, and a native submitter without submission overrides.' });
			const fieldMetadata = await field.evaluate(element => ({
				type: element.type || 'text',
				required: Boolean(element.required),
				hasExistingValue: Boolean(element.value)
			}));
			if (!await safeSubmitter(submit, field, originalUrl)) return unsafe();
			if (fieldMetadata.hasExistingValue) {
				return { success: false, code: 'FORM_SMOKE_NONEMPTY_FIELD', error: 'The selected field already contains a value; refusing to read, replace, or expose it.' };
			}
			if (fieldMetadata.type !== 'email') {
				return { success: false, code: 'FORM_SMOKE_UNSUPPORTED_FIELD', error: `The bounded generated cases currently support email fields, not ${fieldMetadata.type}.` };
			}
			if (!protectInputs) return { success: false, code: 'FORM_SMOKE_ISOLATION_UNAVAILABLE', error: 'The browser cannot isolate network requests during a live form smoke check.' };
			const blocked = protectInputs(page);
			const blockedBefore = blocked.total;
			const testedField = await field.elementHandle({ timeout: 3_000 });
			const cases = [];
			const exercise = async (name, value) => {
				await testedField.fill(value, { timeout: 3_000 });
				const beforeClick = await validityState(field);
				if (!await safeSubmitter(submit, field, originalUrl)) return false;
				const signalsBefore = await statusSignals(page);
				// Native validation feedback can interrupt Firefox pointer actions.
				await submit.press('Enter', { timeout: 3_000 });
				await settle(120);
				const urlAfter = page.url();
				if (urlAfter !== originalUrl || blocked.total !== blockedBefore) return false;
				const signals = await statusSignals(page);
				cases.push({ name, validity: beforeClick, submissionBlocked: !beforeClick.valid, urlChanged: false, statusSignals: signals,
					feedbackChanged: JSON.stringify(signals) !== JSON.stringify(signalsBefore) });
				return true;
			};
			let interrupted;
			try {
				for (const [name, value] of [['empty', ''], ['invalid_email', 'not-an-email'], ['valid_email', 'sqa@example.test'], ['invalid_after_valid', 'not-an-email']]) {
					if (!await exercise(name, value)) { interrupted = true; break; }
				}
			} finally {
				try {
					if (page.url() !== originalUrl) await open(originalUrl).catch(() => undefined);
					else if (await testedField.evaluate(element => element.isConnected).catch(() => false)) {
						await testedField.fill('', { timeout: 3_000 });
					} else interrupted = true;
				} finally {
					await testedField.dispose();
				}
			}
			if (interrupted || blocked.total !== blockedBefore) return {
				success: false, action: 'form_validation', code: 'FORM_SMOKE_BLOCKED', cases,
				error: 'The form changed its submission behavior or attempted network access. The bounded local validation check could not finish.'
			};
			const valid = cases.find(item => item.name === 'valid_email');
			const validSignals = valid?.statusSignals ?? [];
			const recoverySignals = cases.find(item => item.name === 'invalid_after_valid')?.statusSignals ?? [];
			return {
				success: true,
				action: 'form_validation',
				eligible: true,
				field: { label: selected.fieldLabel, type: fieldMetadata.type, required: fieldMetadata.required },
				form: { method: 'get', sameOrigin: true },
				discovery: { automatic: !suppliedField, eligibleForms: inspection.eligibleForms },
				cases,
				staleSuccessSignalAfterInvalid: valid?.feedbackChanged && validSignals.length > 0 && JSON.stringify(validSignals) === JSON.stringify(recoverySignals),
				restoredUrl: page.url(),
				limitation: 'Generated email cases on one form with browser HTTP egress blocked. Results cover local feedback and constraints only.'
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
