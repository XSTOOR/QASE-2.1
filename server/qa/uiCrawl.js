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

/** Tags visible clickable controls whose label is in `labels` (a panel's new controls). Runs in the page. */
function tagPanelControls(labels) {
	const wanted = new Set(labels);
	const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < innerHeight && s.visibility !== 'hidden' && s.display !== 'none'; };
	for (const el of document.querySelectorAll('[data-qase-sub]')) el.removeAttribute('data-qase-sub');
	const out = [];
	for (const el of document.querySelectorAll('a, button, [role=button], [role=tab], [role=menuitem], [role=option], [tabindex="0"]')) {
		if (!visible(el) || el.closest('form') || el.closest('[data-qase-ignore]')) continue;
		const text = String(el.getAttribute('aria-label') || el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60);
		if (!wanted.has(text) || out.some(item => item.label === text)) continue;
		el.setAttribute('data-qase-sub', String(out.length));
		out.push({ index: out.length, label: text });
	}
	return out;
}

/** What the screen shows: url, headings, open dialog, and the visible landmark texts. Runs in the page. */
export function screenSignature() {
	const shown = el => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.05; };
	const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
	const heading = [...document.querySelectorAll('h1, h2, [role=heading]')].filter(shown).map(h => clean(h.innerText)).filter(Boolean).slice(0, 3).join(' · ').slice(0, 160);
	const dialog = [...document.querySelectorAll('[role=dialog], [aria-modal=true], dialog[open], [role=menu], [role=listbox]')].find(shown);
	// "Landmarks": headings, labelled regions and controls. A click that reveals a feature adds some.
	const marks = new Set();
	for (const el of document.querySelectorAll('h1, h2, h3, h4, [role=heading], [role=dialog] *, [role=menu] [role=menuitem], [role=tab], label, legend, button, [role=button], a, input, select, textarea, th')) {
		if (marks.size > 400 || !shown(el) || el.closest('[data-qase-ignore]')) continue;
		const text = clean(el.getAttribute('aria-label') || el.innerText || el.placeholder || el.value).slice(0, 60);
		if (text && text.length > 1) marks.add(`${el.tagName.toLowerCase()}:${text}`);
		// Disclosure state: an accordion/menu toggle reports open/closed even when its content is plain text.
		if (el.hasAttribute('aria-expanded') && text) marks.add(`expanded:${text}=${el.getAttribute('aria-expanded')}`);
	}
	// Revealed text: paragraphs, list items, cells and text-bearing blocks (accordion answers,
	// tab panels, toasts) — the content a click often reveals without any new heading or control.
	let blocks = 0;
	for (const el of document.querySelectorAll('p, li, dd, dt, td, blockquote, figcaption, summary, [role=tabpanel], [role=region], [role=alert], [role=status], div, span')) {
		if (blocks > 500 || marks.size > 900) break;
		if (el.closest('[data-qase-ignore]') || el.closest('button, a, label')) continue;
		const own = [...el.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
		if (own.length < 12 || !shown(el)) continue;
		blocks++;
		marks.add(`text:${own.slice(0, 60)}`);
	}
	return { url: location.href, heading, dialog: dialog ? clean(dialog.getAttribute('aria-label') || dialog.innerText).slice(0, 80) : '', marks: [...marks], controls: document.querySelectorAll('button, a, input, select, textarea').length };
}

/** What appeared on screen between two signatures (new headings first). */
export function appeared(before, after) {
	const old = new Set(before.marks);
	const fresh = after.marks.filter(mark => !old.has(mark) && !mark.startsWith('expanded:'));
	const rank = mark => /^(h\d|\[role=heading\]|label|legend|th):/.test(mark) ? 0 : /^(button|a|input|select|textarea):/.test(mark) ? 1 : /^text:/.test(mark) ? 2 : 3;
	return fresh.sort((a, b) => rank(a) - rank(b)).map(mark => mark.replace(/^[a-z0-9]+:/, ''));
}

/** Disclosure toggles whose aria-expanded changed between two signatures ("Label" → open/closed). */
export function toggled(before, after) {
	const state = marks => new Map(marks.filter(mark => mark.startsWith('expanded:')).map(mark => { const body = mark.slice(9); const at = body.lastIndexOf('='); return [body.slice(0, at), body.slice(at + 1)]; }));
	const was = state(before.marks);
	return [...state(after.marks)].filter(([label, value]) => was.has(label) && was.get(label) !== value).map(([label, value]) => `${label} (${value === 'true' ? 'opened' : 'closed'})`);
}

/**
 * Walks the UI from `starts`, in place: click a control, look at what appeared,
 * then return with Back or Escape (a page load is only the last resort, because
 * reloading an app can have side effects such as creating a new record).
 * open(url) → { page, log } handles sign-in and pop-ups; prepare(page) clears
 * pop-ups; onView(view) receives { kind, url, from, label, heading, appeared }.
 */
export async function discoverViews({ browser, open, prepare = async () => [], starts, inScope, deadline, maxScreens = 12, maxControls = 24, maxSubControls = 8, knownTemplates = new Set(), knownPopupTexts = [], onView = () => {}, progress = () => {}, stats = {} }) {
	const queue = starts.map(url => ({ url, depth: 0 }));
	const templates = new Set(knownTemplates);
	for (const item of starts) templates.add(routeTemplate(item));
	const visitedBases = new Set();
	const recorded = new Set(); // template|label: one view per control per screen
	// The same control opening the same content (e.g. a sidebar present on every screen) is one feature.
	const seenContent = new Set();
	const subLabels = new Set(); // controls already explored inside a panel
	const novel = (label, items) => { const key = `${label}|${items.slice(0, 5).join('|')}`; if (seenContent.has(key)) return false; seenContent.add(key); return true; };
	const views = [];
	stats.clicks = stats.clicks ?? 0; stats.reloads = stats.reloads ?? 0; stats.backs = stats.backs ?? 0;
	const knownPopups = new Set(knownPopupTexts.map(text => String(text).split(' → ')[0].slice(0, 50)));
	const clear = async page => {
		const done = await prepare(page);
		for (const item of done ?? []) knownPopups.add(String(item).split(' → ')[0].slice(0, 50));
	};
	const sameScreen = (a, b) => routeTemplate(a) === routeTemplate(b);

	while (queue.length && Date.now() < deadline && visitedBases.size < maxScreens) {
		const { url: base, depth } = queue.shift();
		const baseTemplate = routeTemplate(base);
		if (visitedBases.has(baseTemplate)) continue;
		visitedBases.add(baseTemplate);
		let page, log;
		try { ({ page, log } = await open(base)); } catch { continue; }
		try {
			await clear(page);
			const baseUrl = page.url();
			const done = new Set();
			// Return to the base screen without reloading when possible.
			const restore = async () => {
				if (sameScreen(page.url(), baseUrl)) return true;
				stats.backs++;
				await page.goBack({ waitUntil: 'commit', timeout: 8000 }).catch(() => {});
				await browser.settle(page, { quietMs: 600 }).catch(() => {});
				if (sameScreen(page.url(), baseUrl)) { await clear(page); return true; }
				stats.reloads++;
				await browser.goto(page, baseUrl, log, { quietMs: 700 }).catch(() => {});
				await clear(page);
				return sameScreen(page.url(), baseUrl);
			};
			const initial = new Set();
			let resets = 0;
			for (let round = 0; round < maxControls && Date.now() < deadline; round++) {
				let controls = await page.evaluate(tagNavControls, maxControls).catch(() => []);
				if (!round) for (const item of controls) initial.add(`${item.label}|${item.region}`);
				let control = controls.find(item => !done.has(`${item.label}|${item.region}`) && !subLabels.has(item.label) && !DESTRUCTIVE.test(item.label));
				// Controls from the original screen were hidden by an earlier click (e.g. another tab is
				// selected): restore the screen once, then continue with what is left.
				const missing = [...initial].filter(key => !done.has(key) && !controls.some(item => `${item.label}|${item.region}` === key) && !DESTRUCTIVE.test(key));
				if ((!control || missing.length) && missing.length && resets < 2) {
					resets++; stats.reloads++;
					await browser.goto(page, baseUrl, log, { quietMs: 700 }).catch(() => {});
					await clear(page);
					controls = await page.evaluate(tagNavControls, maxControls).catch(() => []);
					control = controls.find(item => !done.has(`${item.label}|${item.region}`) && !subLabels.has(item.label) && !DESTRUCTIVE.test(item.label));
				}
				if (!control) break;
				done.add(`${control.label}|${control.region}`);
				await progress(`Exploring "${control.label}" on ${new URL(baseUrl).pathname}`);
				const before = await page.evaluate(screenSignature).catch(() => undefined);
				const target = page.locator(`[data-qase-nav="${control.index}"]`).first();
				if (!before || !await target.count().catch(() => 0)) continue;
				await browser.pointAt?.(page, target, control.label);
				stats.clicks++;
				const clicked = await browser.interact(() => target.click({ timeout: 4000 })).then(() => true).catch(() => false);
				if (!clicked) continue;
				await browser.settle(page, { quietMs: 900 }).catch(() => {});
				// After a navigation the new screen may open with a tour; known pop-ups are cleared anywhere.
				if (!sameScreen(page.url(), before.url) || (await openOverlays(page)).some(item => knownPopups.has(item.text.slice(0, 50)))) await clear(page);
				const after = await page.evaluate(screenSignature).catch(() => undefined);
				if (!after) { await restore(); continue; }
				const urlChanged = !sameScreen(after.url, before.url);
				if (urlChanged && inScope(after.url)) {
					const template = routeTemplate(after.url);
					if (!templates.has(template)) {
						templates.add(template);
						const view = { kind: 'route', url: after.url, from: baseUrl, label: control.label, heading: after.heading, appeared: appeared(before, after).slice(0, 8) };
						views.push(view);
						await onView(view);
						if (depth < 2) queue.push({ url: after.url, depth: depth + 1 });
					}
					if (!await restore()) break;
					continue;
				}
				const fresh = appeared(before, after);
				const key = `${baseTemplate}|${control.label}`;
				// A panel/dialog/menu counts only when something new is on screen.
				const meaningful = fresh.length >= 2 || Boolean(after.dialog && after.dialog !== before.dialog) || after.marks.some(mark => /^(h\d|\[role=heading\]):/.test(mark) && !before.marks.includes(mark));
				if (!urlChanged && meaningful && !recorded.has(key) && novel(control.label, fresh)) {
					recorded.add(key);
					const view = { kind: after.dialog ? 'dialog' : 'panel', url: baseUrl, from: baseUrl, label: control.label, heading: after.dialog || fresh.slice(0, 3).join(' · ').slice(0, 120), appeared: fresh.slice(0, 10) };
					views.push(view);
					await onView(view);
				}
				// One level deeper: the panel's own controls (tabs, sub-sections, menu items).
				if (!urlChanged && meaningful && depth < 2 && recorded.has(key)) {
					const parent = control.label;
					const subs = (await page.evaluate(tagPanelControls, fresh.slice(0, 30)).catch(() => [])).filter(item => !DESTRUCTIVE.test(item.label)).slice(0, maxSubControls);
					for (const sub of subs) {
						if (Date.now() >= deadline) break;
						const subKey = `${baseTemplate}|${parent} › ${sub.label}`;
						subLabels.add(sub.label);
						done.add(`${sub.label}|rail`); done.add(`${sub.label}|nav`); done.add(`${sub.label}|top`); done.add(`${sub.label}|opener`); done.add(`${sub.label}|tabs`);
						if (recorded.has(subKey)) continue;
						// Re-tag (the panel may have re-rendered); re-open the parent if it closed.
						let tagged = await page.evaluate(tagPanelControls, [sub.label]).catch(() => []);
						if (!tagged.length) {
							const again = (await page.evaluate(tagNavControls, maxControls).catch(() => [])).find(item => item.label === parent);
							if (again) { await page.locator(`[data-qase-nav="${again.index}"]`).first().click({ timeout: 3000 }).catch(() => {}); await browser.settle(page, { quietMs: 600 }).catch(() => {}); }
							tagged = await page.evaluate(tagPanelControls, [sub.label]).catch(() => []);
						}
						if (!tagged.length) continue;
						await progress(`Exploring "${parent} › ${sub.label}"`);
						const subBefore = await page.evaluate(screenSignature).catch(() => undefined);
						const subTarget = page.locator('[data-qase-sub="0"]').first();
						await browser.pointAt?.(page, subTarget, `${parent} › ${sub.label}`);
						stats.clicks++;
						if (!await browser.interact(() => subTarget.click({ timeout: 4000 })).then(() => true).catch(() => false)) continue;
						await browser.settle(page, { quietMs: 900 }).catch(() => {});
						const subAfter = await page.evaluate(screenSignature).catch(() => undefined);
						if (!subBefore || !subAfter) continue;
						recorded.add(subKey);
						if (!sameScreen(subAfter.url, subBefore.url) && inScope(subAfter.url)) {
							const template = routeTemplate(subAfter.url);
							if (!templates.has(template)) {
								templates.add(template);
								const view = { kind: 'route', url: subAfter.url, from: baseUrl, label: `${parent} › ${sub.label}`, heading: subAfter.heading, appeared: appeared(subBefore, subAfter).slice(0, 8) };
								views.push(view); await onView(view);
								if (depth < 1) queue.push({ url: subAfter.url, depth: depth + 1 });
							}
							await restore();
							continue;
						}
						const subFresh = appeared(subBefore, subAfter);
						if ((subFresh.length || (subAfter.dialog && subAfter.dialog !== subBefore.dialog)) && novel(`${parent} › ${sub.label}`, subFresh)) {
							const view = { kind: subAfter.dialog && subAfter.dialog !== subBefore.dialog ? 'dialog' : 'panel', url: baseUrl, from: baseUrl, label: `${parent} › ${sub.label}`, heading: subAfter.dialog || subFresh.slice(0, 3).join(' · ').slice(0, 120), appeared: subFresh.slice(0, 10) };
							views.push(view); await onView(view);
							if (subAfter.dialog && subAfter.dialog !== subBefore.dialog) await page.keyboard.press('Escape').catch(() => {});
						}
					}
				}
				// Close what the click opened, without reloading, so it cannot cover the next controls:
				// Escape, then the same control again (toggles), checked against what had appeared.
				if (!sameScreen(page.url(), baseUrl)) { await restore(); continue; }
				const stillOpen = async () => {
					const now = await page.evaluate(screenSignature).catch(() => undefined);
					return Boolean(now && fresh.slice(0, 4).some(text => now.marks.some(mark => mark.endsWith(`:${text}`))));
				};
				if (meaningful && await stillOpen()) {
					await page.keyboard.press('Escape').catch(() => {});
					await page.waitForTimeout(250);
					if (await stillOpen()) {
						const again = (await page.evaluate(tagNavControls, maxControls).catch(() => [])).find(item => item.label === control.label);
						if (again) { await page.locator(`[data-qase-nav="${again.index}"]`).first().click({ timeout: 1500 }).catch(() => {}); await page.waitForTimeout(300); }
					}
				}
			}
		} finally { await page.close().catch(() => {}); }
	}
	return views;
}
