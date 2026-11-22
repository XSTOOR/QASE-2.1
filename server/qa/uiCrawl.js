import { openOverlays } from './overlays.js';
/**
 * Interactive feature discovery for single-page apps. Many apps navigate with
 * buttons (icon sidebars, tabs, menus) instead of links, so a link crawler
 * sees one page. This walks the UI instead: on each known screen it finds the
 * navigation-like controls, clicks each one (read-only: writes stay blocked,
 * destructive labels are refused), and records what appeared:
 *
 *   route  the URL changed to a new screen → a new page in the graph
 *   panel  same URL, different content (tab, drawer, dialog, settings pane)
 *
 * Nothing is site specific: controls are found by role, landmark and layout.
 */

const DESTRUCTIVE = /\b(delete|remove|destroy|erase|log ?out|sign ?out|unsubscribe|deactivate|pay|purchase|buy|checkout|place order|transfer|close account|reset|revoke|archive)\b/i;

/** URL with id-like path segments replaced by :id, so /chat/<uuid> is one screen. */
export function routeTemplate(url) {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname.split('/').map(segment => {
			if (!segment) return segment;
			if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':id';
			if (/^\d+$/.test(segment)) return ':id';
			if (/^[0-9a-f]{10,}$/i.test(segment)) return ':id';
			if (segment.length >= 16 && /\d/.test(segment) && /[a-z]/i.test(segment) && !/-[a-z]{3,}-/i.test(segment)) return ':id';
			return segment;
		}).join('/');
		return `${parsed.origin}${path}`;
	} catch { return url; }
}

/** Tags navigation-like controls on the page; returns their labels. Runs in the page. */
function tagNavControls(max) {
	const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 6 && r.height > 6 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1; };
	const label = el => (el.getAttribute('aria-label') || el.innerText || el.title || el.getAttribute('data-tooltip') || el.querySelector('[class*=label i], span')?.innerText || '').replace(/\s+/g, ' ').trim();
	const inRegion = el => {
		if (el.closest('nav, aside, header, [role=navigation], [role=tablist], [role=menu], [role=menubar], [class*=sidebar i], [class*=sidenav i], [class*=navbar i], [class*=tabs i]')) return 'nav';
		const r = el.getBoundingClientRect();
		// Icon rails and top bars: controls in a narrow column at the left or a strip at the top.
		if (r.left < 120 && r.width < 140) return 'rail';
		if (r.top < 72) return 'top';
		if (el.matches('[role=tab], [role=menuitem]')) return 'tabs';
		// Body controls that open something: they declare a popup/expansion, or say so in their label.
		if (el.matches('[aria-haspopup], [aria-expanded], [aria-controls], summary')) return 'opener';
		if (/^(open|view|show|details|more|see all|settings|preferences|options|filters?|manage|history|info|about|help|profile|account|activity|share|invite|members|integrations|notifications)\b/i.test(label(el)) && !el.matches('[type=submit]')) return 'opener';
		return '';
	};
	for (const el of document.querySelectorAll('[data-qase-nav]')) el.removeAttribute('data-qase-nav');
	const seen = new Set();
	const out = [];
	for (const el of document.querySelectorAll('a, button, [role=button], [role=tab], [role=menuitem], [role=link], [tabindex="0"]')) {
		if (out.length >= max) break;
		if (!visible(el) || el.closest('form') || el.closest('[data-qase-ignore]')) continue;
		const region = inRegion(el);
		if (!region) continue;
		const text = label(el);
		if (!text || text.length > 40) continue;
		const href = el.getAttribute('href');
		if (href && /^(https?:)?\/\//.test(href) && !href.startsWith(location.origin)) continue;
		const key = `${text}|${href ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		el.setAttribute('data-qase-nav', String(out.length));
		out.push({ index: out.length, label: text, region, href: href ?? undefined });
	}
	return out;
}

/** A compact fingerprint of what the screen shows. Runs in the page. */
function screenSignature() {
	const heading = [...document.querySelectorAll('h1, h2, [role=heading]')].filter(h => h.getBoundingClientRect().height > 0).map(h => h.innerText.trim()).filter(Boolean).slice(0, 3).join(' · ').slice(0, 160);
	const dialog = [...document.querySelectorAll('[role=dialog], [aria-modal=true], dialog[open]')].find(d => d.getBoundingClientRect().height > 0);
	const main = (document.querySelector('main, [role=main]') ?? document.body);
	const text = (main.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
	const controls = document.querySelectorAll('button, a, input, select, textarea').length;
	return { url: location.href, heading, dialog: dialog ? (dialog.getAttribute('aria-label') || dialog.innerText || '').trim().slice(0, 80) : '', text, controls };
}

const different = (a, b) => a.url.split('#')[0] !== b.url.split('#')[0] || a.heading !== b.heading || a.dialog !== b.dialog || Math.abs(a.controls - b.controls) > 6 || similarity(a.text, b.text) < 0.6;
function similarity(a, b) {
	const wa = new Set(a.toLowerCase().split(' ')); const wb = new Set(b.toLowerCase().split(' '));
	const inter = [...wa].filter(word => wb.has(word)).length;
	return inter / Math.max(1, Math.max(wa.size, wb.size));
}

/**
 * Walks the UI from `starts`. open(url) → { page, log } must handle sign-in and
 * overlays. onView(view) receives { kind, url, from, label, heading, dialog }.
 */
export async function discoverViews({ browser, open, prepare = async () => {}, starts, inScope, deadline, maxScreens = 12, maxControls = 24, knownTemplates = new Set(), onView = () => {}, progress = () => {} }) {
	const queue = starts.map(url => ({ url, depth: 0 }));
	const templates = new Set(knownTemplates);
	for (const item of starts) templates.add(routeTemplate(item));
	const visitedBases = new Set();
	const views = [];
	// Pop-ups already dismissed once (tours, banners) are cleared again whenever they return;
	// anything else that appears after a click is a real dialog and is recorded.
	const knownPopups = new Set();
	const clear = async page => {
		const done = await prepare(page);
		for (const item of done ?? []) knownPopups.add(String(item).split(' → ')[0].slice(0, 50));
	};
	while (queue.length && Date.now() < deadline && visitedBases.size < maxScreens) {
		const { url: base, depth } = queue.shift();
		if (visitedBases.has(routeTemplate(base))) continue;
		visitedBases.add(routeTemplate(base));
		let page, log;
		try { ({ page, log } = await open(base)); } catch { continue; }
		await clear(page);
		try {
			const controls = await page.evaluate(tagNavControls, maxControls).catch(() => []);
			const baseUrl = page.url();
			const panels = new Set();
			for (const control of controls) {
				if (Date.now() >= deadline) break;
				if (DESTRUCTIVE.test(control.label)) continue;
				await progress(`Exploring "${control.label}" on ${new URL(baseUrl).pathname}`);
				// Fresh state for each control: return to the base screen and re-tag.
				if (page.url() !== baseUrl || control.index > 0) {
					await browser.goto(page, baseUrl, log, { quietMs: 700 }).catch(() => {});
					await clear(page);
					await page.evaluate(tagNavControls, maxControls).catch(() => []);
				}
				const before = await page.evaluate(screenSignature).catch(() => undefined);
				const target = page.locator(`[data-qase-nav="${control.index}"]`).first();
				if (!before || !await target.count().catch(() => 0)) continue;
				await browser.pointAt?.(page, target, control.label);
				const clicked = await browser.interact(() => target.click({ timeout: 4000 })).then(() => true).catch(() => false);
				if (!clicked) continue;
				await browser.settle(page, { quietMs: 900 }).catch(() => {});
				// A new screen can open with its own tour; the signature must describe the screen, not the pop-up.
				if (page.url().split('#')[0] !== before.url.split('#')[0]) await clear(page);
				else if ((await openOverlays(page)).some(item => knownPopups.has(item.text.slice(0, 50)))) await clear(page);
				const after = await page.evaluate(screenSignature).catch(() => undefined);
				if (!after || !different(before, after)) continue;
				const urlChanged = after.url.split('#')[0] !== before.url.split('#')[0];
				if (urlChanged && inScope(after.url)) {
					const template = routeTemplate(after.url);
					if (templates.has(template)) continue;
					templates.add(template);
					const view = { kind: 'route', url: after.url, from: baseUrl, label: control.label, heading: after.heading };
					views.push(view);
					await onView(view);
					if (depth < 2) queue.push({ url: after.url, depth: depth + 1 });
				} else if (!urlChanged) {
					const key = `${after.heading}|${after.dialog}|${control.label}`;
					if (panels.has(key)) continue;
					panels.add(key);
					const view = { kind: after.dialog ? 'dialog' : 'panel', url: baseUrl, from: baseUrl, label: control.label, heading: after.dialog || after.heading };
					views.push(view);
					await onView(view);
				}
			}
		} finally { await page.close().catch(() => {}); }
	}
	return views;
}
