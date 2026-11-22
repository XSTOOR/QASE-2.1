/**
 * The application graph: what QASE has learned about the product under test.
 * Built from observation only (nothing application specific is assumed), kept
 * in run state so a resumed run continues with the same model.
 *
 *   pages        url → { title, role, auth, status, features, forms, controls, depth, discoveredBy }
 *   transitions  [{ from, to, via }]
 *   features     feature → number of pages that have it
 *   auth         { detected, passwordForm, identifierStep, loginUrl, loginLinks, sso, challenge, signedIn, ... }
 *   roles        observed roles (public, signed-in, refused-for-role pages)
 *   history      observations that changed the model (they trigger replanning)
 */

import { routeTemplate } from './uiCrawl.js';

/** DOM features of the open page; runs in the browser. */
export async function observeFeatures(page) {
	return page.evaluate(() => {
		const visible = element => { const r = element.getBoundingClientRect(); const s = getComputedStyle(element); return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none'; };
		const count = selector => [...document.querySelectorAll(selector)].filter(visible).length;
		const text = (document.body?.innerText ?? '').slice(0, 20000);
		const links = [...document.querySelectorAll('a[href]')];
		const sameOrigin = links.filter(a => { try { return new URL(a.href).origin === location.origin; } catch { return false; } });
		const params = [...new URLSearchParams(location.search).keys()];
		return {
			navigation: count('nav, [role=navigation], header a') > 0 ? 1 : 0,
			search: count('input[type=search], [role=search] input, input[name=q], input[name*=search i], input[placeholder*=search i]'),
			filter: count('select, [role=listbox], input[type=checkbox][name], [data-filter]') + (params.some(key => /status|filter|category|type|tag/i.test(key)) ? 1 : 0),
			sort: count('th a[href*=sort], [aria-sort], select[name*=sort i], a[href*="sort="]'),
			pagination: count('[aria-label*=pagination i] a, .pagination a, a[rel=next], nav a[href*="page="]'),
			table: count('table'),
			forms: count('form'),
			upload: count('input[type=file]'),
			dates: count('input[type=date], input[type=datetime-local]'),
			media: count('video, audio'),
			menus: count('[aria-expanded], [aria-haspopup], details > summary, button[aria-controls]'),
			dialogs: count('[aria-haspopup=dialog], [data-toggle=modal], [data-bs-toggle=modal], dialog') + [...document.querySelectorAll('button')].filter(b => visible(b) && /^(open|show|launch)\b/i.test(b.innerText || '')).length,
			accordion: count('details, [aria-expanded][aria-controls]'),
			carousel: count('[aria-roledescription=carousel], .carousel, .swiper, .slick-slider'),
			tabs: count('[role=tablist]'),
			draggable: count('[draggable=true]'),
			checkout: /checkout|add to cart|place order|pay now|billing details/i.test(text) ? 1 : 0,
			external_links: links.length - sameOrigin.length,
			third_party: [...document.scripts].filter(s => { try { return s.src && new URL(s.src).origin !== location.origin; } catch { return false; } }).length,
			manifest: document.querySelector('link[rel=manifest]') ? 1 : 0,
			i18n: document.querySelector('link[hreflang], [lang]:not(html), a[hreflang]') ? 1 : 0,
			restricted: /admins? only|access denied|forbidden|not authori[sz]ed|permission to|need the \w+ role/i.test(text) ? 1 : 0,
			headings: count('h1, h2, h3'),
			title: document.title,
			heading: (document.querySelector('h1')?.innerText ?? '').trim().slice(0, 120),
			links: sameOrigin.length,
			controls: count('button, a[href], input, select, textarea, [role=button]')
		};
	}).catch(() => ({}));
}

const FEATURE_KEYS = ['navigation', 'search', 'filter', 'sort', 'pagination', 'table', 'forms', 'upload', 'dates', 'media', 'menus', 'dialogs', 'accordion', 'carousel', 'tabs', 'draggable', 'checkout', 'external_links', 'third_party', 'manifest', 'i18n', 'restricted', 'websocket', 'protected'];

export function createAppGraph(saved) {
	const graph = saved && typeof saved === 'object'
		? saved
		: { pages: {}, transitions: [], features: {}, auth: { detected: false }, roles: ['public'], history: [], observedAt: Date.now() };
	graph.pages ??= {}; graph.views ??= []; graph.transitions ??= []; graph.features ??= {}; graph.auth ??= { detected: false }; graph.roles ??= ['public']; graph.history ??= [];

	const recount = () => {
		const totals = Object.fromEntries(FEATURE_KEYS.map(key => [key, 0]));
		for (const page of Object.values(graph.pages)) for (const key of FEATURE_KEYS) if ((page.features?.[key] ?? 0) > 0) totals[key]++;
		graph.features = totals;
	};
	const note = (kind, detail) => { graph.history.push({ ts: Date.now(), kind, detail: String(detail).slice(0, 240) }); if (graph.history.length > 200) graph.history.shift(); };

	return {
		graph,
		/** Adds or updates a page. Returns the list of features that are new to the application. */
		addPage(url, info = {}) {
			const before = new Set(Object.entries(graph.features).filter(([, n]) => n > 0).map(([key]) => key));
			const existing = graph.pages[url];
			graph.pages[url] = {
				...existing,
				...info,
				template: routeTemplate(url),
				features: { ...(existing?.features ?? {}), ...(info.features ?? {}) },
				discoveredBy: existing?.discoveredBy ?? info.discoveredBy ?? 'crawl',
				firstSeen: existing?.firstSeen ?? Date.now()
			};
			if (!existing) note('page', url);
			recount();
			const added = Object.entries(graph.features).filter(([key, n]) => n > 0 && !before.has(key)).map(([key]) => key);
			for (const key of added) note('feature', `${key} on ${url}`);
			return added;
		},
		/** A panel, tab or dialog reached by clicking on a screen (same URL). */
		addView(view) {
			if (graph.views.length >= 200 || graph.views.some(item => item.url === view.url && item.label === view.label)) return false;
			graph.views.push({ url: view.url, label: String(view.label).slice(0, 60), heading: String(view.heading ?? '').slice(0, 120), kind: view.kind, ts: Date.now() });
			note('view', `${view.label} on ${view.url}`);
			return true;
		},
		hasTemplate: url => Object.values(graph.pages).some(page => page.template === routeTemplate(url)),
		addTransition(from, to, via) {
			if (!from || !to || from === to || graph.transitions.length > 600) return;
			if (!graph.transitions.some(item => item.from === from && item.to === to)) graph.transitions.push({ from, to, via: String(via ?? '').slice(0, 80) });
		},
		markProtected(url, how) {
			if (!graph.pages[url]) return;
			graph.pages[url].auth = 'protected';
			graph.pages[url].features = { ...graph.pages[url].features, protected: 1 };
			graph.pages[url].protection = how;
			recount();
		},
		setAuth(patch) {
			const before = JSON.stringify(graph.auth);
			graph.auth = { ...graph.auth, ...patch };
			if (patch.signedIn && !graph.roles.includes('signed-in')) graph.roles.push('signed-in');
			if (JSON.stringify(graph.auth) !== before) note('auth', Object.keys(patch).join(', '));
		},
		addRole(role) { if (role && !graph.roles.includes(role)) { graph.roles.push(role); note('role', role); } },
		websocket(url) {
			if (!graph.pages[url]) return;
			graph.pages[url].features = { ...graph.pages[url].features, websocket: 1 };
			recount();
		},
		pages: () => Object.keys(graph.pages),
		page: url => graph.pages[url],
		/** Pages ordered by testing value: start page, signed-in landing, then feature-rich pages. */
		ranked(start, signedInUrl) {
			const score = ([url, page]) => (url === start ? 1000 : 0) + (url === signedInUrl ? 900 : 0)
				+ Object.values(page.features ?? {}).filter(value => typeof value === 'number' && value > 0).length * 10
				+ (page.auth === 'protected' ? 25 : 0) - (page.depth ?? 0) * 3;
			const seen = new Set();
			return Object.entries(graph.pages).filter(([, page]) => (page.status ?? 200) < 400 && !page.login).sort((a, b) => score(b) - score(a))
				.filter(([url, page]) => { const key = page.template ?? routeTemplate(url); if (seen.has(key)) return false; seen.add(key); return true; }).map(([url]) => url);
		},
		withFeature: key => {
			const seen = new Set();
			return Object.entries(graph.pages).filter(([url, page]) => {
				if (!((page.features?.[key] ?? 0) > 0 && (page.status ?? 200) < 400)) return false;
				const template = page.template ?? routeTemplate(url);
				if (seen.has(template)) return false;
				seen.add(template);
				return true;
			}).map(([url]) => url);
		},
		/** A short text model of the application for the reasoner. */
		summary(limit = 30) {
			const rows = Object.entries(graph.pages).slice(0, limit).map(([url, page]) => {
				const features = Object.entries(page.features ?? {}).filter(([key, value]) => typeof value === 'number' && value > 0 && FEATURE_KEYS.includes(key)).map(([key]) => key);
				let path = url; try { const u = new URL(url); path = `${u.pathname}${u.search}`; } catch { /* keep */ }
				return `${path} — "${page.heading || page.title || ''}"${page.auth === 'protected' ? ' [signed-in only]' : ''}${features.length ? ` {${features.join(', ')}}` : ''}`;
			});
			const auth = graph.auth.detected ? `Authentication: ${graph.auth.signedIn ? 'signed in with the owner\'s test account' : 'detected, not signed in'}${graph.auth.identifierStep ? ' (two-step sign-in)' : ''}.` : 'Authentication: none detected.';
			const templates = new Set();
			const unique = rows.filter((row, index) => { const key = routeTemplate(Object.keys(graph.pages)[index]); if (templates.has(key)) return false; templates.add(key); return true; });
			const views = graph.views.slice(0, 40).map(view => { let path = view.url; try { path = new URL(view.url).pathname; } catch { /* keep */ } return `"${view.label}" on ${path} → ${view.kind}${view.heading ? ` "${view.heading}"` : ''}`; });
			return `${auth}\nRoles seen: ${graph.roles.join(', ')}\nScreens:\n${unique.join('\n')}${views.length ? `\nPanels, tabs and dialogs reached by clicking:\n${views.join('\n')}` : ''}`;
		},
		stats: () => ({ pages: Object.keys(graph.pages).length, screens: new Set(Object.keys(graph.pages).map(routeTemplate)).size, views: graph.views.length, protected: Object.values(graph.pages).filter(page => page.auth === 'protected').length, transitions: graph.transitions.length, features: Object.fromEntries(Object.entries(graph.features).filter(([, n]) => n > 0)), roles: graph.roles })
	};
}
