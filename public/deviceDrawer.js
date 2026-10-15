/**
 * Device Matrix drawer (Phase 10).
 *
 * Compact selection surface for run environments: a collapsed chip in the
 * feature dock shows the current/default environment; [Change] opens an
 * overlay drawer with search, ALL/APPLE/ANDROID/WINDOWS tabs, expandable
 * manufacturer sections, device → OS → browser drill-down with validation-
 * driven filtering, multi-select environment creation and the saved
 * environments list (run / edit / remove / set default).
 *
 * This is deliberately NOT the admin surface — the Device Matrix dialog
 * (Phase 3) keeps catalog CRUD. Pure helpers are exported for unit tests.
 */

/**
 * Phase 20 runtime capability display data — mirrors the server's
 * PLATFORM_RUNTIME_PROFILES honestly. Display only; the server re-validates
 * every capability answer before recording it.
 */
export const RUNTIME_PROFILES = {
	ios: { media: { camera: { supported: true }, microphone: { supported: true }, screenShare: { supported: 'limited' } }, input: ['touch'] },
	ipados: { media: { camera: { supported: true }, microphone: { supported: true }, screenShare: { supported: 'limited' } }, input: ['touch', 'keyboard', 'pen'] },
	macos: { media: { camera: { supported: true }, microphone: { supported: true }, screenShare: { supported: true } }, input: ['mouse', 'keyboard'] },
	android: { media: { camera: { supported: true }, microphone: { supported: true }, screenShare: { supported: 'limited' } }, input: ['touch'] },
	windows: { media: { camera: { supported: true }, microphone: { supported: true }, screenShare: { supported: true } }, input: ['mouse', 'keyboard', 'touch'] }
};

/** Human category name → drawer tab. Windows categories are Laptop/Desktop/Tablet. */
export function platformForCategory(categoryDisplay = '') {
	const name = String(categoryDisplay).toLowerCase();
	if (name.includes('windows')) return 'windows';
	if (/(samsung|pixel|oneplus|motorola|xiaomi|redmi|oppo|vivo|realme|nothing|android)/.test(name)) return 'android';
	return 'apple';
}

/** Group device models by their category, in catalog order. */
export function groupModelsByCategory(models = [], categories = []) {
	const byId = new Map(categories.map((c) => [c.id, c]));
	const groups = new Map();
	for (const model of models) {
		const category = byId.get(model.category_id);
		const key = category?.display_name ?? model.category_id ?? 'Other devices';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(model);
	}
	return [...groups.entries()].map(([category, rows]) => ({ category, models: rows }));
}

/** Filter drawer categories by tab + search term (matches category and model names). */
export function filterDrawerSections(sections = [], { tab = 'all', search = '' } = {}) {
	const term = String(search).trim().toLowerCase();
	return sections
		.filter((section) => tab === 'all' || platformForCategory(section.category) === tab)
		.map((section) => ({
			...section,
			models: section.models.filter((m) => !term || `${m.display_name} ${m.id}`.toLowerCase().includes(term))
		}))
		.filter((section) => section.models.length > 0);
}

/** Count label for the Apply button: "3 environments selected". */
export function selectionCountLabel(count) {
	return `${count} environment${count === 1 ? '' : 's'} selected`;
}

/** Short label for the collapsed chip: "Galaxy S24 · Android 15 — Chrome 141". */
export function chipLabel(env) {
	if (!env) return 'none yet';
	const os = env.osLabel ?? [env.os, env.osVersion].filter(Boolean).join(' ');
	const browser = env.browserLabel ?? [env.browser, env.browserVersion].filter(Boolean).join(' ');
	return [env.device, os, browser].filter(Boolean).join(' — ');
}

import { availabilityMeta, executionTypeLabel } from './deviceRuntimeUi.js';

export function createDeviceDrawer({ api, toast, fail, onApplied, onRunEnvironment, onOpenPicker, elements }) {
	const {
		drawer, chip, chipChange, chipLabel: chipLabelEl,
		search, tabs, sections, detail, detailBody,
		selectionSummary, applyBtn, clearSelection,
		savedList, savedRefresh, closeBtn,
		advancedToggle, advancedBody
	} = elements;

	const state = {
		tab: 'all',
		search: '',
		catalog: { deviceCategories: [], deviceModels: [], osVersions: [], browsers: [], browserVersions: {} },
		compatCache: new Map(), // modelId → [{ slug, display, osVersionId }]
		selection: new Map(),   // comboKey → { label, body }
		environments: [],
		board: new Map(),       // envId → device-runtime board entry (Phase 23)
		defaultEnvId: localStorage.getItem('qase.environmentId') || ''
	};

	// ── Data ────────────────────────────────────────────────────────────────
	async function loadCatalog() {
		const [categories, models, osVersions, browsers] = await Promise.all([
			api('/catalog/deviceCategories').catch(() => ({ rows: [] })),
			api('/catalog/deviceModels').catch(() => ({ rows: [] })),
			api('/catalog/osVersions').catch(() => ({ rows: [] })),
			api('/catalog/browsers').catch(() => ({ rows: [] }))
		]);
		state.catalog.deviceCategories = categories.rows ?? [];
		state.catalog.deviceModels = models.rows ?? [];
		state.catalog.osVersions = osVersions.rows ?? [];
		state.catalog.browsers = browsers.rows ?? [];
	}

	async function loadModelOs(modelId) {
		if (state.compatCache.has(modelId)) return state.compatCache.get(modelId);
		const payload = await api(`/catalog/deviceModels/${encodeURIComponent(modelId)}/osVersions`).catch(() => ({ rows: [] }));
		const rows = (payload.rows ?? []).map((row) => ({
			slug: row.id ?? row.osVersionId,
			display: row.display ?? row.id,
			osVersionId: row.id ?? row.osVersionId
		}));
		state.compatCache.set(modelId, rows);
		return rows;
	}

	async function loadBrowserVersions(browserId) {
		if (state.catalog.browserVersions[browserId]) return state.catalog.browserVersions[browserId];
		const payload = await api(`/catalog/browsers/${encodeURIComponent(browserId)}/versions`).catch(() => ({ rows: [] }));
		state.catalog.browserVersions[browserId] = payload.rows ?? [];
		return state.catalog.browserVersions[browserId];
	}

	async function refreshEnvironments() {
		const [payload, boardPayload] = await Promise.all([
			api('/environments?active=true&limit=1000').catch(() => ({ environments: [] })),
			api('/device-runtime/devices').catch(() => null)
		]);
		state.environments = payload.environments ?? [];
		state.board = new Map((boardPayload?.devices ?? []).map((d) => [d.envId, d]));
	}

	// ── Chip (collapsed indicator) ──────────────────────────────────────────
	function paintChip() {
		if (!chipLabelEl) return;
		// DX Phase 3 / UI Fix Phase 3: the chip reads the ACTIVE SELECTION
		// (store), not the drawer's own default-env state — one source of
		// truth. Falls back to the legacy key only if the store is empty.
		const sel = globalThis.__qaseActiveSelection?.();
		const envId = sel?.envId ?? state.defaultEnvId ?? localStorage.getItem('qase.environmentId');
		const env = state.environments.find((e) => e.envId === envId) ?? null;
		chipLabelEl.textContent = env ? env.device : 'none yet';
		chipLabelEl.title = env ? chipLabel(env) : 'Choose where the next run executes';
		// Phase D5: full compact panel — all six labeled fields, no truncation.
		const osEl = document.getElementById('device-chip-os');
		const browserEl = document.getElementById('device-chip-browser');
		const execEl = document.getElementById('device-chip-exec');
		const statusEl = document.getElementById('device-chip-status');
		const sessionEl = document.getElementById('device-chip-session');
		if (osEl) osEl.textContent = env ? [env.os, env.osVersion].filter(Boolean).join(' ') : '—';
		if (browserEl) browserEl.textContent = env ? [env.browser, env.browserVersion].filter(Boolean).join(' ') : '—';
		if (execEl) execEl.textContent = env ? executionTypeLabel(env.executionLevelRequested ?? env.runtimeAttestedLevel ?? null).toUpperCase() : '—';
		if (statusEl) {
			statusEl.textContent = env ? '● Available' : '○ Not selected';
		}
		if (sessionEl) sessionEl.textContent = env?.runtimeSessionId ?? '—';
		if (chip) {
			chip.dataset.ready = env ? 'true' : 'false';
			chip.title = chipLabelEl.title;
		}
	}

	// ── Drawer sections ─────────────────────────────────────────────────────
	function currentSections() {
		const grouped = groupModelsByCategory(state.catalog.deviceModels, state.catalog.deviceCategories);
		return filterDrawerSections(grouped, { tab: state.tab, search: state.search });
	}

	function renderSections() {
		if (!sections) return;
		sections.innerHTML = '';
		const visible = currentSections();
		if (!visible.length) {
			const empty = document.createElement('p');
			empty.className = 'dd-empty';
			empty.textContent = state.search ? 'No devices match your search.' : 'No devices yet.';
			sections.append(empty);
			return;
		}
		for (const section of visible) {
			const details = document.createElement('details');
			details.className = 'dd-section';
			const summary = document.createElement('summary');
			summary.textContent = section.category;
			details.append(summary);
			const list = document.createElement('ul');
			list.className = 'dd-device-list';
			for (const model of section.models) {
				const li = document.createElement('li');
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'dd-device';
				btn.textContent = model.display_name;
				btn.onclick = () => selectDevice(model);
				li.append(btn);
				list.append(li);
			}
			details.append(list);
			sections.append(details);
		}
	}

	// ── Device → OS → browser drill-down ────────────────────────────────────
	async function selectDevice(model) {
		if (!detail || !detailBody) return;
		detail.hidden = false;
		detailBody.innerHTML = '';
		const title = document.createElement('h4');
		title.textContent = model.display_name;
		detailBody.append(title);

		const osVersions = await loadModelOs(model.id);
		if (!osVersions.length) {
			const empty = document.createElement('p');
			empty.className = 'dd-empty';
			empty.textContent = 'No compatible OS versions recorded.';
			detailBody.append(empty);
			return;
		}

		const osSelect = document.createElement('select');
		osSelect.className = 'dd-os-select';
		osSelect.setAttribute('aria-label', `OS version for ${model.display_name}`);
		for (const os of osVersions) {
			const option = document.createElement('option');
			option.value = os.osVersionId;
			option.textContent = os.display;
			osSelect.append(option);
		}
		detailBody.append(labelled('Operating system', osSelect));

		const browserBox = document.createElement('div');
		browserBox.className = 'dd-browser-box';
		detailBody.append(labelled('Browsers', browserBox));

		const platform = osVersions[0]?.osVersionId?.split(':')[0] ?? 'ios';
		const available = state.catalog.browsers.filter((b) => browserAvailableOn(b, platform));
		for (const browser of available) {
			const versions = await loadBrowserVersions(browser.id);
			const row = document.createElement('label');
			row.className = 'dd-check';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.dataset.browser = browser.id;
			const text = document.createElement('span');
			text.textContent = browser.display_name;
			row.append(input, text);
			// Default-check the newest version once selected.
			input.onchange = () => {
				if (!input.checked) {
					row.querySelectorAll('.dd-version').forEach((el) => { el.checked = false; });
					return;
				}
				const versionInputs = [...row.querySelectorAll('.dd-version')];
				if (versionInputs.length && !versionInputs.some((v) => v.checked)) versionInputs[0].checked = true;
			};
			const versionWrap = document.createElement('div');
			versionWrap.className = 'dd-versions';
			for (const version of versions.slice(0, 4)) { // newest few; admin matrix has all
				const vLabel = document.createElement('label');
				vLabel.className = 'dd-version-label';
				const vInput = document.createElement('input');
				vInput.type = 'checkbox';
				vInput.className = 'dd-version';
				vInput.dataset.version = String(version.version);
				vLabel.append(vInput, Object.assign(document.createElement('span'), { textContent: String(version.version) }));
				versionWrap.append(vLabel);
			}
			row.append(versionWrap);
			browserBox.append(row);
		}

		const addBtn = document.createElement('button');
		addBtn.type = 'button';
		addBtn.className = 'btn btn-sm btn-primary dd-add';
		addBtn.textContent = 'Add to selection';
		addBtn.onclick = () => {
			const osId = osSelect.value;
			const os = osVersions.find((o) => o.osVersionId === osId);
			let added = 0;
			for (const browserInput of browserBox.querySelectorAll('input[type=checkbox][data-browser]')) {
				if (!browserInput.checked) continue;
				const browser = state.catalog.browsers.find((b) => b.id === browserInput.dataset.browser);
				const versionInputs = [...browserInput.closest('.dd-check').querySelectorAll('.dd-version:checked')];
				for (const versionInput of versionInputs) {
					addCombo(model, os, browser, versionInput.dataset.version);
					added += 1;
				}
				if (!versionInputs.length) { addCombo(model, os, browser, null); added += 1; }
			}
			if (added) toast(`${added} combination${added === 1 ? '' : 's'} added.`);
			else toast('Pick at least one browser version.');
		};
		detailBody.append(addBtn);

		// ── Phase 20: permission + orientation scenario pickers ──────────────
		// Honest capabilities first: what this platform can actually do in the
		// local runtime (never invented). Then the per-run permission scenario.
		const runtime = RUNTIME_PROFILES[platform] ?? null;
		if (runtime) {
			const chips = document.createElement('div');
			chips.className = 'dd-capability-chips';
			for (const [name, cap] of Object.entries(runtime.media)) {
				const chipEl = document.createElement('span');
				chipEl.className = 'dd-capability-chip';
				const supportedLabel = cap.supported === true ? 'SUPPORTED (simulated locally)'
					: cap.supported === 'limited' ? 'LIMITED' : 'NOT SUPPORTED';
				chipEl.textContent = `${name}: ${supportedLabel}`;
				if (cap.supported === true) chipEl.dataset.support = 'yes';
				else if (cap.supported === 'limited') chipEl.dataset.support = 'limited';
				else chipEl.dataset.support = 'no';
				chipEl.title = cap.note ?? '';
				chips.append(chipEl);
			}
			detailBody.append(chips);
		}

		const permRow = document.createElement('div');
		permRow.className = 'dd-scenario';
		permRow.append(Object.assign(document.createElement('span'), {
			className: 'dd-scenario-label',
			textContent: 'Permissions during test'
		}));
		for (const perm of ['camera', 'microphone', 'notifications', 'geolocation']) {
			const sel = document.createElement('select');
			sel.className = 'dd-perm-select';
			sel.dataset.permission = perm;
			sel.setAttribute('aria-label', `${perm} permission`);
			for (const [value, label] of [['ask', `${perm}: ask`], ['allow', `${perm}: allow`], ['deny', `${perm}: deny`]]) {
				const option = document.createElement('option');
				option.value = value;
				option.textContent = label;
				sel.append(option);
			}
			permRow.append(sel);
		}
		detailBody.append(permRow);

		const orientRow = document.createElement('div');
		orientRow.className = 'dd-scenario';
		orientRow.append(Object.assign(document.createElement('span'), {
			className: 'dd-scenario-label',
			textContent: 'Orientation'
		}));
		const orientSelect = document.createElement('select');
		orientSelect.className = 'dd-orient-select';
		const touchDevice = model.device_type !== 'desktop';
		for (const [value, label] of [
			['portrait', 'Portrait'],
			['landscape', 'Landscape'],
			...(touchDevice ? [['rotate-during-test', 'Rotate during test']] : [])
		]) {
			const option = document.createElement('option');
			option.value = value;
			option.textContent = label;
			orientSelect.append(option);
		}
		orientRow.append(orientSelect);
		detailBody.append(orientRow);
	}

	function browserAvailableOn(browser, platform) {
		const platforms = browser.platforms ?? browser.available_platforms;
		if (Array.isArray(platforms)) return platforms.includes(platform);
		return true; // catalog rows without platform data: assume available, server validates
	}

	function comboKey(model, os, browser, version) {
		return [model.id, os?.osVersionId ?? '', browser.id, version ?? ''].join('|');
	}

	function addCombo(model, os, browser, version) {
		const key = comboKey(model, os, browser, version);
		const label = [model.display_name, os?.display, browser.display_name, version ? String(version) : '']
			.filter(Boolean).join(' · ');
		// Phase 20: the scenario pickers ride along with the selection so the
		// created environments carry permission/orientation scenarios.
		const permissionScenario = {};
		for (const sel of detailBody?.querySelectorAll('.dd-perm-select') ?? []) {
			if (sel.value !== 'ask') permissionScenario[sel.dataset.permission] = sel.value;
		}
		const orientSel = detailBody?.querySelector('.dd-orient-select');
		const orientationScenario = orientSel && orientSel.value !== 'portrait' ? orientSel.value : null;
		state.selection.set(key, {
			label,
			body: {
				device: model.display_name,
				platform: (os?.osVersionId ?? '').split(':')[0],
				osVersion: (os?.osVersionId ?? '').split(':').slice(1).join(':'),
				browser: browser.id,
				...(version ? { browserVersion: String(version) } : {}),
				...(Object.keys(permissionScenario).length ? { permissionScenario } : {}),
				...(orientationScenario ? { orientationScenario } : {})
			}
		});
		paintSelection();
	}

	function paintSelection() {
		if (selectionSummary) selectionSummary.textContent = selectionCountLabel(state.selection.size);
		if (applyBtn) applyBtn.disabled = state.selection.size === 0;
		if (clearSelection) clearSelection.hidden = state.selection.size === 0;
	}

	async function applySelection() {
		if (!state.selection.size) return;
		applyBtn.disabled = true;
		try {
			const payload = await api('/environments/bulk', {
				method: 'POST',
				body: JSON.stringify({ combinations: [...state.selection.values()].map((entry) => entry.body) })
			});
			const created = payload.created ?? [];
			const skipped = payload.skipped ?? [];
			if (created.length) {
				state.defaultEnvId = created[0].envId;
				localStorage.setItem('qase.environmentId', created[0].envId);
			}
			toast(`Created ${created.length} environment${created.length === 1 ? '' : 's'}` +
				(skipped.length ? `; skipped ${skipped.length} (not supported).` : '.'));
			state.selection.clear();
			paintSelection();
			await refreshEnvironments();
			paintChip();
			renderSaved();
			onApplied?.(created);
		} catch (error) {
			fail(error);
		} finally {
			applyBtn.disabled = state.selection.size > 0;
		}
	}

	// ── Saved environments ──────────────────────────────────────────────────
	function renderSaved() {
		if (!savedList) return;
		savedList.innerHTML = '';
		if (!state.environments.length) {
			const empty = document.createElement('p');
			empty.className = 'dd-empty';
			empty.textContent = 'No saved environments yet — select devices above and Apply.';
			savedList.append(empty);
			return;
		}
		for (const env of state.environments) {
			const li = document.createElement('li');
			li.className = 'dd-saved';
			if (env.envId === state.defaultEnvId) li.classList.add('is-default');

			const label = document.createElement('span');
			label.className = 'dd-saved-label';
			label.textContent = chipLabel(env);
			li.append(label);

			const boardEntry = state.board.get(env.envId) ?? null;
			if (boardEntry) {
				const meta = availabilityMeta(boardEntry.status);
				const badge = document.createElement('span');
				badge.className = `dd-avail avail-${meta.dot}`;
				badge.textContent = `${meta.label} · ${executionTypeLabel(boardEntry.maximumLevel)}`;
				badge.title = meta.title;
				li.append(badge);
			}

			const actions = document.createElement('span');
			actions.className = 'dd-saved-actions';

			const run = document.createElement('button');
			run.type = 'button';
			run.className = 'btn btn-ghost btn-sm';
			run.textContent = 'Run';
			run.title = 'Use this environment for the next run';
			run.onclick = () => {
				state.defaultEnvId = env.envId;
				localStorage.setItem('qase.environmentId', env.envId);
				paintChip();
				renderSaved();
				if (typeof onRunEnvironment === 'function') {
					// Phase 23: Run starts a real one-click run (with honest
					// fallbacks), not just a default-environment switch.
					void onRunEnvironment(env);
				} else {
					toast(`${chipLabel(env)} is ready for your next run.`);
				}
			};

			const makeDefault = document.createElement('button');
			makeDefault.type = 'button';
			makeDefault.className = 'btn btn-ghost btn-sm';
			makeDefault.textContent = env.envId === state.defaultEnvId ? 'Default ✓' : 'Set default';
			makeDefault.onclick = async () => {
				state.defaultEnvId = env.envId;
				localStorage.setItem('qase.environmentId', env.envId);
				paintChip();
				renderSaved();
				// Server-side preference so the default survives other devices.
				try {
					const profile = await api('/profile');
					await api('/profile', { method: 'PUT', body: JSON.stringify({
						displayName: profile.displayName,
						timezone: profile.profile?.timezone ?? 'UTC',
						profile: { ...(profile.profile ?? {}), timezone: profile.profile?.timezone ?? 'UTC', defaultEnvironmentId: env.envId }
					}) });
				} catch { /* client pref already set; server pref is best-effort */ }
			};

			const remove = document.createElement('button');
			remove.type = 'button';
			remove.className = 'btn btn-ghost btn-sm';
			remove.textContent = 'Remove';
			remove.onclick = async () => {
				try {
					await api(`/environments/${encodeURIComponent(env.envId)}`, { method: 'DELETE' });
					if (state.defaultEnvId === env.envId) {
						state.defaultEnvId = state.environments.find((e) => e.envId !== env.envId)?.envId ?? '';
						localStorage.setItem('qase.environmentId', state.defaultEnvId);
					}
					toast('Environment removed.');
					await refreshEnvironments();
					paintChip();
					renderSaved();
				} catch (error) { fail(error); }
			};

			actions.append(run, ' ', makeDefault, ' ', remove);
			li.append(actions);
			savedList.append(li);
		}
	}

	// ── Advanced disclosure ─────────────────────────────────────────────────
	function renderAdvanced() {
		if (!advancedBody) return;
		advancedBody.hidden = advancedToggle?.getAttribute('aria-expanded') !== 'true';
		if (advancedBody.hidden || advancedBody.dataset.filled) return;
		advancedBody.dataset.filled = '1';
		const note = document.createElement('p');
		note.className = 'dd-advanced-note';
		note.textContent = 'Technical details (screen size, resolution, execution provider) are managed in the full Device Matrix.';
		const open = document.createElement('button');
		open.type = 'button';
		open.className = 'btn btn-ghost btn-sm';
		open.textContent = 'Open full Device Matrix';
		open.onclick = () => { drawer.close(); document.getElementById('nav-device-matrix')?.click(); };
		advancedBody.append(note, open);
	}

	// ── Wiring ──────────────────────────────────────────────────────────────
	function openDrawer() {
		if (!drawer.open) drawer.showModal();
		void (async () => {
			await Promise.all([loadCatalog(), refreshEnvironments()]);
			renderSections();
			renderSaved();
			paintChip();
		})();
	}

	function closeDrawer() { if (drawer.open) drawer.close(); }

	function wire() {
		// DX Phase 2: the ONE picker is the single selection surface. The chip's
		// [Change] opens it; the drawer stays reachable via Device Management.
		if (chipChange) chipChange.addEventListener('click', () => { if (onOpenPicker) onOpenPicker(); else openDrawer(); });
		// Phase D5: "Device details" opens the same drawer scrolled to details.
		document.getElementById('device-chip-details')?.addEventListener('click', openDrawer);
		closeBtn?.addEventListener('click', closeDrawer);
		search?.addEventListener('input', () => {
			clearTimeout(search._timer);
			search._timer = setTimeout(() => { state.search = search.value; renderSections(); }, 200);
		});
		for (const tab of tabs ?? []) {
			tab.addEventListener('click', () => {
				for (const other of tabs) {
					other.classList.toggle('is-active', other === tab);
					other.setAttribute('aria-selected', other === tab ? 'true' : 'false');
				}
				state.tab = tab.dataset.ddTab ?? 'all';
				renderSections();
			});
		}
		applyBtn?.addEventListener('click', () => void applySelection());
		clearSelection?.addEventListener('click', () => { state.selection.clear(); paintSelection(); });
		savedRefresh?.addEventListener('click', () => void refreshEnvironments().then(renderSaved));
		advancedToggle?.addEventListener('click', () => {
			const expanded = advancedToggle.getAttribute('aria-expanded') === 'true';
			advancedToggle.setAttribute('aria-expanded', String(!expanded));
			renderAdvanced();
		});
	}
	wire();

	return { open: openDrawer, close: closeDrawer, paintChip, refreshEnvironments, state };
}

function labelled(text, control) {
	const label = document.createElement('label');
	label.className = 'field dd-field';
	const span = document.createElement('span');
	span.textContent = text;
	label.append(span, control);
	return label;
}
