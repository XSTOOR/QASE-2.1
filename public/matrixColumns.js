/**
 * matrixColumns — browser-brand column renderer for the device & browser
 * matrix (M4 #14423).
 *
 * Renders M2's buildBrowserColumns output into #mx-columns: one column per
 * compatible browser brand with an inline SVG brand icon, name, scrollable
 * version list (channel labels via the browserChannels mirror), favorite star
 * per version, More control, honest availability/execution labels.
 *
 * Brand glyphs are simplified inline SVG approximations of the official marks
 * in official brand colors — CSP-safe (no CDN, no runtime fetch).
 */

import { channelFor } from './browserChannels.js';
import { brandIcon } from './brandIcons.js';

const CHANNEL_LABEL = { stable: 'STABLE', beta: 'BETA', dev: 'DEV', canary: 'CANARY', nightly: 'NIGHTLY' };

export function createMatrixColumns({ container, emptyState, favoritesStore, recentsStore, onSelectVersion }) {
	if (!container) return null;
	const state = {
		columns: [],
		selectedEnvId: null,
		windows: new Map() // browserCode → count of revealed rows
	};

	function starButton(code, version, isFav) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `mx-star${isFav ? ' is-fav' : ''}`;
		btn.setAttribute('aria-label', `${isFav ? 'Unfavorite' : 'Favorite'} ${code} ${version}`);
		btn.setAttribute('aria-pressed', String(Boolean(isFav)));
		btn.textContent = isFav ? '★' : '☆';
		btn.onclick = (event) => {
			event.stopPropagation();
			favoritesStore?.toggle?.(`version:${code}:${version}`);
			render();
		};
		return btn;
	}

	function renderRow(column, row) {
		const el = document.createElement('button');
		el.type = 'button';
		el.className = `mx-version${row.envId === state.selectedEnvId ? ' is-selected' : ''}${row.available ? '' : ' is-unavailable'}`;
		// Unavailable rows stay SELECTABLE (the user must see the honest
		// REAL DEVICE UNAVAILABLE state + reason); EXECUTION is what's blocked,
		// at run start via the fallback dialog and the server's availability
		// guard (#14490–R3). aria-disabled would wrongly imply the row cannot
		// even be inspected.
		const head = document.createElement('span');
		head.className = 'mx-version-head';
		const ver = document.createElement('span');
		ver.className = 'mx-version-num';
		ver.textContent = row.version;
		const channel = document.createElement('span');
		channel.className = `mx-channel mx-channel--${row.channel}`;
		channel.textContent = CHANNEL_LABEL[row.channel] ?? row.channel.toUpperCase();
		head.append(ver, channel);
		const meta = document.createElement('span');
		meta.className = 'mx-version-meta';
		const level = row.executionType ? String(row.executionType).toUpperCase().replace(/_/g, ' ') : 'VIRTUAL DEVICE';
		// #14632 (NI01 Phase 2): provider-derived browser executability wins.
		// NOT SUPPORTED (e.g. DuckDuckGo — no execution provider) and
		// ENGINE-EQUIVALENT (Opera/Brave on Chromium, Safari on WebKit
		// locally) are shown with their reason; never as plain availability.
		if (row.status === 'NOT_SUPPORTED') {
			meta.textContent = 'NOT SUPPORTED';
			el.title = row.browserSupport?.reason ?? 'No execution provider can run this browser.';
		} else if (row.browserSupport?.status === 'engine_equivalent') {
			meta.textContent = `${level} · ENGINE-EQUIVALENT (${(row.browserSupport.engine ?? 'chromium').toUpperCase()})`;
			el.title = row.browserSupport.reason;
		} else {
			meta.textContent = row.available
				? `${level}${row.status && row.status !== 'AVAILABLE' ? ` · ${row.status}` : ''}`
				: 'REAL DEVICE UNAVAILABLE';
		}
		el.append(head, meta);
		el.appendChild(starButton(column.browserCode, row.version, row.favorite));
		el.onclick = () => {
			// Selection is allowed for unavailable rows (honest state shown);
			// startEnvironmentRun blocks execution via the fallback dialog.
			state.selectedEnvId = row.envId;
			onSelectVersion?.(row.env, column, row);
			render();
		};
		return el;
	}

	function renderColumn(column) {
		const el = document.createElement('div');
		el.className = 'mx-col';
		el.setAttribute('role', 'group');
		el.setAttribute('aria-label', `${column.browser} versions`);
		const head = document.createElement('div');
		head.className = 'mx-col-head';
		head.appendChild(brandIcon(column.browserCode));
		const name = document.createElement('span');
		name.className = 'mx-col-name';
		name.textContent = column.browser;
		head.appendChild(name);
		if (column.webkitNote) {
			const note = document.createElement('span');
			note.className = 'mx-webkit-note';
			note.textContent = 'WebKit';
			note.title = 'Runs on the required WebKit engine on iOS/iPadOS';
			head.appendChild(note);
		}
		el.appendChild(head);
		const list = document.createElement('div');
		list.className = 'mx-version-list';
		const window = state.windows.get(column.browserCode) ?? 6;
		const visible = column.rows.slice(0, window);
		for (const row of visible) list.appendChild(renderRow(column, row));
		if (column.rows.length > visible.length) {
			const more = document.createElement('button');
			more.type = 'button';
			more.className = 'mx-more';
			more.textContent = `More (${column.rows.length - visible.length})`;
			more.onclick = () => {
				state.windows.set(column.browserCode, window + 8);
				render();
			};
			list.appendChild(more);
		}
		el.appendChild(list);
		return el;
	}

	function render() {
		container.textContent = '';
		if (!state.columns.length) {
			container.hidden = true;
			if (emptyState) emptyState.hidden = false;
			return;
		}
		container.hidden = false;
		if (emptyState) emptyState.hidden = true;
		for (const column of state.columns) {
			// Refresh favorite flags from the live store so a star toggle
			// re-renders immediately (state.columns is otherwise a snapshot).
			const favList = favoritesStore?.list?.() ?? [];
			for (const row of column.rows) row.favorite = favList.includes(`version:${column.browserCode}:${row.version}`);
			container.appendChild(renderColumn(column));
		}
	}

	return {
		setColumns(columns, selectedEnvId = null) {
			state.columns = columns ?? [];
			state.selectedEnvId = selectedEnvId;
			state.windows.clear();
			render();
		},
		setSelectedEnvId(envId) {
			state.selectedEnvId = envId ?? null;
			render();
		},
		render
	};
}
