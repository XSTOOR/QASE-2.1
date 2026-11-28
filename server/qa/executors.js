/**
 * Browser executors for capability categories beyond the original detectors.
 * Each executor is read-only (GET navigations, keyboard focus, emulation and
 * inspection), produces candidates with evidence, and reports what it tested:
 *
 *   async (ctx, scenario) → { candidates, tested, evidence: string[] }
 *
 * ctx: { browser, profile, open(url, opts) → { page, log }, fetchImpl, deadline,
 *        save, model (app graph), signedIn, isSignInPage(page), origin }
 */
import { candidate } from './findings.js';

const pathOf = url => { try { const parsed = new URL(url); return `${parsed.pathname}${parsed.search}` || '/'; } catch { return url; } };
const timeLeft = ctx => Date.now() < ctx.deadline;
const visibleText = page => page.evaluate(() => (document.body?.innerText ?? '').trim()).catch(() => '');
const heading = page => page.evaluate(() => (document.querySelector('h1')?.innerText ?? document.title ?? '').trim().slice(0, 160)).catch(() => '');

async function withPage(ctx, url, options, work) {
	const { page, log } = await ctx.open(url, options);
	try { return await work(page, log); }
	finally { await page.close().catch(() => {}); }
}

/** Keyboard: Tab order, visible focus, traps, headings, landmarks, skip link. */
async function keyboard(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	let tested = 0;
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async page => {
			const structure = await page.evaluate(() => {
				const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(h => Number(h.tagName[1]));
				let skip;
				for (let i = 1; i < levels.length; i++) if (levels[i] - levels[i - 1] > 1) { skip = `h${levels[i - 1]} → h${levels[i]}`; break; }
				const navLinks = document.querySelectorAll('nav a, header a').length;
				const focusables = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
				return { h1: levels.filter(level => level === 1).length, skip, main: Boolean(document.querySelector('main, [role=main]')), navLinks, focusables };
			});
			await page.mouse.click(1, 1).catch(() => {});
			const stops = [];
			for (let i = 0; i < Math.min(30, structure.focusables + 2); i++) {
				await page.keyboard.press('Tab');
				stops.push(await page.evaluate(() => {
					const el = document.activeElement;
					if (!el || el === document.body) return { tag: 'body' };
					const s = getComputedStyle(el);
					const ring = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || (s.boxShadow && s.boxShadow !== 'none');
					const id = el.id ? `#${el.id}` : '';
					return { tag: el.tagName.toLowerCase(), key: `${el.tagName.toLowerCase()}${id}:${(el.innerText || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 40)}`, href: el.getAttribute('href') ?? '', ring, text: (el.innerText || '').trim().slice(0, 40) };
				}).catch(() => ({ tag: 'body' })));
			}
			tested++;
			const reached = new Set(stops.filter(stop => stop.tag !== 'body').map(stop => stop.key));
			evidence.push(`${pathOf(url)}: ${reached.size} distinct Tab stops of ${structure.focusables} focusable elements; h1×${structure.h1}; main landmark ${structure.main ? 'present' : 'missing'}.`);
			const base = { url, viewport: ctx.profile.name, category: 'accessibility' };
			if (structure.focusables > 2 && !reached.size) candidates.push(candidate({ ...base, detector: 'keyboard.no_focus', severity: 'high', confidence: 0.8, title: 'Keyboard users cannot reach any control', actual: `Pressing Tab ${stops.length} times never focused an element, although ${structure.focusables} focusable elements are visible.`, expected: 'Tab moves focus through the page\'s controls.', steps: [`Open ${url}`, 'Press Tab repeatedly'], data: { key: url } }));
			const tail = stops.slice(-8).map(stop => stop.key);
			if (structure.focusables > 4 && tail.length === 8 && new Set(tail).size === 1 && tail[0]) candidates.push(candidate({ ...base, detector: 'keyboard.trap', severity: 'high', confidence: 0.75, title: 'Keyboard focus gets trapped', actual: `Focus stayed on ${tail[0]} for the last 8 Tab presses.`, expected: 'Tab keeps moving through the page.', steps: [`Open ${url}`, 'Press Tab 20+ times'], data: { key: url } }));
			const focused = stops.filter(stop => stop.tag !== 'body');
			const invisible = focused.filter(stop => !stop.ring);
			if (focused.length >= 4 && invisible.length / focused.length > 0.6) candidates.push(candidate({ ...base, detector: 'keyboard.focus_invisible', severity: 'medium', confidence: 0.55, title: 'Keyboard focus is not visible on most controls', actual: `${invisible.length} of ${focused.length} focused controls showed no outline or focus ring (e.g. ${invisible.slice(0, 3).map(stop => stop.key).join(', ')}).`, expected: 'Every focused control shows a visible focus indicator (WCAG 2.4.7).', steps: [`Open ${url}`, 'Press Tab and watch the focused control'], data: { key: url } }));
			if (!structure.h1) candidates.push(candidate({ ...base, detector: 'keyboard.no_h1', severity: 'low', confidence: 0.7, title: 'Page has no main heading (h1)', actual: 'No h1 element on the page.', expected: 'One h1 names the page for screen-reader users.', steps: [`Open ${url}`], data: { key: url } }));
			if (structure.skip) candidates.push(candidate({ ...base, detector: 'keyboard.heading_skip', severity: 'low', confidence: 0.6, title: 'Heading levels are skipped', actual: `Heading order jumps ${structure.skip}.`, expected: 'Heading levels increase one step at a time.', steps: [`Open ${url}`], data: { key: `${url}|${structure.skip}` } }));
			if (!structure.main) candidates.push(candidate({ ...base, detector: 'keyboard.no_main', severity: 'low', confidence: 0.6, title: 'Page has no main landmark', actual: 'No <main> or role="main" element.', expected: 'A main landmark lets assistive technology jump to the content.', steps: [`Open ${url}`], data: { key: url } }));
			if (structure.navLinks > 8 && focused[0] && !String(focused[0].href).startsWith('#')) candidates.push(candidate({ ...base, detector: 'keyboard.no_skip_link', severity: 'low', confidence: 0.5, title: 'No skip link before a long navigation', actual: `The first Tab stop is "${focused[0].key}", followed by ${structure.navLinks} navigation links.`, expected: 'A "Skip to content" link is the first Tab stop.', steps: [`Open ${url}`, 'Press Tab once'], data: { key: url } }));
		});
	}
	return { candidates, tested, evidence };
}

/** Back/forward: walking three pages and back again lands on the right URLs. */
async function history(ctx, scenario) {
	const urls = scenario.targets.slice(0, 3);
	const evidence = [];
	const candidates = [];
	if (urls.length < 2) return { candidates, tested: 0, evidence: ['Only one page was available; back/forward needs two.'], notApplicable: 'Only one page is reachable.' };
	await withPage(ctx, urls[0], {}, async (page, log) => {
		for (const url of urls.slice(1)) await ctx.browser.goto(page, url, log, { quietMs: 600 }).catch(() => {});
		const expectBack = [...urls].reverse().slice(1);
		const seen = [];
		for (const expected of expectBack) {
			await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
			await ctx.browser.settle(page, { quietMs: 400 });
			seen.push({ expected, actual: page.url() });
		}
		await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
		await ctx.browser.settle(page, { quietMs: 400 });
		seen.push({ expected: urls[1], actual: page.url() });
		const wrong = seen.filter(item => item.actual.split('#')[0] !== item.expected.split('#')[0] && !ctx.isLoginUrl?.(item.actual));
		evidence.push(`Visited ${urls.map(pathOf).join(' → ')}, then back ×${expectBack.length} and forward ×1: ${seen.map(item => pathOf(item.actual)).join(', ')}.`);
		if (wrong.length) candidates.push(candidate({ detector: 'state.history_mismatch', category: 'navigation', severity: 'medium', confidence: 0.7, url: urls[0], viewport: ctx.profile.name, title: 'Back/forward lands on the wrong page', actual: wrong.map(item => `expected ${pathOf(item.expected)}, got ${pathOf(item.actual)}`).join('; '), expected: 'The browser history restores each previous page.', steps: [...urls.map(url => `Open ${url}`), 'Press Back, then Forward'], data: { key: urls.join('|') } }));
		const errors = log.pageErrors.length;
		if (errors) evidence.push(`${errors} JavaScript error(s) during history navigation (reported by the page audit).`);
	});
	return { candidates, tested: 1, evidence };
}

/** Reload and second-tab persistence, including the signed-in session. */
async function persistence(ctx, scenario) {
	const url = scenario.targets[0];
	const candidates = [];
	const evidence = [];
	await withPage(ctx, url, {}, async page => {
		const before = await heading(page);
		await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
		await ctx.browser.settle(page, { quietMs: 600 });
		const afterReload = await heading(page);
		let lostOnReload = ctx.signedIn && await ctx.isSignInPage(page);
		const second = await page.context().newPage();
		await second.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
		await ctx.browser.settle(second, { quietMs: 600 });
		const inTab = await heading(second);
		let lostInTab = ctx.signedIn && await ctx.isSignInPage(second);
		await second.close().catch(() => {});
		// The session may simply have expired during the run: sign in again and repeat once
		// immediately; only a loss that repeats right after a fresh sign-in is reported.
		if ((lostOnReload || lostInTab) && ctx.reauthenticate && await ctx.reauthenticate(url)) {
			evidence.push('The first check saw the sign-in page; QASE signed in again and repeated it immediately.');
			const retry = await ctx.open(url, { noReauth: true });
			try {
				await retry.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
				await ctx.browser.settle(retry.page, { quietMs: 600 });
				lostOnReload = await ctx.isSignInPage(retry.page);
				lostInTab = false;
			} finally { await retry.page.close().catch(() => {}); }
		}
		evidence.push(`${pathOf(url)}: "${before}" → after reload "${afterReload}" → in a new tab "${inTab}"${ctx.signedIn ? `; session kept: ${!lostOnReload && !lostInTab}` : ''}.`);
		if (lostOnReload || lostInTab) candidates.push(candidate({ detector: 'state.session_lost', category: 'functional', severity: 'high', confidence: 0.6, url, viewport: ctx.profile.name, title: `Signed-in session is lost on ${lostOnReload ? 'reload' : 'a new tab'}`, actual: `After ${lostOnReload ? 'reloading' : 'opening a new tab'}, the sign-in page was shown instead of "${before}".`, expected: 'A signed-in user stays signed in across reloads and tabs.', steps: [`Sign in`, `Open ${url}`, lostOnReload ? 'Reload the page' : 'Open the same URL in a new tab'], data: { key: url, harness: 'If the session also expired by time during testing, this may be expiry rather than a persistence bug.' } }));
		else if (before && afterReload && before !== afterReload) candidates.push(candidate({ detector: 'state.reload_changed', category: 'functional', severity: 'low', confidence: 0.45, url, viewport: ctx.profile.name, title: 'Reloading shows a different page', actual: `Heading "${before}" became "${afterReload}" after reload.`, expected: 'Reload shows the same page.', steps: [`Open ${url}`, 'Reload'], data: { key: url } }));
	});
	return { candidates, tested: 1, evidence };
}

/** Offline navigation and third-party failure, in a private context. */
async function offline(ctx, scenario) {
	const url = scenario.targets[0];
	const candidates = [];
	const evidence = [];
	await withPage(ctx, url, { isolated: true }, async (page, log) => {
		const errorsBefore = log.pageErrors.length;
		const internal = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).find(href => { try { const u = new URL(href); return u.origin === location.origin && u.pathname !== location.pathname && !/log-?out|sign-?out/i.test(u.pathname); } catch { return false; } })).catch(() => undefined);
		await page.context().setOffline(true);
		if (internal) await page.evaluate(href => { const a = [...document.querySelectorAll('a[href]')].find(item => item.href === href); a?.click(); }, internal).catch(() => {});
		await page.waitForTimeout(2500);
		const offlineErrors = log.pageErrors.slice(errorsBefore);
		await page.context().setOffline(false);
		evidence.push(`Went offline on ${pathOf(url)}${internal ? ` and followed ${pathOf(internal)}` : ''}: ${offlineErrors.length} uncaught JavaScript error(s).`);
		if (offlineErrors.length) candidates.push(candidate({ detector: 'network.offline_unhandled_error', category: 'functional', severity: 'low', confidence: 0.55, url, viewport: ctx.profile.name, title: 'Uncaught errors when the connection drops', actual: `Offline, the page threw: ${offlineErrors[0].message.slice(0, 200)}`, expected: 'Network loss is handled with a message, not an uncaught error.', steps: [`Open ${url}`, 'Go offline', internal ? `Click the link to ${pathOf(internal)}` : 'Wait'], data: { key: url } }));
	});
	// Third-party resilience: block every off-origin request once.
	const thirdParty = ctx.model.page(url)?.features?.third_party ?? 0;
	if (thirdParty && timeLeft(ctx)) {
		await withPage(ctx, 'about:blank', { isolated: true }, async (page, log) => {
			const origin = new URL(url).origin;
			await page.route('**/*', route => (new URL(route.request().url()).origin === origin ? route.fallback() : route.abort('blockedbyclient')));
			await ctx.browser.goto(page, url, log).catch(() => {});
			const text = await visibleText(page);
			evidence.push(`With ${thirdParty} third-party script(s) blocked, ${pathOf(url)} rendered ${text.length} characters and ${log.pageErrors.length} uncaught error(s).`);
			if (text.length < 30) candidates.push(candidate({ detector: 'network.third_party_breaks_page', category: 'functional', severity: 'high', confidence: 0.6, url, viewport: ctx.profile.name, title: 'The page goes blank when a third-party script fails', actual: `With third-party requests blocked the page rendered only ${text.length} characters.`, expected: 'Core content renders without third-party scripts.', steps: [`Block requests to other origins`, `Open ${url}`], data: { key: url } }));
		});
	}
	return { candidates, tested: 1, evidence };
}

/** Loading indicators that never resolve; usability on a slow connection. */
async function slowNetwork(ctx, scenario) {
	const url = scenario.targets[0];
	const candidates = [];
	const evidence = [];
	const urls = [...new Set([url, ...ctx.model.ranked(ctx.start, ctx.signedInUrl).slice(0, 4)])].slice(0, 4);
	for (const target of urls) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, target, {}, async page => {
			await page.waitForTimeout(6000);
			const stuck = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(el => {
				if (el.children.length > 2) return false;
				const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
				return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && /^\s*(loading|please wait|fetching)\b[^\n]{0,40}(…|\.\.\.)?\s*$/i.test(el.innerText || '');
			}).map(el => (el.innerText || '').trim().slice(0, 60)).slice(0, 3)).catch(() => []);
			if (stuck.length) {
				evidence.push(`${pathOf(target)}: "${stuck[0]}" still shown 6 s after load.`);
				candidates.push(candidate({ detector: 'network.stuck_loading', category: 'functional', severity: 'medium', confidence: 0.7, url: target, viewport: ctx.profile.name, title: `Loading indicator never resolves ("${stuck[0]}")`, actual: `"${stuck[0]}" was still displayed 6 seconds after the page finished loading.`, expected: 'Loading states resolve to content or to an error message.', steps: [`Open ${target}`, 'Wait 6 seconds'], data: { key: `${target}|${stuck[0]}` } }));
			}
		});
	}
	if (ctx.browser.engine === 'chromium' && timeLeft(ctx)) {
		await withPage(ctx, 'about:blank', { isolated: true }, async page => {
			const cdp = await ctx.browser.chromeSession(page);
			await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 64 * 1024, uploadThroughput: 32 * 1024 });
			const started = Date.now();
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
			const ms = Date.now() - started;
			evidence.push(`Slow 3G-like profile (400 ms RTT, 64 KB/s): ${pathOf(url)} became interactive (DOMContentLoaded) in ${(ms / 1000).toFixed(1)} s.`);
			if (ms >= 30000) candidates.push(candidate({ detector: 'network.slow_unusable', category: 'performance', severity: 'medium', confidence: 0.6, url, viewport: ctx.profile.name, title: 'Page is unusable on a slow connection', actual: `On a 400 ms / 64 KB/s connection the page needed ${(ms / 1000).toFixed(0)} s to become interactive.`, expected: 'Usable within about 15 s on a slow mobile connection.', steps: ['Throttle the network to slow 3G', `Open ${url}`], data: { key: url } }));
		});
	} else evidence.push('Network throttling needs Chromium; only stuck loading states were checked.');
	return { candidates, tested: urls.length, evidence };
}

/** TTFB, compression, caching, oversized images, render-blocking scripts. */
async function performance(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	let tested = 0;
	const statics = new Set();
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async page => {
			const data = await page.evaluate(() => {
				const nav = performance.getEntriesByType('navigation')[0];
				const resources = performance.getEntriesByType('resource').map(r => ({ name: r.name, type: r.initiatorType, encoded: r.encodedBodySize, decoded: r.decodedBodySize }));
				const images = [...document.images].filter(img => img.complete && img.naturalWidth && img.getBoundingClientRect().width > 0).map(img => ({ src: img.currentSrc || img.src, natural: img.naturalWidth, shown: Math.round(img.getBoundingClientRect().width * devicePixelRatio) }));
				const blocking = [...document.head.querySelectorAll('script[src]')].filter(s => !s.async && !s.defer && s.type !== 'module').length;
				return { ttfb: nav ? Math.round(nav.responseStart - nav.requestStart) : undefined, docEncoded: nav?.encodedBodySize, docDecoded: nav?.decodedBodySize, resources, images, blocking };
			}).catch(() => undefined);
			if (!data) return;
			tested++;
			const base = { url, viewport: ctx.profile.name, category: 'performance' };
			evidence.push(`${pathOf(url)}: TTFB ${data.ttfb ?? '?'} ms, ${data.resources.length} resources, ${data.blocking} render-blocking script(s).`);
			if (data.ttfb > 1500) candidates.push(candidate({ ...base, detector: 'perf.slow_ttfb', severity: 'medium', confidence: 0.6, title: `Slow server response (${data.ttfb} ms)`, actual: `Time to first byte was ${data.ttfb} ms.`, expected: 'TTFB under 800 ms.', steps: [`Open ${url}`], data: { key: url } }));
			const uncompressed = [{ name: url, encoded: data.docEncoded, decoded: data.docDecoded }, ...data.resources.filter(r => ['script', 'link', 'css'].includes(r.type))].filter(r => r.decoded > 60_000 && r.encoded >= r.decoded * 0.95);
			if (uncompressed.length) candidates.push(candidate({ ...base, detector: 'perf.uncompressed', severity: 'low', confidence: 0.6, title: 'Large text files are served uncompressed', actual: uncompressed.slice(0, 3).map(r => `${pathOf(r.name)} ${(r.decoded / 1024).toFixed(0)} KB`).join(', '), expected: 'gzip or brotli compression for text responses.', steps: [`Open ${url}`, 'Inspect response sizes'], data: { key: uncompressed[0].name } }));
			const oversized = data.images.filter(img => img.natural > 1000 && img.natural > img.shown * 2.5);
			if (oversized.length) candidates.push(candidate({ ...base, detector: 'perf.oversized_image', severity: 'low', confidence: 0.6, title: 'Images are much larger than displayed', actual: oversized.slice(0, 3).map(img => `${pathOf(img.src)} is ${img.natural}px wide, shown at ${img.shown}px`).join('; '), expected: 'Responsive images close to the display size.', steps: [`Open ${url}`], data: { key: oversized[0].src } }));
			if (data.blocking > 4) candidates.push(candidate({ ...base, detector: 'perf.render_blocking', severity: 'low', confidence: 0.5, title: `${data.blocking} render-blocking scripts in the page head`, actual: `${data.blocking} synchronous scripts in <head> delay the first render.`, expected: 'Scripts use defer/async or load after content.', steps: [`Open ${url}`], data: { key: url } }));
			for (const r of data.resources) { try { if (new URL(r.name).origin === ctx.origin && ['script', 'link', 'css', 'img'].includes(r.type)) statics.add(r.name); } catch { /* skip */ } }
		});
	}
	const noCache = [];
	for (const asset of [...statics].slice(0, 6)) {
		try {
			const response = await ctx.fetchImpl(asset, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
			const headers = response.headers;
			if (!headers.get('cache-control') && !headers.get('etag') && !headers.get('last-modified') && !headers.get('expires')) noCache.push(asset);
		} catch { /* unreachable asset is reported by the page audit */ }
	}
	if (statics.size) evidence.push(`Checked caching headers on ${Math.min(6, statics.size)} static assets: ${noCache.length} without any caching header.`);
	if (noCache.length >= 2) candidates.push(candidate({ url: scenario.targets[0], viewport: ctx.profile.name, category: 'performance', detector: 'perf.no_cache_static', severity: 'low', confidence: 0.6, title: 'Static assets have no caching headers', actual: `${noCache.length} assets (e.g. ${noCache.slice(0, 2).map(pathOf).join(', ')}) have no Cache-Control, ETag, Last-Modified or Expires.`, expected: 'Static assets are cacheable.', steps: ['Request the assets and inspect response headers'], data: { key: ctx.origin } }));
	return { candidates, tested, evidence };
}

/** JS heap after repeated in-page navigation (Chromium only). */
async function memory(ctx, scenario) {
	const url = scenario.targets[0];
	if (ctx.browser.engine !== 'chromium') return { candidates: [], tested: 0, evidence: ['Heap sampling needs Chromium.'], inconclusive: 'Heap sampling needs Chromium.' };
	const candidates = [];
	const evidence = [];
	await withPage(ctx, url, {}, async (page, log) => {
		const cdp = await ctx.browser.chromeSession(page);
		const sample = async () => { await cdp.send('HeapProfiler.collectGarbage').catch(() => {}); return (await cdp.send('Runtime.getHeapUsage').catch(() => ({ usedSize: 0 }))).usedSize; };
		const samples = [await sample()];
		const toggles = await page.locator('[aria-expanded], details > summary').count().catch(() => 0);
		for (let i = 0; i < 6 && timeLeft(ctx); i++) {
			if (toggles) for (let t = 0; t < Math.min(3, toggles); t++) await page.locator('[aria-expanded], details > summary').nth(t).click({ timeout: 1500 }).catch(() => {});
			else await ctx.browser.goto(page, url, log, { quietMs: 300 }).catch(() => {});
			samples.push(await sample());
		}
		const mb = samples.map(value => Math.round(value / 1048576 * 10) / 10);
		evidence.push(`${pathOf(url)} heap after GC across ${samples.length} cycles (${toggles ? 'toggling controls' : 'reloading'}): ${mb.join(' → ')} MB.`);
		const growth = mb.at(-1) - mb[0];
		const monotonic = mb.every((value, index) => index === 0 || value >= mb[index - 1] - 0.2);
		if (growth > 25 && monotonic) candidates.push(candidate({ detector: 'perf.memory_growth', category: 'performance', severity: 'medium', confidence: 0.55, url, viewport: ctx.profile.name, title: `JavaScript heap grows ${growth.toFixed(0)} MB with use`, actual: `Heap after garbage collection: ${mb.join(' → ')} MB.`, expected: 'Heap returns near its baseline.', steps: [`Open ${url}`, 'Repeat the interaction 6 times'], data: { key: url } }));
	});
	return { candidates, tested: 1, evidence };
}

/** Secrets in localStorage/sessionStorage (values are never recorded). */
async function storage(ctx, scenario) {
	const url = scenario.targets[0];
	const candidates = [];
	const evidence = [];
	await withPage(ctx, url, {}, async page => {
		const result = await page.evaluate(() => {
			const out = { keys: 0, suspicious: [], error: undefined };
			try {
				for (const store of [localStorage, sessionStorage]) {
					for (let i = 0; i < store.length; i++) {
						const key = store.key(i); const value = String(store.getItem(key) ?? '');
						out.keys++;
						if (/password|passwd|secret|private.?key/i.test(key) || /^eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}$/.test(value) || /"(password|refresh_token)"\s*:/.test(value)) out.suspicious.push(key.slice(0, 60));
					}
				}
			} catch (error) { out.error = String(error.message).slice(0, 120); }
			return out;
		}).catch(error => ({ keys: 0, suspicious: [], error: String(error.message).slice(0, 120) }));
		evidence.push(`${pathOf(url)}: ${result.keys} storage key(s); ${result.suspicious.length} look like credentials or tokens${result.error ? `; access error: ${result.error}` : ''}.`);
		if (result.suspicious.length) candidates.push(candidate({ detector: 'storage.secret_in_storage', category: 'security', severity: 'medium', confidence: 0.55, url, viewport: ctx.profile.name, title: 'Credentials or tokens kept in browser storage', actual: `Storage keys holding credential-like values: ${result.suspicious.join(', ')} (values not recorded).`, expected: 'Session secrets live in HttpOnly cookies, not script-readable storage.', steps: [`Open ${url}`, 'Inspect localStorage/sessionStorage'], data: { key: url } }));
		if (result.error && !/denied|insecure/i.test(result.error)) candidates.push(candidate({ detector: 'storage.access_error', category: 'functional', severity: 'low', confidence: 0.4, url, viewport: ctx.profile.name, title: 'Browser storage throws on access', actual: result.error, expected: 'Storage access works or fails gracefully.', steps: [`Open ${url}`], data: { key: url } }));
	});
	return { candidates, tested: 1, evidence };
}

/** Titles, descriptions, noindex, robots.txt and sitemap — via read-only GETs. */
async function seo(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	const titles = new Map();
	let tested = 0;
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		try {
			const response = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'follow' });
			if (!response.ok || !(response.headers.get('content-type') ?? '').includes('html') || ctx.isLoginUrl?.(response.url) && !ctx.isLoginUrl?.(url)) { await response.body?.cancel?.(); continue; }
			const html = (await response.text()).slice(0, 300_000);
			tested++;
			const title = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
			const description = /<meta[^>]+name=["']description["'][^>]*>/i.test(html);
			const noindex = /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html) || /noindex/i.test(response.headers.get('x-robots-tag') ?? '');
			if (title) titles.set(title, [...(titles.get(title) ?? []), url]);
			if (!description) candidates.push(candidate({ detector: 'seo.missing_description', category: 'content', severity: 'info', confidence: 0.8, url, viewport: ctx.profile.name, title: 'Page has no meta description', actual: 'No <meta name="description">.', expected: 'A short description for search results and link previews.', steps: [`View the source of ${url}`], data: { key: 'seo.description' } }));
			if (noindex && (ctx.model.page(url)?.auth !== 'protected')) candidates.push(candidate({ detector: 'seo.robots_noindex', category: 'content', severity: 'medium', confidence: 0.6, url, viewport: ctx.profile.name, title: 'Public page is marked noindex', actual: 'The page tells search engines not to index it.', expected: 'Public pages are indexable unless intentionally hidden.', steps: [`View the source of ${url}`], data: { key: url } }));
		} catch { /* unreachable pages are reported elsewhere */ }
	}
	for (const [title, urls] of titles) if (urls.length > 1) candidates.push(candidate({ detector: 'seo.duplicate_title', category: 'content', severity: 'low', confidence: 0.7, url: urls[0], viewport: ctx.profile.name, title: `${urls.length} pages share the title "${title.slice(0, 60)}"`, actual: `Same <title> on ${urls.map(pathOf).join(', ')}.`, expected: 'Each page has a unique, descriptive title.', steps: urls.slice(0, 3).map(url => `Open ${url}`), data: { key: title } }));
	for (const [path, detector] of [['/robots.txt', 'seo.robots_blocks_all'], ['/sitemap.xml', 'seo.sitemap_missing']]) {
		try {
			const response = await ctx.fetchImpl(`${ctx.origin}${path}`, { signal: AbortSignal.timeout(6000) });
			const text = response.ok ? (await response.text()).slice(0, 50_000) : (await response.body?.cancel?.(), '');
			evidence.push(`${path}: HTTP ${response.status}`);
			if (path === '/robots.txt' && /user-agent:\s*\*[\s\S]*?\n\s*disallow:\s*\/\s*(\n|$)/i.test(text)) candidates.push(candidate({ detector, category: 'content', severity: 'medium', confidence: 0.6, url: `${ctx.origin}${path}`, viewport: ctx.profile.name, title: 'robots.txt blocks the whole site', actual: '"Disallow: /" for all user agents.', expected: 'Only private areas are disallowed.', steps: [`Open ${ctx.origin}${path}`], data: { key: path } }));
			if (path === '/sitemap.xml' && response.status === 404) candidates.push(candidate({ detector, category: 'content', severity: 'info', confidence: 0.7, url: `${ctx.origin}${path}`, viewport: ctx.profile.name, title: 'No sitemap.xml', actual: '/sitemap.xml answers 404.', expected: 'A sitemap lists the public pages.', steps: [`Open ${ctx.origin}${path}`], data: { key: path } }));
		} catch { /* optional */ }
	}
	evidence.unshift(`Read metadata of ${tested} public page(s); ${[...titles.values()].filter(urls => urls.length > 1).length} duplicated title(s).`);
	return { candidates, tested, evidence };
}

/** Web app manifest completeness. */
async function pwa(ctx) {
	const candidates = [];
	const evidence = [];
	const url = ctx.start;
	await withPage(ctx, url, {}, async page => {
		const href = await page.evaluate(() => document.querySelector('link[rel=manifest]')?.href).catch(() => undefined);
		if (!href) { evidence.push('No manifest link on the start page.'); return; }
		let manifest;
		try { const response = await ctx.fetchImpl(href, { signal: AbortSignal.timeout(6000) }); manifest = await response.json(); }
		catch (error) { candidates.push(candidate({ detector: 'pwa.manifest_invalid', category: 'content', severity: 'low', confidence: 0.8, url: href, viewport: ctx.profile.name, title: 'Web app manifest cannot be read', actual: String(error.message).slice(0, 160), expected: 'A valid JSON manifest.', steps: [`Open ${href}`], data: { key: href } })); return; }
		const missing = ['name', 'icons', 'start_url', 'display'].filter(key => !(key === 'name' ? manifest.name || manifest.short_name : manifest[key]));
		evidence.push(`Manifest ${pathOf(href)}: missing ${missing.join(', ') || 'nothing'}.`);
		if (missing.length) candidates.push(candidate({ detector: 'pwa.manifest_incomplete', category: 'content', severity: 'low', confidence: 0.75, url: href, viewport: ctx.profile.name, title: 'Web app manifest is incomplete', actual: `Missing: ${missing.join(', ')}.`, expected: 'name, icons, start_url and display are set.', steps: [`Open ${href}`], data: { key: href } }));
	});
	return { candidates, tested: 1, evidence };
}

/** Translation keys leaking into the UI and invalid language codes. */
async function i18n(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	let tested = 0;
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async page => {
			const data = await page.evaluate(() => ({ lang: document.documentElement.getAttribute('lang') ?? '', text: (document.body?.innerText ?? '').slice(0, 30000) })).catch(() => ({ lang: '', text: '' }));
			tested++;
			const keys = [...new Set((data.text.match(/(?<![\w@/.-])[a-z][a-z_]{1,}(?:\.[a-z][a-z_]{1,}){2,}(?![\w/.-])/g) ?? []).filter(token => !/\.(com|org|net|io|dev|app|test|js|css|html|png|jpg)$/.test(token)))].slice(0, 5);
			const templates = [...new Set(data.text.match(/\{\{\s*[\w.]+\s*\}\}|__MSG_\w+__|\$t\(['"][\w.]+['"]\)/g) ?? [])].slice(0, 5);
			evidence.push(`${pathOf(url)}: lang="${data.lang}", ${keys.length + templates.length} untranslated key(s).`);
			if (keys.length || templates.length) candidates.push(candidate({ detector: 'i18n.translation_key', category: 'content', severity: 'medium', confidence: 0.6, url, viewport: ctx.profile.name, title: 'Untranslated keys are shown to users', actual: `Visible text contains ${[...templates, ...keys].join(', ')}.`, expected: 'Every key is replaced by translated text.', steps: [`Open ${url}`], data: { key: `${url}|${[...templates, ...keys][0]}` } }));
			if (data.lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(data.lang)) candidates.push(candidate({ detector: 'i18n.invalid_lang', category: 'accessibility', severity: 'low', confidence: 0.8, url, viewport: ctx.profile.name, title: `Invalid language code "${data.lang}"`, actual: `<html lang="${data.lang}">`, expected: 'A BCP 47 language tag such as "en" or "en-GB".', steps: [`Open ${url}`], data: { key: data.lang } }));
		});
	}
	return { candidates, tested, evidence };
}

/** Media: captions, autoplay with sound, load errors. */
async function media(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async page => {
			await page.waitForTimeout(1500);
			const items = await page.evaluate(() => [...document.querySelectorAll('video, audio')].map(el => ({ tag: el.tagName.toLowerCase(), src: (el.currentSrc || el.src || '').slice(0, 200), captions: el.tagName === 'VIDEO' ? [...el.querySelectorAll('track')].some(t => ['captions', 'subtitles'].includes(t.kind)) : true, autoplaySound: !el.paused && !el.muted && el.volume > 0, error: el.error?.code }))).catch(() => []);
			evidence.push(`${pathOf(url)}: ${items.length} media element(s).`);
			for (const [index, item] of items.entries()) {
				const base = { url, viewport: ctx.profile.name, category: 'accessibility', selector: `${item.tag}:nth-of-type(${index + 1})` };
				if (!item.captions) candidates.push(candidate({ ...base, detector: 'media.no_captions', severity: 'medium', confidence: 0.75, title: 'Video has no captions', actual: `${item.src || 'A video'} has no captions or subtitles track.`, expected: 'Videos with speech have captions (WCAG 1.2.2).', steps: [`Open ${url}`], data: { key: item.src || `${url}|${index}` } }));
				if (item.autoplaySound) candidates.push(candidate({ ...base, detector: 'media.autoplay_sound', severity: 'medium', confidence: 0.75, title: 'Media autoplays with sound', actual: `${item.src || 'Media'} started playing with sound on load.`, expected: 'No sound plays without a user action (WCAG 1.4.2).', steps: [`Open ${url}`], data: { key: item.src || `${url}|${index}` } }));
				if (item.error) candidates.push(candidate({ ...base, category: 'functional', detector: 'media.load_error', severity: 'medium', confidence: 0.8, title: 'Media fails to load', actual: `${item.src} failed with MediaError code ${item.error}.`, expected: 'Media loads and plays.', steps: [`Open ${url}`], data: { key: item.src } }));
			}
		});
	}
	return { candidates, tested: scenario.targets.length, evidence };
}

const PERMISSION_PROBE = `(() => {
	window.__qasePermissionCalls = [];
	const note = name => window.__qasePermissionCalls.push({ name, activated: Boolean(navigator.userActivation?.hasBeenActive) });
	try { const geo = navigator.geolocation; if (geo) { const g = geo.getCurrentPosition.bind(geo); geo.getCurrentPosition = (...a) => { note('geolocation'); return g(...a); }; const w = geo.watchPosition.bind(geo); geo.watchPosition = (...a) => { note('geolocation'); return w(...a); }; } } catch {}
	try { if (window.Notification) { const r = Notification.requestPermission.bind(Notification); Notification.requestPermission = (...a) => { note('notifications'); return r(...a); }; } } catch {}
	try { const m = navigator.mediaDevices; if (m?.getUserMedia) { const u = m.getUserMedia.bind(m); m.getUserMedia = (...a) => { note('camera/microphone'); return u(...a); }; } } catch {}
})();`;

/** Permission requests made on load without a user gesture. */
async function permissions(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, 'about:blank', {}, async (page, log) => {
			await page.addInitScript(PERMISSION_PROBE);
			await ctx.browser.goto(page, url, log).catch(() => {});
			await page.waitForTimeout(2500);
			const calls = await page.evaluate(() => window.__qasePermissionCalls ?? []).catch(() => []);
			const unprompted = calls.filter(call => !call.activated);
			evidence.push(`${pathOf(url)}: ${calls.length} permission request(s) on load, ${unprompted.length} without a user action.`);
			if (unprompted.length) candidates.push(candidate({ detector: 'permissions.requested_on_load', category: 'functional', severity: 'low', confidence: 0.75, url, viewport: ctx.profile.name, title: `The page asks for ${[...new Set(unprompted.map(call => call.name))].join(' and ')} permission on load`, actual: 'Permission was requested before the visitor did anything.', expected: 'Ask for permissions only after the user starts a feature that needs them.', steps: [`Open ${url}`], data: { key: url } }));
		});
	}
	return { candidates, tested: scenario.targets.length, evidence };
}

/** WebSocket connections opened by the page stay healthy. */
async function websocket(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async (page, log) => {
			await page.waitForTimeout(5000);
			const sockets = log.websockets ?? [];
			const broken = sockets.filter(socket => socket.errors.length || (socket.closedAt && socket.closedAt - socket.openedAt < 2000 && !socket.frames));
			evidence.push(`${pathOf(url)}: ${sockets.length} WebSocket(s), ${broken.length} failing.`);
			if (broken.length) candidates.push(candidate({ detector: 'network.websocket_error', category: 'functional', severity: 'medium', confidence: 0.7, url, viewport: ctx.profile.name, title: 'WebSocket connection fails', actual: `${broken[0].url}: ${broken[0].errors[0] ?? 'closed within 2 s without exchanging data'}.`, expected: 'Real-time connections stay open.', steps: [`Open ${url}`, 'Wait 5 seconds'], data: { key: broken[0].url } }));
		});
	}
	return { candidates, tested: scenario.targets.length, evidence };
}

/** Pages found only while signed in must not be readable by a signed-out visitor. */
async function authz(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	let tested = 0;
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, { anonymous: true, noReauth: true }, async (page, log) => {
			tested++;
			const status = log.mainResponse?.status ?? 0;
			const finalUrl = page.url();
			const signInShown = await ctx.isSignInPage(page);
			const anonymousHeading = await heading(page);
			const signedInHeading = ctx.model.page(url)?.heading ?? '';
			if (signInShown || [401, 403].includes(status) || ctx.isLoginUrl?.(finalUrl)) {
				ctx.model.markProtected(url, signInShown ? 'redirects to sign-in' : `HTTP ${status}`);
				evidence.push(`${pathOf(url)}: signed out → ${signInShown ? `sign-in page (${pathOf(finalUrl)})` : `HTTP ${status}`} ✓`);
				return;
			}
			evidence.push(`${pathOf(url)}: signed out → HTTP ${status}, "${anonymousHeading}" ✗`);
			if (status < 400 && anonymousHeading && (!signedInHeading || anonymousHeading === signedInHeading)) {
				candidates.push(candidate({ detector: 'authz.protected_page_public', category: 'security', severity: 'high', confidence: 0.65, url, viewport: ctx.profile.name, title: `Signed-in page is readable without signing in: ${pathOf(url)}`, actual: `A signed-out browser opened ${pathOf(url)} and got HTTP ${status} with the same content ("${anonymousHeading}") the signed-in user sees. This page was only reachable from the signed-in area.`, expected: 'Signed-in pages redirect signed-out visitors to sign-in or answer 401/403.', steps: ['Sign out (or use a private window)', `Open ${url} directly`], fix: 'Apply the same session check to this route as to the other signed-in pages.', data: { key: url } }));
			}
		});
	}
	return { candidates, tested, evidence };
}

/** Pages that refuse the current role must do so cleanly. */
async function roles(ctx, scenario) {
	const candidates = [];
	const evidence = [];
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, {}, async (page, log) => {
			const status = log.mainResponse?.status ?? 0;
			const text = await visibleText(page);
			const explained = /admins? only|access denied|forbidden|not authori[sz]ed|permission|role/i.test(text);
			evidence.push(`${pathOf(url)}: HTTP ${status} for the signed-in role${explained ? ', with an explanation' : ''}.`);
			ctx.model.addRole(`restricted:${pathOf(url)}`);
			if (status >= 500) candidates.push(candidate({ detector: 'authz.role_error', category: 'functional', severity: 'high', confidence: 0.75, url, viewport: ctx.profile.name, title: 'Restricted page crashes for a role without access', actual: `HTTP ${status} instead of a clear refusal.`, expected: 'Users without the role get 403 with an explanation.', steps: ['Sign in with a non-admin account', `Open ${url}`], data: { key: url } }));
			else if (status === 200 && !explained && text.length < 40) candidates.push(candidate({ detector: 'authz.role_unclear', category: 'functional', severity: 'low', confidence: 0.4, url, viewport: ctx.profile.name, title: 'Restricted page refuses silently', actual: 'The page is empty for this role and gives no reason.', expected: 'An explanation of the missing permission.', steps: [`Open ${url}`], data: { key: url } }));
		});
	}
	return { candidates, tested: scenario.targets.length, evidence };
}

/** Search, filters, sorting and pagination through their own GET URLs. */
async function search(ctx, scenario) {
	const url = scenario.targets[0];
	const candidates = [];
	const evidence = [];
	const visits = [];
	const base = { viewport: ctx.profile.name };
	const form = await withPage(ctx, url, {}, async page => page.evaluate(() => {
		const input = document.querySelector('input[type=search], [role=search] input, input[name=q], input[name*=search i]');
		const owner = input?.form ?? document.querySelector('form[role=search], form');
		const action = owner ? new URL(owner.getAttribute('action') || location.href, location.href).href : location.href;
		const method = (owner?.getAttribute('method') || 'get').toLowerCase();
		const selects = owner ? [...owner.querySelectorAll('select[name]')].map(s => ({ name: s.name, values: [...s.options].map(o => o.value).filter(Boolean).slice(0, 4) })) : [];
		const links = sel => [...document.querySelectorAll(sel)].map(a => a.href).filter((href, i, all) => all.indexOf(href) === i).slice(0, 6);
		return { input: input?.name, action, method, selects, sorts: links('a[href*="sort="], th a[href]'), pages: links('[aria-label*=pagination i] a, .pagination a, .pager a, a[rel=next]') };
	}).catch(() => undefined));
	if (!form) return { candidates, tested: 0, evidence: ['The page could not be read.'], inconclusive: 'The page could not be read.' };
	const check = async (target, label, detector) => {
		if (!timeLeft(ctx)) return;
		await withPage(ctx, target, {}, async (page, log) => {
			const status = log.mainResponse?.status ?? 0;
			const text = await visibleText(page);
			visits.push(`${label} → HTTP ${status}`);
			if (status >= 500) candidates.push(candidate({ ...base, url: target, detector, category: 'functional', severity: 'high', confidence: 0.9, title: `${label[0].toUpperCase()}${label.slice(1)} fails with HTTP ${status}`, actual: `${pathOf(target)} answered HTTP ${status}${/error|wrong/i.test(text) ? ` ("${text.slice(0, 80).replace(/\s+/g, ' ')}")` : ''}.`, expected: 'Every reachable results view loads.', steps: [`Open ${url}`, `Use ${label}`, `Observe ${pathOf(target)}`], fix: 'Fix the server error for this query and return an empty page of results when it is past the end.', data: { key: `${detector}|${new URL(target).pathname}` } }));
			if (label.startsWith('search for a term with no matches') && status < 400 && !/no (results|matches)|nothing (found|matches)|0 (results|found|items|matches)|not find|no \w+ match/i.test(text)) candidates.push(candidate({ ...base, url: target, detector: 'search.empty_state', category: 'functional', severity: 'low', confidence: 0.45, title: 'Searching with no matches gives no feedback', actual: 'A search that matches nothing showed no "no results" message.', expected: 'An empty state explains that nothing matched.', steps: [`Open ${url}`, 'Search for a nonsense term'], data: { key: url } }));
			return text;
		});
	};
	const withParam = (base, name, value) => { const u = new URL(base); u.searchParams.set(name, value); return u.href; };
	if (form.input && form.method === 'get') {
		await check(withParam(form.action, form.input, 'a'), 'search for a common letter', 'search.server_error');
		await check(withParam(form.action, form.input, 'zzqxqxnomatch'), 'search for a term with no matches', 'search.server_error');
		await check(withParam(form.action, form.input, '%" \' ; -- 😀'), 'search with special characters', 'search.server_error');
		// Harmless markup probe: an <i> element carrying a unique token must never be rendered as markup.
		const token = `qase${Math.random().toString(36).slice(2, 8)}`;
		const probe = withParam(form.action, form.input, `"><i class="${token}">${token}</i>`);
		if (timeLeft(ctx)) await withPage(ctx, probe, {}, async page => {
			const rendered = await page.evaluate(name => Boolean(document.querySelector(`i.${name}`)), token).catch(() => false);
			visits.push(`markup probe → ${rendered ? 'rendered as HTML ✗' : 'escaped ✓'}`);
			if (rendered) candidates.push(candidate({ ...base, url: probe, detector: 'security.reflected_xss', category: 'security', severity: 'high', confidence: 0.9, title: `Search reflects input as HTML (${pathOf(form.action).split('?')[0]})`, actual: `Searching for a harmless <i> tag rendered it as a real element: the search term is inserted into the page without escaping.`, expected: 'The search term is HTML-escaped wherever it is shown.', steps: [`Open ${url}`, `Search for "><i>test</i>`, 'The text appears in italics'], fix: 'HTML-escape the search term in the results heading (and everywhere it is echoed).', data: { key: `xss|${new URL(form.action).pathname}|${form.input}` } }));
		});
	} else if (form.input) evidence.push('The search form posts its data; QASE only tests GET search without write authorization.');
	for (const select of form.selects) for (const value of select.values) await check(withParam(form.action, select.name, value), `filter ${select.name}=${value}`, 'search.filter_error');
	for (const href of form.sorts) await check(href, `sort link ${pathOf(href)}`, 'search.sort_error');
	for (const href of form.pages) await check(href, `pagination link ${pathOf(href)}`, 'search.pagination_error');
	// Filters must survive a reload when they are in the URL.
	if (form.selects[0]?.values[0] && timeLeft(ctx)) {
		const target = withParam(form.action, form.selects[0].name, form.selects[0].values[0]);
		await withPage(ctx, target, {}, async page => {
			await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
			const value = await page.evaluate(name => document.querySelector(`select[name="${name}"]`)?.value, form.selects[0].name).catch(() => undefined);
			visits.push(`reload with ${form.selects[0].name}=${form.selects[0].values[0]} → select shows "${value ?? ''}"`);
			if (value !== undefined && value !== form.selects[0].values[0]) candidates.push(candidate({ ...base, url: target, detector: 'search.state_lost', category: 'functional', severity: 'low', confidence: 0.5, title: 'Applied filter is lost after reload', actual: `After reload the filter shows "${value}" although the URL has ${form.selects[0].name}=${form.selects[0].values[0]}.`, expected: 'Controls reflect the state in the URL.', steps: [`Open ${target}`, 'Reload'], data: { key: target } }));
		});
	}
	evidence.push(`${pathOf(url)}: ${visits.length} result views — ${visits.slice(0, 12).join('; ')}${visits.length > 12 ? '…' : ''}.`);
	return { candidates, tested: visits.length, evidence };
}

/** Dark colour-scheme preference: readable text when the site adapts. */
async function darkMode(ctx, scenario, { auditPage }) {
	const candidates = [];
	const evidence = [];
	for (const url of scenario.targets) {
		if (!timeLeft(ctx)) break;
		await withPage(ctx, url, { colorScheme: 'dark' }, async (page, log) => {
			const adapts = await page.evaluate(() => {
				const meta = document.querySelector('meta[name=color-scheme]')?.content ?? '';
				if (/dark/.test(meta) || /dark/.test(getComputedStyle(document.documentElement).colorScheme)) return true;
				for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) if (rule.media?.mediaText?.includes('prefers-color-scheme')) return true; } catch { /* cross-origin sheet */ } }
				return false;
			}).catch(() => false);
			if (!adapts) { evidence.push(`${pathOf(url)}: no dark colour scheme; the page renders as in light mode.`); return; }
			const result = await auditPage(page, { url, viewport: ctx.profile.name, touch: ctx.profile.hasTouch, log, save: ctx.save });
			const contrast = result.candidates.filter(item => item.detector === 'page.low_contrast');
			evidence.push(`${pathOf(url)}: dark scheme active; ${contrast.length} low-contrast text group(s).`);
			for (const item of contrast) candidates.push({ ...item, detector: 'scheme.dark_low_contrast', title: `In dark mode: ${item.title}`, fingerprint: `${item.fingerprint}|dark`, steps: ['Set the system to dark mode', ...(item.steps ?? [])] });
		});
	}
	return { candidates, tested: scenario.targets.length, evidence };
}

export const EXECUTORS = { keyboard, history, persistence, offline, slow_network: slowNetwork, performance, memory, storage, seo, pwa, i18n, media, permissions, websocket, authz, roles, search, dark_mode: darkMode };
