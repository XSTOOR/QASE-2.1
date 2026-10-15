import { createSelectionState, computeExplicitSelection, deviceKeyOf, isSelectable } from './qaConfigMatrix.js';

/** Versions are runtime metadata, never separate user selections or jobs. */
export function preferredConfiguration(rows) {
	return [...rows].sort((a, b) =>
		Number(b.device === 'Windows Desktop') - Number(a.device === 'Windows Desktop')
		|| Number(b.orientation === (b.deviceType === 'desktop' ? 'landscape' : 'portrait')) - Number(a.orientation === (a.deviceType === 'desktop' ? 'landscape' : 'portrait'))
		|| String(b.browserVersion ?? '').localeCompare(String(a.browserVersion ?? ''), 'en', { numeric: true })
		|| String(b.osVersion ?? '').localeCompare(String(a.osVersion ?? ''), 'en', { numeric: true })
		|| String(a.envId).localeCompare(String(b.envId)))[0] ?? null;
}

export function singleSelection(index, row) {
	if (!row || !isSelectable(row)) return createSelectionState();
	const key = deviceKeyOf(row);
	return createSelectionState({ deviceKeys: [key], browserFamilies: [row.browserCode],
		deselectedEnvIds: index.filter(r => deviceKeyOf(r) === key && r.browserCode === row.browserCode && r.envId !== row.envId).map(r => r.envId) });
}

/** Migrate old multi-device/version preferences to exactly one runnable pair. */
export function normalizeSingleSelection(index, selection, browserCode) {
	const available = index.filter(isSelectable);
	const selected = new Set(computeExplicitSelection(index, selection));
	const current = preferredConfiguration(available.filter(r => selected.has(r.envId)));
	const family = browserCode || current?.browserCode || 'chrome';
	const rows = available.filter(r => r.browserCode === family);
	const sameDevice = current && rows.filter(r => deviceKeyOf(r) === deviceKeyOf(current));
	return singleSelection(index, preferredConfiguration(sameDevice?.length ? sameDevice : rows));
}

export const devicePlatformLabels = { ios: 'iOS', ipados: 'iPadOS', android: 'Android', windows: 'Windows', macos: 'macOS', linux: 'Linux' };

export function singleDeviceOptions(index, browserCode, { search = '', category = '', platform = '', manufacturer = '' } = {}) {
	const devices = new Map();
	for (const row of index.filter(r => isSelectable(r) && r.browserCode === browserCode)) {
		const key = deviceKeyOf(row);
		if (!devices.has(key)) devices.set(key, []);
		devices.get(key).push(row);
	}
	const terms = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return [...devices.values()].map(preferredConfiguration).filter(row =>
		(!category || row.deviceType === category) && (!platform || row.platform === platform)
		&& (!manufacturer || row.manufacturer === manufacturer)
		&& terms.every(term => [row.device, row.manufacturer, row.os, devicePlatformLabels[row.platform]].filter(Boolean).join(' ').toLowerCase().includes(term)))
		.sort((a, b) => a.device.localeCompare(b.device));
}
