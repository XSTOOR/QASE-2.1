/**
 * Measured compliance evidence.
 *
 * Before the agent tests anything by hand, the host measures what can be
 * measured exactly: accessibility (the QA engine's page audit, including a
 * 320 px reflow pass), security (headers, cookies, TLS, exposed files, safe
 * injection probes) and privacy signals (policy and terms links, cookie
 * consent, trackers that load before consent, contact and accessibility
 * statements, child-directed notices, notices on data-collecting forms).
 *
 * Each EVIDENCE_KINDS entry becomes one evidence item with status
 * ok | issue | not_applicable | unknown, the observations behind it and the
 * pages it was seen on. Requirements reference these items by kind.
 */
import { auditPage } from '../qa/detectors/page.js';
import { auditOrigin, auditPageSecurity, probeInjection, probeRedirects } from '../qa/detectors/security.js';
import { EVIDENCE_KINDS } from './catalog.js';

const DETECTOR_KIND = {
	'page.image_alt_missing': 'a11y.images_alt', 'page.field_no_label': 'a11y.form_labels', 'page.low_contrast': 'a11y.contrast',
	'page.control_no_name': 'a11y.control_names', 'page.missing_lang': 'a11y.lang', 'page.zoom_disabled': 'a11y.zoom',
	'page.small_touch_targets': 'a11y.touch_targets', 'page.missing_h1': 'a11y.headings', 'page.missing_title': 'a11y.page_title',
	'security.https_redirect_missing': 'sec.https', 'security.hsts_missing': 'sec.hsts', 'security.csp_missing': 'sec.csp', 'security.csp_weak': 'sec.csp',
	'security.clickjacking': 'sec.clickjacking', 'security.nosniff_missing': 'sec.nosniff', 'security.cookie_flags': 'sec.cookie_flags',
	'security.exposed_file': 'sec.exposed_files', 'security.vulnerable_library': 'sec.vulnerable_libraries', 'security.client_secret': 'sec.client_secrets',
	'security.password_over_http': 'sec.password_transport', 'security.insecure_form_action': 'sec.password_transport',
	'security.reflected_xss': 'sec.injection', 'security.dom_xss': 'sec.injection', 'security.sql_error': 'sec.injection', 'security.open_redirect': 'sec.injection'
};

/** Cookies and request hosts that indicate analytics/advertising tracking. */
const TRACKING_COOKIE = /^(_ga|_gid|_gat|_gcl_|_fbp|fr$|_hj|_clck|_clsk|_uet|ajs_|mp_|amplitude|_pin_|_tt_|li_|bcookie|IDE$|test_cookie|NID$|_ym)/i;
const TRACKER_HOST = /(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.net|connect\.facebook|hotjar\.com|clarity\.ms|segment\.(io|com)|mixpanel\.com|amplitude\.com|snap\.licdn\.com|ads-twitter\.com|analytics\.tiktok\.com|bat\.bing\.com|plausible\.io|matomo)/i;

/** In-page privacy and transparency signals. */
function privacySignals() {
	const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
	const links = [...document.querySelectorAll('a[href]')].map(a => ({ text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80), href: a.href }));
	const find = pattern => links.find(link => pattern.test(`${link.text} ${link.href}`));
	const text = document.body?.innerText ?? '';
	const banner = [...document.querySelectorAll('div,section,aside,dialog,[role=dialog],[role=region],footer')].filter(element => visible(element) && /cookie|consent|tracking/i.test(element.innerText || '') && (element.innerText || '').length < 1500 && element.querySelector('button,a,[role=button]')).sort((a, b) => (a.innerText.length - b.innerText.length))[0];
	const buttons = banner ? [...banner.querySelectorAll('button,a,[role=button]')].map(button => (button.innerText || button.getAttribute('aria-label') || '').trim()) : [];
	const forms = [...document.forms].filter(visible).map(form => {
		const fields = [...form.elements].filter(field => /email|name|phone|tel|mobile|address|birth|dob|age|school|student|password/i.test(`${field.type} ${field.name} ${field.id} ${field.placeholder} ${field.getAttribute('autocomplete') ?? ''}`));
		const region = form.closest('section,main,div') ?? form;
		return { personal: fields.length > 0, fields: fields.map(field => field.name || field.id || field.type).slice(0, 6), notice: /privacy|data protection|personal data|policy/i.test(region.innerText || '') || Boolean(region.querySelector('a[href*=privacy i]')) };
	});
	return {
		privacy: find(/privacy|data[- ]protection|datenschutz/i), terms: find(/terms|conditions|\btos\b|legal/i), cookies: find(/cookie/i),
		accessibility: find(/accessibility|a11y/i), contact: find(/contact|support|help|grievance|imprint|impressum/i) ?? (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text) ? { text: 'email address', href: '' } : undefined),
		banner: banner ? { text: banner.innerText.replace(/\s+/g, ' ').trim().slice(0, 200), buttons } : null,
		children: /\b(kids?|children|child|students?|pupils?|parents?|guardians?|grade \d|class \d|k-12|ages? \d{1,2}|under 1[3-8])\b/i.test(text),
		forms
	};
}

export async function collectEvidence({ browser, profile, mobile, targetUrl, pages = [], mainResponse, cookies = [], fetchImpl, save, deadline = Infinity, progress = async () => {} }) {
	const found = new Map(); // kind -> [{ title, detail, url, artifactId }]
	const measured = new Set();
	const note = (kind, entry) => { measured.add(kind); if (entry) { if (!found.has(kind)) found.set(kind, []); if (found.get(kind).length < 6) found.get(kind).push(entry); } };
	const fromCandidates = (list, { reflow = false } = {}) => {
		for (const item of list) {
			const kind = reflow ? (item.detector === 'page.horizontal_overflow' ? 'a11y.reflow' : undefined) : DETECTOR_KIND[item.detector];
			if (kind) note(kind, { title: item.title, detail: item.actual, url: item.url, artifactId: item.artifactId });
		}
	};
	const signals = [];
	const firstLoad = { cookies: [], trackers: [] };
	const keyPages = [...new Set([targetUrl, ...pages])].slice(0, 5);

	// Accessibility + privacy signals per page (desktop).
	for (const [index, url] of keyPages.entries()) {
		if (Date.now() >= deadline) break;
		await progress(`Measuring ${new URL(url).pathname}`);
		const { page, log } = await browser.openPage(profile);
		browser.setActivePage(page);
		try {
			await browser.goto(page, url, log);
			if (index === 0) {
				// What loads before the visitor has made any choice.
				firstLoad.cookies = (await page.context().cookies()).map(cookie => ({ name: cookie.name, domain: cookie.domain }));
				firstLoad.trackers = [...new Set((log.responses ?? []).map(item => item.url).filter(href => TRACKER_HOST.test(href)).map(href => new URL(href).host))];
				fromCandidates(await auditPageSecurity(page, { url, viewport: profile.name, fetchImpl }).catch(() => []));
				for (const kind of ['sec.vulnerable_libraries', 'sec.client_secrets']) measured.add(kind);
			}
			const result = await auditPage(page, { url, viewport: profile.name, touch: profile.hasTouch, log, save, maxScreens: 3 });
			fromCandidates(result.candidates);
			for (const kind of ['a11y.images_alt', 'a11y.form_labels', 'a11y.contrast', 'a11y.control_names', 'a11y.lang', 'a11y.zoom', 'a11y.headings', 'a11y.page_title']) measured.add(kind);
			signals.push({ url, ...await page.evaluate(privacySignals).catch(() => ({})) });
		} catch { /* a page that fails to load is simply not measured */ }
		finally { await page.close().catch(() => {}); }
	}

	// Touch targets and reflow on a phone, then at 320 CSS px.
	for (const [variant, viewportProfile] of [['mobile', mobile], ['reflow', { ...mobile, name: 'reflow', label: 'Reflow 320×640', viewport: { width: 320, height: 640 } }]]) {
		if (!viewportProfile || Date.now() >= deadline) continue;
		await progress(variant === 'reflow' ? 'Checking reflow at 320 px' : 'Checking the phone layout');
		const { page, log } = await browser.openPage(viewportProfile);
		try {
			await browser.goto(page, targetUrl, log);
			const result = await auditPage(page, { url: targetUrl, viewport: viewportProfile.name, touch: true, log, save, maxScreens: 3 });
			if (variant === 'reflow') { fromCandidates(result.candidates, { reflow: true }); measured.add('a11y.reflow'); }
			else { fromCandidates(result.candidates.filter(item => item.detector === 'page.small_touch_targets')); measured.add('a11y.touch_targets'); }
		} catch { /* not measured */ }
		finally { await page.close().catch(() => {}); }
	}

	// Site-wide security.
	if (Date.now() < deadline) {
		await progress('Checking security headers, cookies and exposed files');
		fromCandidates(await auditOrigin({ targetUrl, mainResponse, cookies, fetchImpl, deadline }).catch(() => []));
		for (const kind of ['sec.https', 'sec.hsts', 'sec.csp', 'sec.clickjacking', 'sec.nosniff', 'sec.cookie_flags', 'sec.exposed_files', 'sec.password_transport']) measured.add(kind);
		if (!targetUrl.startsWith('https:')) note('sec.https', { title: 'The site is served over plain HTTP', detail: `${targetUrl} does not use HTTPS.`, url: targetUrl });
	}
	if (Date.now() < deadline) {
		await progress('Running safe injection probes');
		fromCandidates(await probeInjection({ browser, profile, url: targetUrl, params: [], fetchImpl, deadline }).catch(() => []));
		fromCandidates(await probeRedirects({ urls: [targetUrl], fetchImpl, deadline }).catch(() => []));
		measured.add('sec.injection');
	}

	// Privacy and transparency from the collected signals.
	const any = key => signals.find(item => item[key])?.[key];
	const urls = signals.map(item => item.url);
	const privacyLink = any('privacy');
	note('privacy.policy_link', privacyLink ? undefined : { title: 'No privacy policy link found', detail: `None of the ${signals.length} pages checked links to a privacy policy.`, url: targetUrl });
	note('privacy.terms_link', any('terms') ? undefined : { title: 'No terms of service link found', detail: `None of the ${signals.length} pages checked links to terms of service.`, url: targetUrl });
	note('privacy.contact_info', any('contact') ? undefined : { title: 'No contact or grievance channel found', detail: 'No contact page, support link or email address was found.', url: targetUrl });
	note('privacy.accessibility_statement', any('accessibility') ? undefined : { title: 'No accessibility statement found', detail: 'No page links to an accessibility statement or accessibility contact.', url: targetUrl });
	const trackingCookies = firstLoad.cookies.filter(cookie => TRACKING_COOKIE.test(cookie.name));
	const tracking = trackingCookies.length || firstLoad.trackers.length;
	note('privacy.tracking_before_consent', tracking ? { title: 'Tracking starts before the visitor consents', detail: `On first load, before any choice: ${[trackingCookies.length ? `cookies ${trackingCookies.map(cookie => cookie.name).slice(0, 6).join(', ')}` : '', firstLoad.trackers.length ? `requests to ${firstLoad.trackers.slice(0, 6).join(', ')}` : ''].filter(Boolean).join('; ')}.`, url: targetUrl } : undefined);
	const banner = signals[0]?.banner;
	if (banner) {
		note('privacy.cookie_banner');
		const reject = banner.buttons.some(label => /reject|decline|deny|refuse|necessary only|only necessary|essential only/i.test(label));
		note('privacy.cookie_reject', reject ? undefined : { title: 'The cookie notice has no equal "reject" option', detail: `Notice: "${banner.text}". Buttons: ${banner.buttons.join(', ') || 'none'}.`, url: targetUrl });
	} else if (tracking) {
		note('privacy.cookie_banner', { title: 'No cookie consent notice', detail: 'Tracking cookies or trackers load, but no consent notice is shown.', url: targetUrl });
		note('privacy.cookie_reject', { title: 'Visitors cannot refuse tracking', detail: 'There is no consent notice, so non-essential cookies cannot be refused.', url: targetUrl });
	}
	const personalForms = signals.flatMap(item => (item.forms ?? []).filter(form => form.personal).map(form => ({ ...form, url: item.url })));
	if (personalForms.length) {
		const silent = personalForms.filter(form => !form.notice);
		note('privacy.form_notice', silent.length ? { title: 'A form collects personal data without a privacy notice', detail: silent.slice(0, 3).map(form => `${new URL(form.url).pathname} (${form.fields.join(', ')})`).join('; '), url: silent[0].url } : undefined);
	}
	const childCues = signals.some(item => item.children);
	if (childCues) {
		let policyText = '';
		if (privacyLink?.href && Date.now() < deadline) {
			const { page, log } = await browser.openPage(profile);
			try { await browser.goto(page, privacyLink.href, log); policyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''); } catch { /* unreadable */ }
			finally { await page.close().catch(() => {}); }
		}
		note('privacy.children_notice', /\b(parent|guardian|children|child|minor|under (?:the age of )?1[3-8])\b/i.test(policyText) ? undefined
			: { title: 'No parental-consent or children’s notice', detail: privacyLink ? 'The site addresses children or students, but its privacy policy does not mention children, minors or parental consent.' : 'The site addresses children or students, and has no privacy policy.', url: privacyLink?.href ?? targetUrl });
	}

	return Object.entries(EVIDENCE_KINDS).map(([kind, title], index) => {
		const issues = found.get(kind) ?? [];
		const applicable = !(kind === 'privacy.children_notice' && !childCues) && !(kind === 'privacy.form_notice' && !personalForms.length) && !(['privacy.cookie_banner', 'privacy.cookie_reject'].includes(kind) && !banner && !tracking);
		const status = !applicable ? 'not_applicable' : issues.length ? 'issue' : measured.has(kind) ? 'ok' : 'unknown';
		return {
			id: `E${index + 1}`, kind, title, status,
			detail: status === 'issue' ? issues.map(item => `${item.title}${item.detail ? ` — ${String(item.detail).slice(0, 240)}` : ''}`).slice(0, 4).join(' | ')
				: status === 'ok' ? `Checked on ${urls.length || 1} page${urls.length === 1 ? '' : 's'}; no problem found.`
					: status === 'not_applicable' ? 'Not applicable to what was observed.' : 'Could not be measured in this run.',
			urls: [...new Set(issues.map(item => item.url).filter(Boolean))].slice(0, 5),
			artifactId: issues.find(item => item.artifactId)?.artifactId
		};
	});
}
