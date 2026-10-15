import { familyRows, computeExplicitSelection, createSelectionState, deviceKeyOf, isSelectable, setSelectionMode, assignDevice, unassignDevice, executionTypeLabel, MATRIX_BATCH_SIZE } from './qaConfigMatrix.js';
import { matrixDevices, matrixRecipe, visibleMatrixDevices, changeMatrixPairs, exactMatrixSelection, onePerBrowserSelection } from './matrixPickerModel.js';

export function renderMatrixPicker({ document, hosts, index, families: catalogFamilies, selection, search, view, apply, render, brandIcon }) {
	hosts.search.dataset.pickerFocus = 'search';
	const focusKey = document.activeElement?.dataset.pickerFocus;
	const searchBar = hosts.search.parentElement;
	const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
	const button = (text, callback, key) => {
		const node = el('button', 'mp-button', text); node.type = 'button';
		if (key) node.dataset.pickerFocus = key;
		node.addEventListener('click', callback); return node;
	};
	const check = (label, rows, callback, key) => {
		const wrapper = el('label', 'mp-check');
		const input = el('input'); input.type = 'checkbox'; input.dataset.pickerFocus = key;
		const available = rows.filter(isSelectable);
		const count = available.filter(row => selected.has(row.envId)).length;
		input.checked = available.length > 0 && count === available.length;
		input.indeterminate = count > 0 && count < available.length;
		input.disabled = available.length === 0;
		input.setAttribute('aria-label', label);
		wrapper.title = available.length ? `${count} of ${available.length} configurations selected. Includes available OS and browser versions.` : rows.find(row => row.availabilityReason)?.availabilityReason || 'This combination is unavailable.';
		input.addEventListener('change', () => callback(input.checked));
		wrapper.append(input, el('span', '', available.length ? (count && count < available.length ? `${count}/${available.length} selected` : `${count || available.length} ${count ? 'selected' : 'available'}`) : 'Unavailable'));
		return wrapper;
	};
	const selected = new Set(computeExplicitSelection(index, selection));
	const devices = matrixDevices(index);
	const families = familyRows(index, catalogFamilies);
	const chosen = families.filter(family => selection.browserFamilies.has(family.code));
	const perBrowser = selection.mode === 'perBrowser';
	const selectedDevices = devices.filter(device => device.rows.some(row => selected.has(row.envId)));
	hosts.root.classList.add('mp-picker');
	hosts.browsers.replaceChildren(); hosts.devices.replaceChildren(); hosts.summary.replaceChildren();

	const starter = el('div', 'mp-starters');
	starter.append(el('span', 'mp-eyebrow', 'QUICK START · REPLACES SELECTION'));
	const recipes = el('div', 'mp-recipe-list');
	for (const [id, name] of [['desktop', 'Desktop'], ['mobile', 'Mobile'], ['balanced', 'Desktop + mobile + tablet']]) {
		const recipe = matrixRecipe(index, id);
		const total = computeExplicitSelection(index, recipe).length;
		const label = id === 'balanced' && total < 3 ? 'Balanced available coverage' : name;
		const pick = button(`${label} · ${total} ${total === 1 ? 'run' : 'runs'}`, () => apply(recipe), `recipe-${id}`);
		pick.disabled = total === 0; recipes.append(pick);
	}
	starter.append(recipes); hosts.browsers.append(starter);
	const heading = el('div', 'mp-section-heading');
	heading.append(el('h3', '', '1. Choose browsers'), el('span', 'mp-muted', `${chosen.length} selected`));
	hosts.browsers.append(heading);
	const browserList = el('div', 'mp-browser-list'); browserList.setAttribute('aria-label', 'Browsers');
	for (const family of families) {
		const active = selection.browserFamilies.has(family.code);
		const item = button('', () => {
			const next = createSelectionState(selection);
			if (active) next.browserFamilies.delete(family.code); else next.browserFamilies.add(family.code);
			apply(perBrowser ? setSelectionMode(next, index, 'perBrowser') : next);
		}, `browser-${family.code}`);
		item.classList.add('mp-browser'); item.classList.toggle('is-selected', active);
		item.setAttribute('aria-pressed', String(active)); item.dataset.family = family.code;
		item.disabled = !family.available;
		item.title = family.available ? `${active ? 'Remove' : 'Include'} ${family.label} on selected devices` : family.reason || 'Unavailable';
		item.append(brandIcon(family.code, 20), el('span', '', family.label), el('span', 'mp-muted', family.available ? (active ? '✓' : '+') : 'Unavailable'));
		browserList.append(item);
	}
	hosts.browsers.append(browserList);
	const modes = el('div', 'mp-modes');
	for (const [id, label] of [['cross', 'Mix & match'], ['perBrowser', 'One device per browser']]) {
		const mode = button(label, () => apply(id === 'cross' ? exactMatrixSelection(index, selected, selection) : onePerBrowserSelection(index, selection)), `mode-${id}`);
		mode.setAttribute('aria-pressed', String((perBrowser ? 'perBrowser' : 'cross') === id)); modes.append(mode);
	}
	hosts.browsers.append(modes);
	const second = el('div', 'mp-section-heading'); second.append(el('h3', '', '2. Pick combinations'), el('span', 'mp-muted', perBrowser ? 'Assign one compatible device to each browser' : 'Check individual cells, or a device to select its browsers'));
	hosts.devices.append(second, searchBar);
	const toolbar = el('div', 'mp-toolbar');
	const categories = el('div', 'mp-categories'); categories.setAttribute('role', 'group'); categories.setAttribute('aria-label', 'Device categories');
	for (const [id, label] of [['', 'All devices'], ['mobile', 'Phones'], ['tablet', 'Tablets'], ['desktop', 'Desktops']]) {
		const count = devices.filter(device => (!id || device.type === id) && device.rows.some(isSelectable)).length;
		const chip = button(`${label} ${count}`, () => { view.category = id; view.limit = 10; render(); }, `category-${id}`);
		chip.setAttribute('aria-pressed', String(view.category === id)); categories.append(chip);
	}
	toolbar.append(categories);
	const platform = el('select', 'mp-platform'); platform.setAttribute('aria-label', 'Filter operating system'); platform.dataset.pickerFocus = 'platform';
	const labels = { ios: 'iOS', ipados: 'iPadOS', android: 'Android', windows: 'Windows', macos: 'macOS', linux: 'Linux' };
	for (const id of ['', ...new Set(devices.map(device => device.platform))]) {
		const option = el('option', '', id ? labels[id] || id : 'All operating systems'); option.value = id; platform.append(option);
	}
	platform.value = view.platform;
	platform.addEventListener('change', () => { view.platform = platform.value; view.limit = 10; render(); }); toolbar.append(platform);
	const only = button(`Selected devices (${selectedDevices.length})`, () => { view.selectedOnly = !view.selectedOnly; view.limit = 10; render(); }, 'selected-only');
	only.setAttribute('aria-pressed', String(view.selectedOnly)); toolbar.append(only); hosts.devices.append(toolbar);
	const filtered = visibleMatrixDevices(devices, { ...view, search }, selected);
	const visible = filtered.slice(0, view.limit);
	const reset = button('Reset filters', () => {
		view.category = ''; view.platform = ''; view.selectedOnly = false; view.limit = 10;
		hosts.search.value = ''; hosts.search.dispatchEvent(new Event('input', { bubbles: true })); render();
	}, 'reset-filters');
	const count = el('div', 'mp-count'); count.append(el('span', '', `${visible.length} of ${filtered.length} matching devices · Filters never change your selection`), reset); hosts.devices.append(count);
	if (!chosen.length) hosts.devices.append(el('p', 'mp-empty', 'Choose at least one browser above, then pick its device combinations.'));
	else if (perBrowser) {
		const assignments = el('div', 'mp-assignments');
		for (const family of chosen) {
			const row = el('label', 'mp-assignment'); row.append(el('strong', '', family.label));
			const select = el('select'); select.dataset.pickerFocus = `assign-${family.code}`; select.setAttribute('aria-label', `Device for ${family.label}`);
			const empty = el('option', '', 'Choose a compatible device'); empty.value = ''; select.append(empty);
			const assignedKey = selection.deviceAssignments[family.code];
			const options = devices.filter(device => (filtered.includes(device) || device.key === assignedKey) && device.pairs.get(family.code)?.some(isSelectable));
			for (const device of options) { const option = el('option', '', `${device.name} · ${labels[device.platform] || device.platform}`); option.value = device.key; select.append(option); }
			select.value = assignedKey || '';
			select.addEventListener('change', () => {
				const next = select.value ? assignDevice(selection, index, family.code, select.value) : unassignDevice(selection, family.code);
				for (const config of index) if (deviceKeyOf(config) === select.value && config.browserCode === family.code) next.deselectedEnvIds.delete(config.envId);
				apply(next);
			});
			row.append(select); assignments.append(row);
		}
		hosts.devices.append(assignments);
	} else if (!visible.length) hosts.devices.append(el('p', 'mp-empty', 'No matching devices. Reset filters or search for a different device. Your selections are kept.'));
	else {
		const scroll = el('div', 'mp-table-scroll'); scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', 'Device and browser combinations. Scroll horizontally for more browsers.');
		const table = el('table', 'mp-table'); const caption = el('caption', 'sr-only', 'Choose compatible device and browser pairs. Each cell includes its available versions.'); table.append(caption);
		const header = el('tr'); const first = el('th', '', 'Device'); first.scope = 'col'; header.append(first);
		for (const family of chosen) { const th = el('th', '', family.label); th.scope = 'col'; header.append(th); }
		const thead = el('thead'); thead.append(header); table.append(thead); const tbody = el('tbody');
		for (const device of visible) {
			const row = el('tr'); const deviceCell = el('th'); deviceCell.scope = 'row';
			const pairList = chosen.map(family => [device.key, family.code]);
			const applicable = device.rows.filter(config => selection.browserFamilies.has(config.browserCode));
			const identity = check(`All selected browsers on ${device.name}`, applicable, checked => apply(changeMatrixPairs(index, selection, pairList, checked)), `device-${device.key}`);
			identity.lastChild.textContent = device.name;
			deviceCell.append(identity, el('small', 'mp-muted', `${labels[device.platform] || device.platform} · ${device.manufacturer || device.type || 'Device'}`)); row.append(deviceCell);
			for (const family of chosen) {
				const cell = el('td'); const configs = device.pairs.get(family.code) || [];
				cell.append(check(`${family.label} on ${device.name}`, configs, checked => apply(changeMatrixPairs(index, selection, [[device.key, family.code]], checked)), `pair-${device.key}-${family.code}`)); row.append(cell);
			}
			tbody.append(row);
		}
		table.append(tbody); scroll.append(table); hosts.devices.append(scroll);
		const bulk = el('div', 'mp-bulk');
		const pairs = visible.flatMap(device => chosen.map(family => [device.key, family.code]));
		bulk.append(button(`Select shown devices (${visible.length})`, () => apply(changeMatrixPairs(index, selection, pairs, true)), 'select-shown'), button('Clear shown devices', () => apply(changeMatrixPairs(index, selection, pairs, false)), 'clear-shown'));
		if (filtered.length > visible.length) bulk.append(button('Show 10 more devices', () => { view.limit += 10; render(); }, 'show-more'));
		hosts.devices.append(bulk, el('p', 'mp-muted mp-help', 'Each cell includes available OS, orientation and browser versions. A dash in a checkbox means only some versions are selected. Inspect the exact list below.'));
	}

	const summary = el('div', 'mp-total'); summary.append(el('strong', '', `${selected.size.toLocaleString()} ${selected.size === 1 ? 'run' : 'runs'} selected`), el('span', 'mp-muted', `${selectedDevices.length} devices · ${new Set(index.filter(row => selected.has(row.envId)).map(row => row.browserCode)).size} browsers`));
	const clear = button('Clear selection', () => apply(createSelectionState({ browserFamilies: selection.browserFamilies })), 'clear-selection'); clear.disabled = !selected.size; summary.append(clear); hosts.summary.append(summary);
	if (selected.size > 20) hosts.summary.append(el('p', 'mp-warning', `This selection creates ${selected.size.toLocaleString()} separate runs${selected.size > MATRIX_BATCH_SIZE ? ` in ${Math.ceil(selected.size / MATRIX_BATCH_SIZE)} batches` : ''}. More configurations take longer and use more model capacity.`));
	const review = el('details', 'mp-review'); review.open = Boolean(view.reviewOpen);
	review.addEventListener('toggle', () => { if (view.reviewOpen !== review.open) { view.reviewOpen = review.open; render(); } });
	const reviewTitle = el('summary', '', `Review exact configurations (${selected.size.toLocaleString()})`); reviewTitle.dataset.pickerFocus = 'review'; review.append(reviewTitle);
	const list = el('ul', 'mp-review-list');
	const reviewRows = view.reviewOpen ? index.filter(row => selected.has(row.envId)) : [];
	const reviewLimit = view.reviewLimit || 30;
	for (const config of reviewRows.slice(0, reviewLimit)) {
		const row = el('li'); row.append(el('span', '', [config.device, config.os, config.osVersion, config.browser || config.browserCode, config.browserVersion, config.orientation, executionTypeLabel(config.executionType)].filter(Boolean).join(' · ')));
		row.append(button('Remove', () => { const ids = new Set(selected); ids.delete(config.envId); apply(exactMatrixSelection(index, ids, selection)); }, `remove-${config.envId}`)); list.append(row);
	}
	if (!selected.size) list.append(el('li', '', 'No configurations selected yet. Choose a quick start or check a combination above.'));
	if (reviewRows.length > reviewLimit) list.append(button(`Show 30 more configurations (${reviewRows.length - reviewLimit} remaining)`, () => { view.reviewLimit = reviewLimit + 30; render(); }, 'review-more'));
	review.append(list); hosts.summary.append(review);
	const notes = catalogFamilies.filter(family => selection.browserFamilies.has(family.code) && family.note).map(family => `${family.label || family.code}: ${family.note}`);
	if (notes.length) hosts.summary.append(el('p', 'mp-muted mp-help', notes.join(' · ')));
	if (focusKey) [...hosts.root.querySelectorAll('[data-picker-focus]')].find(node => node.dataset.pickerFocus === focusKey)?.focus({ preventScroll: true });
}
