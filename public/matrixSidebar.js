/**
 * matrixSidebar — sidebar renderer for the device & browser matrix (M3 #14422).
 *
 * Renders the M2 model (buildSidebarTree / filterSidebarTree) into
 * #mx-sidebar inside the existing device-picker dialog: search box is shared
 * with the legacy card list (dp-search), categories expand/collapse, devices
 * select, stars toggle the favorites store, OS sub-navigation per device.
 *
 * All styling is CSS-class based (mx-*) consuming theme tokens only — no
 * JS-applied colors, so theme flips are handled entirely by CSS.
 */

import { buildSidebarTree, filterSidebarTree, CATEGORY_LABELS, rankEnvironments } from './deviceBrowserMatrix.js';

export function createMatrixSidebar({ container, favoritesStore, recentsStore, onSelectDevice, channel }) {
	if (!container) return null;
	const state = {
		environments: [],
		boardByEnvId: new Map(),
		dataState: 'loading',
		search: '',
		expanded: new Set(['ios', 'android', 'windows', 'macos', 'favorites', 'recent']),
		selectedDevice: null,
		selectedOS: null
	};

	function treeModel() {
		return buildSidebarTree(state.environments, {
			favorites: favoritesStore?.list?.() ?? [],
			recents: recentsStore?.list?.() ?? []
		});
	}

	function deviceEnvFor(deviceName) {
		const envs = state.environments.filter((e) => e?.active !== false && String(e.device ?? '').trim() === deviceName);
		if (!envs.length) return null;
		// Same ranking as the card path: attested level first, then OS/browser
		// freshness — never raw catalog order.
		return rankEnvironments(envs.find((e) => e.osVersion === state.selectedOS) ? envs.filter((e) => e.osVersion === state.selectedOS) : envs)[0];
	}

	function starButton(kind, label, isFav, onToggle) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `mx-star${isFav ? ' is-fav' : ''}`;
		btn.setAttribute('aria-label', `${isFav ? 'Unfavorite' : 'Favorite'} ${label}`);
		btn.setAttribute('aria-pressed', String(Boolean(isFav)));
		btn.textContent = isFav ? '★' : '☆';
		btn.onclick = (event) => {
			event.stopPropagation();
			onToggle();
			// Re-render just re-derives from the store; keeps render simple.
			render();
		};
		return btn;
	}

	function renderOSNav(entry, row) {
		if (!entry.osVersions.length) return;
		const nav = document.createElement('div');
		nav.className = 'mx-os-nav';
		nav.setAttribute('role', 'group');
		nav.setAttribute('aria-label', `OS versions for ${entry.device}`);
		for (const version of entry.osVersions) {
			const chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'mx-os-chip';
			const isActive = state.selectedDevice === entry.device && String(state.selectedOS) === String(version);
			if (isActive) chip.classList.add('is-active');
			chip.textContent = version;
			chip.onclick = (event) => {
				event.stopPropagation();
				state.selectedDevice = entry.device;
				state.selectedOS = version;
				onSelectDevice?.(entry.device, version, deviceEnvFor(entry.device));
				render();
			};
			nav.appendChild(chip);
		}
		row.appendChild(nav);
	}

	function renderDeviceRow(entry, categoryNode) {
		const row = document.createElement('div');
		const isActive = state.selectedDevice === entry.device && !categoryNode.id.startsWith('fav') && !categoryNode.id.startsWith('recent');
		row.className = `mx-device${isActive ? ' is-active' : ''}${entry.stale ? ' is-stale' : ''}`;
		row.setAttribute('role', 'treeitem');
		row.setAttribute('aria-selected', String(Boolean(isActive)));

		const head = document.createElement('div');
		head.className = 'mx-device-head';
		const name = document.createElement('span');
		name.className = 'mx-device-name';
		name.textContent = entry.device;
		name.title = entry.device;
		head.appendChild(name);

		if (!categoryNode.id.startsWith('fav')) {
			// Star toggle (Favorites category itself manages membership by
			// definition; the star lives on the source rows).
			head.appendChild(starButton('device', entry.device, entry.favorite, () => {
				favoritesStore?.toggle?.(`device:${entry.device}`);
			}));
		} else {
			// Removal from Favorites is available on the Favorites row itself.
			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'mx-star is-fav';
			remove.setAttribute('aria-label', `Remove ${entry.device} from favorites`);
			remove.textContent = '×';
			remove.onclick = (event) => {
				event.stopPropagation();
				favoritesStore?.remove?.(`device:${entry.device}`);
				render();
			};
			head.appendChild(remove);
		}
		row.appendChild(head);

		const sub = document.createElement('span');
		sub.className = 'mx-device-sub';
		if (categoryNode.id === 'recent' && entry.env) {
			sub.textContent = [entry.env.os, entry.env.osVersion, entry.env.browser, entry.env.browserVersion].filter(Boolean).join(' ');
		} else if (entry.stale) {
			sub.textContent = 'no active environments';
		} else {
			sub.textContent = `${entry.envCount} environments`;
		}
		row.appendChild(sub);

		// OS sub-navigation: only for live devices with more than the active OS.
		if (!entry.stale && entry.osVersions.length) renderOSNav(entry, row);

		if (entry.stale) {
			row.setAttribute('aria-disabled', 'true');
		} else {
			row.tabIndex = 0;
			row.onclick = () => {
				state.selectedDevice = entry.device;
				if (!entry.osVersions.includes(state.selectedOS)) state.selectedOS = entry.osVersions[0] ?? null;
				onSelectDevice?.(entry.device, state.selectedOS, deviceEnvFor(entry.device));
				render();
			};
			row.onkeydown = (event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					row.click();
				}
			};
		}
		return row;
	}

	function render() {
		container.textContent = '';
		if (state.dataState === 'loading') {
			const p = document.createElement('p');
			p.className = 'dp-empty';
			p.setAttribute('aria-live', 'polite');
			p.textContent = 'Loading device catalog…';
			container.appendChild(p);
			return;
		}
		if (state.dataState === 'error') {
			const p = document.createElement('p');
			p.className = 'dp-empty';
			p.setAttribute('role', 'alert');
			p.textContent = 'Could not load the device catalog — check your connection and reopen the picker.';
			container.appendChild(p);
			return;
		}
		const tree = filterSidebarTree(treeModel(), state.search);
		if (!tree.categories.length) {
			const p = document.createElement('p');
			p.className = 'dp-empty';
			p.textContent = 'No devices match — clear the search.';
			container.appendChild(p);
			return;
		}
		const nav = document.createElement('div');
		nav.className = 'mx-tree';
		nav.setAttribute('role', 'tree');
		nav.setAttribute('aria-label', 'Devices by category');
		for (const categoryNode of tree.categories) {
			const section = document.createElement('div');
			section.className = 'mx-category';
			const head = document.createElement('button');
			head.type = 'button';
			head.className = `mx-category-head${state.expanded.has(categoryNode.id) ? ' is-expanded' : ''}`;
			head.setAttribute('aria-expanded', String(state.expanded.has(categoryNode.id)));
			const arrow = document.createElement('span');
			arrow.className = 'mx-arrow';
			arrow.textContent = state.expanded.has(categoryNode.id) ? '▾' : '▸';
			const label = document.createElement('span');
			label.textContent = CATEGORY_LABELS[categoryNode.id] ?? categoryNode.label;
			const count = document.createElement('span');
			count.className = 'mx-count';
			count.textContent = String(categoryNode.devices.length);
			head.append(arrow, label, count);
			head.onclick = () => {
				if (state.expanded.has(categoryNode.id)) state.expanded.delete(categoryNode.id);
				else state.expanded.add(categoryNode.id);
				render();
			};
			section.appendChild(head);
			if (state.expanded.has(categoryNode.id)) {
				const list = document.createElement('div');
				list.className = 'mx-device-list';
				list.setAttribute('role', 'group');
				if (!categoryNode.devices.length) {
					const empty = document.createElement('p');
					empty.className = 'mx-empty';
					empty.textContent = categoryNode.id === 'favorites'
						? 'No favorites yet — star a device.'
						: categoryNode.id === 'recent' ? 'No recent tests yet.' : 'No devices.';
					list.appendChild(empty);
				}
				for (const entry of categoryNode.devices) list.appendChild(renderDeviceRow(entry, categoryNode));
				section.appendChild(list);
			}
			nav.appendChild(section);
		}
		container.appendChild(nav);
	}

	return {
		setData({ environments, boardByEnvId, dataState = 'ready' }) {
			state.environments = environments ?? [];
			state.boardByEnvId = boardByEnvId ?? new Map();
			state.dataState = dataState;
			render();
		},
		setSearch(search) {
			state.search = String(search ?? '');
			render();
		},
		setSelection(device, osVersion) {
			state.selectedDevice = device ?? null;
			state.selectedOS = osVersion ?? null;
			render();
		},
		getSelection() {
			return { device: state.selectedDevice, osVersion: state.selectedOS };
		},
		render
	};
}
