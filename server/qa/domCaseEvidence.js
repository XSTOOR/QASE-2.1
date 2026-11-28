import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

// Never persist a URL containing credentials, arbitrary query values or private route IDs.
export function publicRoute(value, allowedPaths = []) {
	try {
		const u = new URL(value);
		if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.search) return null;
		const terms = /^(?:home|app|workspace|form|forms|test|demo|staging|settings|account|profile|login|register|signup|sign-in|checkout|cart|shop|products?|orders?|notes?|items?|projects?|search|filter|about|contact|help|docs|support|solutions|pricing|dashboard|index\.html)$/i;
		const safe = path => path.split('/').filter(Boolean).every(v => terms.test(v)) || allowedPaths.includes(path);
		if (!safe(u.pathname) || (u.hash && (!u.hash.startsWith('#/') || !safe(u.hash.slice(1))))) return null;
		return u.href;
	} catch { return null; }
}

// Called by the existing page-feature inspection only when it needs case evidence.
// Only bounded structural, semantic and constraint data crosses the browser boundary.
export async function inspectCaseControls(page, allowedPaths = []) {
	const url = publicRoute(page.url(), allowedPaths);
	if (!url) return { unavailable: 'Route contains non-public data or an unconfigured path.' };
	const evidence = await page.evaluate(() => {
		const elements = [];
		const publicName = /^(?:(?:user ?name|first name|last name|name|e-?mail(?: address)?|password|date|quantity|amount|search|save|submit|continue|next|back|menu|settings|home|help|notes?|orders?|country|category|agree|remember me|filter|login|log in|sign in|add|create|update|delete|remove|send|pay|upload)(?: (?:button|field|note|order|item|record))?)$/i;
		const selector = 'input:not([type=hidden]),textarea,select,button,a[href],summary,form,table,nav,dialog,[role=tab],[role=button],[role=checkbox],[role=radio],[role=combobox],[aria-expanded],[contenteditable=true]';
		const list = document.querySelectorAll(selector);
		function locationOf(el) {
			const parts = [];
			for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
				if (parts.length >= 24) return null;
				let i = 1;
				for (let s = n.previousElementSibling; s; s = s.previousElementSibling) i++;
				parts.unshift(i);
			}
			return { css: parts.map(i => '*:nth-child(' + i + ')').join(' > '), xpath: parts.map(i => '/*[' + i + ']').join('') };
		}
		let omitted = 0;
		for (const el of Array.from(list).slice(0, 160)) {
			const r = el.getBoundingClientRect();
			if (!r.width || !r.height || !el.checkVisibility({checkVisibilityCSS:true})) continue;
			const loc = locationOf(el);
			if (!loc || document.querySelector(loc.css) !== el || document.evaluate(loc.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue !== el) { omitted++; continue; }
			const tag = el.localName;
			const type = tag === 'input' || tag === 'button' ? el.type : tag;
			const label = (el.getAttribute('aria-label') || el.labels?.[0]?.textContent || (['button','a','summary'].includes(tag) ? el.textContent : '') || '').trim();
			const role = el.getAttribute('role');
			const attrs = {};
			for (const key of ['min','max','minlength','maxlength','step']) {
				const val = el.getAttribute(key);
				if (val && /^(?:-?\d{1,8}(?:\.\d{1,6})?|\d{4}-\d{2}-\d{2})$/.test(val)) attrs[key] = val;
			}
			const pattern = el.getAttribute('pattern');
			const digits = /^(?:\[0-9\]|\\d)\{([1-9]\d?)\}$/.exec(pattern ?? '');
			const form = el.form;
			const action = tag === 'form' && URL.canParse(el.action) ? new URL(el.action) : null;
			elements.push({ ...loc, tag: /^[a-z]+$/.test(tag) ? tag : 'custom', type: /^[a-z-]{1,24}$/.test(type) && !tag.includes('-') ? type : 'custom',
				role: ['tab','button','checkbox','radio','combobox','link','dialog'].includes(role) ? role : null,
				name: publicName.test(label) ? label.toLowerCase() : null, required: !!el.required, readOnly: !!el.readOnly,
				disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true', nativeValidation: el.willValidate === true,
				pattern: el.hasAttribute('pattern'), digitCount: digits ? Number(digits[1]) : undefined, expanded: el.hasAttribute('aria-expanded') ? el.getAttribute('aria-expanded') === 'true' : null,
				formMethod: tag === 'form' ? el.method : undefined,
				action: action?.origin === location.origin && !action.search && !action.username && !action.password ? action.href : undefined,
				formNumber: tag === 'form' ? [...document.forms].indexOf(el) + 1 : undefined,
				form: form ? locationOf(form)?.css : null, attrs, options: tag === 'select' ? Array.from(el.options).filter(o => !o.disabled && !o.parentElement?.disabled).length : undefined,
				destination: tag === 'a' && el.origin === location.origin && !el.search && !el.href.includes('@') && /^[/#a-zA-Z.-]{1,100}$/.test(el.pathname + el.hash) ? el.pathname + el.hash : undefined });
		}
		return { elements, truncated: list.length > 160 || omitted > 0, frames: document.querySelectorAll('iframe,frame').length, shadowHosts: Array.from(document.querySelectorAll('*')).slice(0,1000).some(node => node.shadowRoot) };
	});
	for (const e of evidence.elements) {
		if (e.action) e.action = publicRoute(e.action, allowedPaths) ?? undefined;
		if (e.destination) e.destination = publicRoute(new URL(e.destination, url).href, allowedPaths) ?? undefined;
		e.fingerprint = digest([url, e.css, e.tag, e.type, e.role, e.name, e.form]);
		e.revision = digest(e);
	}
	// A workflow must be re-reviewed if a field or submit control changes.
	for (const form of evidence.elements.filter(e => e.tag === 'form')) {
		form.revision = digest([form.revision,evidence.elements.filter(e => e.form === form.css).map(e => e.revision)]);
	}
	const snapshotId = digest([url, evidence.elements.map(e => e.revision)]);
	return { url, snapshotId, observedAt: Date.now(), ...evidence };
}
