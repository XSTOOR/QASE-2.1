/**
 * Measured business signals for the Founder review.
 *
 * Before the agent judges anything, the host measures what a first-time
 * visitor experiences: the first screen on desktop and on a phone (headline,
 * primary call to action, screenshots), trust signals (social proof, company,
 * legal pages, HTTPS), conversion (pricing, low-risk start, sign-up form
 * length), polish (the QA engine's visual and readability audit), speed and
 * reliability (largest contentful paint, errors, broken links), search and
 * share previews, and retention hooks. Each SIGNAL_KINDS entry becomes one
 * signal with status good | weak | missing | unknown | not_applicable; the
 * agent cites them by id (S1, S2…) and the host scores lenses from them when
 * no model is available.
 */
import { auditPage } from '../qa/detectors/page.js';
import { SIGNAL_KINDS } from './catalog.js';

/** In-page business signals (runs in the browser). */
function businessSignals() {
	const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
	const text = document.body?.innerText ?? '';
	const fold = innerHeight;
	const heading = [...document.querySelectorAll('h1, h2, [role=heading]')].filter(visible).map(element => ({ text: (element.innerText || '').replace(/\s+/g, ' ').trim(), top: element.getBoundingClientRect().top + scrollY, size: parseFloat(getComputedStyle(element).fontSize), tag: element.tagName.toLowerCase() })).filter(item => item.text)
		.sort((a, b) => (a.tag === 'h1' ? -1 : 0) - (b.tag === 'h1' ? -1 : 0) || a.top - b.top)[0];
	const controls = [...document.querySelectorAll('a[href], button, [role=button], input[type=submit]')].filter(visible).map(element => {
		const r = element.getBoundingClientRect(); const s = getComputedStyle(element);
		const label = (element.innerText || element.value || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
		const filled = s.backgroundColor && !/rgba?\(0, 0, 0, 0\)|transparent/.test(s.backgroundColor);
		return { label, top: r.top + scrollY, buttonLike: element.tagName === 'BUTTON' || element.type === 'submit' || filled || /btn|button|cta/i.test(element.className || ''), inNav: Boolean(element.closest('nav, header')) };
	}).filter(item => item.label);
	const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href: a.href }));
	const find = pattern => links.find(link => pattern.test(`${link.text} ${link.href}`));
	const meta = name => document.querySelector(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ?? '';
	const forms = [...document.forms].filter(visible).map(form => {
		const fields = [...form.elements].filter(field => !['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type) && field.tagName !== 'BUTTON' && field.tagName !== 'FIELDSET' && visible(field));
		return { fields: fields.length, required: fields.filter(field => field.required).length, password: fields.some(field => field.type === 'password'), email: fields.some(field => field.type === 'email' || /email/i.test(field.name || field.id || '')), signup: /sign ?up|create|register|join|get started|start free|trial/i.test(form.innerText || ''), names: fields.map(field => field.name || field.id || field.type).slice(0, 12) };
	});
	return {
		url: location.href, title: document.title, fold,
		headline: heading ? { text: heading.text.slice(0, 200), aboveFold: heading.top < fold, words: heading.text.split(/\s+/).length } : null,
		ctas: controls.filter(item => item.buttonLike && /\w/.test(item.label) && !/^(log ?in|sign ?in|menu|close|accept|decline|reject)$/i.test(item.label)).map(item => ({ ...item, action: /get started|start|try|sign ?up|join|create|register|book|request|schedule|buy|shop|order|subscribe|download|install|contact sales|talk to|demo|quote|access|apply|enrol|enroll/i.test(item.label) })),
		socialProof: (text.match(/testimonial|what (our )?(customers|users|clients) say|reviews?\b|rated \d|\d(\.\d)? ?\/ ?5|★|trusted by|used by|loved by|customers? (love|trust)|\d[\d,.]*\+? (customers|users|teams|companies|students|members|downloads)/gi) ?? []).length + document.querySelectorAll('blockquote, [class*=testimonial i], [class*=review i], [class*=logo-cloud i], [class*=logos i]').length,
		about: Boolean(find(/about|team|company|our story|who we are/i)), contact: Boolean(find(/contact|support|help|chat with/i)) || /[\w.+-]+@[\w-]+\.[\w.]+/.test(text),
		privacy: Boolean(find(/privacy/i)), terms: Boolean(find(/terms|conditions|\btos\b/i)),
		pricingLink: find(/pricing|plans|price/i)?.href ?? null,
		prices: (text.match(/[$€£₹¥]\s?\d[\d,.]*|\d[\d,.]*\s?(usd|eur|gbp|inr)\b|\/\s?(mo|month|yr|year)\b|per (month|user|seat|year)/gi) ?? []).length,
		freeStart: /free (plan|trial|forever|tier|to start|account)|start (for )?free|try (it )?(for )?free|no credit card|free demo|book a demo|request a demo|freemium|\bfree\b.{0,20}(sign ?up|start)/i.test(text),
		signupLink: find(/sign ?up|get started|register|create account|start free|try free|join/i)?.href ?? null,
		socialLogin: /continue with (google|apple|github|microsoft)|sign (in|up) with (google|apple|github|microsoft)/i.test(text),
		forms,
		meta: { title: document.title, description: meta('description'), ogTitle: meta('og:title'), ogImage: meta('og:image'), twitter: meta('twitter:card'), canonical: document.querySelector('link[rel=canonical]')?.href ?? '' },
		hooks: [find(/blog|guides?|resources|articles|learn|academy|docs/i) ? 'content' : '', find(/discord|slack|community|forum/i) ? 'community' : '', find(/apps\.apple|play\.google|app store|google play/i) ? 'apps' : '', /newsletter|subscribe|stay (in the loop|updated)|get updates/i.test(text) ? 'newsletter' : '', find(/twitter\.com|x\.com|linkedin\.com|instagram\.com|youtube\.com|facebook\.com|tiktok\.com/i) ? 'social' : ''].filter(Boolean),
		overflow: document.documentElement.scrollWidth > innerWidth + 2 ? document.documentElement.scrollWidth : 0,
		internalLinks: [...new Set(links.map(link => link.href.split('#')[0]).filter(href => { try { return new URL(href).origin === location.origin; } catch { return false; } }))].slice(0, 60)
	};
}

/**
 * Measures the business signals. Returns { signals, screenshots, pages }.
 * `save(bytes, label)` stores a screenshot artifact and returns its id.
 */
export async function collectSignals({ browser, profile, mobile, targetUrl, pages = [], fetchImpl = fetch, save, deadline = Infinity, progress = async () => {} }) {
	const facts = { desktop: undefined, mobile: undefined, pages: [], visual: [], readability: [], metrics: undefined, errors: [], failed: [], broken: [] };
	const screenshots = [];
	const keyPages = [...new Set([targetUrl, ...pages])].slice(0, 6);

	for (const [index, url] of keyPages.entries()) {
		if (Date.now() >= deadline) break;
		await progress(`Measuring ${(() => { try { return new URL(url).pathname; } catch { return url; } })()}`);
		const { page, log } = await browser.openPage(profile);
		browser.setActivePage(page);
		try {
			await browser.goto(page, url, log);
			await browser.settle?.(page, { quietMs: 800 }).catch?.(() => {});
			const read = await page.evaluate(businessSignals).catch(() => undefined);
			if (read) facts.pages.push(read);
			if (index === 0) {
				facts.desktop = read;
				const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => undefined);
				const artifactId = await save(shot, 'First screen on desktop');
				if (artifactId) screenshots.push({ id: artifactId, label: 'First screen — desktop', url });
				const audit = await auditPage(page, { url, viewport: profile.name, touch: profile.hasTouch, log, save, maxScreens: 3 }).catch(() => ({ candidates: [] }));
				facts.metrics = audit.metrics;
				for (const item of audit.candidates ?? []) {
					if (/overlap|hidden_content|broken_image|truncat|clipped|horizontal_overflow|layout_shift|text_overflow/.test(item.detector)) facts.visual.push(item);
					else if (/low_contrast|field_no_label|image_alt_missing|control_no_name/.test(item.detector)) facts.readability.push(item);
				}
			}
			facts.errors.push(...log.pageErrors.map(error => ({ url, message: error.message })), ...log.console.filter(item => item.type === 'error' && !/^Failed to load resource/i.test(item.text)).map(item => ({ url, message: item.text })));
			facts.failed.push(...log.failedRequests.filter(item => !/favicon/.test(item.url)).map(item => ({ url, request: item.url })), ...log.responses.filter(item => item.status >= 400 && item.resourceType !== 'document' && !/favicon/.test(item.url)).map(item => ({ url, request: `${item.url} (HTTP ${item.status})` })));
		} catch { /* a page that fails to load is simply not measured */ }
		finally { await page.close().catch(() => {}); }
	}

	// The first screen on a phone.
	if (mobile && Date.now() < deadline) {
		await progress('Checking the first screen on a phone');
		const { page, log } = await browser.openPage(mobile);
		try {
			await browser.goto(page, targetUrl, log);
			facts.mobile = await page.evaluate(businessSignals).catch(() => undefined);
			const shot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => undefined);
			const artifactId = await save(shot, 'First screen on a phone');
			if (artifactId) screenshots.push({ id: artifactId, label: 'First screen — phone', url: targetUrl });
			const audit = await auditPage(page, { url: targetUrl, viewport: mobile.name, touch: true, log, save, maxScreens: 2 }).catch(() => ({ candidates: [] }));
			facts.mobileIssues = (audit.candidates ?? []).filter(item => /horizontal_overflow|small_touch_targets|overlap|text_overflow/.test(item.detector));
		} catch { /* not measured */ }
		finally { await page.close().catch(() => {}); }
	}

	// Broken internal links (HEAD, then GET when HEAD is refused).
	const links = [...new Set(facts.pages.flatMap(item => item.internalLinks ?? []))].filter(href => !/log ?out|sign ?out|\.(pdf|zip)$/i.test(href)).slice(0, 40);
	for (const href of links) {
		if (Date.now() >= deadline) break;
		try {
			let response = await fetchImpl(href, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(6000) });
			if ([405, 501].includes(response.status)) response = await fetchImpl(href, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
			if (response.status >= 400) facts.broken.push({ href, status: response.status });
		} catch { /* unreachable links are not counted as broken: they may be blocked by policy */ }
	}

	return { signals: toSignals(facts, { targetUrl }), screenshots, facts: summarizeFacts(facts) };
}

/** Converts raw measurements into SIGNAL_KINDS entries. Exported for tests. */
export function toSignals(facts, { targetUrl }) {
	const home = facts.desktop, phone = facts.mobile, all = facts.pages ?? [];
	const any = key => all.some(page => page?.[key]);
	const out = [];
	const add = (kind, status, detail, extra = {}) => out.push({ id: `S${out.length + 1}`, kind, lens: SIGNAL_KINDS[kind].lens, title: SIGNAL_KINDS[kind].title, status, detail: String(detail).slice(0, 600), urls: extra.urls ?? [targetUrl], ...(extra.value !== undefined ? { value: extra.value } : {}), ...(extra.artifactId ? { artifactId: extra.artifactId } : {}) });
	if (!home) {
		for (const kind of Object.keys(SIGNAL_KINDS)) add(kind, 'unknown', 'The start page could not be measured.');
		return out;
	}
	const headline = home.headline;
	add('value.headline', !headline ? 'missing' : !headline.aboveFold ? 'weak' : headline.words > 12 ? 'weak' : 'good',
		!headline ? 'No headline was found on the start page.' : `"${headline.text}" (${headline.words} words${headline.aboveFold ? ', above the fold' : ', below the first screen'}).`, { value: headline?.text });
	const firstScreen = (home.ctas ?? []).filter(item => item.top < home.fold && item.action && !item.inNav);
	const navCta = (home.ctas ?? []).filter(item => item.top < home.fold && item.action && item.inNav);
	add('value.cta_above_fold', firstScreen.length ? 'good' : navCta.length ? 'weak' : 'missing',
		firstScreen.length ? `First-screen actions: ${[...new Set(firstScreen.map(item => item.label))].slice(0, 4).join(', ')}.` : navCta.length ? `Only the navigation offers an action (${navCta[0].label}); the hero has no call to action.` : 'No call to action is visible on the first desktop screen.');
	const distinct = [...new Set(firstScreen.map(item => item.label.toLowerCase()))];
	add('value.cta_focus', !firstScreen.length ? 'not_applicable' : distinct.length <= 2 ? 'good' : distinct.length <= 4 ? 'weak' : 'missing', `${distinct.length} distinct action${distinct.length === 1 ? '' : 's'} compete on the first screen${distinct.length ? `: ${distinct.slice(0, 6).join(', ')}` : ''}.`, { value: distinct.length });
	const proof = all.reduce((sum, page) => sum + (page.socialProof ?? 0), 0);
	add('trust.social_proof', proof >= 3 ? 'good' : proof >= 1 ? 'weak' : 'missing', proof ? `${proof} social-proof cue${proof === 1 ? '' : 's'} (testimonials, reviews, logos or usage numbers) across ${all.length} pages.` : `No testimonials, reviews, customer logos or usage numbers on ${all.length} pages.`, { value: proof });
	add('trust.company', any('about') && any('contact') ? 'good' : any('about') || any('contact') ? 'weak' : 'missing', `About page: ${any('about') ? 'yes' : 'no'}; contact channel: ${any('contact') ? 'yes' : 'no'}.`);
	add('trust.legal', any('privacy') && any('terms') ? 'good' : any('privacy') || any('terms') ? 'weak' : 'missing', `Privacy policy: ${any('privacy') ? 'linked' : 'not found'}; terms: ${any('terms') ? 'linked' : 'not found'}.`);
	add('trust.https', String(targetUrl).startsWith('https:') ? 'good' : 'missing', String(targetUrl).startsWith('https:') ? 'Served over HTTPS.' : 'Served over plain HTTP.');
	const priced = all.some(page => (page.prices ?? 0) >= 2);
	const pricingLink = all.map(page => page.pricingLink).find(Boolean);
	const pricingBroken = pricingLink && (facts.broken ?? []).some(item => item.href.split('#')[0] === pricingLink.split('#')[0]);
	add('conversion.pricing', priced && !pricingBroken ? 'good' : pricingLink && !pricingBroken ? 'weak' : 'missing', pricingBroken ? `The pricing link (${pricingLink}) is broken.` : priced ? 'Prices are shown.' : pricingLink ? `A pricing page is linked (${pricingLink}) but no prices were read on the pages measured.` : 'No pricing page or prices were found.', { urls: pricingLink ? [pricingLink] : [targetUrl] });
	add('conversion.free_start', any('freeStart') ? 'good' : 'missing', any('freeStart') ? 'A free plan, trial or demo is offered.' : 'No free plan, trial or demo is mentioned.');
	const signupForms = all.flatMap(page => (page.forms ?? []).filter(form => form.password || form.signup).map(form => ({ ...form, url: page.url })));
	const shortest = signupForms.sort((a, b) => a.fields - b.fields)[0];
	add('onboarding.signup_found', signupForms.length || any('signupLink') ? 'good' : 'missing', signupForms.length ? `Sign-up form on ${shortest.url}.` : any('signupLink') ? 'A sign-up link is present.' : 'No sign-up form or link was found on the pages measured.');
	add('onboarding.signup_friction', !shortest ? 'unknown' : shortest.fields <= 3 || any('socialLogin') ? 'good' : shortest.fields <= 5 ? 'weak' : 'missing',
		!shortest ? 'No sign-up form was measured.' : `${shortest.fields} fields (${shortest.required} required: ${shortest.names.join(', ')})${any('socialLogin') ? '; one-click sign-in is offered' : '; no one-click sign-in'}.`, { urls: shortest ? [shortest.url] : [targetUrl], value: shortest?.fields });
	const visual = facts.visual ?? [];
	add('experience.visual_issues', visual.length === 0 ? 'good' : visual.length <= 2 ? 'weak' : 'missing', visual.length ? visual.slice(0, 4).map(item => item.title).join('; ') : 'No overlaps, broken images or invisible content on the start page.', { artifactId: visual.find(item => item.artifactId)?.artifactId });
	const readability = facts.readability ?? [];
	add('experience.readability', readability.length === 0 ? 'good' : readability.length <= 2 ? 'weak' : 'missing', readability.length ? readability.slice(0, 4).map(item => item.title).join('; ') : 'Contrast, labels and alt text are fine on the start page.');
	const overflowIssue = (facts.mobileIssues ?? []).find(item => /horizontal_overflow/.test(item.detector));
	add('mobile.layout', !phone ? 'unknown' : phone.overflow || overflowIssue ? 'missing' : (facts.mobileIssues ?? []).length ? 'weak' : 'good',
		!phone ? 'The phone layout was not measured.' : phone.overflow ? `The page is ${phone.overflow}px wide on a 390px phone, so it scrolls sideways.` : (facts.mobileIssues ?? []).length ? facts.mobileIssues.slice(0, 3).map(item => item.title).join('; ') : 'Fits the phone screen.');
	const phoneCta = (phone?.ctas ?? []).filter(item => item.top < phone.fold && item.action);
	add('mobile.cta', !phone ? 'unknown' : phoneCta.length ? 'good' : 'missing', !phone ? 'Not measured.' : phoneCta.length ? `Visible on the first phone screen: ${phoneCta[0].label}.` : 'No call to action on the first phone screen.');
	const lcp = facts.metrics?.lcpMs ?? facts.metrics?.loadMs;
	add('performance.speed', lcp === undefined ? 'unknown' : lcp <= 2500 ? 'good' : lcp <= 4000 ? 'weak' : 'missing', lcp === undefined ? 'Load timing was not available.' : `Main content shown after ${(lcp / 1000).toFixed(1)} s${facts.metrics?.transferBytes ? `; ${(facts.metrics.transferBytes / 1e6).toFixed(1)} MB transferred` : ''}.`, { value: lcp });
	const errors = [...new Set((facts.errors ?? []).map(item => item.message.slice(0, 120)))];
	const failed = [...new Set((facts.failed ?? []).map(item => item.request))];
	add('performance.errors', errors.length + failed.length === 0 ? 'good' : errors.length + failed.length <= 2 ? 'weak' : 'missing', errors.length + failed.length ? [errors.length ? `${errors.length} JavaScript error${errors.length === 1 ? '' : 's'} (${errors.slice(0, 2).join('; ')})` : '', failed.length ? `${failed.length} failed request${failed.length === 1 ? '' : 's'} (${failed.slice(0, 2).join('; ')})` : ''].filter(Boolean).join('; ') : 'No errors or failed requests on the key pages.');
	const broken = facts.broken ?? [];
	add('performance.broken_links', broken.length === 0 ? 'good' : broken.length <= 1 ? 'weak' : 'missing', broken.length ? `${broken.length} broken link${broken.length === 1 ? '' : 's'}: ${broken.slice(0, 4).map(item => `${(() => { try { return new URL(item.href).pathname; } catch { return item.href; } })()} (HTTP ${item.status})`).join(', ')}.` : 'All internal links checked respond.', { urls: broken.map(item => item.href).slice(0, 5) });
	const metaInfo = home.meta ?? {};
	const titleOk = metaInfo.title && metaInfo.title.length >= 15 && metaInfo.title.length <= 70;
	add('discoverability.meta', titleOk && metaInfo.description ? 'good' : metaInfo.title && (metaInfo.description || titleOk) ? 'weak' : 'missing', `Title: "${metaInfo.title || 'none'}" (${(metaInfo.title || '').length} chars); meta description: ${metaInfo.description ? `${metaInfo.description.length} chars` : 'missing'}.`);
	add('discoverability.sharing', metaInfo.ogTitle && metaInfo.ogImage ? 'good' : metaInfo.ogTitle || metaInfo.ogImage || metaInfo.twitter ? 'weak' : 'missing', `Open Graph title: ${metaInfo.ogTitle ? 'yes' : 'no'}; share image: ${metaInfo.ogImage ? 'yes' : 'no'}; Twitter card: ${metaInfo.twitter ? 'yes' : 'no'}.`);
	const hooks = [...new Set(all.flatMap(page => page.hooks ?? []))];
	add('retention.hooks', hooks.length >= 2 ? 'good' : hooks.length === 1 ? 'weak' : 'missing', hooks.length ? `Found: ${hooks.join(', ')}.` : 'No newsletter, content, community, apps or social channels.');
	return out;
}

function summarizeFacts(facts) {
	return {
		headline: facts.desktop?.headline?.text, title: facts.desktop?.title, pagesMeasured: facts.pages.length,
		lcpMs: facts.metrics?.lcpMs, brokenLinks: facts.broken.length, errors: facts.errors.length, failedRequests: facts.failed.length
	};
}
