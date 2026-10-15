import test from 'node:test';
import assert from 'node:assert/strict';
import {
	FAMILY_ORDER,
	createDeselectionStore,
	computeSelection,
	computeCappedSelection,
	deviceKeyOf,
	catalogDeviceKeys,
	availableBrowserFamilies,
	createSelectionState,
	computeExplicitSelection,
	selectAllDevices,
	deselectAllDevices,
	selectAllBrowsers,
	deselectAllBrowsers,
	toggleDevice,
	toggleBrowserFamily,
	createSelectionStore,
	MATRIX_BATCH_SIZE,
	sanitizeSelection,
	buildSummary,
	filterConfigurations,
	groupDeviceTree,
	facetValues,
	familyRows,
	isSelectable,
	isValidTargetUrl,
	canStartRun,
	fetchQaConfigurations,
	fetchConfigurationIndex,
	fetchConfigurationWindow,
	executionTypeLabel,
	configurationsForDevice,
	compatibleBrowserFamilies,
	defaultSelectionForDevice,
	recommendedDeviceScope,
	deviceScopeSelection,
	planBatches,
	batchKeyFor,
	selectionDimensions,
	setSelectionMode,
	defaultDeviceKeyForFamily,
	assignDevice,
	unassignDevice,
	computePerBrowserSelection,
	perBrowserOverview
} from './qaConfigMatrix.js';

/** Minimal in-memory localStorage. */
function memoryStorage() {
	const map = new Map();
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, String(value)),
		removeItem: (key) => map.delete(key)
	};
}

function configuration(overrides = {}) {
	return {
		envId: 'ENV-IOS-IP15-18.0-CHR-140',
		device: 'iPhone 15',
		manufacturer: 'Apple',
		platform: 'ios',
		os: 'iOS',
		osVersion: '18.0',
		deviceType: 'mobile',
		orientation: 'portrait',
		browser: 'Chrome',
		browserCode: 'chrome',
		browserVersion: '140',
		executionType: 'emulator',
		availability: 'AVAILABLE',
		availabilityReason: null,
		...overrides
	};
}

const CATALOG = [
	configuration(),
	configuration({ envId: 'ENV-IOS-IP15-18.0-CHR-141', browserVersion: '141' }),
	configuration({ envId: 'ENV-AND-SGS24-15-BRV-138', device: 'Galaxy S24', manufacturer: 'Samsung', platform: 'android', os: 'Android', osVersion: '15', browser: 'Brave', browserCode: 'brave', browserVersion: '138', executionType: 'virtual_machine' }),
	configuration({ envId: 'ENV-WIN-SL5-11-EDG-140', device: 'Surface Laptop 5', manufacturer: 'Microsoft', platform: 'windows', os: 'Windows', osVersion: '11', deviceType: 'desktop', orientation: 'landscape', browser: 'Edge', browserCode: 'edge', browserVersion: '140', executionType: 'browser_emulation' }),
	configuration({ envId: 'ENV-AND-PIX9-16-DDG-2', device: 'Pixel 9', manufacturer: 'Google', platform: 'android', browser: 'DuckDuckGo', browserCode: 'duckduckgo', browserVersion: '2', availability: 'NOT_SUPPORTED', availabilityReason: 'DuckDuckGo is mobile-only with no automation channel.' }),
	configuration({ envId: 'PROV-BS-IP15-REAL', device: 'iPhone 15', platform: 'ios', availability: 'NOT_CONFIGURED', availabilityReason: 'Provider "browserstack" not configured.' })
];

// #16042 fixtures: a Safari-only Mac (Safari has no rows on iPhone/Android in
// this catalog) and a second iPhone device so assignment paths are distinct.
const PAIRWISE_CATALOG = [
	...CATALOG,
	configuration({ envId: 'ENV-MAC-M3-17-SAF-26', device: 'MacBook Pro M3', manufacturer: 'Apple', platform: 'macos', os: 'macOS', osVersion: '17', deviceType: 'desktop', orientation: 'landscape', browser: 'Safari', browserCode: 'safari', browserVersion: '26', executionType: 'browser_emulation' }),
	configuration({ envId: 'ENV-IOS-IP15-18.0-SAF-26', browser: 'Safari', browserCode: 'safari', browserVersion: '26' }),
	configuration({ envId: 'ENV-IOS-IP11-17.0-CHR-140', device: 'iPhone 11', osVersion: '17.0', browser: 'Chrome', browserCode: 'chrome', browserVersion: '140' })
];

test('FAMILY_ORDER matches the seven required families', () => {
	assert.deepEqual(FAMILY_ORDER, ['edge', 'chrome', 'brave', 'firefox', 'safari', 'opera', 'duckduckgo']);
});

test('isSelectable: only AVAILABLE rows selectable', () => {
	assert.equal(isSelectable(configuration()), true);
	assert.equal(isSelectable(configuration({ availability: 'NOT_SUPPORTED' })), false);
	assert.equal(isSelectable(configuration({ availability: 'NOT_CONFIGURED' })), false);
	assert.equal(isSelectable(configuration({ availability: 'UNAVAILABLE' })), false);
});

test('default selection = all available configurations; unavailable never selected', () => {
	const store = createDeselectionStore(memoryStorage());
	const selected = computeSelection(CATALOG, store);
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-IOS-IP15-18.0-CHR-141', 'ENV-AND-SGS24-15-BRV-138', 'ENV-WIN-SL5-11-EDG-140']);
	assert.ok(!selected.includes('ENV-AND-PIX9-16-DDG-2'));
	assert.ok(!selected.includes('PROV-BS-IP15-REAL'));
});

test('explicit deselections persist and survive store recreation', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	store.deselect('ENV-AND-SGS24-15-BRV-138');
	store.deselect('ENV-WIN-SL5-11-EDG-140');
	let selected = computeSelection(CATALOG, store);
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-IOS-IP15-18.0-CHR-141']);
	// Simulate dialog reopen: fresh store over the same storage.
	const reopened = createDeselectionStore(storage);
	selected = computeSelection(CATALOG, reopened);
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-IOS-IP15-18.0-CHR-141']);
	// Reselect one back.
	reopened.reselect('ENV-AND-SGS24-15-BRV-138');
	assert.equal(computeSelection(CATALOG, reopened).length, 3);
	// Select-all clears memory.
	reopened.clear();
	assert.equal(computeSelection(CATALOG, reopened).length, 4);
});

test('deselection of an unavailable envId is inert (no fabricated availability)', () => {
	const store = createDeselectionStore(memoryStorage());
	store.deselect('ENV-AND-PIX9-16-DDG-2');
	assert.ok(!computeSelection(CATALOG, store).includes('ENV-AND-PIX9-16-DDG-2'));
	store.reselect('ENV-AND-PIX9-16-DDG-2');
	assert.ok(!computeSelection(CATALOG, store).includes('ENV-AND-PIX9-16-DDG-2'), 'resurrecting a deselected NOT_SUPPORTED row must not select it');
});

test('sanitizeSelection drops envIds that became unselectable', () => {
	const clean = sanitizeSelection(CATALOG, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-AND-PIX9-16-DDG-2', 'GONE-ID', 'PROV-BS-IP15-REAL']);
	assert.deepEqual(clean, ['ENV-IOS-IP15-18.0-CHR-140']);
});

test('buildSummary: planned total, per-family, per-platform, deselected and unavailable counts', () => {
	const store = createDeselectionStore(memoryStorage());
	store.deselect('ENV-WIN-SL5-11-EDG-140');
	const selected = computeSelection(CATALOG, store);
	const summary = buildSummary(CATALOG, selected);
	assert.equal(summary.total, 3);
	assert.equal(summary.availableTotal, 4);
	assert.equal(summary.unavailable, 2);
	assert.equal(summary.deselected, 1);
	assert.equal(summary.byFamily.chrome, 2);
	assert.equal(summary.byFamily.brave, 1);
	assert.equal(summary.byFamily.edge, 0);
	assert.equal(summary.byFamily.duckduckgo, 0);
	assert.deepEqual(summary.byPlatform, { ios: 2, android: 1 });
});

test('filterConfigurations: all five facets + search', () => {
	assert.equal(filterConfigurations(CATALOG, { platform: 'android' }).length, 2);
	assert.equal(filterConfigurations(CATALOG, { manufacturer: 'Samsung' }).length, 1);
	assert.equal(filterConfigurations(CATALOG, { device: 'Pixel 9' }).length, 1);
	assert.equal(filterConfigurations(CATALOG, { osVersion: '18.0' }).length, 4);
	assert.equal(filterConfigurations(CATALOG, { orientation: 'landscape' }).length, 1);
	assert.equal(filterConfigurations(CATALOG, { browserCode: 'brave' }).length, 1);
	assert.equal(filterConfigurations(CATALOG, { search: 'galaxy' }).length, 1);
	assert.equal(filterConfigurations(CATALOG, { search: 'IPHONE' }).length, 3);
	assert.equal(filterConfigurations(CATALOG, { executionType: 'virtual_machine' }).length, 1);
});

test('groupDeviceTree: platform → device → OS → family versions newest first', () => {
	const tree = groupDeviceTree(CATALOG);
	const ios = tree.find((group) => group.platform === 'ios');
	assert.ok(ios);
	const iphone = ios.devices.find((device) => device.device === 'iPhone 15');
	assert.ok(iphone);
	assert.equal(iphone.manufacturer, 'Apple');
	assert.ok(iphone.executionTypes.includes('emulator'));
	const os = iphone.osVersions[0];
	assert.equal(os.osVersion, '18.0');
	const chrome = os.browsers.find((browser) => browser.browserCode === 'chrome');
	// iPhone 15 iOS 18.0: two chrome versions + the provider-overlay iPhone 15 row
	// shares the device tree node only when its osVersion matches; the fixture
	// provider row carries osVersion 18.0 too, so three chrome rows exist.
	assert.deepEqual(chrome.versions.map((version) => version.browserVersion), ['141', '140', '140']);
});

test('facetValues returns facet lists with counts', () => {
	const facets = facetValues(CATALOG);
	assert.deepEqual(facets.platform.map((entry) => entry.value), ['ios', 'android', 'windows']);
	assert.ok(facets.manufacturer.some((entry) => entry.value === 'Apple' && entry.count === 3));
	assert.ok(facets.orientation.some((entry) => entry.value === 'landscape'));
});

test('familyRows: all seven always present; DDG unavailable with reason; versions newest first', () => {
	const rows = familyRows(CATALOG, [
		{ code: 'chrome', label: 'Chrome' },
		{ code: 'edge', label: 'Edge' },
		{ code: 'firefox', label: 'Firefox' },
		{ code: 'opera', label: 'Opera' },
		{ code: 'brave', label: 'Brave' },
		{ code: 'duckduckgo', label: 'DuckDuckGo', reasonWhenUnavailable: 'No automation channel.' },
		{ code: 'safari', label: 'Safari' }
	]);
	assert.equal(rows.length, 7);
	assert.deepEqual(rows.map((row) => row.code), FAMILY_ORDER);
	const chrome = rows.find((row) => row.code === 'chrome');
	assert.equal(chrome.available, true);
	assert.deepEqual(chrome.versions, ['141', '140']);
	const ddg = rows.find((row) => row.code === 'duckduckgo');
	assert.equal(ddg.available, false);
	assert.match(ddg.reason, /automation channel|mobile-only/);
	// Families with no rows at all (firefox/opera/safari in this fixture) stay visible + reason.
	for (const code of ['firefox', 'opera', 'safari']) {
		const row = rows.find((candidate) => candidate.code === code);
		assert.equal(row.available, false);
		assert.ok(row.reason, `${code} needs a reason`);
	}
});

test('safari absent from Android/Windows rows but present in family list', () => {
	const androidOnly = filterConfigurations(CATALOG, { platform: 'android' });
	assert.ok(androidOnly.every((row) => row.browserCode !== 'safari'));
	const rows = familyRows(androidOnly, []);
	const safari = rows.find((row) => row.code === 'safari');
	assert.equal(safari.available, false);
	assert.ok(safari.reason);
});

test('canStartRun gating: URL validity + at least one configuration', () => {
	assert.equal(isValidTargetUrl('https://example.com'), true);
	assert.equal(isValidTargetUrl('http://localhost:3000'), true);
	assert.equal(isValidTargetUrl('example.com'), false);
	assert.equal(isValidTargetUrl('ftp://example.com'), false);
	assert.equal(isValidTargetUrl(''), false);
	assert.equal(canStartRun({ targetUrl: 'https://example.com', selectedEnvIds: ['A'] }), true);
	assert.equal(canStartRun({ targetUrl: 'https://example.com', selectedEnvIds: [] }), false);
	assert.equal(canStartRun({ targetUrl: 'not-a-url', selectedEnvIds: ['A'] }), false);
});

// ---------------------------------------------------------------------------
// Pipeline Phase 1: EXPLICIT selection model — no selection cap. The 2,000
// limit is a per-batch EXECUTION limit (MATRIX_BATCH_SIZE), never a selection
// limit. Regression for the "Select All silently truncated to 2,000" defect.
// ---------------------------------------------------------------------------

test('Phase 1: canStartRun no longer caps the selection (batching owns that)', () => {
	// 5,250 selected configurations remain startable — Phase 2 batches them.
	assert.equal(canStartRun({ targetUrl: 'https://example.com', selectedEnvIds: new Array(5250).fill('A') }), true);
	assert.equal(MATRIX_BATCH_SIZE, 2000, 'batch size constant replaces the old cap');
});

test('Phase 1: selectAllDevices + selectAllBrowsers selects the ENTIRE catalog (37,244, not 2,000)', () => {
	const rows = cappedCatalog(2300, 1000); // 3,300 selectable rows, Android-first
	let state = createSelectionState();
	state = selectAllDevices(rows, state);
	state = selectAllBrowsers(rows, state);
	const selection = computeExplicitSelection(rows, state);
	assert.equal(selection.length, 3300, 'selection is NEVER truncated by a cap');
	assert.ok(selection.includes('ENV-IOS-0'), 'catalog-order tail (iOS) stays selected — no silent discard');
});

test('Phase 1: deselectAllDevices empties devices but keeps families; deselectAllBrowsers the inverse', () => {
	const rows = cappedCatalog(5, 5);
	let state = selectAllBrowsers(rows, selectAllDevices(rows, createSelectionState()));
	state = deselectAllDevices(rows, state);
	assert.equal(computeExplicitSelection(rows, state).length, 0);
	assert.equal(state.browserFamilies.size, 2, 'families untouched by device bulk action');
	state = selectAllDevices(rows, state);
	state = deselectAllBrowsers(rows, state);
	assert.equal(computeExplicitSelection(rows, state).length, 0);
	assert.equal(state.deviceKeys.size, 2, 'devices untouched by browser bulk action');
});

test('Phase 1: device toggle adds/removes one device; multi-device selection persists', () => {
	const rows = cappedCatalog(3, 3); // Galaxy S24 + iPhone 15
	const state = createSelectionState();
	toggleDevice(state, deviceKeyOf(rows[0]), true);
	toggleBrowserFamily(state, rows, rows[0].browserCode, true);
	toggleDevice(state, deviceKeyOf(rows[3]), true); // iPhone 15 also selected
	toggleBrowserFamily(state, rows, rows[3].browserCode, true);
	const selection = computeExplicitSelection(rows, state);
	assert.equal(selection.filter((envId) => envId.startsWith('ENV-AND-')).length, 3);
	assert.equal(selection.filter((envId) => envId.startsWith('ENV-IOS-')).length, 3);
	toggleDevice(state, deviceKeyOf(rows[0]), false);
	assert.equal(computeExplicitSelection(rows, state).filter((envId) => envId.startsWith('ENV-AND-')).length, 0, 'removing one device never touches the others');
});

test('Phase 1: granular envId overrides win over device/family selection', () => {
	const rows = cappedCatalog(4, 4);
	const state = selectAllBrowsers(rows, selectAllDevices(rows, createSelectionState()));
	state.deselectedEnvIds.add('ENV-AND-1');
	state.deselectedEnvIds.add('ENV-IOS-2');
	const selection = computeExplicitSelection(rows, state);
	assert.equal(selection.length, 6);
	assert.ok(!selection.includes('ENV-AND-1'));
	assert.ok(!selection.includes('ENV-IOS-2'));
});

test('Phase 1: unavailable rows are never selectable even under Select All', () => {
	const rows = [
		...cappedCatalog(2, 2),
		configuration({ envId: 'ENV-DDG-1', browserCode: 'duckduckgo', browser: 'DuckDuckGo', availability: 'NOT_SUPPORTED', availabilityReason: 'DuckDuckGo has no desktop automation channel.' })
	];
	const state = selectAllBrowsers(rows, selectAllDevices(rows, createSelectionState()));
	const selection = computeExplicitSelection(rows, state);
	assert.ok(!selection.includes('ENV-DDG-1'));
	assert.ok(!availableBrowserFamilies(rows).includes('duckduckgo'), 'DDG family is not offered for selection');
});

test('Phase 1: selection survives a catalog reload (store restores explicit state)', () => {
	const storage = memoryStorage();
	const provider = () => cappedCatalog(3, 3);
	const storeA = createSelectionStore(storage, provider);
	let state = storeA.get();
	toggleDevice(state, deviceKeyOf(provider()[3]), true);
	toggleBrowserFamily(state, provider(), 'chrome', true);
	storeA.save(state);
	// New session, fresh store over the SAME storage: explicit state restores.
	const storeB = createSelectionStore(storage, () => cappedCatalog(3, 3));
	const restored = storeB.get();
	assert.deepEqual(computeExplicitSelection(cappedCatalog(3, 3), restored).sort(),
		computeExplicitSelection(cappedCatalog(3, 3), state).sort());
});

test('Phase 1: legacy deselections migrate best-effort into the new model', () => {
	const storage = memoryStorage();
	const rows = cappedCatalog(5, 5);
	// A prior session's persisted opt-outs under the LEGACY key.
	storage.setItem('qase.qaConfigDeselections', JSON.stringify({ envIds: ['ENV-AND-1', 'ENV-IOS-3'] }));
	const store = createSelectionStore(storage, () => rows);
	const state = store.get();
	const selection = computeExplicitSelection(rows, state);
	assert.ok(!selection.includes('ENV-AND-1'), 'legacy opt-out honored');
	assert.ok(!selection.includes('ENV-IOS-3'), 'legacy opt-out honored');
	// Everything else defaults to selected (full catalog).
	assert.equal(selection.length, 8);
});

test('Phase 1: family toggle clears granular deselections within that family', () => {
	const rows = cappedCatalog(3, 3);
	const state = selectAllBrowsers(rows, selectAllDevices(rows, createSelectionState()));
	state.deselectedEnvIds.add('ENV-AND-1');
	toggleBrowserFamily(state, rows, 'brave', false);
	toggleBrowserFamily(state, rows, 'brave', true);
	const selection = computeExplicitSelection(rows, state);
	assert.ok(selection.includes('ENV-AND-1'), 're-selecting the family resets chip-level opt-outs in it');
});

test('Phase 1: unknown persisted keys (stale catalog ids) simply match nothing', () => {
	const storage = memoryStorage();
	storage.setItem('qase.qaConfigSelection.v2', JSON.stringify({
		deviceKeys: ['Ghost|ghost|GhostPhone'],
		browserFamilies: ['chrome'],
		deselectedEnvIds: []
	}));
	const store = createSelectionStore(storage, () => cappedCatalog(2, 2));
	const state = store.get();
	assert.equal(computeExplicitSelection(cappedCatalog(2, 2), state).length, 0);
});

test('Phase 1 regression: Select All clears a LARGE stale override set (tester round 1 — count stuck at 6)', () => {
	// A legacy migration (or prior chip opt-outs) left 37k+ granular
	// deselections in place; clicking Select All must give the FULL catalog,
	// not the trickle that survives the exclusions.
	const rows = cappedCatalog(2300, 1000);
	// Recreate the observed broken state: devices + families selected, but
	// nearly every envId excluded at chip level (legacy migration artifact).
	let state = selectAllDevices(rows, selectAllBrowsers(rows, createSelectionState()));
	const staleOverrides = new Set(rows.slice(0, rows.length - 6).map((row) => row.envId));
	state = createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: staleOverrides
	});
	assert.equal(computeExplicitSelection(rows, state).length, 6, 'sanity: the stale exclusions starve the count');
	state = selectAllDevices(rows, state);
	state = selectAllBrowsers(rows, state);
	assert.equal(computeExplicitSelection(rows, state).length, 3300, 'Select All now yields the complete catalog');
});

test('fetchQaConfigurations: ok → payload; error status → thrown with message; malformed → thrown', async () => {
	const ok = await fetchQaConfigurations({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({ configurations: [], browserFamilies: [], totals: { configurations: 0 } }) }) });
	assert.deepEqual(ok.configurations, []);
	await assert.rejects(
		fetchQaConfigurations({ fetcher: async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }) }),
		/boom/
	);
	await assert.rejects(
		fetchQaConfigurations({ fetcher: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }) }),
		/malformed/
	);
});

test('executionTypeLabel maps all five execution types', () => {
	assert.equal(executionTypeLabel('physical_device'), 'Physical device');
	assert.equal(executionTypeLabel('virtual_machine'), 'Virtual machine');
	assert.equal(executionTypeLabel('emulator'), 'Emulator');
	assert.equal(executionTypeLabel('simulator'), 'Simulator');
	assert.equal(executionTypeLabel('browser_emulation'), 'Browser emulation');
});

/* ── Windowed catalog model (30MB-payload fix, #15013) ─────────────── */

test('fetchConfigurationIndex requests the compact index and returns it', async () => {
	const calls = [];
	const fetcher = async (url) => {
		calls.push(url);
		assert.match(url, /\/api\/qa-configurations\?index=1&limit=1/);
		return { ok: true, json: async () => ({ index: [configuration()], configurations: [], totals: {} }) };
	};
	const index = await fetchConfigurationIndex({ fetcher });
	assert.equal(index.length, 1);
	assert.equal(index[0].envId, 'ENV-IOS-IP15-18.0-CHR-140');
});

test('fetchConfigurationIndex surfaces server errors with status', async () => {
	const fetcher = async () => ({ ok: false, status: 500, json: async () => ({ error: 'catalog exploded' }) });
	await assert.rejects(
		() => fetchConfigurationIndex({ fetcher }),
		(error) => error.status === 500 && /catalog exploded/.test(error.message)
	);
});

test('fetchConfigurationWindow passes filters + pagination and reports hasMore', async () => {
	const seen = [];
	const fetcher = async (url) => {
		seen.push(url);
		return { ok: true, json: async () => ({ configurations: [configuration()], totals: { configurations: 12 } }) };
	};
	const result = await fetchConfigurationWindow({ platform: 'ios', search: 'iphone 15' }, { fetcher, limit: 50, offset: 100 });
	assert.match(seen[0], /platform=ios/);
	assert.match(seen[0], /search=iphone(%2015|\+15)/);
	assert.match(seen[0], /limit=50/);
	assert.match(seen[0], /offset=100/);
	assert.equal(result.configurations.length, 1);
	assert.equal(result.total, 12);
	assert.equal(result.hasMore, false); // 100 + 1 < 12 is false
});

test('#16045: fetchConfigurationWindow serializes deviceType when set and omits it when empty', async () => {
	const seen = [];
	const fetcher = async (url) => {
		seen.push(url);
		return { ok: true, json: async () => ({ configurations: [configuration()], totals: { configurations: 12 } }) };
	};
	await fetchConfigurationWindow({ deviceType: 'mobile' }, { fetcher });
	assert.match(seen[0], /deviceType=mobile/);
	await fetchConfigurationWindow({ deviceType: '' }, { fetcher });
	assert.doesNotMatch(seen[1], /deviceType=/);
	await fetchConfigurationWindow({}, { fetcher });
	assert.doesNotMatch(seen[2], /deviceType=/);
});

test('fetchConfigurationWindow hasMore is true when window is partial', async () => {
	// #15439: windows are device-grouped — hasMore comes from the server's
	// device-group pagination, not raw row arithmetic.
	const fetcher = async (url) => {
		assert.match(url, /groupBy=device/);
		return { ok: true, json: async () => ({ configurations: Array.from({ length: 50 }, (_, i) => configuration({ envId: `E${i}` })), totals: { configurations: 500 }, deviceGroups: 176, deviceOffset: 0, deviceLimit: 12, hasMore: true }) };
	};
	const result = await fetchConfigurationWindow({}, { fetcher, limit: 12, offset: 0 });
	assert.equal(result.hasMore, true);
	assert.equal(result.deviceTotal, 176);
	assert.equal(result.deviceCount, 12);
});

test('fetchConfigurationWindow rejects malformed payloads', async () => {
	const fetcher = async () => ({ ok: true, json: async () => ({ nonsense: true }) });
	await assert.rejects(() => fetchConfigurationWindow({}, { fetcher }), /malformed/);
});

test('default selection over an index honors deselections across the full catalog', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	store.deselect('ENV-AND-SGS24-15-BRV-138');
	const selected = computeSelection(CATALOG, store);
	assert.ok(!selected.includes('ENV-AND-SGS24-15-BRV-138'));
	assert.ok(!selected.includes('PROV-BS-IP15-REAL')); // NOT_CONFIGURED never selected
	assert.equal(selected.length, 3);
});

test('buildSummary over the index reports full-catalog totals', () => {
	const selected = computeSelection(CATALOG, createDeselectionStore(memoryStorage()));
	const summary = buildSummary(CATALOG, selected);
	assert.equal(summary.total, 4); // 6 rows − 1 NOT_SUPPORTED − 1 NOT_CONFIGURED
	assert.equal(summary.availableTotal, 4);
	assert.equal(summary.unavailable, 2);
	assert.equal(summary.byFamily.chrome, 2);
	assert.equal(summary.byFamily.edge, 1);
	assert.equal(summary.byFamily.brave, 1);
});

test('#15092 family-toggle bulk store writes persist once and survive reopen', () => {
	const storage = memoryStorage();
	let writes = 0;
	const counting = {
		getItem: storage.getItem,
		setItem: (key, value) => { writes += 1; storage.setItem(key, value); },
		removeItem: storage.removeItem
	};
	const store = createDeselectionStore(counting);
	// Family toggle deselecting ~8k rows must be ONE store write, not one
	// per envId (the per-row persist crashed the renderer tab).
	const ids = Array.from({ length: 8000 }, (_, index) => `ENV-BULK-${index}`);
	store.deselectMany(ids);
	assert.equal(writes, 1);
	assert.equal(store.get().size, 8000);
	// Persistence survives a "reopen" (new store over the same storage).
	const reopened = createDeselectionStore(storage);
	assert.equal(reopened.get().size, 8000);
	reopened.reselectMany(ids.slice(0, 4000));
	assert.equal(reopened.get().size, 4000);
	const reopened2 = createDeselectionStore(storage);
	assert.equal(reopened2.get().size, 4000);
});

// ---------------------------------------------------------------------------
// #15163 device scope: picking a device auto-selects ALL its compatible
// browsers; switching devices never leaks the previous scope.
// ---------------------------------------------------------------------------
test('#15163 configurationsForDevice scopes by platform+device+manufacturer', () => {
	const galaxy = configurationsForDevice(CATALOG, { platform: 'android', device: 'Galaxy S24', manufacturer: 'Samsung' });
	assert.equal(galaxy.length, 1);
	assert.ok(galaxy.every((row) => row.device === 'Galaxy S24' && row.platform === 'android'));
	const other = configurationsForDevice(CATALOG, { platform: 'android', device: 'Galaxy S24', manufacturer: 'Other' });
	assert.equal(other.length, 0);
});

test('#15163 compatibleBrowserFamilies lists only families with an available row', () => {
	const galaxy = configurationsForDevice(CATALOG, { platform: 'android', device: 'Galaxy S24', manufacturer: 'Samsung' });
	const families = compatibleBrowserFamilies(galaxy);
	assert.ok(families.includes('brave'));
	assert.ok(!families.includes('duckduckgo'), 'statically unsupported family must never appear');
	const pixel = configurationsForDevice(CATALOG, { platform: 'android', device: 'Pixel 9', manufacturer: 'Google' });
	assert.deepEqual(compatibleBrowserFamilies(pixel), []);
});

test('#15163 defaultSelectionForDevice returns exactly the available envIds', () => {
	const galaxy = configurationsForDevice(CATALOG, { platform: 'android', device: 'Galaxy S24', manufacturer: 'Samsung' });
	assert.deepEqual([...defaultSelectionForDevice(galaxy)], ['ENV-AND-SGS24-15-BRV-138']);
	const pixel = configurationsForDevice(CATALOG, { platform: 'android', device: 'Pixel 9', manufacturer: 'Google' });
	assert.deepEqual([...defaultSelectionForDevice(pixel)], []);
});

test('customer launcher recommends a focused desktop device and respects a saved selection', () => {
	assert.deepEqual(recommendedDeviceScope(CATALOG), {
		platform: 'windows',
		device: 'Surface Laptop 5',
		manufacturer: 'Microsoft'
	});
	assert.deepEqual(recommendedDeviceScope(CATALOG, { envId: 'ENV-AND-SGS24-15-BRV-138' }), {
		platform: 'android',
		device: 'Galaxy S24',
		manufacturer: 'Samsung'
	});
	assert.equal(recommendedDeviceScope(CATALOG.map((row) => ({ ...row, availability: 'UNAVAILABLE' }))), null);
});

test('#15163 deviceScopeSelection derives scope + selection + families in one call', () => {
	const result = deviceScopeSelection(CATALOG, { platform: 'android', device: 'Galaxy S24', manufacturer: 'Samsung' });
	assert.equal(result.scope.platform, 'android');
	assert.deepEqual(result.selectedEnvIds, ['ENV-AND-SGS24-15-BRV-138']);
	assert.ok(result.browserFamilies.includes('brave'));
	assert.equal(result.configurationCount, 1);
	assert.equal(deviceScopeSelection(CATALOG, null), null);
});

// ---------------------------------------------------------------------------
// #14276: computeCappedSelection — explicit ticks survive the 2,000-cap
// (#15323 interplay). Regression: catalog order is Android-first, so the
// capped default selection was entirely Android; ticking an iPhone chip was a
// reselect() no-op that the slice then discarded ("devices are not getting
// selected").
// ---------------------------------------------------------------------------

/** Catalog with `androidCount` Android rows first (catalog order), then iOS rows. */
function cappedCatalog(androidCount, iosCount) {
	const rows = [];
	for (let i = 0; i < androidCount; i += 1) {
		rows.push(configuration({
			envId: `ENV-AND-${i}`,
			device: 'Galaxy S24', manufacturer: 'Samsung', platform: 'android', os: 'Android', osVersion: '15',
			browserCode: 'brave', browser: 'Brave', browserVersion: '138'
		}));
	}
	for (let i = 0; i < iosCount; i += 1) {
		rows.push(configuration({
			envId: `ENV-IOS-${i}`,
			device: 'iPhone 15', manufacturer: 'Apple', platform: 'ios', os: 'iOS', osVersion: '18.0',
			browserCode: 'chrome', browser: 'Chrome', browserVersion: '140'
		}));
	}
	return rows;
}

test('#14276 computeCappedSelection caps the default at MAX_RUN_CONFIGURATIONS in catalog order', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	const rows = cappedCatalog(2100, 100);
	const selection = computeCappedSelection(rows, store);
	assert.equal(selection.length, 2000);
	assert.ok(selection.every((envId) => envId.startsWith('ENV-AND-')), 'cap eats the catalog-order tail first');
});

test('#14276 explicit tick of an out-of-cap device survives the cap', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	const rows = cappedCatalog(2100, 100);
	// User ticks one iPhone chip while the run sits at the cap.
	const explicit = new Set(['ENV-IOS-3']);
	const selection = computeCappedSelection(rows, store, explicit);
	assert.equal(selection.length, 2000, 'cap total unchanged — the tick displaces a tail row');
	assert.ok(selection.includes('ENV-IOS-3'), 'the explicitly ticked iPhone chip stays selected');
	assert.equal(selection.filter((envId) => envId.startsWith('ENV-AND-')).length, 1999, 'one Android tail row gives up its slot');
});

test('#14276 explicit deselection keeps losing its slot before the cap applies', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	const rows = cappedCatalog(2100, 100);
	// User unticks one Android chip (persisted) AND ticks one iPhone chip.
	store.deselect('ENV-AND-0');
	const explicit = new Set(['ENV-IOS-5']);
	const selection = computeCappedSelection(rows, store, explicit);
	assert.equal(selection.length, 2000);
	assert.ok(!selection.includes('ENV-AND-0'), 'explicit deselection is never re-added');
	assert.ok(selection.includes('ENV-IOS-5'), 'explicit tick survives');
});

test('#14276 unticking an explicitly ticked chip releases its pinned slot', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	const rows = cappedCatalog(2100, 100);
	const explicit = new Set(['ENV-IOS-3']);
	let selection = computeCappedSelection(rows, store, explicit);
	assert.ok(selection.includes('ENV-IOS-3'));
	// Then the user unticks it again: chip untick records a persisted deselect.
	store.deselect('ENV-IOS-3');
	explicit.delete('ENV-IOS-3');
	selection = computeCappedSelection(rows, store, explicit);
	assert.ok(!selection.includes('ENV-IOS-3'));
	assert.equal(selection.filter((envId) => envId.startsWith('ENV-AND-')).length, 2000);
});

test('#14276 computeCappedSelection equals capped computeSelection with no explicit ticks', () => {
	const storage = memoryStorage();
	const store = createDeselectionStore(storage);
	const rows = cappedCatalog(2100, 100);
	assert.deepEqual(computeCappedSelection(rows, store), computeSelection(rows, store).slice(0, 2000));
});

// ---------------------------------------------------------------------------
// Pipeline Phase 2: batch planning — >2,000 selections become ordered
// batches of ≤2,000; the 2,000 limit is an EXECUTION/batch limit, never a
// selection limit.
// ---------------------------------------------------------------------------

test('Phase 2: planBatches edge cases (0, 1, exactly 2000, 2001, 5250)', () => {
	assert.deepEqual(planBatches([]), [], 'empty selection → no batches');
	assert.deepEqual(planBatches(['A']), [['A']]);
	const exactly = Array.from({ length: 2000 }, (_, i) => `E${i}`);
	assert.deepEqual(planBatches(exactly), [exactly], 'exactly 2,000 → one full batch');
	const over = Array.from({ length: 2001 }, (_, i) => `E${i}`);
	const overBatches = planBatches(over);
	assert.equal(overBatches.length, 2);
	assert.equal(overBatches[0].length, 2000);
	assert.equal(overBatches[1].length, 1);
	// Spec acceptance: 5,250 → 2000/2000/1250.
	const big = Array.from({ length: 5250 }, (_, i) => `E${i}`);
	const bigBatches = planBatches(big);
	assert.deepEqual(bigBatches.map((batch) => batch.length), [2000, 2000, 1250]);
	// Disjoint by construction, order preserved, union = original.
	for (const batch of bigBatches) assert.ok(batch.length <= MATRIX_BATCH_SIZE);
	assert.deepEqual(bigBatches.flat(), big);
	// 37,244 "Run All" → 19 batches (18 full + 1 of 644).
	const huge = Array.from({ length: 37244 }, (_, i) => `E${i}`);
	const hugeBatches = planBatches(huge);
	assert.equal(hugeBatches.length, 19);
	assert.deepEqual(hugeBatches.map((batch) => batch.length).slice(0, 18), Array(18).fill(2000));
	assert.equal(hugeBatches[18].length, 1244); // 37,244 − 18×2,000
});

test('Phase 2: planBatches rejects invalid batch sizes; batchKeyFor is stable and parent/env scoped', async () => {
	assert.throws(() => planBatches(['A'], 0), TypeError);
	assert.throws(() => planBatches(['A'], 1.5), TypeError);
	const ids = ['ENV-A', 'ENV-B'];
	const keyA = await batchKeyFor('parent-1', ids);
	const keyA2 = await batchKeyFor('parent-1', [...ids]);
	const keyB = await batchKeyFor('parent-2', ids);
	const keyC = await batchKeyFor('parent-1', ['ENV-B', 'ENV-A']);
	assert.equal(keyA, keyA2, 'same parent + same ids → same key (retry-safe)');
	assert.notEqual(keyA, keyB, 'different parent → different key');
	assert.notEqual(keyA, keyC, 'different id set → different key');
	assert.match(keyA, /^[0-9a-f]{32}$/, 'hex digest key');
});

// ---------------------------------------------------------------------------
// #16042 Phase 1: per-browser device selection (one device per browser)
// ---------------------------------------------------------------------------

test('#16042: default state mode is cross; mode persists in state', () => {
	const state = createSelectionState();
	assert.equal(state.mode, 'cross');
	assert.equal(state.activeFamily, null);
	const per = createSelectionState({ mode: 'perBrowser', browserFamilies: new Set(['chrome']) });
	assert.equal(per.mode, 'perBrowser');
});

test('#16042: setSelectionMode to perBrowser auto-assigns default devices', () => {
	const state = createSelectionState({
		browserFamilies: new Set(['chrome', 'brave']),
		deviceKeys: catalogDeviceKeys(PAIRWISE_CATALOG)
	});
	const next = setSelectionMode(state, PAIRWISE_CATALOG, 'perBrowser');
	assert.equal(next.mode, 'perBrowser');
	// chrome's first selectable config is iPhone 15 (catalog order)
	assert.equal(next.deviceAssignments.chrome, 'Apple|ios|iPhone 15');
	// brave's first selectable config is Galaxy S24
	assert.equal(next.deviceAssignments.brave, 'Samsung|android|Galaxy S24');
	// cross-product fields untouched
	assert.deepEqual([...next.browserFamilies].sort(), ['brave', 'chrome']);
});

test('#16042: switching back to cross keeps assignments inert and restores them on return', () => {
	let state = createSelectionState({
		browserFamilies: new Set(['chrome', 'safari']),
		deviceKeys: catalogDeviceKeys(PAIRWISE_CATALOG)
	});
	state = setSelectionMode(state, PAIRWISE_CATALOG, 'perBrowser');
	state = assignDevice(state, PAIRWISE_CATALOG, 'safari', 'Apple|macos|MacBook Pro M3');
	assert.equal(state.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3');
	const cross = setSelectionMode(state, PAIRWISE_CATALOG, 'cross');
	assert.equal(cross.mode, 'cross');
	assert.equal(cross.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3', 'assignment kept in state');
	// cross-mode selection ignores assignments entirely
	const crossSelected = computeExplicitSelection(PAIRWISE_CATALOG, cross);
	assert.ok(crossSelected.includes('ENV-IOS-IP15-18.0-CHR-140'));
	assert.ok(crossSelected.includes('ENV-MAC-M3-17-SAF-26'), 'cross selects safari×Mac (not just the per-browser assignment)');
	const back = setSelectionMode(cross, PAIRWISE_CATALOG, 'perBrowser');
	assert.equal(back.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3', 'restored');
});

test('#16042: assignDevice validates the pair and implicitly selects the family', () => {
	let state = createSelectionState({ mode: 'perBrowser' });
	state = assignDevice(state, PAIRWISE_CATALOG, 'chrome', 'Apple|ios|iPhone 11');
	assert.ok(state.browserFamilies.has('chrome'), 'family implicitly selected');
	assert.equal(state.deviceAssignments.chrome, 'Apple|ios|iPhone 11');
	// invalid: device has no selectable configs for the family
	assert.throws(() => assignDevice(state, PAIRWISE_CATALOG, 'safari', 'Microsoft|windows|Surface Laptop 5'), /No available configurations/i);
	// invalid: unknown device key
	assert.throws(() => assignDevice(state, PAIRWISE_CATALOG, 'chrome', 'Nobody|nowhere|Ghost Phone'), /No available configurations/i);
});

test('#16042: unassignDevice removes the assignment, family stays selected', () => {
	let state = createSelectionState({ mode: 'perBrowser', browserFamilies: new Set(['chrome']) });
	state = assignDevice(state, PAIRWISE_CATALOG, 'chrome', 'Apple|ios|iPhone 11');
	state = unassignDevice(state, 'chrome');
	assert.equal(state.deviceAssignments.chrome, undefined);
	assert.ok(state.browserFamilies.has('chrome'));
});

test('#16042: toggleBrowserFamily in perBrowser mode auto-assigns the default device on select', () => {
	let state = createSelectionState({ mode: 'perBrowser' });
	state = setSelectionMode(state, PAIRWISE_CATALOG, 'perBrowser'); // no families yet
	toggleBrowserFamily(state, PAIRWISE_CATALOG, 'safari', true);
	assert.ok(state.browserFamilies.has('safari'));
	assert.equal(state.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3', 'safari default = its only device');
	// deselect keeps the assignment (inert)
	toggleBrowserFamily(state, PAIRWISE_CATALOG, 'safari', false);
	assert.equal(state.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3');
	assert.ok(!state.browserFamilies.has('safari'));
});

test('#16042: computePerBrowserSelection returns only assigned-family device rows', () => {
	const state = createSelectionState({
		mode: 'perBrowser',
		browserFamilies: new Set(['chrome', 'safari']),
		deviceAssignments: {
			chrome: 'Apple|ios|iPhone 15',
			safari: 'Apple|macos|MacBook Pro M3'
		}
	});
	const selected = computePerBrowserSelection(PAIRWISE_CATALOG, state);
	// chrome → iPhone 15 (two version rows), safari → MacBook Pro M3 (one row)
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-IOS-IP15-18.0-CHR-141', 'ENV-MAC-M3-17-SAF-26']);
});

test('#16042: granular deselections still apply in perBrowser mode', () => {
	const state = createSelectionState({
		mode: 'perBrowser',
		browserFamilies: new Set(['chrome']),
		deviceAssignments: { chrome: 'Apple|ios|iPhone 15' },
		deselectedEnvIds: new Set(['ENV-IOS-IP15-18.0-CHR-140'])
	});
	const selected = computePerBrowserSelection(PAIRWISE_CATALOG, state);
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-141']);
});

test('#16042: computeExplicitSelection dispatches on mode', () => {
	const perState = createSelectionState({
		mode: 'perBrowser',
		browserFamilies: new Set(['chrome']),
		deviceKeys: catalogDeviceKeys(PAIRWISE_CATALOG),
		deviceAssignments: { chrome: 'Apple|ios|iPhone 11' }
	});
	assert.deepEqual(computeExplicitSelection(PAIRWISE_CATALOG, perState), ['ENV-IOS-IP11-17.0-CHR-140']);
});

test('#16042: defaultDeviceKeyForFamily returns null when family has no selectable rows', () => {
	assert.equal(defaultDeviceKeyForFamily(PAIRWISE_CATALOG, 'duckduckgo'), null);
	assert.equal(defaultDeviceKeyForFamily(PAIRWISE_CATALOG, 'firefox'), null);
	assert.equal(defaultDeviceKeyForFamily(PAIRWISE_CATALOG, 'chrome'), 'Apple|ios|iPhone 15');
});

test('#16042: selection store round-trips mode and assignments; legacy payloads restore as cross', () => {
	const storage = memoryStorage();
	let provider = { catalog: PAIRWISE_CATALOG };
	const store = createSelectionStore(storage, () => provider.catalog);
	let state = store.get(); // first run → everything selected, cross mode
	assert.equal(state.mode, 'cross');
	state = setSelectionMode(state, provider.catalog, 'perBrowser');
	assignDeviceMutating(state, provider.catalog, 'chrome', 'Apple|ios|iPhone 11');
	store.save(state);

	// fresh store over same storage — restores mode + assignments
	const store2 = createSelectionStore(storage, () => provider.catalog);
	const restored = store2.get();
	assert.equal(restored.mode, 'perBrowser');
	assert.equal(restored.deviceAssignments.chrome, 'Apple|ios|iPhone 11');

	// legacy payload without mode → cross
	storage.setItem('qase.qaConfigSelection.v2', JSON.stringify({
		deviceKeys: ['Apple|ios|iPhone 15'],
		browserFamilies: ['chrome'],
		deselectedEnvIds: []
	}));
	const store3 = createSelectionStore(storage, () => provider.catalog);
	const legacy = store3.get();
	assert.equal(legacy.mode, 'cross');
	assert.deepEqual(legacy.deviceAssignments, {});

	// stale assignment (device left the catalog) dropped on restore
	storage.setItem('qase.qaConfigSelection.v2', JSON.stringify({
		mode: 'perBrowser',
		deviceKeys: [],
		browserFamilies: ['chrome'],
		deselectedEnvIds: [],
		deviceAssignments: { chrome: 'Ghost|none|Phantom', safari: 'Apple|macos|MacBook Pro M3' }
	}));
	const store4 = createSelectionStore(storage, () => provider.catalog);
	const validated = store4.get();
	assert.equal(validated.deviceAssignments.chrome, undefined, 'stale dropped');
	assert.equal(validated.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3', 'valid kept');
});

test('#16042: perBrowserOverview lists one row per selected family with device label and run count', () => {
	const state = createSelectionState({
		mode: 'perBrowser',
		browserFamilies: new Set(['chrome', 'safari', 'brave']),
		deviceAssignments: {
			chrome: 'Apple|ios|iPhone 15',
			safari: 'Apple|macos|MacBook Pro M3'
			// brave selected but unassigned
		}
	});
	const overview = perBrowserOverview(PAIRWISE_CATALOG, state);
	assert.equal(overview.length, 3);
	const chrome = overview.find((row) => row.family === 'chrome');
	assert.equal(chrome.deviceLabel, 'Apple iPhone 15');
	assert.equal(chrome.runs, 2);
	const safari = overview.find((row) => row.family === 'safari');
	assert.equal(safari.deviceLabel, 'Apple MacBook Pro M3');
	assert.equal(safari.runs, 1);
	const brave = overview.find((row) => row.family === 'brave');
	assert.equal(brave.deviceKey, null);
	assert.equal(brave.runs, 0);
});

test('#16042: dimensions math — 2 browsers × 1 device each → 3 runs', () => {
	const state = createSelectionState({
		mode: 'perBrowser',
		browserFamilies: new Set(['chrome', 'safari']),
		deviceAssignments: {
			chrome: 'Apple|ios|iPhone 15',
			safari: 'Apple|macos|MacBook Pro M3'
		}
	});
	const selected = computePerBrowserSelection(PAIRWISE_CATALOG, state);
	const dimensions = selectionDimensions(PAIRWISE_CATALOG, selected);
	assert.equal(dimensions.families, 2);
	assert.equal(dimensions.devices, 2);
	assert.equal(dimensions.runs, 3);
});

// helper: mutate-style assign used in the store round-trip test
function assignDeviceMutating(state, catalog, family, deviceKey) {
	const next = assignDevice(state, catalog, family, deviceKey);
	state.browserFamilies = next.browserFamilies;
	state.deviceKeys = next.deviceKeys;
	state.deselectedEnvIds = next.deselectedEnvIds;
	state.mode = next.mode;
	state.activeFamily = next.activeFamily;
	state.deviceAssignments = next.deviceAssignments;
}

test('#16042: cross-mode behavior byte-identical (regression)', () => {
	const state = createSelectionState({
		deviceKeys: new Set(['Apple|ios|iPhone 15', 'Samsung|android|Galaxy S24']),
		browserFamilies: new Set(['chrome', 'brave'])
	});
	const selected = computeExplicitSelection(PAIRWISE_CATALOG, state);
	assert.deepEqual(selected, ['ENV-IOS-IP15-18.0-CHR-140', 'ENV-IOS-IP15-18.0-CHR-141', 'ENV-AND-SGS24-15-BRV-138']);
});

test('#16042: selectAllBrowsers in perBrowser mode auto-assigns defaults for every family', () => {
	let state = createSelectionState({ mode: 'perBrowser', browserFamilies: new Set(['chrome']), deviceAssignments: { chrome: 'Apple|ios|iPhone 11' } });
	state = selectAllBrowsers(PAIRWISE_CATALOG, state);
	assert.ok(state.browserFamilies.has('edge'));
	assert.ok(state.browserFamilies.has('brave'));
	assert.ok(state.browserFamilies.has('safari'));
	assert.equal(state.deviceAssignments.edge, 'Microsoft|windows|Surface Laptop 5');
	assert.equal(state.deviceAssignments.brave, 'Samsung|android|Galaxy S24');
	assert.equal(state.deviceAssignments.chrome, 'Apple|ios|iPhone 11', 'existing assignment preserved, not reset to default');
	assert.equal(state.deviceAssignments.safari, 'Apple|macos|MacBook Pro M3');
});

test('#16042: deselectedEnvIds honored by setSelectionMode auto-assign (no phantom selections)', () => {
	const state = createSelectionState({
		browserFamilies: new Set(['chrome']),
		deviceKeys: catalogDeviceKeys(PAIRWISE_CATALOG)
	});
	const next = setSelectionMode(state, PAIRWISE_CATALOG, 'perBrowser');
	assert.equal(next.deviceAssignments.chrome, 'Apple|ios|iPhone 15');
});
