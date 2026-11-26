// Evaluated in the browser before and after the action. Ignore hidden or stale banners.
function confirmations() {
	return [...document.querySelectorAll('h1, [role=status]')]
		.filter(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length)
		.map(node => node.innerText.trim())
		.filter(text => /^(?:(?:record|project|item|entry|request|form|details|changes|application|registration)\s+)?(?:successfully\s+)?(?:saved|created|submitted)(?:\s+successfully)?[.!]?$/i.test(text));
}

// Runs in the page. Only an affirmative, newly visible receipt with the exact
// server-issued identifier counts; an echoed title or a generic toast does not.
function visibleReceipts(match) {
	const visible = [...document.querySelectorAll('h1,h2,output,[role=status],[role=alert],[aria-live]')]
		.filter(node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && node.getClientRects().length)
		.map(node => node.innerText.trim().replace(/\s+/g, ' ')).filter(text => text.length <= 250);
	if (!match) return visible;
	if (match.before.some(text => text.match(/[\w-]+/g)?.includes(match.id))) return undefined;
	return visible.find(text => {
		const receipt = /^(?:(?:note|record|project|item|entry|request|form|details|changes|application|registration)\s+)?(?:successfully\s+)?(?:saved|created|submitted)(?:\s+successfully)?[.!:\s-]+(?:reference|receipt|confirmation|id)\b(?:\s+(?:id|number))?\s*[:#]?\s*([\w-]+)[.!]?$/i.exec(text);
		return receipt && receipt[1] === match.id;
	});
}

function submittedValue(request, field) {
	const mime = (request.headers()['content-type'] ?? '').split(';')[0].trim().toLowerCase();
	if (!['application/json','application/x-www-form-urlencoded'].includes(mime)) return undefined;
	try { return request.postDataJSON()?.[field]; } catch { return undefined; }
}

async function recordSubmission(page, pending, responses, action, before, corrected, save) {
	const candidates = [...responses.keys()].filter(request =>
		request.method() === 'POST' && request.url() === action && submittedValue(request, pending.field) === corrected);
	if (candidates.length !== 1) return;
	const [posted] = candidates;
	const outcome = pending.outcome;
	outcome.submitted = true;
	outcome.postStatus = responses.get(posted).status();
	if (!posted.isNavigationRequest()) {
		const response = responses.get(posted);
		if (!await page.evaluate(form => form.ownerDocument === document, pending.form).catch(() => false)) return;
		if (!before?.receipts || !response.ok() || !/^application\/json\b/i.test(response.headers()['content-type'] ?? '') ||
			Number(response.headers()['content-length']) > 65536) return;
		const record = await response.json().catch(() => undefined);
		const id = record?.id ?? record?.reference;
		if (!['number','string'].includes(typeof id) || !/^[\w-]{1,100}$/.test(String(id)) ||
			(record[pending.field] !== undefined && record[pending.field] !== corrected)) return;
		const receipt = await page.waitForFunction(visibleReceipts, { id: String(id), before: before.receipts }, {timeout: 1800}).catch(() => undefined);
		if (!receipt) return;
		const heading = await receipt.jsonValue();
		await receipt.dispose();
		if (!await page.evaluate(form => form.ownerDocument === document, pending.form).catch(() => false)) return;
		outcome.receipt = { path: new URL(action).pathname, heading, status: response.status(), reference: String(id), kind: 'in-page' };
	} else {
		let last = posted;
		while (last.redirectedTo()) {
			last = last.redirectedTo();
			if (new URL(last.url()).origin !== new URL(action).origin) return;
		}
		const destination = new URL(page.url());
		destination.hash = '';
		const response = responses.get(last);
		if (!before?.headings || last.url() !== destination.href || !response?.ok()) return;
		const headings = await page.evaluate(confirmations).catch(() => []);
		const heading = headings.find(text => !before.headings.includes(text));
		if (!heading) return;
		outcome.receipt = { path: destination.pathname, heading, status: response.status() };
	}
	const bytes = await page.screenshot({ type: 'jpeg', quality: 65, timeout: 3000 }).catch(() => undefined);
	if (bytes) outcome.artifactId = await save(bytes, 'Form submission receipt');
}

export function plannedSaveGap(scenario) {
	const target = scenario.saveTarget;
	if (!target || scenario.formOutcomes?.some(o => o.form === target.form && o.path === target.path && o.validation && o.submitted && o.receipt)) return undefined;
	return `Planned save on ${target.path} (form ${target.form}): a corrected submission with a matching visible receipt was not verified.`;
}

// Observe the browser action already chosen by the explorer. Only associate a
// receipt with the same form that previously rejected a blank required field.
export function formOutcomeObserver(page, save, target) {
	const outcomes = [];
	let pending;
	let activeStep;
	let submittedStep;
	let corrected;
	const bound = page.exposeBinding('__qaseFormSubmit', ({ frame }, token, value) => {
		if (frame === page.mainFrame() && token === activeStep && typeof value === 'string' && value.trim()) { submittedStep = token; corrected = value; }
	}).then(() => true, () => false);

	async function observe(control, perform) {
		const form = await control.evaluateHandle(el => el?.form ?? null).catch(() => undefined);
		if (!form) return perform();
		let listener;
		const responses = new Map();
		const started = new Set();
		const start = req => {
			if (req.method() === 'POST' && ['fetch','xhr'].includes(req.resourceType()) && !req.serviceWorker() && req.frame() === page.mainFrame()) started.add(req);
		};
		const capture = response => {
			const req = response.request();
			if (started.has(req) || req.isNavigationRequest() && req.frame() === page.mainFrame()) responses.set(req, response);
		};
		try {
			const meta = await form.evaluate(f => {
				if (!f || f.method !== 'post' || f.querySelector('input[type=password],input[type=file]')) return null;
				const action = new URL(f.action);
				if (action.origin !== location.origin) return null;
				action.hash = '';
				return { path: location.pathname + (location.hash.startsWith('#/') ? location.hash.split('?')[0] : ''), action: action.href, form: [...document.forms].indexOf(f) + 1 };
			}).catch(() => null);
			if (!meta || target && (meta.path !== target.path || meta.form !== target.form)) return await perform();
			const same = pending && await form.evaluate((f, previous) => f === previous, pending.form).catch(() => false);
			const before = same ? { headings: await page.evaluate(confirmations).catch(() => null), receipts: await page.evaluate(visibleReceipts).catch(() => null) } : null;
			activeStep = crypto.randomUUID();
			submittedStep = undefined;
			listener = await form.evaluateHandle((f, { token, field }) => {
				let invalid;
				const onSubmit = e => {
					if (e.isTrusted && e.target === f && field) void window.__qaseFormSubmit(token, f.elements.namedItem(field)?.value).catch(() => {});
				};
				const onInvalid = e => {
					const field = e.target;
					if (e.isTrusted && field.validity?.valueMissing && field.name && !invalid) invalid = e;
				};
				f.addEventListener('invalid', onInvalid, true);
				if (token) f.addEventListener('submit', onSubmit, true);
				return () => {
					f.removeEventListener('invalid', onInvalid, true);
					f.removeEventListener('submit', onSubmit, true);
					if (invalid && !invalid.defaultPrevented && document.activeElement === invalid.target) {
						const field = invalid.target;
						const label = field.labels?.[0]?.innerText || field.getAttribute('aria-label') || field.placeholder || field.name;
						return { name: field.name, label: label.trim().slice(0, 60), message: field.validationMessage };
					}
				};
			}, {token: await bound ? activeStep : null, field: same ? pending.field : undefined}).catch(() => undefined);
			page.on('request', start);
			page.on('response', capture);
			try { return await perform(); }
			finally {
				const invalid = await listener?.evaluate(finish => finish()).catch(() => undefined);
				if (invalid?.message && outcomes.length < 20) {
					if (!same || pending.field !== invalid.name) {
						await pending?.form.dispose().catch(() => {});
						const outcome = { path: meta.path, form: meta.form, field: invalid.label, validation: invalid.message.slice(0, 180) };
						outcomes.push(outcome);
						pending = { form, field: invalid.name, outcome };
					}
				} else if (same && submittedStep === activeStep && !pending.outcome.receipt) {
					pending.outcome.attempted = true;
					if ([...started].some(req => req.url() === meta.action) && ![...responses.keys()].some(req => req.url() === meta.action)) {
						await page.waitForResponse(r => started.has(r.request()) && r.url() === meta.action, {timeout:1800}).catch(() => {});
					}
					await recordSubmission(page, pending, responses, meta.action, before, corrected, save).catch(() => {});
				}
			}
		} finally {
			activeStep = undefined;
			corrected = undefined;
			page.off('request', start);
			page.off('response', capture);
			await listener?.dispose().catch(() => {});
			if (form !== pending?.form) await form.dispose().catch(() => {});
		}
	}
	return { outcomes, observe };
}
