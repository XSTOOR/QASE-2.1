import { setTimeout as settle } from 'node:timers/promises';
import { classifyDestructiveAction } from './browserPolicy.js';
import { safeBrowserRoute } from './browserRouteSafety.js';
import { safeSubmitter, statusSignals, validityState } from './sqaBrowserSmoke.js';

export const FOUNDER_FORM_REVIEW = 'browser_founder_form';
export const FOUNDER_FORM_CASE = 'browser_founder_form_case';

const LIMITATION = 'One public form sampled with synthetic text in a disposable browser. Requests were blocked during input testing. Evidence covers native validity and visible local feedback; server-side persistence was not exercised.';
const STATIC_RESOURCES = new Set(['script', 'stylesheet', 'image', 'font']);
const locatorTimeout = { timeout: 3000 };
const baseUrl = value => {
	const url = new URL(value);
	url.hash = '';
	return url.href;
};
const unavailable = (error, cases = []) => ({ success: false, code: 'FOUNDER_FORM_UNAVAILABLE', error, cases, limitation: LIMITATION });

export function createFounderFormTool(run) {
	return {
		name: FOUNDER_FORM_REVIEW,
		category: 'browser',
		description: 'Check one observed public text form in a single browser call. Provide its exact accessible field label and submit button name. The host opens the current route in a disposable browser, enters synthetic invalid and valid text, and saves separate activity IDs for native validity and visible feedback. Supports one empty text field with a minimum length on a same-origin form. Network egress is blocked during input; remote submission and persistence remain unverified.',
		parametersSchema: {
			type: 'object', additionalProperties: false, required: ['field_label', 'submit_name'],
			properties: {
				field_label: { type: 'string', minLength: 1, maxLength: 120 },
				submit_name: { type: 'string', minLength: 1, maxLength: 120 }
			}
		},
		run(input, { signal } = {}) {
			const validName = name => typeof name === 'string' && name.trim() && name.length <= 120;
			if (!input || Object.keys(input).some(key => !['field_label', 'submit_name'].includes(key))
				|| !validName(input.field_label) || !validName(input.submit_name)) return unavailable('Provide the exact visible field label and submit button name.');
			return run({ fieldLabel: input.field_label.trim(), submitName: input.submit_name.trim() }, signal);
		}
	};
}

export async function runFounderFormReview({ browser, url, contextOptions, fieldLabel, submitName, permitRead, saveCase, signal }) {
	signal?.throwIfAborted();
	if (classifyDestructiveAction('click', { label: submitName }) || classifyDestructiveAction('fill', { label: fieldLabel })) {
		return unavailable('The observed control is outside the public form test scope.');
	}
	const target = new URL(url);
	const context = await browser.newContext({ ...contextOptions, serviceWorkers: 'block', acceptDownloads: false });
	let page, quarantined = false, blocked = 0;
	const cases = [];
	const closeOnAbort = () => { void context.close().catch(() => undefined); };
	signal?.addEventListener('abort', closeOnAbort, { once: true });
	try {
		signal?.throwIfAborted();
		if (typeof context.routeWebSocket !== 'function') return unavailable('This browser cannot isolate WebSocket requests.');
		await context.routeWebSocket('**/*', async socket => {
			if (quarantined) blocked++;
			await socket.close({ code: 1008, reason: 'Public form test' }).catch(() => undefined);
		});
		await context.addInitScript(() => {
			for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
				if (!(name in globalThis)) continue;
				Object.defineProperty(globalThis, name, {
					value: class BlockedTransport { constructor() { throw new DOMException('Network transport unavailable during public form testing.', 'SecurityError'); } },
					configurable: false, writable: false
				});
			}
		});
		await context.route('**/*', safeBrowserRoute(async route => {
			if (quarantined) {
				blocked++;
				await route.abort('blockedbyclient');
				return;
			}
			const request = route.request();
			const destination = new URL(request.url());
			const document = request.resourceType() === 'document';
			const approvedDocument = document && request.isNavigationRequest() && request.frame() === page?.mainFrame() && baseUrl(destination) === baseUrl(target);
			const resource = !document && STATIC_RESOURCES.has(request.resourceType());
			if (['GET', 'HEAD'].includes(request.method()) && destination.origin === target.origin
				&& (approvedDocument || resource) && await permitRead(request.url(), approvedDocument)) {
				await route.continue();
			} else {
				await route.abort('blockedbyclient');
			}
		}));
		page = await context.newPage();
		await page.goto(url, { waitUntil: 'load', timeout: 12000 });
		quarantined = true;
		await context.setOffline(true);
		signal?.throwIfAborted();
		const field = page.getByLabel(fieldLabel, { exact: true });
		if (await field.count() !== 1 || !await field.isVisible()) return unavailable('The named text field is unavailable or ambiguous in the public browser.');
		const form = field.locator('xpath=ancestor::form[1]');
		const submit = form.getByRole('button', { name: submitName, exact: true });
		if (await submit.count() !== 1 || !await submit.isVisible() || !await safeSubmitter(submit, field, url)) {
			return unavailable('The named submitter must be visible and unique on the same-origin GET form.');
		}
		const minLength = await field.evaluate(element => {
			const editable = [...element.form.elements].filter(control => control.willValidate
				&& !['submit', 'button', 'reset', 'image'].includes(control.type));
			return element instanceof HTMLInputElement && element.type === 'text' && !element.readOnly && !element.value
				&& editable.length === 1 && editable[0] === element && !element.pattern
				&& element.minLength >= 2 && element.minLength <= 64
				&& (element.maxLength === -1 || element.maxLength >= element.minLength) ? element.minLength : 0;
		}, undefined, locatorTimeout);
		if (!minLength) return unavailable('This workflow needs one empty text input with a supported minimum length.');
		for (const [name, value] of [['invalid', 'A'], ['valid', 'Sample task'.padEnd(minLength, 'x').slice(0, minLength)]]) {
			signal?.throwIfAborted();
			const before = await statusSignals(page);
			await field.fill('', locatorTimeout);
			await field.pressSequentially(value, locatorTimeout);
			const validity = await validityState(field);
			if (blocked || !await safeSubmitter(submit, field, url)) return unavailable('The form changed or attempted network access during the input check.', cases);
			await submit.press('Enter', locatorTimeout);
			await settle(150, undefined, { signal });
			const feedback = page.url() === url ? await statusSignals(page) : [];
			const evidence = { name, validity, feedback, feedbackChanged: JSON.stringify(feedback) !== JSON.stringify(before), networkBlocked: blocked > 0, samePage: page.url() === url };
			cases.push({ ...evidence, activity_id: await saveCase(evidence) });
			if (blocked || !evidence.samePage) return unavailable('The form attempted network access or changed pages. Local feedback is partial.', cases);
		}
		return { success: true, cases, limitation: LIMITATION };
	} catch (error) {
		signal?.throwIfAborted();
		return unavailable('The disposable browser could not complete the local form sample.', cases);
	} finally {
		signal?.removeEventListener('abort', closeOnAbort);
		await context.close().catch(() => undefined);
	}
}
