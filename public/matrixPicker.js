import { computeExplicitSelection, deviceKeyOf, familyRows } from './qaConfigMatrix.js';
import { normalizeSingleSelection, singleSelection, singleDeviceOptions, devicePlatformLabels } from './singleRunSelection.js';

/** Single browser + single device. No cross products, version chips or bulk actions. */
export function renderMatrixPicker({ document, hosts, index, families: catalogFamilies, selection, search, view, apply, render, brandIcon }) {
	const el = (tag, cls, text) => { const n = document.createElement(tag); n.className = cls || ''; if (text != null) n.textContent = text; return n; };
	const focusKey = document.activeElement?.dataset.pickerFocus;
	const button = (text, action, key) => { const n = el('button', 'mp-button', text); n.type = 'button'; n.dataset.pickerFocus = key; n.onclick = action; return n; };
	const selectedId = computeExplicitSelection(index, selection)[0];
	const selected = index.find(r => r.envId === selectedId);
	const family = [...selection.browserFamilies][0] || 'chrome';
	const searchBar = hosts.search.parentElement;
	hosts.search.dataset.pickerFocus = 'search';
	hosts.root.classList.add('mp-picker');
	hosts.browsers.replaceChildren(); hosts.devices.replaceChildren(); hosts.summary.replaceChildren();
	hosts.browsers.append(el('h3', 'mp-title', '1. Choose a browser'), el('p', 'mp-muted', 'Select one browser. QASE manages the installed version for you.'));
	const browsers = el('div', 'mp-browser-list'); browsers.setAttribute('role', 'group'); browsers.setAttribute('aria-label', 'Choose one browser');
	for (const browser of familyRows(index, catalogFamilies)) {
		const active = family === browser.code;
		const b = button('', () => { view.limit = 8; apply(normalizeSingleSelection(index, selection, browser.code)); }, `browser-${browser.code}`);
		b.classList.add('mp-browser'); b.setAttribute('aria-pressed', String(active)); b.disabled = !browser.available;
		b.title = browser.available ? `Use ${browser.label}` : browser.reason || 'Not available on this server';
		b.append(brandIcon(browser.code, 20), el('span', '', browser.label), el('span', 'mp-muted', active ? '✓' : browser.available ? '' : 'Unavailable'));
		browsers.append(b);
	}
	hosts.browsers.append(browsers);
	hosts.devices.append(el('h3', 'mp-title', '2. Choose a device'), el('p', 'mp-muted', 'Only compatible, available devices are shown. Selecting a device replaces your previous choice.'), searchBar);
	const all = singleDeviceOptions(index, family);
	const toolbar = el('div', 'mp-toolbar');
	const facets = [['category', 'Device type', [['desktop', 'Desktop'], ['mobile', 'Phone'], ['tablet', 'Tablet']]],
		['platform', 'Operating system', [...new Set(all.map(r => r.platform))].sort().map(id => [id, devicePlatformLabels[id] || id])],
		['manufacturer', 'Manufacturer', [...new Set(all.map(r => r.manufacturer).filter(Boolean))].sort().map(id => [id, id])]];
	for (const [key, label, options] of facets) {
		const field = el('label', 'mp-filter'); field.append(el('span', '', label));
		const select = el('select', 'mp-platform'); select.dataset.pickerFocus = key; select.setAttribute('aria-label', `Filter ${label.toLowerCase()}`);
		for (const [value, text] of [['', 'All'], ...options]) { const option = el('option', '', text); option.value = value; select.append(option); }
		if (view[key] && !options.some(([id]) => id === view[key])) { const option = el('option', '', `${view[key]} (no compatible devices)`); option.value = view[key]; select.append(option); }
		select.value = view[key] || '';
		select.onchange = () => { view[key] = select.value; view.limit = 8; render(); };
		field.append(select); toolbar.append(field);
	}
	hosts.devices.append(toolbar);
	const rows = singleDeviceOptions(index, family, { ...view, search }).sort((a, b) => Number(b.envId === selectedId) - Number(a.envId === selectedId));
	const shown = rows.slice(0, view.limit || 8);
	const count = el('div', 'mp-count'); count.setAttribute('role', 'status');
	count.append(el('span', '', `${rows.length} compatible ${rows.length === 1 ? 'device' : 'devices'}`), button('Reset filters', () => {
		view.category = ''; view.platform = ''; view.manufacturer = ''; view.limit = 8;
		hosts.search.value = ''; hosts.search.dispatchEvent(new Event('input', { bubbles: true })); render();
	}, 'reset-filters')); hosts.devices.append(count);
	const list = el('div', 'mp-device-list'); list.setAttribute('role', 'group'); list.setAttribute('aria-label', 'Choose one device');
	for (const row of shown) {
		const active = selected && deviceKeyOf(selected) === deviceKeyOf(row) && selected.browserCode === family;
		const b = button('', () => apply(singleSelection(index, row)), `device-${deviceKeyOf(row)}`);
		b.classList.add('mp-device'); b.setAttribute('aria-pressed', String(Boolean(active)));
		const identity = el('span', 'mp-device-identity'); identity.append(el('strong', '', row.device), el('small', 'mp-muted', [devicePlatformLabels[row.platform] || row.os, row.manufacturer, row.deviceType === 'mobile' ? 'Phone' : row.deviceType].filter(Boolean).join(' · ')));
		b.append(identity, el('span', 'mp-device-check', active ? '✓' : '')); list.append(b);
	}
	if (!rows.length) list.append(el('p', 'mp-empty', 'No devices match these filters. Reset filters or try a different browser. Your selected device is unchanged.'));
	hosts.devices.append(list);
	if (rows.length > shown.length) hosts.devices.append(button(`Show more devices (${rows.length - shown.length} remaining)`, () => { view.limit = (view.limit || 8) + 8; render(); }, 'show-more'));
	const summary = el('div', 'mp-single-summary');
	summary.append(el('span', 'mp-eyebrow', 'YOUR TEST ENVIRONMENT'), el('strong', '', selected ? `${selected.browser || family} · ${selected.device}` : 'Choose one available browser and device'), el('span', 'mp-muted', '1 browser · 1 device · 1 test run. No version selection or additional runs.'));
	hosts.summary.append(summary);
	const familyNote = catalogFamilies.find(browser => browser.code === family)?.note;
	if (familyNote) hosts.summary.append(el('p', 'mp-muted', familyNote));
	if (selected?.browserSupport?.status === 'engine_equivalent') hosts.summary.append(el('p', 'mp-muted', `Runs with the compatible ${selected.browserSupport.engine || 'browser'} engine, not the branded browser binary.`));
	if (selected?.executionType === 'browser_emulation') hosts.summary.append(el('p', 'mp-muted', 'Device profile emulation, not a physical device.'));
	if (focusKey) [...hosts.root.querySelectorAll('[data-picker-focus]')].find(n => n.dataset.pickerFocus === focusKey)?.focus({ preventScroll: true });
}
