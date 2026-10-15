/**
 * Bulk Runs wizard (Phase 11): 3 steps — what to run, where, auto-calculated
 * summary with a single [Run N Tests] button. Runs are created sequentially
 * through POST /api/sessions; failures are reported per pair, not fatal.
 */

import { wizardSummary } from './qaWorkflows.js';

export function pairsToRun(cases, environmentSelection) {
	/** environmentSelection: 'all' (each case uses all assigned envs) or a single envId. */
	const pairs = [];
	for (const testCase of cases) {
		const envs = testCase.environmentIds ?? [];
		if (environmentSelection === 'all') {
			for (const envId of envs) pairs.push({ testCase, envId });
		} else if (envs.includes(environmentSelection)) {
			pairs.push({ testCase, envId: environmentSelection });
		}
	}
	return pairs;
}

import { createDeviceChipList } from './devicePicker.js';

export function createBulkRunView({ api, toast, fail, elements, presets, onLaunch }) {
	const {
		dialog, navButton, close,
		what, casesField, caseList, casesCount, casesAll, casesNone,
		where, envsField, deviceChips, addDeviceBtn,
		preview, availabilityEl, launchBtn, result,
		steps
	} = elements;
	if (!dialog) return { open() {}, refresh() {} };

	/** TEST ON DEVICES chip list (DX Phase 4) — replaces the Ctrl/Cmd multi-select. */
	const state = { cases: [], environments: [], environmentsById: new Map(), lastRuns: new Map(), step: 1, chosenCases: new Set(), boardByEnvId: new Map() };
	const deviceList = createDeviceChipList({
		container: deviceChips,
		addBtn: addDeviceBtn,
		environmentsById: (id) => state.environmentsById.get(id),
		onChange: () => renderPreview()
	});

	function showStep(n) {
		state.step = n;
		for (const step of steps ?? []) {
			const num = Number(step.dataset.bulkStep);
			step.hidden = num !== n;
			step.classList.toggle('is-active', num === n);
		}
	}

	function open() {
		dialog.showModal();
		showStep(1);
		void refresh();
	}
	if (navButton) navButton.addEventListener('click', open);
	if (close) close.addEventListener('click', () => dialog.close());

	async function refresh() {
		try {
			const [casePayload, envPayload, sessionPayload] = await Promise.all([
				api('/test-cases'),
				api('/environments?active=true&limit=1000'),
				api('/sessions?limit=100').catch(() => [])
			]);
			state.cases = Array.isArray(casePayload?.testCases) ? casePayload.testCases : [];
			state.environments = Array.isArray(envPayload?.environments) ? envPayload.environments : [];
			state.environmentsById = new Map(state.environments.map((e) => [e.envId, e]));
			const sessions = Array.isArray(sessionPayload) ? sessionPayload : [];
			// Rebuild the case → last-run map from qaWorkflows (imported lazily
			// through the module-level binding set by app.js wiring).
			state.lastRuns = lastRunIndex(sessions);
			renderCases();
			deviceList.set(deviceList.ids); // re-resolve chip labels against fresh envs
			renderPreview();
		} catch (error) {
			fail(error);
		}
	}

	/** Injected by app.js: reuses the qaWorkflows.lastRunByCase helper. */
	let lastRunIndex = (sessions) => new Map();
	function setLastRunIndex(fn) { lastRunIndex = fn; }

	function casesForWhat() {
		const mode = what?.value ?? 'all';
		if (mode === 'selected') {
			return state.cases.filter((c) => state.chosenCases.has(c.caseNumber));
		}
		return wizardFilter(mode);
	}

	/** Injected: qaWorkflows.filterCasesForWizard with the current last-run map. */
	let wizardFilter = () => state.cases;
	function setWizardFilter(fn) { wizardFilter = fn; }

	function resolvedPairs() {
		const cases = casesForWhat();
		const mode = where?.value ?? 'assigned';
		if (mode === 'assigned') return pairsToRun(cases, 'all');
		if (mode === 'default') {
			const envId = state.defaultEnvId ?? '';
			return envId ? cases.flatMap((testCase) => (testCase.environmentIds ?? []).includes(envId) ? [{ testCase, envId }] : []) : [];
		}
		const chosen = deviceList.ids;
		return cases.flatMap((testCase) => chosen.filter((id) => (testCase.environmentIds ?? []).includes(id)).map((envId) => ({ testCase, envId })));
	}

	/** Phase D6 (#13782): checkbox case list — Select all / Clear all / live
	 * counter; replaces the Ctrl/Cmd-click multi-select. */
	function renderCases() {
		if (!caseList) return;
		caseList.textContent = '';
		for (const testCase of state.cases) {
			const label = document.createElement('label');
			label.className = 'check bulk-case';
			const box = document.createElement('input');
			box.type = 'checkbox';
			box.value = testCase.caseNumber;
			box.checked = state.chosenCases.has(testCase.caseNumber);
			box.addEventListener('change', () => {
				if (box.checked) state.chosenCases.add(testCase.caseNumber);
				else state.chosenCases.delete(testCase.caseNumber);
				renderCasesCount();
				renderPreview();
			});
			const text = document.createElement('span');
			text.textContent = `${testCase.caseNumber} — ${testCase.title ?? ''} (${(testCase.environmentIds ?? []).length} envs)`;
			label.append(box, text);
			caseList.append(label);
		}
		renderCasesCount();
	}

	function renderCasesCount() {
		if (casesCount) {
			casesCount.textContent = state.chosenCases.size
				? `Selected: ${state.chosenCases.size} case${state.chosenCases.size === 1 ? '' : 's'}`
				: 'No cases selected';
		}
	}

	if (casesAll) casesAll.addEventListener('click', () => {
		for (const c of state.cases) state.chosenCases.add(c.caseNumber);
		renderCases();
		renderPreview();
	});
	if (casesNone) casesNone.addEventListener('click', () => {
		state.chosenCases.clear();
		renderCases();
		renderPreview();
	});

	// DX Phase 4: renderEnvs() replaced by the TEST ON DEVICES chip list.
	function renderPreview() {
		if (!preview) return;
		const pairs = resolvedPairs();
		const tests = new Set(pairs.map((p) => p.testCase.caseNumber)).size;
		const devices = new Set(pairs.map((p) => p.envId)).size;
		preview.innerHTML = '';
		if (!pairs.length) {
			preview.textContent = what?.value === 'failed'
				? 'No failed runs — nothing to re-run.'
				: 'Nothing to run yet — choose tests and devices.';
			renderAvailability(pairs); // clears any stale rows from a previous visit
			launchBtn.disabled = true;
			launchBtn.textContent = 'Run tests';
			return;
		}
		const summary = wizardSummary(tests, devices);
		const line = document.createElement('div');
		line.textContent = `Tests: ${summary.tests} · Devices: ${summary.devices} · Total executions: ${summary.total}`;
		preview.append(line);
		if (summary.warn) {
			const warn = document.createElement('div');
			warn.className = 'bulk-warn';
			warn.textContent = summary.warnText;
			preview.append(warn);
		}
		renderAvailability(pairs);
		launchBtn.disabled = false;
		launchBtn.textContent = `Run ${summary.total} test${summary.total === 1 ? '' : 's'}`;
	}

	/** Phase D6 (#13782): per-device availability + execution type in the
	 * step-3 summary BEFORE launch — the user sees what each device can
	 * honestly run (from the runtime board) before committing. */
	function renderAvailability(pairs) {
		if (!availabilityEl) return;
		availabilityEl.textContent = '';
		const byDevice = new Map();
		for (const { envId } of pairs) {
			if (!byDevice.has(envId)) byDevice.set(envId, { envId, count: 0 });
			byDevice.get(envId).count += 1;
		}
		const rows = [...byDevice.values()].map(({ envId, count }) => {
			const env = state.environmentsById.get(envId);
			const board = state.boardByEnvId.get(envId) ?? null;
			const status = board?.status ?? 'UNKNOWN';
			const level = board?.maximumLevel ?? env?.runtimeAttestedLevel ?? null;
			const label = env ? `${env.device ?? envId} · ${[env.os, env.osVersion].filter(Boolean).join(' ')} · ${env.browser ?? ''} ${env.browserVersion ?? ''}`.trim() : envId;
			const availText = status === 'AVAILABLE' ? 'Available' : status === 'BUSY' ? 'Busy — will queue' : status === 'UNKNOWN' ? 'Status unknown' : status;
			return { envId, count, label, availText, status, level };
		});
		for (const row of rows) {
			const el = document.createElement('div');
			el.className = 'bulk-avail-row';
			const dot = document.createElement('span');
			// Dot class from the raw board status, not the display text —
			// "Status unknown" must map to is-unknown (review WARN fix).
			dot.className = `bulk-avail-dot is-${String(row.status).toLowerCase()}`;
			const text = document.createElement('span');
			text.textContent = `${row.label} — ${row.availText}${row.level ? ` · ${row.level.replace(/_/g, ' ').toLowerCase()}` : ''} · ${row.count} run${row.count === 1 ? '' : 's'}`;
			el.append(dot, text);
			availabilityEl.append(el);
		}
	}

	/** Injected by app.js: cached runtime-board fetch (availability data). */
	let boardFetch = null;
	function setRuntimeBoardFetch(fn) { boardFetch = fn; }

	async function refreshBoard() {
		if (!boardFetch) return;
		try {
			const devices = (await boardFetch(true)) ?? [];
			state.boardByEnvId = new Map(devices.map((d) => [d.envId, d]));
		} catch { /* board unavailable — rows show honest 'Status unknown' */ }
		renderPreview();
	}

	// Wiring
	if (what) {
		what.addEventListener('change', () => {
			if (casesField) casesField.hidden = what.value !== 'selected';
			renderPreview();
		});
	}
	if (where) {
		where.addEventListener('change', () => {
			if (envsField) envsField.hidden = where.value !== 'pick';
			renderPreview();
		});
	}
	// Fresh availability every time the summary step is shown (#13782).
	for (const next of dialog.querySelectorAll('[data-bulk-next]')) {
		next.addEventListener('click', () => { showStep(Number(next.dataset.bulkNext)); if (Number(next.dataset.bulkNext) === 3) void refreshBoard(); });
	}
	for (const back of dialog.querySelectorAll('[data-bulk-back]')) {
		back.addEventListener('click', () => showStep(Number(back.dataset.bulkBack)));
	}

	if (launchBtn) launchBtn.addEventListener('click', async () => {
		const pairs = resolvedPairs();
		if (!pairs.length) {
			toast('Nothing selected — pick at least one test case and device.', 'bad');
			return;
		}
		// Delegate to the shared launcher when available: it records the batch
		// for per-environment progress (executions list with honest levels).
		if (typeof onLaunch === 'function') {
			launchBtn.disabled = true;
			launchBtn.textContent = `Launching ${pairs.length} runs…`;
			try {
				const { created, failures } = await onLaunch(pairs, 'Bulk run: ');
				if (result) {
					result.hidden = false;
					result.textContent = failures.length
						? `${created} created, ${failures.length} failed:\n${failures.join('\n')}`
						: `${created} run${created === 1 ? '' : 's'} created.`;
				}
			} finally {
				launchBtn.disabled = false;
				renderPreview();
			}
			return;
		}
		launchBtn.disabled = true;
		launchBtn.textContent = `Launching ${pairs.length} runs…`;
		const failures = [];
		let created = 0;
		for (const { testCase, envId } of pairs) {
			try {
				await api('/sessions', { method: 'POST', body: JSON.stringify({ testCaseId: testCase.caseNumber, environmentId: envId }) });
				created += 1;
			} catch (error) {
				failures.push(`${testCase.caseNumber} @ ${envId}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		launchBtn.disabled = false;
		renderPreview();
		if (result) {
			result.hidden = false;
			result.textContent = failures.length
				? `${created} created, ${failures.length} failed:\n${failures.join('\n')}`
				: `${created} run${created === 1 ? '' : 's'} created.`;
		}
		toast(failures.length ? `${created} launched, ${failures.length} failed.` : `${created} run${created === 1 ? '' : 's'} launched.`);
	});

	/** Presets hand-off: preset → environments → jump to step 3 pre-resolved. */
	function applyPreset(presetId) {
		const envs = presets?.environmentsFor?.(presetId) ?? [];
		if (!envs.length) {
			toast('No environments match this preset yet — create some in Choose devices.', 'bad');
			return false;
		}
		if (where) {
			where.value = 'pick';
			if (envsField) envsField.hidden = false;
		}
		deviceList.set(envs.map((e) => e.envId));
		if (what) what.value = 'all';
		if (casesField) casesField.hidden = true;
		renderPreview();
		showStep(3);
		return true;
	}

	// Public surface used by app.js quick actions.
	return {
		open, refresh,
		runPreset: applyPreset,
		setWizardFilter, setLastRunIndex,
		setRuntimeBoardFetch,
		setDefaultEnvId(envId) { state.defaultEnvId = envId; },
		get state() { return state; },
		get deviceList() { return deviceList; }
	};
}

