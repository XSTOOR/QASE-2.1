/**
 * Form detectors. Submissions never reach the server: the browser layer
 * blocks non-GET requests during interaction, and the detector observes
 * whether the page *tried* to submit. That is enough to tell whether
 * validation happens before data would be sent.
 */
import { candidate } from '../findings.js';

export const FORM_FIX = {
	no_validation: 'Validate required fields before submitting: add required/aria-required and type attributes, block submission while invalid, and show an inline message next to each invalid field.',
	invalid_email_accepted: 'Use <input type="email"> (or a robust pattern) and validate on the server too; show a clear message for malformed addresses.',
	silent_rejection: 'When validation fails, show visible, specific error messages next to the fields (and announce them with aria-live / aria-describedby).',
	password_autocomplete: 'Set autocomplete="current-password" or "new-password" on password fields so password managers work correctly.',
	password_plain_text: 'Use type="password" for password fields.'
};

const FILLER = { tel: '5551234567', number: '7', url: 'https://example.com', date: '2030-01-15', email: 'qa.tester@example.com', text: 'QASE Test', search: 'test' };

async function inventory(page) {
	return page.evaluate(() => [...document.forms].slice(0, 6).map((form, index) => {
		form.setAttribute('data-qase-form', String(index));
		const fields = [...form.elements].filter(field => field.matches('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]),textarea,select'));
		const visible = element => { const r = element.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(element).visibility !== 'hidden'; };
		const labelOf = field => (field.labels?.[0]?.innerText || field.getAttribute('aria-label') || field.placeholder || field.name || '').trim().slice(0, 60);
		return {
			index, method: (form.getAttribute('method') || 'get').toLowerCase(), action: form.action, visible: visible(form) && fields.some(visible),
			role: fields.some(field => field.type === 'password') ? 'login' : fields.some(field => field.type === 'search' || /search|query|^q$/i.test(field.name)) ? 'search' : 'data',
			fields: fields.filter(visible).slice(0, 15).map((field, fieldIndex) => {
				field.setAttribute('data-qase-field', `${index}-${fieldIndex}`);
				const label = labelOf(field);
				return { id: `${index}-${fieldIndex}`, tag: field.tagName.toLowerCase(), type: field.type, name: field.name, label,
					required: field.required || field.getAttribute('aria-required') === 'true' || /\*\s*$/.test(field.labels?.[0]?.innerText ?? ''),
					emailLike: field.type === 'email' || /e-?mail/i.test(`${field.name} ${label} ${field.id}`), autocomplete: field.getAttribute('autocomplete') };
			}),
			hasSubmit: Boolean(form.querySelector('button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]'))
		};
	})).catch(() => []);
}

async function feedback(page, formIndex) {
	return page.evaluate(index => {
		const form = document.querySelector(`[data-qase-form="${index}"]`);
		if (!form) return { gone: true };
		const nativeInvalid = [...form.elements].filter(field => field.willValidate && !field.validity.valid).length;
		const ariaInvalid = form.querySelectorAll('[aria-invalid=true]').length;
		const messages = [...form.querySelectorAll('[role=alert],[aria-live],.error,.invalid-feedback,.field-error,.help-block,.form-error,[class*=error],[class*=invalid]')]
			.filter(element => { const r = element.getBoundingClientRect(); return r.width > 2 && r.height > 2 && (element.innerText || '').trim(); })
			.map(element => element.innerText.trim().slice(0, 100));
		return { nativeInvalid, ariaInvalid, messages: messages.slice(0, 5) };
	}, formIndex).catch(() => ({}));
}

// Runs in the page. Keep field values and DOM references inside the browser.
function watchRequiredFields(form, required) {
	const fields = required.map(({ id, label }) => ({ field: form.querySelector('[data-qase-field="' + id + '"]'), label }))
		.filter(({ field }) => field && !field.matches(':disabled, [readonly]') && field.value === '');
	const errorSelector = '.field-error,.invalid-feedback,.error,[data-field-error]';
	const visibleText = node => node?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length ? (node.innerText || '').trim().slice(0, 160) : '';
	// An alert is a notification channel. Only use it as field-error evidence
	// when the field itself is marked invalid or explicitly points to an error.
	const notices = () => [...form.querySelectorAll('[role=alert],[role=status],[aria-live]')].map(visibleText).filter(Boolean);
	const initialNotices = new Set(notices());
	function visibleErrors(field, initial = false) {
		const nodes = new Set();
		const refs = key => (field.getAttribute(key) || '').trim().split(/\s+/).filter(Boolean).map(id => document.getElementById(id)).filter(Boolean);
		for (const node of refs('aria-errormessage')) nodes.add(node);
		for (const node of refs('aria-describedby')) {
			if (field.getAttribute('aria-invalid') === 'true' || node.matches(errorSelector)) nodes.add(node);
		}
		const wrapper = field.parentElement;
		if (wrapper && wrapper !== form && form.contains(wrapper) && wrapper.querySelectorAll('input:not([type=hidden]),textarea,select').length === 1) {
			const selector = initial || field.getAttribute('aria-invalid') === 'true' ? errorSelector + ',[role=alert]' : errorSelector;
			for (const node of wrapper.querySelectorAll(selector)) nodes.add(node);
		}
		return [...nodes].filter(node => (!node.closest('form') || node.closest('form') === form) && node !== field && !node.contains(field) && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length)
			.map(node => (node.innerText || '').trim().slice(0, 160)).filter(Boolean);
	}
	for (const entry of fields) {
		entry.before = new Set(visibleErrors(entry.field, true));
		// A persistent hint must not become an error just because aria-invalid changes.
		for (const id of (entry.field.getAttribute('aria-describedby') || '').split(/\s+/)) {
			const hint = id && document.getElementById(id);
			if (hint && hint.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) entry.before.add((hint.innerText || '').trim().slice(0, 160));
		}
		entry.wasInvalid = entry.field.getAttribute('aria-invalid') === 'true';
	}
	let invalid, submit, click, missingAtSubmit = false;
	const onInvalid = e => { if (e.isTrusted && fields.some(item => item.field === e.target) && !invalid) invalid = e; };
	const onSubmit = e => {
		if (!e.isTrusted) return;
		submit = e;
		missingAtSubmit = fields.some(({ field }) => field.isConnected && field.value === '');
	};
	const onClick = e => { if (e.isTrusted && e.target.closest?.('button:not([type]),button[type=submit],input[type=submit],input[type=image]')) click = e; };
	form.addEventListener('invalid', onInvalid, true);
	form.addEventListener('submit', onSubmit, true);
	form.addEventListener('click', onClick, true);
	return () => {
		form.removeEventListener('invalid', onInvalid, true);
		form.removeEventListener('submit', onSubmit, true);
		form.removeEventListener('click', onClick, true);
		const nativeField = invalid?.target;
		const nativeMessage = nativeField && nativeField === document.activeElement && !invalid.defaultPrevented && nativeField.validationMessage;
		const field = nativeMessage ? fields.find(entry => entry.field === nativeField)?.label : undefined;
		const cancelled = Boolean(submit?.defaultPrevented || click?.defaultPrevented || invalid);
		const rejected = [];
		for (const entry of fields) {
			if (!entry.field.isConnected || entry.field.value !== '') continue;
			const visible = visibleErrors(entry.field);
			const message = visible.find(text => !entry.before.has(text));
			const marked = !entry.wasInvalid && entry.field.getAttribute('aria-invalid') === 'true';
			if (message || marked) rejected.push({ field: entry.label, message, missingLinkedError: marked && Boolean(entry.field.getAttribute('aria-errormessage')?.trim()) && !visible.length });
		}
		const success = notices().find(text => !initialNotices.has(text) && /^(?:(?:form|record|changes|details)\s+)?(?:successfully\s+(?:saved|submitted)|(?:saved|submitted)(?:\s+successfully)?)[.!]?$/i.test(text));
		return { submitted: Boolean(submit), emptyRequired: fields.length, missingAtSubmit, success, cancelled, rejected, field, message: nativeMessage ? nativeMessage.slice(0, 140) : '' };
	};
}

function requiredVerdict(observed, empty) {
	const quiet = !empty.attempted && !empty.actionRequested && !empty.writeRequested;
	if (observed?.message && quiet && !observed.submitted) return { status: 'passed', field: observed.field, detail: 'The browser focused the empty required field and reported “' + observed.message + '”. No submission was observed.' };
	if (observed?.missingAtSubmit && empty.actionRequested) return { status: 'failed', detector: 'forms.no_validation', detail: 'The form attempted submission with a required field empty.' };
	if (observed?.missingAtSubmit && observed.success) return { status: 'failed', detector: 'forms.no_validation', detail: 'The form reported “' + observed.success + '” after submission with a required field empty.' };
	if (observed?.cancelled && quiet && observed.rejected.length) {
		const broken = observed.rejected.find(item => item.missingLinkedError);
		if (broken) return { status: 'failed', detector: 'forms.silent_rejection', field: broken.field, detail: 'The form marked the field invalid, but its linked error message was missing, hidden or empty.' };
		const missing = observed.rejected.find(item => !item.message);
		if (missing) return { status: 'inconclusive', field: missing.field, detail: 'The field was marked invalid, but QASE could not verify a new visible error message for it.' };
		const first = observed.rejected[0];
		return { status: 'passed', field: first.field, detail: 'The form blocked the action and showed “' + first.message + '”' };
	}
	return { status: 'inconclusive', detail: 'Could not verify both a blocked submission and visible feedback for the empty required field.' };
}

/**
 * Tests the forms on one page. `blocked()` returns the count of blocked
 * write requests so far; `reload()` restores the page.
 */
export async function testForms(page, { url, viewport, browser, blocked, reload, save, limit = 3 }) {
	const out = [];
	const requiredChecks = [];
	const forms = (await inventory(page)).filter(form => form.visible && form.fields.length && form.role !== 'search').slice(0, limit);
	let tested = 0;
	for (const form of forms) {
		if (tested) await inventory(page); // Previous form checks reload the document.
		tested++;
		const base = { url, viewport, category: 'forms', selector: `form:nth-of-type(${form.index + 1})` };
		const submit = async () => {
			const before = blocked();
			const startUrl = page.url();
			let actionRequested = false, writeRequested = false;
			const action = new URL(form.action || startUrl, url);
			const track = request => {
				const target = new URL(request.url());
				if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) writeRequested = true;
				if (target.origin === action.origin && target.pathname === action.pathname && request.method().toLowerCase() === form.method
					&& (request.isNavigationRequest() || form.method !== 'get' && ['xhr', 'fetch'].includes(request.resourceType()))) actionRequested = true;
			};
			page.on('request', track);
			try { await browser.interact(async () => {
				const button = page.locator(`[data-qase-form="${form.index}"] button:not([type=button]):not([type=reset]), [data-qase-form="${form.index}"] input[type=submit]`).first();
				if (form.hasSubmit && await button.count()) await button.click({ timeout: 8000 }).catch(() => {});
				else await page.locator(`[data-qase-field="${form.fields[0].id}"]`).press('Enter', { timeout: 8000 }).catch(() => {});
				// Wait for a (blocked) submission or a navigation, bounded; slow machines need more than a fixed delay.
				for (let waited = 0; waited < 3000 && blocked() === before && page.url() === startUrl; waited += 150) await page.waitForTimeout(150);
				await page.waitForTimeout(300);
			}); } finally { page.off('request', track); }
			return { actionRequested, writeRequested, attempted: blocked() > before || page.url() !== startUrl && form.method === 'get', state: await feedback(page, form.index) };
		};
		const hasRequired = form.fields.some(field => field.required);

		// 1. Empty submission.
		// Observe the same submission as the defect detector. An invalid field on
		// initial render is insufficient evidence that pressing Submit worked.
		const witness = hasRequired && await page.locator(`[data-qase-form="${form.index}"]`).evaluateHandle(watchRequiredFields,
			form.fields.filter(field => field.required), { timeout: 1200 }).catch(() => undefined);
		const empty = await submit();
		let requiredCheck, observed;
		if (hasRequired) {
			observed = witness && await witness.evaluate(read => read()).catch(() => undefined);
			if (witness) await witness.dispose().catch(() => {});
			requiredCheck = { path: new URL(url).pathname, form: form.index + 1, ...requiredVerdict(observed, empty) };
			if (requiredCheck.field || requiredCheck.status === 'failed') {
				const bytes = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 2000 }).catch(() => undefined);
				if (bytes) requiredCheck.artifactId = await save(bytes, viewport + ': required-field validation');
			}
			requiredChecks.push(requiredCheck);
		}
		const emptyFeedback = requiredCheck?.status === 'passed' || (empty.state.nativeInvalid ?? 0) + (empty.state.ariaInvalid ?? 0) + (empty.state.messages?.length ?? 0) > 0;
		if (requiredCheck?.detector === 'forms.no_validation') {
			out.push(candidate({ ...base, detector: 'forms.no_validation', severity: 'medium', confidence: 0.9,
				title: 'Form attempts submission with an empty required field', actual: requiredCheck.detail, expected: 'Empty required fields block submission.',
				steps: [`Open ${url}`, 'Submit the form with the required field empty'], fix: FORM_FIX.no_validation,
				artifactId: requiredCheck.artifactId, data: { key: `no_validation:${form.action}` } }));
		} else if (empty.attempted && !emptyFeedback && (!hasRequired || empty.actionRequested) && (hasRequired || form.role === 'login' || form.fields.length >= 2)) {
			const bytes = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
			out.push(candidate({ ...base, detector: 'forms.no_validation', severity: form.role === 'login' ? 'medium' : 'medium', confidence: hasRequired ? 0.85 : 0.6,
				title: `Form sends empty ${form.role === 'login' ? 'sign-in' : 'data'} without any validation`,
				actual: `Submitting the form with every field empty was sent to ${form.action || 'the server'} (QASE blocked the request) and no validation message appeared.${hasRequired ? ' Some fields are marked required.' : ''}`,
				expected: 'Empty required fields are rejected in the browser with a visible message, before anything is sent.',
				steps: [`Open ${url}`, 'Leave every field empty', 'Submit the form'], fix: FORM_FIX.no_validation,
				artifactId: bytes ? await save(bytes, `${viewport}: empty form submitted`) : undefined, data: { key: `no_validation:${form.action}` } }));
		} else if (requiredCheck?.detector === 'forms.silent_rejection') {
			out.push(candidate({ ...base, detector: 'forms.silent_rejection', severity: 'medium', confidence: 0.9,
				title: 'Required field has no visible linked error message', actual: requiredCheck.detail,
				expected: 'An empty required field displays its associated error after submission.', artifactId: requiredCheck.artifactId,
				steps: [`Open ${url}`, 'Submit with the required field empty', 'Inspect the field and its linked error message'],
				fix: FORM_FIX.silent_rejection, data: { key: 'missing-linked-error:' + form.index } }));
		} else if (!empty.attempted && !emptyFeedback && observed?.emptyRequired && observed.cancelled) {
			out.push(candidate({ ...base, detector: 'forms.silent_rejection', severity: 'low', confidence: 0.55,
				title: 'Submitting an incomplete form gives no feedback',
				actual: 'The form did not submit with empty required fields, but it showed no message explaining why.', expected: 'Users see which fields need attention.',
				steps: [`Open ${url}`, 'Submit the empty form'], fix: FORM_FIX.silent_rejection, data: { key: `silent:${form.action}` } }));
		}
		await reload();

		// 2. Malformed email.
		const emailField = form.fields.find(field => field.emailLike && field.tag === 'input');
		if (emailField) {
			await (await inventory(page)); // re-tag after reload
			for (const field of form.fields) {
				const value = field.id === emailField.id ? 'not-an-email' : field.tag === 'select' ? undefined : FILLER[field.type] ?? FILLER.text;
				if (field.type === 'password') continue;
				const locator = page.locator(`[data-qase-field="${field.id}"]`);
				if (value === undefined) await locator.selectOption({ index: 1 }).catch(() => {});
				else await locator.fill(value, { timeout: 6000 }).catch(() => {});
			}
			const malformed = await submit();
			const emailState = await page.evaluate(id => {
				const field = document.querySelector(`[data-qase-field="${id}"]`);
				return field ? { valid: field.validity.valid, ariaInvalid: field.getAttribute('aria-invalid') === 'true' } : {};
			}, emailField.id).catch(() => ({}));
			if (malformed.attempted && emailState.valid !== false && !emailState.ariaInvalid && !(malformed.state.messages?.length)) {
				out.push(candidate({ ...base, detector: 'forms.invalid_email_accepted', severity: 'medium', confidence: 0.8,
					title: `"${emailField.label || emailField.name || 'Email'}" accepts a malformed email address`,
					actual: 'With "not-an-email" in the email field the form was submitted (QASE blocked the request) without any validation message.',
					expected: 'Malformed email addresses are rejected before submission.', steps: [`Open ${url}`, 'Enter "not-an-email" in the email field', 'Fill the other fields', 'Submit'],
					fix: FORM_FIX.invalid_email_accepted, data: { key: `email:${form.action}:${emailField.name}` } }));
			}
			await reload();
		}

		// 3. Password field hygiene.
		for (const field of form.fields) {
			if (/pass(word)?|pwd/i.test(`${field.name} ${field.label}`) && field.type !== 'password' && field.tag === 'input') {
				out.push(candidate({ ...base, detector: 'forms.password_plain_text', category: 'security', severity: 'high', confidence: 0.8,
					title: 'Password is typed in plain text', actual: `The field "${field.label || field.name}" looks like a password field but uses type="${field.type}", so the password is visible on screen.`,
					expected: 'Password fields use type="password".', fix: FORM_FIX.password_plain_text, data: { key: `pw_plain:${field.name}` } }));
			}
		}
	}
	return { candidates: out, tested, requiredChecks, inventory: forms.map(form => ({ role: form.role, method: form.method, action: form.action, fields: form.fields.length })) };
}
