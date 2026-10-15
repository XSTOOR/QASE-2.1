/**
 * BrowserStack catalog provider adapter (#14275, Phase 2).
 *
 * Config-gated: if BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY are set the
 * adapter queries BrowserStack's public browser/device list endpoint and
 * maps real capability data into overlay rows (REAL_DEVICE where the device
 * list says so, honest levels otherwise). Without credentials it is
 * registered but `connected:false` and contributes NOTHING — it never
 * simulates results. All tests run against recorded fixtures, never live.
 */

import { browserstackCredentials } from './browserstackProvider.js';

const BROWSERSTACK_LIST_ENDPOINT = 'https://api.browserstack.com/v5/browsers';

/**
 * Maps one BrowserStack browser-list entry to a provider overlay row.
 * The API reports `real_device` per entry — REAL_DEVICE is attested only
 * from that field; anything else is honestly VIRTUAL_DEVICE (BrowserStack
 * terminology) rather than guessed.
 */
export function mapBrowserstackEntry(entry) {
	if (!entry || typeof entry !== 'object') return null;
	const os = entry.os ?? entry.os_version;
	if (!os || !entry.browser || !entry.browser_version) return null;
	const isReal = entry.real_device === true;
	const deviceName = entry.device ?? `${os} desktop`;
	return {
		envId: `BS-${String(os).toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${String(entry.browser).toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${entry.browser_version}`,
		device: deviceName,
		os: entry.os ?? os,
		osVersion: entry.os_version ?? '',
		browser: entry.browser,
		browserCode: String(entry.browser).toLowerCase(),
		browserVersion: String(entry.browser_version),
		platform: entry.os === 'ios' ? 'ios' : entry.os === 'android' ? 'android' : (entry.os ?? '').startsWith('windows') ? 'windows' : 'macos',
		deviceType: entry.device ? 'mobile' : 'desktop',
		executionLevel: isReal ? 'REAL_DEVICE' : 'VIRTUAL_DEVICE',
		isRealDevice: isReal,
		executionProvider: 'browserstack',
		screenSize: '',
		orientation: null,
		runtimeCapabilities: { os: entry.os ?? os, osVersion: entry.os_version ?? '', browser: entry.browser, browserVersion: String(entry.browser_version) }
	};
}

/** Fetch-and-map with an injectable fetcher (tests pass a fixture fetcher). */
export function createBrowserstackCatalogProvider({ fetcher, credentials = browserstackCredentials() } = {}) {
	const connected = Boolean(credentials);
	const provider = {
		name: 'BrowserStack',
		slug: 'browserstack',
		kind: 'external',
		connected,
		stale: false,
		lastRowCount: 0,
		async fetchCatalog() {
			if (!credentials) return { environments: [], attestations: [] };
			const doFetch = fetcher ?? globalThis.fetch;
			const auth = Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64');
			const response = await doFetch(BROWSERSTACK_LIST_ENDPOINT, {
				headers: { Authorization: `Basic ${auth}` }
			});
			if (!response.ok) throw new Error(`browserstack list failed: ${response.status}`);
			const entries = await response.json();
			const environments = (Array.isArray(entries) ? entries : []).map(mapBrowserstackEntry).filter(Boolean);
			provider.lastRowCount = environments.length;
			return { environments, attestations: [] };
		}
	};
	return provider;
}
