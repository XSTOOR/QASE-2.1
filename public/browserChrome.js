/**
 * browserChrome — browser identity for the live device view.
 *
 * Pure/DOM-free label + brand metadata derived from the activeRuntimeEnvironment
 * view-model, so the chrome bar above the live screen always names the browser
 * that is ACTUALLY executing (never a hardcoded label).
 */

const BRANDS = Object.freeze({
	safari: { name: 'Safari', color: '#3fb6f0', nav: true, lock: true },
	chrome: { name: 'Chrome', color: '#4fc3f7', nav: true, lock: true },
	firefox: { name: 'Firefox', color: '#ff7139', nav: true, lock: true },
	edge: { name: 'Edge', color: '#3fd6c5', nav: true, lock: true },
	opera: { name: 'Opera', color: '#ff5f5f', nav: true, lock: true },
	brave: { name: 'Brave', color: '#fb8f3d', nav: true, lock: true },
	duckduckgo: { name: 'DuckDuckGo', color: '#de5833', nav: true, lock: true },
	other: { name: 'Browser', color: '#8fa3b8', nav: true, lock: true }
});

/** Brand metadata for a browser key (from activeRuntimeEnvironment.browserKey). */
export function browserBrand(browserKey) {
	return BRANDS[browserKey] ?? BRANDS.other;
}

/**
 * Compact chrome view-model for the live screen.
 *   { brand, url, secure, navGlyphs: ['←','→','↻'] }
 * URL comes from the LIVE frame payload (applyFrame), never invented;
 * secure is true only for https.
 */
export function chromeViewModel({ browserKey, url, title } = {}) {
	const brand = browserBrand(browserKey);
	let safeUrl = String(url ?? '').trim();
	if (!safeUrl || safeUrl === 'about:blank') safeUrl = title ? '' : 'about:blank';
	let host = safeUrl;
	try {
		if (safeUrl.startsWith('http')) host = new URL(safeUrl).host;
	} catch {
		// keep raw string for non-URL values
	}
	return {
		brand,
		url: host,
		fullUrl: safeUrl,
		secure: safeUrl.startsWith('https://'),
		navGlyphs: ['←', '→', '↻']
	};
}
