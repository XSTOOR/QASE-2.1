import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MATRIX_CATEGORIES,
	CATEGORY_LABELS,
	sidebarCategoryFor,
	compareVersionsDesc,
	createFavoritesStore,
	createRecentsStore,
	buildSidebarTree,
	filterSidebarTree,
	buildBrowserColumns,
	assembleSelection,
	selectionDisplayString,
	resolvePickerFocus
} from './deviceBrowserMatrix.js';

/** Minimal env factory matching /api/environments shape. */
function env(overrides = {}) {
	return {
		envId: 'ENV-TEST',
		platform: 'ios',
		device: 'iPhone 17 Pro',
		os: 'iOS',
		osVersion: '26.0',
		browser: 'Chrome',
		browserCode: 'chrome',
		browserVersion: '154',
		deviceType: 'mobile',
		active: true,
		executionType: 'VIRTUAL_DEVICE',
		runtimeStatus: 'AVAILABLE',
		...overrides
	};
}

/** A tiny realistic env list: iPhone on iOS 26, a Pixel on Android 16, a Windows desktop. */
function sampleEnvironments() {
	return [
		env({ envId: 'ENV-IOS-IP17PRO-26.0-CHR-156', browserVersion: '156' }),
		env({ envId: 'ENV-IOS-IP17PRO-26.0-CHR-155', browserVersion: '155' }),
		env({ envId: 'ENV-IOS-IP17PRO-26.0-CHR-154', browserVersion: '154' }),
		env({ envId: 'ENV-IOS-IP17PRO-26.0-SAF-26.0', browser: 'Safari', browserCode: 'safari', browserVersion: '26.0' }),
		env({ envId: 'ENV-IOS-IP17PRO-26.0-DDG-3', browser: 'DuckDuckGo', browserCode: 'duckduckgo', browserVersion: '3' }),
		env({
			envId: 'ENV-AND-PIX10PRO-16-CHR-156', platform: 'android', device: 'Pixel 10 Pro', os: 'Android',
			osVersion: '16', deviceType: 'mobile'
		}),
		env({
			envId: 'ENV-WIN-11-EDG-140-WINDESKTOP', platform: 'windows', device: 'Windows Desktop', os: 'Windows',
			osVersion: '11', browser: 'Edge', browserCode: 'edge', browserVersion: '140', deviceType: 'desktop'
		})
	];
}

/** Positional channel stub mirroring server channelForVersion (chrome ladder). */
function channelFor(code, version) {
	const ladders = {
		chrome: ['canary', 'dev', 'beta', 'stable'],
		firefox: ['nightly', 'beta', 'stable'],
		safari: ['stable'],
		duckduckgo: ['stable']
	};
	const versions = { chrome: ['140', '141', '142', '143', '144', '145', '146', '147', '148', '149', '150', '151', '152', '153', '154', '155', '156'], safari: ['26.0'], duckduckgo: ['1', '2', '3'] }[code];
	if (!versions) return 'stable';
	const distance = versions.length - 1 - versions.indexOf(String(version));
	const ladder = ladders[code] ?? ['stable'];
	return distance >= 0 && distance < ladder.length - 1 ? ladder[distance] : 'stable';
}

function memoryStorage() {
	const map = new Map();
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => map.set(k, String(v)),
		removeItem: (k) => map.delete(k)
	};
}

test('categories are the six spec categories in order', () => {
	assert.deepEqual(MATRIX_CATEGORIES, ['favorites', 'recent', 'ios', 'android', 'windows', 'macos']);
	assert.equal(CATEGORY_LABELS.favorites, 'Favorites');
	assert.equal(CATEGORY_LABELS.recent, 'Recent Tests');
});

test('sidebarCategoryFor maps platforms, iPadOS rides with iOS, unknown → other', () => {
	assert.equal(sidebarCategoryFor(env()), 'ios');
	assert.equal(sidebarCategoryFor(env({ platform: 'ipados' })), 'ios');
	assert.equal(sidebarCategoryFor(env({ platform: 'android' })), 'android');
	assert.equal(sidebarCategoryFor(env({ platform: 'windows' })), 'windows');
	assert.equal(sidebarCategoryFor(env({ platform: 'macos' })), 'macos');
	assert.equal(sidebarCategoryFor(env({ platform: 'webos' })), 'other');
});

test('compareVersionsDesc sorts newest first across formats', () => {
	assert.deepEqual(['26.0', '18.3', '13.0', '9.1'].sort(compareVersionsDesc), ['26.0', '18.3', '13.0', '9.1']);
	assert.deepEqual(['11', '10', '8.1'].sort(compareVersionsDesc), ['11', '10', '8.1']);
});

test('favorites store toggles, caps, persists, and degrades when storage throws', () => {
	const storage = memoryStorage();
	const store = createFavoritesStore({ storage });
	assert.equal(store.has('device:iPhone 17 Pro'), false);
	assert.equal(store.toggle('device:iPhone 17 Pro'), true);
	assert.equal(store.has('device:iPhone 17 Pro'), true);

	// New instance against same storage sees the persistence.
	const store2 = createFavoritesStore({ storage });
	assert.deepEqual(store2.list(), ['device:iPhone 17 Pro']);

	// Subscription fires on change.
	let events = 0;
	const unsub = store2.subscribe(() => { events += 1; });
	store2.toggle('version:chrome:154');
	assert.equal(events, 1);
	unsub();

	// Cap: only the newest `cap` keys survive.
	const capped = createFavoritesStore({ storage: memoryStorage(), cap: 3 });
	for (const k of ['a', 'b', 'c', 'd']) capped.toggle(k);
	assert.deepEqual(capped.list(), ['b', 'c', 'd']);

	// Throwing storage degrades to session-only without throwing out.
	const throwing = { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); }, removeItem: () => {} };
	const store3 = createFavoritesStore({ storage: throwing });
	assert.doesNotThrow(() => store3.toggle('x'));
	assert.equal(store3.has('x'), true);
});

test('recents store dedupes, caps at 10, orders most-recent-first', () => {
	const store = createRecentsStore({ storage: memoryStorage() });
	for (let i = 0; i < 12; i += 1) store.record(env({ envId: `ENV-${i}` }));
	assert.equal(store.list().length, 10);
	// Most recent first.
	assert.equal(store.list()[0].envId, 'ENV-11');
	// Dedupe: re-recording ENV-11 moves it to front, not duplicated.
	store.record(env({ envId: 'ENV-9' }));
	assert.equal(store.list()[0].envId, 'ENV-9');
	assert.equal(store.list().filter((e) => e.envId === 'ENV-9').length, 1);
	assert.equal(store.list().length, 10);
	// Persistence across instances.
	const storage = memoryStorage();
	const a = createRecentsStore({ storage });
	a.record(env({ envId: 'ENV-A' }));
	assert.deepEqual(createRecentsStore({ storage }).list().map((e) => e.envId), ['ENV-A']);
});

test('buildSidebarTree always renders all six categories with empty states', () => {
	const tree = buildSidebarTree(sampleEnvironments(), {});
	assert.equal(tree.categories.length, 6);
	assert.deepEqual(tree.categories.map((c) => c.id), MATRIX_CATEGORIES);
	assert.equal(tree.categories.find((c) => c.id === 'favorites').devices.length, 0);
	assert.equal(tree.categories.find((c) => c.id === 'recent').devices.length, 0);
	assert.ok(tree.categories.find((c) => c.id === 'ios').devices.length >= 1);
	assert.ok(tree.categories.find((c) => c.id === 'android').devices.length === 1);
	assert.ok(tree.categories.find((c) => c.id === 'windows').devices.length === 1);
});

test('buildSidebarTree resolves favorites and recents into their categories', () => {
	const favorites = ['device:Pixel 10 Pro'];
	const recents = [{ envId: 'ENV-IOS-IP17PRO-26.0-CHR-154', device: 'iPhone 17 Pro', os: 'iOS', osVersion: '26.0', browser: 'Chrome', browserVersion: '154' }];
	const tree = buildSidebarTree(sampleEnvironments(), { favorites, recents });
	assert.equal(tree.categories.find((c) => c.id === 'favorites').devices.length, 1);
	assert.equal(tree.categories.find((c) => c.id === 'favorites').devices[0].device, 'Pixel 10 Pro');
	const recent = tree.categories.find((c) => c.id === 'recent').devices[0];
	assert.equal(recent.device, 'iPhone 17 Pro');
	assert.equal(recent.stale, false, 'live recent pins to the tree');
});

test('retired favorited devices stay visible, flagged stale, never selectable', () => {
	const tree = buildSidebarTree(sampleEnvironments(), { favorites: ['device:BlackBerry Storm'] });
	const fav = tree.categories.find((c) => c.id === 'favorites').devices.find((d) => d.device === 'BlackBerry Storm');
	assert.ok(fav);
	assert.equal(fav.stale, true);
	assert.deepEqual(fav.envIds, []);
});

test('buildSidebarTree never drops or crashes on unknown platforms', () => {
	const weird = [...sampleEnvironments(), env({
		envId: 'ENV-OTHER-1', platform: 'webos', device: 'Palm Pre', os: 'webOS', osVersion: '1.0'
	})];
	const tree = buildSidebarTree(weird, {});
	assert.equal(tree.categories.length, 6, 'still exactly six rendered categories');
	// The unknown-platform device rides at the end of macOS rather than crashing.
	const macos = tree.categories.find((c) => c.id === 'macos');
	assert.ok(macos.devices.some((d) => d.device === 'Palm Pre'));
});

test('filterSidebarTree matches device, OS, and browser haystacks', () => {
	const tree = buildSidebarTree(sampleEnvironments(), {});
	// Browser search finds devices that can run the browser.
	const byBrowser = filterSidebarTree(tree, 'duckduckgo');
	assert.ok(byBrowser.categories.some((c) => c.devices.some((d) => d.device === 'iPhone 17 Pro')));
	// OS search.
	const byOs = filterSidebarTree(tree, 'android 16');
	assert.ok(byOs.categories.find((c) => c.id === 'android').devices.length === 1);
	// No match → all categories filtered away (not an empty tree crash).
	const none = filterSidebarTree(tree, ' Commodore 64 ');
	assert.equal(none.categories.length, 0);
});

test('buildBrowserColumns returns one column per brand with honest metadata', () => {
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', sampleEnvironments(), { channelFor });
	const codes = columns.map((c) => c.browserCode);
	assert.deepEqual(codes, ['chrome', 'duckduckgo', 'safari'], 'brand order chrome→ddg→safari per BRAND_ORDER');
	const chrome = columns[0];
	assert.deepEqual(chrome.rows.map((r) => r.version), ['156', '155', '154']);
	assert.deepEqual(chrome.rows.map((r) => r.channel), ['canary', 'dev', 'beta'], 'positional channel labels');
	assert.equal(chrome.webkitNote, true, 'non-Safari on iOS carries WebKit note');
	const safari = columns[2];
	assert.equal(safari.webkitNote, false);
	assert.equal(chrome.hiddenCount, 0);
});

test('buildBrowserColumns favorite stars mark version rows', () => {
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', sampleEnvironments(), { channelFor, favorites: ['version:chrome:154'] });
	const chrome = columns[0];
	assert.equal(chrome.rows.find((r) => r.version === '154').favorite, true);
	assert.equal(chrome.rows.find((r) => r.version === '156').favorite, false);
});

test('buildBrowserColumns honors the runtime board: offline/unavailable rows flagged', () => {
	const board = new Map([['ENV-IOS-IP17PRO-26.0-CHR-154', { status: 'OFFLINE' }]]);
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', sampleEnvironments(), { channelFor, boardByEnvId: board });
	const row154 = columns[0].rows.find((r) => r.version === '154');
	assert.equal(row154.available, false);
	assert.equal(row154.status, 'OFFLINE');
	assert.equal(columns[0].rows.find((r) => r.version === '156').available, true);
});

test('buildBrowserColumns marks retired rows unavailable and hidden when the window trims', () => {
	const withRetired = [...sampleEnvironments(), env({ envId: 'ENV-IOS-IP17PRO-26.0-CHR-140', browserVersion: '140', active: false })];
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', withRetired, { channelFor });
	// Active filter excludes the retired row entirely from candidates…
	assert.ok(!columns[0].rows.some((r) => r.version === '140'), 'inactive envs never offered');
	// …and the window metadata counts the trim.
	const many = [];
	for (let v = 140; v <= 156; v += 1) many.push(env({ envId: `ENV-X-${v}`, browserVersion: String(v) }));
	const cols = buildBrowserColumns('iPhone 17 Pro', '26.0', many, { channelFor, initialWindow: 6 });
	assert.equal(cols[0].hiddenCount, many.length - 6);
	assert.equal(cols[0].totalVersions, many.length);
});

test('buildBrowserColumns returns [] for unknown device/OS', () => {
	assert.deepEqual(buildBrowserColumns('', '26.0', sampleEnvironments(), {}), []);
	assert.deepEqual(buildBrowserColumns('iPhone 17 Pro', '9.9', sampleEnvironments(), {}), []);
});

test('assembleSelection resolves valid combos from the environments list only', () => {
	const environments = sampleEnvironments();
	const good = assembleSelection({ device: 'iPhone 17 Pro', osVersion: '26.0', browserCode: 'chrome', browserVersion: '154', environments });
	assert.equal(good.ok, true);
	assert.equal(good.env.envId, 'ENV-IOS-IP17PRO-26.0-CHR-154');
	const latest = assembleSelection({ device: 'iPhone 17 Pro', osVersion: '26.0', browserCode: 'chrome', environments });
	assert.equal(latest.ok, true);
	assert.equal(latest.env.browserVersion, '156', 'no explicit version → newest');
});

test('assembleSelection rejects invalid cross-combinations with reasons', () => {
	const environments = sampleEnvironments();
	assert.equal(assembleSelection({ device: '', osVersion: '26.0', browserCode: 'chrome', environments }).reason, 'no-device');
	// Safari never exists for a Windows device in the list — combination unbuildable.
	const safariOnWindows = assembleSelection({ device: 'Windows Desktop', osVersion: '11', browserCode: 'safari', environments });
	assert.equal(safariOnWindows.ok, false);
	assert.equal(safariOnWindows.reason, 'no-combination');
	// Chrome 999 not offered.
	const missing = assembleSelection({ device: 'iPhone 17 Pro', osVersion: '26.0', browserCode: 'chrome', browserVersion: '999', environments });
	assert.equal(missing.ok, false);
	assert.equal(missing.reason, 'version-not-found');
	// Cross-device OS mixup.
	const cross = assembleSelection({ device: 'Pixel 10 Pro', osVersion: '26.0', browserCode: 'chrome', environments });
	assert.equal(cross.ok, false);
});

test('selectionDisplayString renders the six-part spec format', () => {
	const line = selectionDisplayString(env({ runtimeStatus: 'AVAILABLE' }));
	assert.equal(line, 'iPhone 17 Pro · iOS 26.0 · Chrome · 154 · VIRTUAL DEVICE · AVAILABLE');
	assert.equal(selectionDisplayString(null), '');
});

test('resolvePickerFocus derives focus from the active selection', () => {
	const focus = resolvePickerFocus({ selection: { device: 'iPhone 17 Pro', envId: 'ENV-IOS-IP17PRO-26.0-CHR-154' }, environments: sampleEnvironments() });
	assert.deepEqual(focus, { device: 'iPhone 17 Pro', osVersion: '26.0', browserCode: 'chrome' });
	assert.deepEqual(resolvePickerFocus({ selection: null, environments: [] }), { device: null, osVersion: null, browserCode: null });
});

// --- #14632 (NI01 Phase 2): browser-support truth in the picker model ---

test('buildBrowserColumns marks not_supported browsers NOT SUPPORTED and unavailable', () => {
	const envs = [
		env({ envId: 'ENV-IOS-IP17PRO-26.0-DDG-3', browser: 'DuckDuckGo', browserCode: 'duckduckgo', browserVersion: '3',
			browserSupport: { status: 'not_supported', reason: 'no execution provider', provider: 'local-playwright', engine: null, engineEquivalent: false } }),
		env({ envId: 'ENV-IOS-IP17PRO-26.0-CHR-154', browserVersion: '154',
			browserSupport: { status: 'supported', reason: 'runs on chromium', provider: 'local-playwright', engine: 'chromium', engineEquivalent: false } })
	];
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', envs, { channelFor });
	const ddg = columns.find((c) => c.browserCode === 'duckduckgo');
	assert.ok(ddg, 'duckduckgo column visible');
	for (const row of ddg.rows) {
		assert.equal(row.available, false);
		assert.equal(row.status, 'NOT_SUPPORTED');
		assert.equal(row.browserSupport.status, 'not_supported');
	}
	const chrome = columns.find((c) => c.browserCode === 'chrome');
	for (const row of chrome.rows) {
		assert.equal(row.status, null);
		assert.equal(row.available, true);
	}
});

test('buildBrowserColumns keeps engine_equivalent browsers available but labeled', () => {
	const envs = [
		env({ envId: 'ENV-IOS-IP17PRO-26.0-OPR-130', browser: 'Opera', browserCode: 'opera', browserVersion: '130',
			browserSupport: { status: 'engine_equivalent', reason: 'Chromium underneath', provider: 'local-playwright', engine: 'chromium', engineEquivalent: true } })
	];
	const columns = buildBrowserColumns('iPhone 17 Pro', '26.0', envs, { channelFor });
	const opera = columns.find((c) => c.browserCode === 'opera');
	assert.ok(opera);
	for (const row of opera.rows) {
		assert.equal(row.available, true, 'engine-equivalent is executable');
		assert.equal(row.browserSupport.engineEquivalent, true);
	}
});
