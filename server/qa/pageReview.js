import { crawlablePath, normalizeUrl } from './crawl.js';

const navLinks = 'header a[href], nav a[href], [role="navigation"] a[href]';
const isRouteHash = hash => /^#!?\/(?!\/)/.test(hash);
export function reviewUrl(value) {
	const documentUrl = normalizeUrl(value);
	if (!documentUrl) return undefined;
	const { hash } = new URL(value);
	return documentUrl + (isRouteHash(hash) ? hash : '');
}
const pathOf = value => {
	const url = new URL(value);
	return url.pathname + (isRouteHash(url.hash) ? url.hash.split('?')[0] : '');
};

// A hash change alone also occurs on a static page without a router.
function renderedView(previous) {
	const heading = document.querySelector('main h1, [role=main] h1, h1');
	const main = document.querySelector('main, [role=main]');
	const snapshot = JSON.stringify([document.title, heading?.innerText, main?.innerText?.slice(0, 4000)]);
	return previous === undefined ? snapshot : snapshot !== previous;
}

function pageResult({ url, status, title, screenshot, at }) {
	return {
		path: pathOf(url), screenshot, recordedAt: at ?? Date.now(),
		checks: [
			{ name: 'Document response', status: status == null ? 'untested' : status >= 200 && status < 400 ? 'passed' : 'failed', detail: status == null ? 'No document response observed' : 'HTTP ' + status },
			{ name: 'Page title', status: title?.trim() ? 'passed' : 'failed', detail: title?.trim().slice(0, 160) || 'Empty page title' }
		]
	};
}

async function nextLink(page, browser) {
	const source = new URL(page.url());
	const handles = await page.locator(navLinks).elementHandles();
	for (const handle of handles.slice(0, 150)) {
		const link = await handle.evaluate(a => ({
			href: a.href, name: (a.getAttribute('aria-label') || a.innerText || '').trim().slice(0, 100),
			visible: Boolean(a.getClientRects().length && getComputedStyle(a).visibility === 'visible'),
			sameTab: (!a.target || a.target === '_self') && !a.hasAttribute('download')
		}));
		if (!link.visible || !link.sameTab || !link.name || !/^https?:/.test(link.href)) continue;
		const url = new URL(link.href);
		if (url.origin !== source.origin || !browser.inScope(url.href) || url.search || url.username || url.password || !crawlablePath(url.pathname) || reviewUrl(url.href) === reviewUrl(source.href)) continue;
		if (url.hash) {
			if (!isRouteHash(url.hash)) continue;
			// Only plain internal route paths; ordinary anchors, query parameters
			// and ambiguous encoded destinations stay outside this two-page check.
			const path = url.hash.replace(/^#!/, '#').slice(1);
			if (!/^\/[\w./~-]*$/.test(path) || !crawlablePath(path)) continue;
		}
		return { ...link, handle };
	}
}

async function followLink(page, browser, link, save) {
	let status;
	const target = new URL(link.href);
	const hashRoute = isRouteHash(target.hash);
	const before = hashRoute ? await page.evaluate(renderedView) : undefined;
	const onResponse = response => {
		if (response.request().isNavigationRequest() && response.frame() === page.mainFrame() && normalizeUrl(response.url()) === normalizeUrl(link.href)) status = response.status();
	};
	page.on('response', onResponse);
	try {
		if (!await link.handle.evaluate((a, href) => a.isConnected && a.href === href, link.href)) return { status: 'inconclusive', detail: 'The selected link changed before the click.' };
		await browser.interact(() => browser.activate(link.handle, { timeout: 4000 }, page));
		await page.waitForURL(url => reviewUrl(url.href) === link.href, { timeout: 4000, waitUntil: 'domcontentloaded' }).catch(() => {});
		await browser.settle(page);
	} finally { page.off('response', onResponse); }
	const actual = pathOf(page.url());
	if (reviewUrl(page.url()) !== link.href || !browser.inScope(page.url())) return { actual, status: 'failed', detail: 'Click did not reach the linked URL.' };
	if (hashRoute) {
		const changed = await page.waitForFunction(renderedView, before, { timeout: 2200 }).then(() => true, () => false);
		if (!changed || reviewUrl(page.url()) !== link.href) return { actual: pathOf(page.url()), status: 'inconclusive', detail: 'Could not confirm a rendered view change at the linked route.' };
	}
	const screenshot = await save(await page.screenshot({ type: 'jpeg', quality: 60, timeout: 3000 }).catch(() => undefined), 'Navigation to ' + actual);
	const destination = pageResult({ url: page.url(), title: await page.title(), status, screenshot });
	if (hashRoute && status == null) destination.checks[0] = { name: 'Document response', status: 'not applicable', detail: 'Client-side route in the loaded document' };
	return { actual, status: 'passed', detail: hashRoute ? 'Click reached the linked route and the rendered view changed.' : 'Click reached the linked URL.', destination };
}

// An in-flight click has an unknown outcome after a restart. Preserve its
// checkpoint and never replay it or credit it as a successful action.
export async function reviewFirstPages({ state, observation, entryPage, reopen, browser, save, checkpoint, stopped, allowNext }) {
	const review = state.pageReview ??= { pages: [] };
	let page = entryPage;
	try {
		if (!review.pages.length) {
			review.pages.push(pageResult(observation));
			await checkpoint();
		}
		if (review.journey?.status === 'running') {
			Object.assign(review.journey, { status: 'inconclusive', detail: 'Run interrupted after the link was selected. Its destination was not confirmed.' });
			await checkpoint();
		}
		if (review.journey || stopped()) return;
		let link;
		let detail = 'Entry response, scope or page limit prevented a second-page check.';
		if (allowNext && browser.inScope(observation.url) && observation.status >= 200 && observation.status < 400) {
			try {
				page ??= await reopen();
				if (reviewUrl(page.url()) === reviewUrl(observation.url)) link = await nextLink(page, browser);
				detail = 'No eligible visible navigation link was available on the entry page.';
			} catch { detail = 'The browser could not inspect the entry page navigation.'; }
		}
		if (stopped()) return;
		if (link) {
			review.journey = { status: 'running', control: link.name, expected: pathOf(link.href) };
			await checkpoint();
			if (stopped()) return;
			try {
				const { destination, ...outcome } = await followLink(page, browser, link, save);
				Object.assign(review.journey, outcome);
				if (destination) review.pages.push(destination);
			} catch {
				Object.assign(review.journey, { status: 'inconclusive', detail: 'The browser could not complete or verify the click.' });
			}
		} else review.journey = { status: 'untested', detail };
		await checkpoint();
	} finally { await page?.close().catch(() => {}); }
}
