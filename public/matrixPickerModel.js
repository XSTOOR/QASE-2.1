import { createSelectionState, computeExplicitSelection, deviceKeyOf, isSelectable, setSelectionMode } from './qaConfigMatrix.js';

export function onePerBrowserSelection(index, selection) {
	const next = setSelectionMode(selection, index, 'perBrowser');
	const selected = new Set(computeExplicitSelection(index, selection));
	for (const family of next.browserFamilies) {
		const existing = index.find(row => row.browserCode === family && selected.has(row.envId));
		if (existing) next.deviceAssignments[family] = deviceKeyOf(existing);
	}
	return next;
}

/** Encode exact IDs in the existing execution contract; never invent combinations. */
export function exactMatrixSelection(index, ids, previous = createSelectionState()) {
	const wanted = new Set(ids);
	const rows = index.filter(row => isSelectable(row) && wanted.has(row.envId));
	const deviceKeys = new Set(rows.map(deviceKeyOf));
	const browserFamilies = new Set([...previous.browserFamilies, ...rows.map(row => row.browserCode)]);
	return createSelectionState({ deviceKeys, browserFamilies,
		deselectedEnvIds: index.filter(row => deviceKeys.has(deviceKeyOf(row)) && browserFamilies.has(row.browserCode) && !wanted.has(row.envId)).map(row => row.envId) });
}

/** Toggling one cell must not select other cells through the cross product. */
export function changeMatrixPairs(index, selection, pairs, checked) {
	const ids = new Set(computeExplicitSelection(index, selection));
	const targets = new Set(pairs.map(([device, browser]) => JSON.stringify([device, browser])));
	for (const row of index) {
		if (!isSelectable(row) || !targets.has(JSON.stringify([deviceKeyOf(row), row.browserCode]))) continue;
		if (checked) ids.add(row.envId); else ids.delete(row.envId);
	}
	return exactMatrixSelection(index, ids, selection);
}

export function matrixDevices(index) {
	const devices = new Map();
	for (const row of index) {
		const key = deviceKeyOf(row);
		if (!devices.has(key)) devices.set(key, { key, name: row.device, manufacturer: row.manufacturer, platform: row.platform, type: row.deviceType, rows: [], pairs: new Map() });
		const device = devices.get(key);
		device.rows.push(row);
		if (!device.pairs.has(row.browserCode)) device.pairs.set(row.browserCode, []);
		device.pairs.get(row.browserCode).push(row);
	}
	return [...devices.values()];
}

/** Deliberately small recipes: one actual configuration per device category. */
export function matrixRecipe(index, recipe) {
	const types = recipe === 'balanced' ? ['desktop', 'mobile', 'tablet'] : [recipe === 'mobile' ? 'mobile' : 'desktop'];
	const ids = [];
	for (const type of types) {
		const available = index.filter(row => isSelectable(row) && row.deviceType === type);
		const row = available.find(row => row.browserCode === (type === 'desktop' ? 'chrome' : 'safari')) ?? available[0];
		if (row) ids.push(row.envId);
	}
	return exactMatrixSelection(index, ids);
}

export function visibleMatrixDevices(devices, { search = '', category = '', platform = '', selectedOnly = false }, selectedIds) {
	const term = search.trim().toLowerCase();
	return devices.filter(device => (!category || device.type === category) && (!platform || device.platform === platform)
		&& (!selectedOnly || device.rows.some(row => selectedIds.has(row.envId)))
		&& (!term || device.rows.some(row => [row.device, row.manufacturer, row.os, row.osVersion, row.browser, row.browserCode, row.browserVersion].filter(Boolean).join(' ').toLowerCase().includes(term))));
}
