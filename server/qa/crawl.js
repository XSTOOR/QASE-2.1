/**
 * Page discovery and link checking.
 */
import { candidate } from './findings.js';

const SKIP_PATH = /\/(log-?out|sign-?out|delete|remove|unsubscribe|destroy|cancel)(\/|$|\?)/i;
const SKIP_EXTENSION = /\.(pdf|zip|gz|tar|rar|7z|dmg|exe|msi|apk|jpe?g|png|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|woff2?|ttf|css|js|json|xml|txt|csv|xlsx?|docx?|pptx?)$/i;

export const crawlablePath = (pathname, url = pathname) => !SKIP_PATH.test(url) && !SKIP_EXTENSION.test(pathname);

export function normalizeUrl(href, base) {
	try {
		const url = new URL(href, base);
		if (!['http:', 'https:'].includes(url.protocol)) return undefined;
		url.hash = '';
		return url.href;
	} catch { return undefined; }
}

const pattern = url => {
	const parsed = new URL(url);
	return parsed.pathname.replace(/\/[0-9a-f-]{6,}(?=\/|$)/gi, '/:id').replace(/\/\d+(?=\/|$)/g, '/:n');
};

/** A bounded crawl frontier: same scope, no destructive or binary URLs, ≤2 per URL pattern. */
export function createFrontier({ start, inScope, maxPages }) {
	const queued = new Set();
	const patterns = new Map();
	const queue = [];
	const add = (href, from) => {
		const url = normalizeUrl(href, from ?? start);
		if (!url || queued.has(url) || !inScope(url) || !crawlablePath(new URL(url).pathname, url)) return false;
		const key = pattern(url);
		if ((patterns.get(key) ?? 0) >= 2) return false;
		patterns.set(key, (patterns.get(key) ?? 0) + 1);
		queued.add(url);
		queue.push(url);
		return true;
	};
	add(start);
	return {
		add,
		next: () => queue.shift(),
		get size() { return queued.size; },
		restore(visited) { for (const url of visited) { queued.add(url); patterns.set(pattern(url), (patterns.get(pattern(url)) ?? 0) + 1); } },
		maxPages
	};
}

/** HEAD/GET every distinct link once. Internal 404/5xx are defects; external ones are low severity. */
export async function checkLinks({ links, origin, fetchImpl = fetch, deadline = Infinity, maxInternal = 80, maxExternal = 25 }) {
	const out = [];
	const internal = [...links.entries()].filter(([url]) => url.startsWith(origin)).slice(0, maxInternal);
	const external = [...links.entries()].filter(([url]) => !url.startsWith(origin)).slice(0, maxExternal);
	const check = async url => {
		try {
			let response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'QASE-QA/2 (+authorized testing)' } });
			if ([405, 403, 501].includes(response.status)) response = await fetchImpl(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'QASE-QA/2 (+authorized testing)' } });
			await response.body?.cancel?.();
			return response.status;
		} catch (error) { return `error: ${String(error.cause?.code ?? error.message).slice(0, 80)}`; }
	};
	const run = async (entries, isInternal) => {
		for (let index = 0; index < entries.length; index += 6) {
			if (Date.now() >= deadline) return;
			const batch = entries.slice(index, index + 6);
			const statuses = await Promise.all(batch.map(([url]) => check(url)));
			batch.forEach(([url, info], position) => {
				const status = statuses[position];
				const broken = typeof status === 'number' ? status === 404 || status === 410 || status >= 500 : isInternal;
				if (!broken) return;
				out.push(candidate({ detector: 'links.broken', category: 'navigation', severity: isInternal ? (typeof status === 'number' && status >= 500 ? 'high' : 'medium') : 'low', confidence: typeof status === 'number' ? 0.9 : 0.6,
					title: `Broken link "${info.text || url.slice(0, 60)}" → ${status}`, url: info.pages[0],
					actual: `${url} returns ${typeof status === 'number' ? `HTTP ${status}` : status}. Linked from ${info.pages.slice(0, 3).join(', ')}${info.pages.length > 3 ? ` and ${info.pages.length - 3} more pages` : ''}.`,
					expected: 'Every link leads to a working page.', steps: [`Open ${info.pages[0]}`, `Click "${info.text || url}"`],
					fix: isInternal ? 'Fix the link target or restore the missing page (add a redirect if the URL moved).' : 'Update or remove the outdated external link.',
					data: { key: url, siteWide: true } }));
			});
		}
	};
	await run(internal, true);
	await run(external, false);
	return { candidates: out, checked: internal.length + external.length };
}
