/**
 * QA launcher configuration matrix model (Phase 2, #15013).
 *
 * Pure model layer for the Start QA dialog's device & browser matrix:
 * - fetch state machine (loading / empty / error with retry)
 * - facet filtering (platform, manufacturer, model, OS version, orientation, search)
 * - selection helpers for a focused default device and explicit user
 *   deselections persisted across dialog reopens (localStorage)
 * - summary assembly (planned total + per-family counts)
 * - Start gating predicate (valid URL + at least one selected configuration)
 *
 * The server contract is GET /api/qa-configurations (server/qaConfigurations.js):
 * { configurations: [...], browserFamilies: [...], providers: [...], totals }.
 */

export const FAMILY_ORDER = ['edge', 'chrome', 'brave', 'firefox', 'safari', 'opera', 'duckduckgo'];

const DESELECTION_STORAGE_KEY = 'qase.qaConfigDeselections';
/** #Phase-1: explicit selection state lives under its own storage key so it
 *  can never collide with the legacy deselection memory being migrated from. */
const SELECTION_STORAGE_KEY = 'qase.qaConfigSelection.v2';

/** Execution-type badge labels shown next to devices/configurations. */
export const EXECUTION_TYPE_LABELS = {
	physical_device: 'Physical device',
	virtual_machine: 'Virtual machine',
	emulator: 'Emulator',
	simulator: 'Simulator',
	browser_emulation: 'Browser emulation'
};

export function executionTypeLabel(executionType) {
	return EXECUTION_TYPE_LABELS[executionType] ?? 'Unknown';
}

/**
 * A configuration is selectable only when it is AVAILABLE — NOT_SUPPORTED,
 * NOT_CONFIGURED and UNAVAILABLE rows stay visible but disabled, with their
 * reason (honest coverage, never silently hidden).
 */
export function isSelectable(configuration) {
	return configuration.availability === 'AVAILABLE';
}

// ---------------------------------------------------------------------------
// Deselection memory
// ---------------------------------------------------------------------------

/** Factory (localStorage injectable for tests). Load/save explicit deselections. */
export function createDeselectionStore(storage) {
	const read = () => {
		try {
			const raw = storage.getItem(DESELECTION_STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			return parsed && typeof parsed === 'object' ? new Set(parsed.envIds ?? []) : new Set();
		} catch {
			return new Set();
		}
	};
	let deselected = read();
	return {
		get() {
			return new Set(deselected);
		},
		deselect(envId) {
			deselected.add(envId);
			persist();
		},
		/** Bulk deselect (family toggle). Writes storage ONCE — one persist per
		 *  call instead of one per envId, which serialized ~8k localStorage
		 *  writes on a family click and crashed the renderer tab (#15092). */
		deselectMany(envIds) {
			for (const envId of envIds) deselected.add(envId);
			persist();
		},
		reselect(envId) {
			deselected.delete(envId);
			persist();
		},
		/** Bulk reselect (family toggle) — single persist, same rationale. */
		reselectMany(envIds) {
			for (const envId of envIds) deselected.delete(envId);
			persist();
		},
		/** Explicitly reselect everything (Select-all affordance). */
		clear() {
			deselected.clear();
			persist();
		}
	};
	function persist() {
		try {
			storage.setItem(DESELECTION_STORAGE_KEY, JSON.stringify({ envIds: [...deselected] }));
		} catch {
			/* storage unavailable (private mode) — in-memory only */
		}
	}
}

// ---------------------------------------------------------------------------
// Explicit selection model (pipeline Phase 1)
// ---------------------------------------------------------------------------

/** Stable identity of one device across the catalog: the same key format the
 *  grouped device tree renders (`manufacturer|platform|device`). */
export function deviceKeyOf(configuration) {
	return `${configuration.manufacturer ?? ''}|${configuration.platform}|${configuration.device}`;
}

/** Canonical set of every selectable family present in the catalog. */
export function availableBrowserFamilies(configurations) {
	return FAMILY_ORDER.filter((code) =>
		configurations.some((configuration) => configuration.browserCode === code && isSelectable(configuration)));
}

/**
 * Explicit selection state: which devices and which browser families are
 * selected, plus granular envId-level deselection overrides (the version-chip
 * UX). State is a plain object of Sets so it can live on qaMatrixState and be
 * persisted/restored as arrays.
 *
 * Modes (#16042):
 * - 'cross' (default): effective selection is the cross-product — device
 *   selected AND family selected AND row selectable AND not granularly
 *   deselected.
 * - 'perBrowser': each selected family runs on EXACTLY ONE assigned device
 *   (deviceAssignments: familyCode → deviceKey). Runs = each family's
 *   selectable configurations on its assigned device. Assignments are kept
 *   when switching back to cross (inert) so a mode round-trip loses nothing.
 *
 * Effective selection = catalog rows where the device is selected AND the
 * family is selected AND the row is selectable AND not granularly deselected.
 * There is NO cap here — the 2,000 limit is a server-side per-batch execution
 * limit (see MATRIX_BATCH_SIZE), never a selection limit.
 */
export function createSelectionState({
	deviceKeys = new Set(),
	browserFamilies = new Set(),
	deselectedEnvIds = new Set(),
	mode = 'cross',
	activeFamily = null,
	deviceAssignments = {}
} = {}) {
	return {
		deviceKeys: new Set(deviceKeys),
		browserFamilies: new Set(browserFamilies),
		deselectedEnvIds: new Set(deselectedEnvIds),
		mode: mode === 'perBrowser' ? 'perBrowser' : 'cross',
		activeFamily: typeof activeFamily === 'string' ? activeFamily : null,
		deviceAssignments: { ...(deviceAssignments ?? {}) }
	};
}

/** Device key of the first selectable configuration of a family in catalog
 *  order — the stable default assignment (#16042). Null when the family has
 *  no selectable rows. */
export function defaultDeviceKeyForFamily(configurations, familyCode) {
	for (const configuration of configurations) {
		if (configuration.browserCode !== familyCode) continue;
		if (!isSelectable(configuration)) continue;
		return deviceKeyOf(configuration);
	}
	return null;
}

/** Does the device have at least one selectable configuration for the family? */
function deviceSupportsFamily(configurations, familyCode, deviceKey) {
	return configurations.some((configuration) =>
		configuration.browserCode === familyCode
		&& isSelectable(configuration)
		&& deviceKeyOf(configuration) === deviceKey);
}

/** Switch selection mode. cross → perBrowser auto-assigns the default device
 *  to every selected available family lacking a valid assignment (the matrix
 *  always yields runs without manual fixing — #16042 UX rule). perBrowser →
 *  cross keeps assignments in state (inert). Returns a NEW state. */
export function setSelectionMode(state, configurations, mode) {
	const nextMode = mode === 'perBrowser' ? 'perBrowser' : 'cross';
	const next = createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: state.deselectedEnvIds,
		mode: nextMode,
		activeFamily: state.activeFamily,
		deviceAssignments: state.deviceAssignments
	});
	if (nextMode === 'perBrowser') {
		for (const familyCode of next.browserFamilies) {
			const assigned = next.deviceAssignments[familyCode];
			if (assigned && deviceSupportsFamily(configurations, familyCode, assigned)) continue;
			const fallback = defaultDeviceKeyForFamily(configurations, familyCode);
			if (fallback) next.deviceAssignments[familyCode] = fallback;
			else delete next.deviceAssignments[familyCode];
		}
	}
	return next;
}

/** Assign one device to one family (perBrowser mode). Validates the pair and
 *  implicitly selects the family. Returns a NEW state. */
export function assignDevice(state, configurations, familyCode, deviceKey) {
	if (!deviceSupportsFamily(configurations, familyCode, deviceKey)) {
		throw new Error(`No available configurations for ${familyCode} on that device.`);
	}
	const next = createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: state.deselectedEnvIds,
		mode: 'perBrowser',
		activeFamily: state.activeFamily,
		deviceAssignments: state.deviceAssignments
	});
	next.browserFamilies.add(familyCode);
	next.deviceAssignments[familyCode] = deviceKey;
	return next;
}

/** Remove a family's device assignment. The family stays selected (it simply
 *  contributes 0 runs until a device is picked). Returns a NEW state. */
export function unassignDevice(state, familyCode) {
	const next = createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: state.deselectedEnvIds,
		mode: state.mode,
		activeFamily: state.activeFamily,
		deviceAssignments: state.deviceAssignments
	});
	delete next.deviceAssignments[familyCode];
	return next;
}

/** Effective selection in perBrowser mode: each selected family's selectable
 *  configurations on its ASSIGNED device (granular deselections still apply). */
export function computePerBrowserSelection(configurations, selectionState) {
	const { browserFamilies, deselectedEnvIds, deviceAssignments } = selectionState;
	const selected = [];
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (deselectedEnvIds.has(configuration.envId)) continue;
		const familyCode = configuration.browserCode;
		if (!browserFamilies.has(familyCode)) continue;
		if (deviceKeyOf(configuration) !== deviceAssignments[familyCode]) continue;
		selected.push(configuration.envId);
	}
	return selected;
}

/** One row per selected family for the UI: assigned device (label, key) and
 *  run count; families without a valid assignment surface honestly
 *  (#16042 summary 'K browsers need a device'). */
export function perBrowserOverview(configurations, selectionState) {
	const { browserFamilies, deviceAssignments } = selectionState;
	const labelFor = (deviceKey) => {
		for (const configuration of configurations) {
			if (deviceKeyOf(configuration) !== deviceKey) continue;
			return `${configuration.manufacturer ? `${configuration.manufacturer} ` : ''}${configuration.device}`;
		}
		return null;
	};
	const runsByFamily = new Map();
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (!browserFamilies.has(configuration.browserCode)) continue;
		if (deviceKeyOf(configuration) !== deviceAssignments[configuration.browserCode]) continue;
		runsByFamily.set(configuration.browserCode, (runsByFamily.get(configuration.browserCode) ?? 0) + 1);
	}
	return FAMILY_ORDER
		.filter((code) => browserFamilies.has(code))
		.map((code) => {
			const deviceKey = deviceAssignments[code] ?? null;
			return {
				family: code,
				deviceKey,
				deviceLabel: deviceKey === null ? null : labelFor(deviceKey),
				runs: runsByFamily.get(code) ?? 0
			};
		});
}

/** Effective selection: envIds in catalog order (stable summary), uncapped.
 *  Dispatches on selection mode (#16042). */
export function computeExplicitSelection(configurations, selectionState) {
	if (selectionState?.mode === 'perBrowser') return computePerBrowserSelection(configurations, selectionState);
	const { deviceKeys, browserFamilies, deselectedEnvIds } = selectionState;
	const selected = [];
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (deselectedEnvIds.has(configuration.envId)) continue;
		if (!deviceKeys.has(deviceKeyOf(configuration))) continue;
		if (!browserFamilies.has(configuration.browserCode)) continue;
		selected.push(configuration.envId);
	}
	return selected;
}

/** O(index) count without materializing the array. */
export function effectiveSelectionCount(configurations, selectionState) {
	const { deviceKeys, browserFamilies, deselectedEnvIds } = selectionState;
	let count = 0;
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (deselectedEnvIds.has(configuration.envId)) continue;
		if (!deviceKeys.has(deviceKeyOf(configuration))) continue;
		if (!browserFamilies.has(configuration.browserCode)) continue;
		count += 1;
	}
	return count;
}

/** All device keys present in the catalog (selectable rows only — a device
 *  whose every row is unavailable can never be selected). */
export function catalogDeviceKeys(configurations) {
	const keys = new Set();
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		keys.add(deviceKeyOf(configuration));
	}
	return keys;
}

/** Select every catalog device (of the selectable rows). Chip-level opt-outs
 *  are cleared — "Select All" is an explicit bulk intent and must never leave
 *  the effective count at a trickle of stale granular deselections (the
 *  regression the browser tester caught: legacy migration + Select All kept
 *  37,238 stale exclusions and the count stayed at 6). Returns a NEW state. */
export function selectAllDevices(configurations, state) {
	return createSelectionState({
		deviceKeys: catalogDeviceKeys(configurations),
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: new Set()
	});
}

export function deselectAllDevices(_configurations, state) {
	return createSelectionState({
		deviceKeys: new Set(),
		browserFamilies: state.browserFamilies,
		deselectedEnvIds: state.deselectedEnvIds
	});
}

/** Select every selectable browser family. As with selectAllDevices, bulk
 *  intent clears stale chip-level opt-outs. Returns a NEW state.
 *  #16042: in perBrowser mode, every newly selected family auto-assigns its
 *  default device (existing valid assignments are preserved). */
export function selectAllBrowsers(configurations, state) {
	const next = createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: new Set(availableBrowserFamilies(configurations)),
		deselectedEnvIds: new Set(),
		mode: state.mode,
		activeFamily: state.activeFamily,
		deviceAssignments: state.deviceAssignments
	});
	if (next.mode === 'perBrowser') {
		for (const familyCode of next.browserFamilies) {
			const assigned = next.deviceAssignments[familyCode];
			if (assigned && deviceSupportsFamily(configurations, familyCode, assigned)) continue;
			const fallback = defaultDeviceKeyForFamily(configurations, familyCode);
			if (fallback) next.deviceAssignments[familyCode] = fallback;
			else delete next.deviceAssignments[familyCode];
		}
	}
	return next;
}

export function deselectAllBrowsers(_configurations, state) {
	return createSelectionState({
		deviceKeys: state.deviceKeys,
		browserFamilies: new Set(),
		deselectedEnvIds: state.deselectedEnvIds
	});
}

/** One device toggle: add/remove a device key in place (state mutation). */
export function toggleDevice(state, deviceKey, selected) {
	if (selected) state.deviceKeys.add(deviceKey);
	else state.deviceKeys.delete(deviceKey);
}

/** One family toggle: add/remove a family in place. Selecting a family also
 *  clears granular deselections WITHIN that family so the family checkbox
 *  remains the primary control (chip ticks then narrow back down).
 *  #16042: in perBrowser mode, selecting auto-assigns the default device when
 *  the family has no valid assignment; deselecting KEEPS the assignment
 *  (inert — reselecting restores it unchanged). */
export function toggleBrowserFamily(state, configurations, familyCode, selected) {
	if (selected) {
		state.browserFamilies.add(familyCode);
		for (const configuration of configurations) {
			if (configuration.browserCode === familyCode) state.deselectedEnvIds.delete(configuration.envId);
		}
		if (state.mode === 'perBrowser') {
			const assigned = state.deviceAssignments[familyCode];
			if (!assigned || !deviceSupportsFamily(configurations, familyCode, assigned)) {
				const fallback = defaultDeviceKeyForFamily(configurations, familyCode);
				if (fallback) state.deviceAssignments[familyCode] = fallback;
				else delete state.deviceAssignments[familyCode];
			}
		}
	} else {
		state.browserFamilies.delete(familyCode);
	}
}

/**
 * Persist/restore selection state (localStorage injectable). The legacy
 * qase.qaConfigDeselections store is honored: if the new key has never been
 * written, the initial state is "everything selected minus the legacy
 * deselections" — a returning user's opt-outs carry over best-effort.
 */
export function createSelectionStore(storage, configurationsProvider) {
	const write = (state) => {
		try {
			storage.setItem(SELECTION_STORAGE_KEY, JSON.stringify({
				deviceKeys: [...state.deviceKeys],
				browserFamilies: [...state.browserFamilies],
				deselectedEnvIds: [...state.deselectedEnvIds],
				// #16042: mode + per-browser device assignments persist under the
				// same key; legacy payloads restore as 'cross'.
				mode: state.mode === 'perBrowser' ? 'perBrowser' : 'cross',
				activeFamily: typeof state.activeFamily === 'string' ? state.activeFamily : null,
				deviceAssignments: state.deviceAssignments ?? {}
			}));
		} catch { /* private mode — in-memory only */ }
	};
	let initialized = false;
	let state = createSelectionState();
	return {
		get() {
			if (initialized) return state;
			initialized = true;
			let loaded = null;
			try {
				const raw = storage.getItem(SELECTION_STORAGE_KEY);
				loaded = raw ? JSON.parse(raw) : null;
			} catch {
				loaded = null;
			}
			const configurations = configurationsProvider?.() ?? [];
			if (loaded && typeof loaded === 'object') {
				// Trusted on restore, validated against the catalog on use by
				// computeExplicitSelection (unknown keys simply match nothing).
				// #16042: per-browser assignments are validated eagerly — a
				// stale (family, device) pair that no longer has selectable
				// rows is dropped so the UI never shows a dead assignment.
				const restoredAssignments = {};
				const restoredMode = loaded.mode === 'perBrowser' ? 'perBrowser' : 'cross';
				if (restoredMode === 'perBrowser' && loaded.deviceAssignments && typeof loaded.deviceAssignments === 'object') {
					for (const [familyCode, deviceKey] of Object.entries(loaded.deviceAssignments)) {
						if (typeof deviceKey !== 'string') continue;
						if (!deviceSupportsFamily(configurations, familyCode, deviceKey)) continue;
						restoredAssignments[familyCode] = deviceKey;
					}
				}
				state = createSelectionState({
					deviceKeys: new Set(loaded.deviceKeys ?? []),
					browserFamilies: new Set(loaded.browserFamilies ?? []),
					deselectedEnvIds: new Set(loaded.deselectedEnvIds ?? []),
					mode: restoredMode,
					activeFamily: typeof loaded.activeFamily === 'string' ? loaded.activeFamily : null,
					deviceAssignments: restoredAssignments
				});
			} else {
				// First run under the new model: default = full catalog minus
				// legacy deselections (best-effort migration, never crashes).
				let legacyDeselected = new Set();
				try {
					const raw = storage.getItem(DESELECTION_STORAGE_KEY);
					const parsed = raw ? JSON.parse(raw) : null;
					if (parsed && Array.isArray(parsed.envIds)) legacyDeselected = new Set(parsed.envIds);
				} catch { /* unreadable legacy data is ignored */ }
				state = selectAllDevices(configurations, selectAllBrowsers(configurations, createSelectionState()));
				state.deselectedEnvIds = legacyDeselected;
				state.mode = 'cross';
			}
			return state;
		},
		save(nextState) {
			state = nextState;
			write(state);
		}
	};
}



/**
 * Compute the effective selection over a configuration list:
 * selectable AND NOT explicitly deselected. Invalid rows are never selected.
 * The selection order follows the catalog order so the summary is stable.
 */
export function computeSelection(configurations, deselectionStore) {
	const deselected = deselectionStore.get();
	return configurations
		.filter((configuration) => isSelectable(configuration) && !deselected.has(configuration.envId))
		.map((configuration) => configuration.envId);
}

/**
 * #14276: explicit-selection overlay for capped runs.
 *
 * The unscoped default selection is capped at MAX_RUN_CONFIGURATIONS (#15323)
 * by slicing the catalog in catalog order. Because the catalog index is
 * Android-first, the capped default is entirely Android — so ticking (e.g.) an
 * iPhone version chip called reselect(), a NO-OP for an envId that was never
 * deselected, and the slice then discarded the tick anyway: the click was
 * silently swallowed ("devices are not getting selected").
 *
 * computeCappedSelection keeps the deselection store semantics (explicit
 * opt-outs always lose their slot first) but honors explicit TICKS made while
 * the run is at the cap: an explicitly ticked envId is taken BEFORE the slice,
 * so it displaces catalog-order tail rows instead of being eaten by them.
 * Explicit ticks are session-scoped (never persisted) — they are answers to
 * "the user clicked this while capped", not durable preferences.
 */
export function computeCappedSelection(configurations, deselectionStore, explicitSelection = new Set()) {
	const deselected = deselectionStore.get();
	const ordered = [];
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (deselected.has(configuration.envId)) continue;
		// Explicitly ticked rows are pinned ahead of the catalog-order tail so
		// the cap can never silently evict them (#14276).
		if (!explicitSelection.has(configuration.envId)) continue;
		ordered.push(configuration.envId);
	}
	// Remainder in stable catalog order — explicit ticks never shuffle the
	// un-ticked part of the default selection.
	for (const configuration of configurations) {
		if (!isSelectable(configuration)) continue;
		if (deselected.has(configuration.envId)) continue;
		if (explicitSelection.has(configuration.envId)) continue;
		if (ordered.length >= MAX_RUN_CONFIGURATIONS) break;
		ordered.push(configuration.envId);
	}
	return ordered;
}

/** Validate that a saved selection still only contains selectable envIds. */
export function sanitizeSelection(configurations, selectedEnvIds) {
	const selectable = new Set(configurations.filter(isSelectable).map((c) => c.envId));
	return [...new Set(selectedEnvIds)].filter((envId) => selectable.has(envId));
}

// ---------------------------------------------------------------------------
// Device scope (#15163): picking one device in the Start QA modal narrows the
// run to that device's configurations and auto-selects ALL its compatible
// (available) browsers. Switching devices never leaks the previous scope.
// ---------------------------------------------------------------------------

/** All AVAILABLE configurations of one device (any OS version / browser). */
export function configurationsForDevice(configurations, { platform, device, manufacturer = '' }) {
	return configurations.filter((configuration) =>
		configuration.platform === platform
		&& configuration.device === device
		&& (configuration.manufacturer ?? '') === manufacturer);
}

/**
 * Browser families compatible with one device — a family counts when at
 * least one of the device's configurations for it is AVAILABLE.
 * DuckDuckGo (and any other statically-unsupported family) never appears.
 */
export function compatibleBrowserFamilies(deviceConfigurations) {
	const families = [];
	for (const code of FAMILY_ORDER) {
		if (deviceConfigurations.some((configuration) =>
			configuration.browserCode === code && isSelectable(configuration))) {
			families.push(code);
		}
	}
	return families;
}

/**
 * Default selection for a device scope: EVERY AVAILABLE envId of the device
 * (all compatible families, all OS versions, both orientations the device
 * supports). Nothing unavailable is ever selected.
 */
export function defaultSelectionForDevice(deviceConfigurations) {
	return deviceConfigurations
		.filter((configuration) => isSelectable(configuration))
		.map((configuration) => configuration.envId);
}

/**
 * Pick a practical device for the customer launcher. A saved device wins when
 * it is still available. Otherwise prefer a locally executable desktop device
 * and the browser order agreed for the product (Edge, Chrome, Brave, ...).
 * The returned scope is intentionally one device; selecting the entire catalog
 * can exceed the server's 2,000-configuration run limit before the user acts.
 */
export function recommendedDeviceScope(configurations, savedSelection = null) {
	const available = configurations.filter(isSelectable);
	if (available.length === 0) return null;

	const saved = savedSelection && (
		available.find((configuration) => configuration.envId === savedSelection.envId)
		?? available.find((configuration) =>
			configuration.platform === savedSelection.platform
			&& configuration.device === savedSelection.device
			&& (configuration.manufacturer ?? '') === (savedSelection.manufacturer ?? ''))
	);
	const platformRank = new Map(['windows', 'macos', 'android', 'ios', 'ipados'].map((platform, index) => [platform, index]));
	const executionRank = new Map(['browser_emulation', 'simulator', 'emulator', 'virtual_machine', 'physical_device'].map((type, index) => [type, index]));
	const ranked = saved ?? [...available].sort((left, right) => {
		const leftDesktop = left.deviceType === 'desktop' ? 0 : 1;
		const rightDesktop = right.deviceType === 'desktop' ? 0 : 1;
		return leftDesktop - rightDesktop
			|| (platformRank.get(left.platform) ?? 99) - (platformRank.get(right.platform) ?? 99)
			|| (FAMILY_ORDER.indexOf(left.browserCode) === -1 ? 99 : FAMILY_ORDER.indexOf(left.browserCode))
				- (FAMILY_ORDER.indexOf(right.browserCode) === -1 ? 99 : FAMILY_ORDER.indexOf(right.browserCode))
			|| (executionRank.get(left.executionType) ?? 99) - (executionRank.get(right.executionType) ?? 99)
			|| String(left.device).localeCompare(String(right.device));
	})[0];

	return {
		platform: ranked.platform,
		device: ranked.device,
		manufacturer: ranked.manufacturer ?? ''
	};
}

/**
 * Set / replace the device scope. Returns the new selection (auto-select-all)
 * — callers assign it; session deselections from the PREVIOUS device are
 * discarded because the scope key changed.
 */
export function deviceScopeSelection(configurations, scope) {
	if (!scope) return null;
	const deviceConfigurations = configurationsForDevice(configurations, scope);
	return {
		scope,
		selectedEnvIds: defaultSelectionForDevice(deviceConfigurations),
		browserFamilies: compatibleBrowserFamilies(deviceConfigurations),
		configurationCount: deviceConfigurations.length
	};
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function buildSummary(configurations, selectedEnvIds) {
	const selected = new Set(selectedEnvIds);
	const byFamily = Object.fromEntries(FAMILY_ORDER.map((code) => [code, 0]));
	let selectedCount = 0;
	const byPlatform = new Map();
	for (const configuration of configurations) {
		if (!selected.has(configuration.envId)) continue;
		selectedCount += 1;
		byFamily[configuration.browserCode] = (byFamily[configuration.browserCode] ?? 0) + 1;
		byPlatform.set(configuration.platform, (byPlatform.get(configuration.platform) ?? 0) + 1);
	}
	const availableTotal = configurations.filter(isSelectable).length;
	const unavailable = configurations.length - availableTotal;
	return {
		total: selectedCount,
		availableTotal,
		unavailable,
		deselected: availableTotal - selectedCount,
		byFamily,
		byPlatform: Object.fromEntries([...byPlatform.entries()].sort((a, b) => b[1] - a[1]))
	};
}

// ---------------------------------------------------------------------------
// Filtering + grouping for the device panel
// ---------------------------------------------------------------------------

export function filterConfigurations(configurations, filters = {}) {
	const term = filters.search ? String(filters.search).toLowerCase().trim() : '';
	return configurations.filter((configuration) => {
		if (filters.platform && configuration.platform !== filters.platform) return false;
		if (filters.manufacturer && configuration.manufacturer !== filters.manufacturer) return false;
		if (filters.device && configuration.device !== filters.device) return false;
		if (filters.osVersion && configuration.osVersion !== filters.osVersion) return false;
		if (filters.browser && configuration.browser !== filters.browser) return false;
		if (filters.browserCode && configuration.browserCode !== filters.browserCode) return false;
		if (filters.orientation && configuration.orientation !== filters.orientation) return false;
		if (filters.deviceType && configuration.deviceType !== filters.deviceType) return false;
		if (filters.executionType && configuration.executionType !== filters.executionType) return false;
		if (term) {
			const haystack = [
				configuration.device,
				configuration.manufacturer,
				configuration.os,
				configuration.osVersion,
				configuration.browser,
				configuration.browserVersion,
				configuration.envId
			].filter(Boolean).join(' ').toLowerCase();
			if (!haystack.includes(term)) return false;
		}
		return true;
	});
}

/** Platform groups for the device tree. */
export const PLATFORM_GROUPS = [
	{ id: 'ios', label: 'Apple iPhone' },
	{ id: 'ipados', label: 'Apple iPad' },
	{ id: 'macos', label: 'Apple Mac' },
	{ id: 'android', label: 'Android' },
	{ id: 'windows', label: 'Windows' }
];

/**
 * #16045: device categories users think in FIRST, composing with the
 * platform groups above (Phones + Android = Android phones). The catalog's
 * deviceType vocabulary is mobile|tablet|desktop (laptops are 'desktop' —
 * see server/environmentCatalog.js deviceType assignment).
 */
export const DEVICE_CATEGORIES = [
	{ id: 'mobile', label: 'Phones' },
	{ id: 'tablet', label: 'Tablets' },
	{ id: 'desktop', label: 'Desktops' }
];

/**
 * Group configurations into platform → device → OS → browser-version rows.
 * One row per (device, osVersion, browserCode) with sorted version list,
 * newest first. Device rows carry execution types present + manufacturer.
 */
export function groupDeviceTree(configurations) {
	const platforms = new Map();
	for (const configuration of configurations) {
		let platformEntry = platforms.get(configuration.platform);
		if (!platformEntry) {
			platformEntry = { platform: configuration.platform, devices: new Map() };
			platforms.set(configuration.platform, platformEntry);
		}
		const deviceKey = `${configuration.manufacturer ?? ''}|${configuration.device}`;
		let deviceEntry = platformEntry.devices.get(deviceKey);
		if (!deviceEntry) {
			deviceEntry = {
				platform: configuration.platform,
				device: configuration.device,
				manufacturer: configuration.manufacturer,
				deviceType: configuration.deviceType,
				executionTypes: new Set(),
				osVersions: new Map()
			};
			platformEntry.devices.set(deviceKey, deviceEntry);
		}
		deviceEntry.executionTypes.add(configuration.executionType);
		let osEntry = deviceEntry.osVersions.get(configuration.osVersion);
		if (!osEntry) {
			osEntry = { osVersion: configuration.osVersion, browsers: new Map() };
			deviceEntry.osVersions.set(configuration.osVersion, osEntry);
		}
		let browserEntry = osEntry.browsers.get(configuration.browserCode);
		if (!browserEntry) {
			browserEntry = {
				browserCode: configuration.browserCode,
				browser: configuration.browser,
				versions: []
			};
			osEntry.browsers.set(configuration.browserCode, browserEntry);
		}
		browserEntry.versions.push(configuration);
	}
	return [...platforms.values()].map((platformEntry) => ({
		platform: platformEntry.platform,
		devices: [...platformEntry.devices.values()].map((deviceEntry) => ({
			platform: deviceEntry.platform,
			device: deviceEntry.device,
			manufacturer: deviceEntry.manufacturer,
			deviceType: deviceEntry.deviceType,
			executionTypes: [...deviceEntry.executionTypes],
			osVersions: [...deviceEntry.osVersions.values()]
				.sort(compareVersionsDesc)
				.map((osEntry) => ({
					osVersion: osEntry.osVersion,
					browsers: FAMILY_ORDER
						.filter((code) => osEntry.browsers.has(code))
						.map((code) => {
							const browserEntry = osEntry.browsers.get(code);
							return {
								...browserEntry,
								versions: [...browserEntry.versions].sort((a, b) => compareVersionsDesc(a.browserVersion, b.browserVersion))
							};
						})
				}))
		})).sort((a, b) => a.device.localeCompare(b.device))
	}));
}

/** Numeric-aware descending version comparison ('26.0' > '18.3' > '9.7'). */
export function compareVersionsDesc(left, right) {
	const parse = (value) => String(value ?? '').split('.').map((part) => Number.parseInt(part, 10) || 0);
	const leftParts = parse(left);
	const rightParts = parse(right);
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
		if (delta !== 0) return delta;
	}
	return 0;
}

/**
 * #15970: plain-language dimensions of the effective selection — how many
 * distinct browsers, how many distinct devices, how many runs. Derived from
 * the same explicit-selection math the run submits.
 */
export function selectionDimensions(configurations = [], selectedEnvIds = []) {
	const selected = new Set(selectedEnvIds);
	const families = new Set();
	const devices = new Set();
	for (const configuration of configurations) {
		if (!selected.has(configuration.envId)) continue;
		families.add(configuration.browserCode);
		devices.add(`${configuration.manufacturer ?? ''}|${configuration.platform}|${configuration.device}`);
	}
	return { families: families.size, devices: devices.size, runs: selected.size };
}

// ---------------------------------------------------------------------------
// Facet values (for the filter dropdowns)
// ---------------------------------------------------------------------------

/**
 * #15969: dedupe windowed device-grouped rows to ONE entry per device key —
 * the device selector renders flat rows, not a nested OS/browser tree. Rolls
 * up availability honestly: a device with zero selectable configurations
 * keeps its first unavailable reason.
 */
export function deviceListFromWindow(rows = []) {
	const byKey = new Map();
	for (const configuration of rows) {
		const key = `${configuration.manufacturer ?? ''}|${configuration.platform}|${configuration.device}`;
		let entry = byKey.get(key);
		if (!entry) {
			entry = {
				key,
				platform: configuration.platform,
				manufacturer: configuration.manufacturer ?? '',
				device: configuration.device,
				deviceType: configuration.deviceType ?? null,
				executionTypes: new Set(),
				osVersions: new Set(),
				osLabel: configuration.os ?? null,
				selectableCount: 0,
				unavailableReason: null
			};
			byKey.set(key, entry);
		}
		if (configuration.executionType) entry.executionTypes.add(configuration.executionType);
		if (configuration.osVersion) entry.osVersions.add(`${configuration.osVersion}`);
		if (isSelectable(configuration)) entry.selectableCount += 1;
		else if (!entry.unavailableReason && configuration.availabilityReason) entry.unavailableReason = configuration.availabilityReason;
	}
	return [...byKey.values()].map((entry) => ({
		...entry,
		executionTypes: [...entry.executionTypes],
		osVersions: [...entry.osVersions].sort(compareVersionsDesc)
	}));
}


export function facetValues(configurations) {
	const count = (key) => {
		const counts = new Map();
		for (const configuration of configurations) {
			const value = configuration[key];
			if (value === null || value === undefined || value === '') continue;
			counts.set(value, (counts.get(value) ?? 0) + 1);
		}
		return [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
	};
	return {
		platform: count('platform'),
		manufacturer: count('manufacturer'),
		osVersion: count('osVersion').sort((a, b) => compareVersionsDesc(a.value, b.value)),
		orientation: count('orientation'),
		deviceType: count('deviceType'),
		executionType: count('executionType')
	};
}

// ---------------------------------------------------------------------------
// Browser families view (checklist column)
// ---------------------------------------------------------------------------

/**
 * Family rows for the checklist: always all seven; a family is available for
 * the current filtered set when at least one of its configurations is
 * selectable. Unavailable families stay visible with a reason.
 */
export function familyRows(configurations, browserFamilies = []) {
	const definitions = new Map((browserFamilies ?? []).map((family) => [family.code, family]));
	return FAMILY_ORDER.map((code) => {
		const definition = definitions.get(code);
		const rows = configurations.filter((configuration) => configuration.browserCode === code);
		const selectable = rows.filter(isSelectable);
		const reason = definition?.reasonWhenUnavailable
			?? rows.find((configuration) => configuration.availabilityReason)?.availabilityReason
			?? (rows.length === 0 ? 'No configurations available for this family.' : null);
		return {
			code,
			label: definition?.label ?? code,
			platforms: definition?.platforms ?? [],
			totalRows: rows.length,
			selectableCount: selectable.length,
			available: selectable.length > 0,
			reason: selectable.length > 0 ? null : reason,
			versions: [...new Set(selectable.map((configuration) => configuration.browserVersion))]
				.sort(compareVersionsDesc)
		};
	});
}

// ---------------------------------------------------------------------------
// Start gating
// ---------------------------------------------------------------------------

export function isValidTargetUrl(value) {
	try {
		const url = new URL(String(value ?? '').trim());
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Pipeline Phase 2: plan the batches for a selection of any size. Returns
 * ordered, DISJOINT slices of at most `batchSize` envIds. A selection ≤
 * batchSize returns a single batch (single-run path — no parent needed).
 */
export function planBatches(envIds, batchSize = MATRIX_BATCH_SIZE) {
	const ids = [...(envIds ?? [])];
	if (!Number.isInteger(batchSize) || batchSize < 1) throw new TypeError('batchSize must be a positive integer.');
	const batches = [];
	for (let index = 0; index < ids.length; index += batchSize) {
		batches.push(ids.slice(index, index + batchSize));
	}
	return batches;
}

/**
 * Stable batch key identifying one batch of one parent across retries — the
 * idempotency token POSTed with each batch (same key ⇒ server returns the
 * existing batch instead of duplicating items).
 */
export async function batchKeyFor(parentId, envIds) {
	const data = new TextEncoder().encode(`${parentId}\n${[...(envIds ?? [])].join(',')}`);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Execution-batch size — matches the server's MAX_MATRIX_CONFIGURATIONS cap
 *  (route: POST /api/qa-matrix-runs, one request = one batch). This is an
 *  EXECUTION limit, never a selection limit (pipeline Phase 1/2): the
 *  selection model above is uncapped; >2,000 selections are batched on
 *  submission. Retained as MAX_RUN_CONFIGURATIONS for callers that check the
 *  per-request limit client-side. */
export const MAX_RUN_CONFIGURATIONS = 2000;
export const MATRIX_BATCH_SIZE = 2000;

export function canStartRun({ targetUrl, selectedEnvIds }) {
	return isValidTargetUrl(targetUrl)
		&& Array.isArray(selectedEnvIds)
		&& selectedEnvIds.length > 0;
}

// ---------------------------------------------------------------------------
// Fetch state machine
// ---------------------------------------------------------------------------

export const FETCH_STATES = {
	LOADING: 'loading',
	READY: 'ready',
	EMPTY: 'empty',
	ERROR: 'error'
};

/**
 * Fetch the catalog with the loading/empty/error contract. `fetcher` is
 * injected so tests can stub; abortSignal supported for dialog-reopen races.
 */
export async function fetchQaConfigurations({ fetcher = globalThis.fetch, signal = null } = {}) {
	// Catalog summary only: families/providers/facet counts. The full
	// configuration list is fetched lazily in windows (see fetchConfigurationWindow)
	// so a 38k-row catalog never renders as one giant DOM tree or payload.
	const response = await fetcher('/api/qa-configurations', { signal, headers: { accept: 'application/json' } });
	if (!response.ok) {
		const detail = await response.json().catch(() => null);
		const error = new Error(detail?.error ?? `Catalog request failed (${response.status}).`);
		error.status = response.status;
		throw error;
	}
	const payload = await response.json();
	const configurations = payload?.configurations;
	if (!Array.isArray(configurations)) {
		throw new Error('Catalog response was malformed.');
	}
	return payload;
}

/**
 * Fetch the full-catalog COMPACT INDEX: one small object per configuration
 * (envId, platform, manufacturer, device, os, osVersion, browser, browserCode,
 * browserVersion, executionEngine, availability, availabilityReason, executionType). The index
 * drives selection math, family checklist counts, facets and the summary; the
 * heavy tree renders only windowed slices (fetchConfigurationWindow).
 */
export async function fetchConfigurationIndex({ fetcher = globalThis.fetch, signal = null } = {}) {
	const response = await fetcher('/api/qa-configurations?index=1&limit=1', { signal, headers: { accept: 'application/json' } });
	if (!response.ok) {
		const detail = await response.json().catch(() => null);
		const error = new Error(detail?.error ?? `Catalog request failed (${response.status}).`);
		error.status = response.status;
		throw error;
	}
	const payload = await response.json();
	if (!Array.isArray(payload?.index)) {
		throw new Error('Catalog response was malformed.');
	}
	return payload.index;
}

/**
 * Fetch one window of configurations from the server-side catalog (which
 * already applies filters + pagination). Returns {configurations, total,
 * hasMore} so the UI can render incrementally with a "Load more" affordance.
 *
 * #15439 Issue 2: windows are DEVICE-GROUPED (groupBy=device) — the server
 * returns ALL rows of `limit` device groups in canonical platform order
 * (iPhone → iPad → Mac → Android → Windows). Raw row pagination previously
 * made the first window 200 rows of a single Android device, so the
 * checklist rendered "two devices" and one platform until dozens of
 * "Load more" clicks. `deviceCount`/`deviceTotal` drive load-more math.
 */
export async function fetchConfigurationWindow(filters = {}, { fetcher = globalThis.fetch, signal = null, limit = 200, offset = 0 } = {}) {
	const params = new URLSearchParams();
	for (const key of ['platform', 'manufacturer', 'osVersion', 'orientation', 'browserCode', 'search', 'deviceType']) {
		if (filters[key]) params.set(key, filters[key]);
	}
	params.set('groupBy', 'device');
	params.set('limit', String(limit));
	params.set('offset', String(offset));
	const response = await fetcher(`/api/qa-configurations?${params}`, { signal, headers: { accept: 'application/json' } });
	if (!response.ok) {
		const detail = await response.json().catch(() => null);
		const error = new Error(detail?.error ?? `Catalog request failed (${response.status}).`);
		error.status = response.status;
		throw error;
	}
	const payload = await response.json();
	if (!Array.isArray(payload?.configurations)) {
		throw new Error('Catalog response was malformed.');
	}
	const deviceTotal = payload.deviceGroups ?? payload.totals?.configurations ?? payload.configurations.length;
	const deviceCount = payload.deviceOffset !== undefined
		? Math.min(payload.deviceLimit ?? limit, Math.max(0, deviceTotal - (payload.deviceOffset ?? 0)))
		: payload.configurations.length;
	return {
		configurations: payload.configurations,
		total: payload.totals?.configurations ?? payload.configurations.length,
		deviceCount,
		deviceTotal,
		hasMore: Boolean(payload.hasMore)
	};
}
