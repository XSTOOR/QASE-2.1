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
		const messages = [...document.querySelectorAll('[role=alert],[aria-live],.error,.invalid-feedback,.field-error,.help-block,.form-error,[class*=error],[class*=invalid]')]
			.filter(element => { const r = element.getBoundingClientRect(); return r.width > 2 && r.height > 2 && (element.innerText || '').trim(); })
			.map(element => element.innerText.trim().slice(0, 100));
		return { nativeInvalid, ariaInvalid, messages: messages.slice(0, 5) };
	}, formIndex).catch(() => ({}));
}

/**
 * Tests the forms on one page. `blocked()` returns the count of blocked
 * write requests so far; `reload()` restores the page.
 */
export async function testForms(page, { url, viewport, browser, blocked, reload, save, limit = 3 }) {
	const out = [];
	const forms = (await inventory(page)).filter(form => form.visible && form.fields.length && form.role !== 'search').slice(0, limit);
	let tested = 0;
	for (const form of forms) {
		tested++;
		const base = { url, viewport, category: 'forms', selector: `form:nth-of-type(${form.index + 1})` };
		const submit = async () => {
			const before = blocked();
			const startUrl = page.url();
			await browser.interact(async () => {
				const button = page.locator(`[data-qase-form="${form.index}"] button:not([type=button]):not([type=reset]), [data-qase-form="${form.index}"] input[type=submit]`).first();
				if (form.hasSubmit && await button.count()) await button.click({ timeout: 8000 }).catch(() => {});
				else await page.locator(`[data-qase-field="${form.fields[0].id}"]`).press('Enter', { timeout: 8000 }).catch(() => {});
				// Wait for a (blocked) submission or a navigation, bounded; slow machines need more than a fixed delay.
				for (let waited = 0; waited < 3000 && blocked() === before && page.url() === startUrl; waited += 150) await page.waitForTimeout(150);
				await page.waitForTimeout(300);
			});
			return { attempted: blocked() > before || page.url() !== startUrl && form.method === 'get', state: await feedback(page, form.index) };
		};
		const hasRequired = form.fields.some(field => field.required);

		// 1. Empty submission.
		const empty = await submit();
		const emptyFeedback = (empty.state.nativeInvalid ?? 0) + (empty.state.ariaInvalid ?? 0) + (empty.state.messages?.length ?? 0) > 0;
		if (empty.attempted && !emptyFeedback && (hasRequired || form.role === 'login' || form.fields.length >= 2)) {
			const bytes = await page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => undefined);
			out.push(candidate({ ...base, detector: 'forms.no_validation', severity: form.role === 'login' ? 'medium' : 'medium', confidence: hasRequired ? 0.85 : 0.6,
				title: `Form sends empty ${form.role === 'login' ? 'sign-in' : 'data'} without any validation`,
				actual: `Submitting the form with every field empty was sent to ${form.action || 'the server'} (QASE blocked the request) and no validation message appeared.${hasRequired ? ' Some fields are marked required.' : ''}`,
				expected: 'Empty required fields are rejected in the browser with a visible message, before anything is sent.',
				steps: [`Open ${url}`, 'Leave every field empty', 'Submit the form'], fix: FORM_FIX.no_validation,
				artifactId: bytes ? await save(bytes, `${viewport}: empty form submitted`) : undefined, data: { key: `no_validation:${form.action}` } }));
		} else if (!empty.attempted && !emptyFeedback && hasRequired) {
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
	return { candidates: out, tested, inventory: forms.map(form => ({ role: form.role, method: form.method, action: form.action, fields: form.fields.length })) };
}
