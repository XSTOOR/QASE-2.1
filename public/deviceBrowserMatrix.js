/**
 * deviceBrowserMatrix — pure model layer for the device & browser matrix (#14421).
 *
 * Derives the sidebar tree, browser-brand columns, favorites/recents stores and
 * selection assembly from EXISTING environment records. No DOM access; every
 * export is unit-testable. The UI phases (M3/M4) render from these shapes.
 *
 * Data-source contract: each environment record carries at least
 * { envId, platform, device, os, osVersion, browser, browserCode, browserVersion,
 *   deviceType, active, executionType/executionLevelRequested/runtimeAttestedLevel,
 *   runtimeStatus/availability } (same shape /api/environments returns today).
 *
 * Channel labels arrive via a channelFor callback (server channelForVersion
 * shape) so this module stays free of server imports and catalog pins.
 */

import { buildDeviceCards, rankEnvironments, resolveDeviceEnvironment, platformGroupFor } from './devicePicker.js';

/** Sidebar categories in display order (spec §1B). */
export const MATRIX_CATEGORIES = Object.freeze(['favorites', 'recent', 'ios', 'android', 'windows', 'macos']);

export const CATEGORY_LABELS = Object.freeze({
	favorites: 'Favorites',
	recent: 'Recent Tests',
	ios: 'iOS',
	android: 'Android',
	windows: 'Windows',
	macos: 'macOS'
});

/**
 * Platform of an environment normalized to a sidebar category.
 * iPadOS rows ride under the iOS umbrella (spec groups iPhone/iPad as "iOS");
 * anything unknown lands in the catch-all 'other' bucket (rendered under its
 * nearest platform, never dropped).
 */
export function sidebarCategoryFor(env) {
	const platform = String(env?.platform ?? '').toLowerCase();
	if (platform === 'ios' || platform === 'ipados') return 'ios';
	if (platform === 'android') return 'android';
	if (platform === 'windows') return 'windows';
	if (platform === 'macos') return 'macos';
	return 'other';
}

/** Newest-first version comparison ("26.0" > "18.3" > "13.0"). */
export function compareVersionsDesc(a, b) {
	const parse = (v) => String(v ?? '').split('.').map((p) => Number.parseInt(p, 10) || 0);
	const pa = parse(a); const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const d = (pb[i] ?? 0) - (pa[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/**
 * Favorites store — devices and browser versions the user starred.
 * Follows the themePreference.js injectable-storage pattern; write failures
 * degrade to session-only (never throw).
 *
 * Keys: `device:<slug?>` — we persist the DEVICE NAME (the only stable
 * identifier environments carry); `version:<browserCode>:<major>`.
 */
export function createFavoritesStore({ storage = globalThis.localStorage, persistenceKey = 'qase.matrixFavorites', cap = 100, onChange = () => {} } = {}) {
	const listeners = new Set([onChange]);
	function read() {
		try {
			const raw = storage?.getItem?.(persistenceKey);
			const parsed = raw ? JSON.parse(raw) : null;
			if (Array.isArray(parsed)) {
				// Legacy/plain list of keys
				return parsed.filter((k) => typeof k === 'string');
			}
			if (parsed && Array.isArray(parsed.keys)) return parsed.keys.filter((k) => typeof k === 'string');
			return [];
		} catch {
			return [];
		}
	}
	let keys = read();
	function persist() {
		try {
			storage?.setItem?.(persistenceKey, JSON.stringify({ v: 1, keys }));
		} catch { /* session-only */ }
	}
	function emit() { for (const fn of [...listeners]) { try { fn([...keys]); } catch { /* listener errors are not ours */ } } }
	return {
		has(key) { return keys.includes(key); },
		list() { return [...keys]; },
		toggle(key) {
			const k = String(key ?? '');
			if (!k) return false;
			if (keys.includes(k)) keys = keys.filter((x) => x !== k);
			else {
				keys.push(k);
				if (keys.length > cap) keys = keys.slice(keys.length - cap);
			}
			persist(); emit();
			return keys.includes(k);
		},
		remove(key) {
			keys = keys.filter((x) => x !== String(key ?? ''));
			persist(); emit();
		},
		clear() { keys = []; persist(); emit(); },
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
	};
}

/**
 * Recents store — full environments the user actually used, most recent
 * first, capped, deduped by envId. Persistence pattern as favorites.
 */
export function createRecentsStore({ storage = globalThis.localStorage, persistenceKey = 'qase.recentEnvironments', cap = 10, onChange = () => {} } = {}) {
	const listeners = new Set([onChange]);
	function read() {
		try {
			const raw = storage?.getItem?.(persistenceKey);
			const parsed = raw ? JSON.parse(raw) : null;
			return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.envId === 'string') : [];
		} catch {
			return [];
		}
	}
	let entries = read();
	function persist() {
		try {
			storage?.setItem?.(persistenceKey, JSON.stringify(entries));
		} catch { /* session-only */ }
	}
	function emit() { for (const fn of [...listeners]) { try { fn([...entries]); } catch { /* listener errors are not ours */ } } }
	return {
		list() { return entries.map((e) => ({ ...e })); },
		record(env) {
			if (!env?.envId) return;
			entries = [{ ...env }, ...entries.filter((e) => e.envId !== env.envId)].slice(0, cap);
			persist(); emit();
		},
		remove(envId) {
			entries = entries.filter((e) => e.envId !== envId);
			persist(); emit();
		},
		clear() { entries = []; persist(); emit(); },
		subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
	};
}

/**
 * Search haystack for a device across all its environments (name, OS names +
 * versions, browser names + versions, manufacturer via env fields). Matches
 * the #14151 quality bar: a browser search must find every device that can
 * run that browser.
 */
function deviceHaystack(deviceEnvs) {
	const parts = new Set();
	for (const env of deviceEnvs) {
		parts.add(env.device);
		parts.add(env.os); parts.add(env.osVersion);
		parts.add(env.browser); if (env.browserVersion) parts.add(env.browserVersion);
		if (env.manufacturer) parts.add(env.manufacturer);
	}
	return [...parts].filter(Boolean).join(' ').toLowerCase();
}

/**
 * Sidebar tree. Every category is always present (spec: Favorites/Recent
 * render honest empty states). Device children derive from ACTIVE environments
 * grouped by device name; each child carries its OS list (newest first) and
 * a searchable haystack.
 */
export function buildSidebarTree(environments, { favorites = [], recents = [] } = {}) {
	const favSet = new Set(favorites.map(String));
	const recEnvIds = new Set(recents.map((r) => r.envId));

	const byDevice = new Map();
	for (const env of environments ?? []) {
		if (env?.active === false) continue;
		const key = String(env.device ?? '').trim();
		if (!key) continue;
		if (!byDevice.has(key)) byDevice.set(key, { device: key, envs: [] });
		byDevice.get(key).envs.push(env);
	}

	const categoryNodes = [];
	for (const id of MATRIX_CATEGORIES) {
		categoryNodes.push({ id, label: CATEGORY_LABELS[id], devices: [], expanded: true });
	}
	// Catch-all bucket for unknown platforms — not a rendered category; its
	// devices are appended to the macOS category so nothing is ever dropped
	// (and the loop below can never dereference undefined).
	const otherBucket = { id: 'other', label: 'Other', devices: [], expanded: true };
	const byCategory = Object.fromEntries([...categoryNodes, otherBucket].map((c) => [c.id, c]));

	// Platform categories: group by sidebar category, sort by device name.
	for (const [device, { envs }] of byDevice) {
		const category = sidebarCategoryFor(envs[0]);
		const target = byCategory[category] ?? otherBucket;
		const osVersions = [...new Set(envs.map((e) => e.osVersion).filter(Boolean))].sort(compareVersionsDesc);
		target.devices.push({
			device,
			platform: envs[0].platform ?? null,
			deviceType: envs[0].deviceType ?? 'phone',
			osVersions,
			envCount: envs.length,
			haystack: deviceHaystack(envs),
			favorite: favSet.has(`device:${device}`),
			envIds: envs.map((e) => e.envId)
		});
	}
	for (const node of categoryNodes) node.devices.sort((a, b) => a.device.localeCompare(b.device));

	// Favorites: device entries (from the tree) the user starred, plus raw
	// favorited names with no active environment (retired/unknown) — visible,
	// removable, not selectable.
	const favDevices = [];
	for (const key of favSet) {
		if (!key.startsWith('device:')) continue;
		const device = key.slice('device:'.length);
		const node = byDevice.get(device);
		if (node) {
			const entry = categoryNodes.flatMap((c) => c.devices).find((d) => d.device === device);
			favDevices.push(entry ?? {
				device, platform: node.envs[0].platform ?? null, deviceType: node.envs[0].deviceType ?? 'phone',
				osVersions: [...new Set(node.envs.map((e) => e.osVersion))].sort(compareVersionsDesc),
				envCount: node.envs.length, haystack: deviceHaystack(node.envs), favorite: true,
				envIds: node.envs.map((e) => e.envId)
			});
		} else {
			favDevices.push({ device, platform: null, deviceType: null, osVersions: [], envCount: 0, haystack: device.toLowerCase(), favorite: true, envIds: [], stale: true });
		}
	}
	byCategory.favorites.devices = favDevices.sort((a, b) => a.device.localeCompare(b.device));

	// Recents: the full environment records (as recorded), pinned to the tree
	// so retired entries can be shown dimmed but not selectable.
	byCategory.recent.devices = recents.map((rec) => {
		const live = rec.envId ? [...byDevice.values()].flatMap(({ envs }) => envs).find((e) => e.envId === rec.envId) : null;
		return {
			device: rec.device ?? live?.device ?? rec.envId,
			platform: live?.platform ?? rec.platform ?? null,
			deviceType: live?.deviceType ?? null,
			osVersions: live ? [live.osVersion] : (rec.osVersion ? [rec.osVersion] : []),
			envCount: live ? 1 : 0,
			haystack: [rec.device, rec.os, rec.osVersion, rec.browser, rec.browserVersion, rec.envId].filter(Boolean).join(' ').toLowerCase(),
			favorite: false,
			envIds: live ? [rec.envId] : [],
			recent: true,
			env: live ?? rec,
			stale: !live
		};
	});

	// 'other' platform bucket (unknown platforms) is appended to the macOS
	// category — kept for honesty, rendered last, never dropped.
	if (otherBucket.devices.length) {
		byCategory.macos.devices.push(...otherBucket.devices);
	}

	return { categories: categoryNodes, deviceCount: byDevice.size, staleFavorites: favDevices.filter((d) => d.stale).length };
}

/**
 * Filter the sidebar tree by search text. Categories with no matching
 * devices are kept with empty device lists only when the search is empty;
 * under search, non-matching categories collapse away.
 */
export function filterSidebarTree(tree, search = '') {
	const q = String(search ?? '').trim().toLowerCase();
	if (!q) return tree;
	const filtered = {
		...tree,
		categories: tree.categories.map((category) => ({
			...category,
			devices: category.devices.filter((d) => d.haystack.includes(q))
		})).filter((category) => category.devices.length > 0)
	};
	return filtered;
}

/**
 * Browser-brand columns for the selected device + OS.
 *
 * One column per browser brand with at least one ACTIVE environment for that
 * device+OS. Versions newest-first, each labeled with its release channel
 * (via the injected channelFor callback, server channelForVersion shape) and
 * per-version favorite state. Honest per-version availability from the
 * runtime board map. Browsers never appear on platforms they cannot execute
 * — the environments list IS the platform-restriction source (Safari never
 * on Android/Windows rows to begin with).
 */
export function buildBrowserColumns(device, osVersion, environments, { favorites = [], channelFor = () => 'stable', boardByEnvId = null, initialWindow = 6 } = {}) {
	const favSet = new Set(favorites.map(String));
	const name = String(device ?? '').trim();
	if (!name) return [];
	const forSelection = (environments ?? []).filter((e) => e?.active !== false
		&& String(e.device ?? '').trim() === name
		&& String(e.osVersion ?? '') === String(osVersion ?? ''));
	if (!forSelection.length) return [];

	const columns = [];
	const byBrand = new Map();
	for (const env of forSelection) {
		const code = env.browserCode ?? String(env.browser ?? '').toLowerCase();
		if (!byBrand.has(code)) byBrand.set(code, []);
		byBrand.get(code).push(env);
	}
	for (const [code, envs] of byBrand) {
		const versions = [...new Map(envs.map((e) => [String(e.browserVersion ?? ''), e])).entries()]
			.sort((a, b) => compareVersionsDesc(a[0], b[0]));
		// #14632 (NI01 Phase 2): server-attached browser-level executability.
		// One resolution per brand (it is browser×provider, not per-version);
		// rows inherit it so the picker can never present an unexecutable
		// browser as available.
		const brandSupport = envs[0]?.browserSupport ?? null;
		const rows = versions.map(([version, env]) => {
			const board = boardByEnvId?.get?.(env.envId ?? env.id) ?? null;
			const notSupported = brandSupport?.status === 'not_supported';
			return {
				version,
				envId: env.envId ?? env.id ?? null,
				channel: channelFor(code, version),
				favorite: favSet.has(`version:${code}:${version}`),
				available: !notSupported && env.active !== false && board?.status !== 'OFFLINE' && board?.status !== 'NOT_EXECUTABLE',
				status: notSupported ? 'NOT_SUPPORTED' : (board?.status ?? (env.active === false ? 'RETIRED' : null)),
				browserSupport: brandSupport,
				executionType: env.executionLevelRequested ?? env.runtimeAttestedLevel ?? (env.executionType ? String(env.executionType).toLowerCase() : null),
				env
			};
		});
		// Pre-release channels first (their majors are newest), then stable
		// back-catalog newest-first. compareVersionsDesc already yields that
		// because pre-release majors > current stable major.
		const column = {
			browserCode: code,
			browser: envs[0].browser,
			platforms: [...new Set(envs.map((e) => e.platform))],
			webkitNote: ['ios', 'ipados'].includes(String(envs[0].platform)) && code !== 'safari',
			rows,
			totalVersions: rows.length,
			hiddenCount: Math.max(0, rows.length - initialWindow)
		};
		columns.push(column);
	}
	// Stable brand display order: chrome, edge, firefox, opera, brave, duckduckgo, safari.
	const BRAND_ORDER = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'duckduckgo', 'safari'];
	columns.sort((a, b) => {
		const ia = BRAND_ORDER.indexOf(a.browserCode); const ib = BRAND_ORDER.indexOf(b.browserCode);
		return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
	});
	return columns;
}

/**
 * Assemble a selection from device + OS + browser + version. Only existing
 * ACTIVE environments resolve — an invalid cross-combination can never be
 * assembled. Returns { ok, env } or { ok: false, reason }.
 */
export function assembleSelection({ device, osVersion, browserCode, browserVersion, environments }) {
	const name = String(device ?? '').trim();
	if (!name) return { ok: false, reason: 'no-device' };
	const browser = String(browserCode ?? '').toLowerCase();
	const candidates = (environments ?? []).filter((e) => e?.active !== false
		&& String(e.device ?? '').trim() === name
		&& String(e.osVersion ?? '') === String(osVersion ?? '')
		&& String(e.browserCode ?? String(e.browser ?? '').toLowerCase()) === browser);
	if (!candidates.length) return { ok: false, reason: 'no-combination' };
		if (browserVersion != null) {
		const exact = candidates.filter((e) => String(e.browserVersion ?? '') === String(browserVersion));
		if (exact.length) return { ok: true, env: rankEnvironments(exact)[0] };
		return { ok: false, reason: 'version-not-found' };
	}
	return { ok: true, env: rankEnvironments(candidates)[0] };
}

/**
 * Selected-environment display string, spec §1 format:
 * Device · OS Version · Browser Name · Browser Version · Execution Type · Availability
 */
export function selectionDisplayString(env) {
	if (!env) return '';
	const osPart = [env.os, env.osVersion].filter(Boolean).join(' ');
	const level = env.executionLevelRequested ?? env.runtimeAttestedLevel ?? (env.executionType ? String(env.executionType).toLowerCase() : 'virtual_device');
	const levelText = { REAL_DEVICE: 'REAL DEVICE', VIRTUAL_DEVICE: 'VIRTUAL DEVICE', SIMULATED: 'SIMULATED' }[String(level).toUpperCase()] ?? 'VIRTUAL DEVICE';
	const availability = env.runtimeStatus ?? env.availability ?? 'AVAILABLE';
	return [env.device, osPart, env.browser, env.browserVersion, levelText, String(availability).toUpperCase()].filter(Boolean).join(' · ');
}

/**
 * The picker-modal entry point behind [Change Device] / add-mode flows. Given
 * the full matrix state, resolve what the picker should open focused on.
 */
export function resolvePickerFocus({ selection, environments } = {}) {
	if (!selection?.device) return { device: null, osVersion: null, browserCode: null };
	const current = (environments ?? []).find((e) => e.envId === selection.envId && e.active !== false) ?? null;
	return {
		device: current?.device ?? selection.device,
		osVersion: current?.osVersion ?? selection.osVersion ?? null,
		browserCode: current?.browserCode ?? selection.browserCode ?? null
	};
}

// Re-exports so the matrix UI phases reuse the existing picker helpers
// without importing two modules.
export { buildDeviceCards, rankEnvironments, resolveDeviceEnvironment, platformGroupFor };
