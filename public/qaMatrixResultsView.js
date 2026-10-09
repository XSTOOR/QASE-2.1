/**
 * qaMatrixResultsView — QA matrix run status board (Phase 4 #14942).
 *
 * Renders a matrix-run record (GET /api/matrix-runs/:id) as a live status
 * board: totals row (planned/completed/passed/failed/blocked/skipped/
 * cancelled + coverage gaps), facet filters, and per-configuration rows
 * (device · OS · browser · version · execution type · status) with evidence
 * (artifacts / defects) attached to the row that produced it.
 *
 * All presentation derives from the qaMatrixResults model — this module owns
 * DOM + polling only. Styling is CSS-class based (qmr-*) so theme flips are
 * handled by styles.css.
 */

import {
	toResultRow, computeTotals, groupResults, filterResults, facetValues,
	STATUS_LABELS, RESULT_STATUSES
} from './qaMatrixResults.js';

const ROW_PAGE_SIZE = 50;

export function createQaMatrixResultsView({ container, api, selectSession, toast, onRunFinished }) {
	if (!container) return null;

	const state = {
		runId: null,
		run: null,
		rows: [],
		renderedRows: 0,
		filters: { status: '', browser: '', executionType: '', search: '' },
		pollTimer: null,
		pollMs: 2500,
		status: 'loading' // loading | ready | error | empty
	};

	function el(tag, className, text) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	// ---- header + layout (built once, updated in place) -----------------
	const root = el('section', 'qmr');
	const head = el('div', 'qmr-head');
	const title = el('h3', 'qmr-title', 'QA run');
	const subtitle = el('p', 'qmr-subtitle', '');
	const cancelBtn = el('button', 'btn btn-danger btn-sm qmr-cancel');
	cancelBtn.type = 'button';
	cancelBtn.textContent = 'Cancel run';
	cancelBtn.hidden = true;
	head.append(title, subtitle, cancelBtn);

	const totalsEl = el('div', 'qmr-totals');
	const gapsEl = el('div', 'qmr-gaps');
	gapsEl.hidden = true;

	const filtersEl = el('div', 'qmr-filters');
	const search = el('input', 'qmr-search');
	search.type = 'search';
	search.setAttribute('aria-label', 'Search configurations in results');
	search.placeholder = 'Search device, OS, browser…';
	const statusSel = facetSelect('All statuses', 'qmr-filter-status');
	const browserSel = facetSelect('All browsers', 'qmr-filter-browser');
	const execSel = facetSelect('All execution types', 'qmr-filter-exec');
	filtersEl.append(search, statusSel, browserSel, execSel);

	const board = el('div', 'qmr-board');
	board.setAttribute('role', 'list');
	board.setAttribute('aria-label', 'QA run configurations');
	const moreBtn = el('button', 'btn btn-ghost btn-sm qmr-more');
	moreBtn.type = 'button';
	moreBtn.textContent = 'Show more configurations';
	moreBtn.hidden = true;

	const stateEl = el('p', 'qmr-state', '');
	const retryEl = el('button', 'btn btn-ghost btn-sm qmr-retry-load');
	retryEl.type = 'button';
	retryEl.textContent = 'Retry';
	retryEl.hidden = true;

	root.append(head, totalsEl, gapsEl, filtersEl, stateEl, retryEl, board, moreBtn);
	container.replaceChildren(root);

	function facetSelect(placeholder, className) {
		const select = el('select', className);
		select.append(new Option(placeholder, ''));
		return select;
	}

	// ---- interactions ----------------------------------------------------
	search.addEventListener('input', () => {
		state.filters.search = search.value;
		state.renderedRows = 0;
		renderBoard();
	});
	for (const [node, key] of [[statusSel, 'status'], [browserSel, 'browser'], [execSel, 'executionType']]) {
		node.addEventListener('change', () => {
			state.filters[key] = node.value;
			state.renderedRows = 0;
			renderBoard();
		});
	}
	moreBtn.addEventListener('click', () => {
		state.renderedRows += ROW_PAGE_SIZE;
		renderBoard();
	});
	retryEl.addEventListener('click', () => {
		if (state.runId) load(state.runId, { keepView: true });
	});
	cancelBtn.addEventListener('click', async () => {
		if (!state.runId) return;
		cancelBtn.disabled = true;
		try {
			await api(`/matrix-runs/${encodeURIComponent(state.runId)}/cancel`, { method: 'POST' });
			toast?.('Run cancellation requested.');
			await load(state.runId, { keepView: true });
		} catch (error) {
			toast?.(`Could not cancel: ${error?.message ?? error}`);
		} finally {
			cancelBtn.disabled = false;
		}
	});

	// ---- data ------------------------------------------------------------
	async function load(runId, { keepView = false } = {}) {
		state.runId = runId;
		if (!keepView) {
			state.status = 'loading';
			stateEl.textContent = 'Loading QA run…';
			stateEl.hidden = false;
			board.replaceChildren();
		}
		try {
			const payload = await api(`/matrix-runs/${encodeURIComponent(runId)}`);
			const run = payload?.run ?? payload;
			if (!run || !Array.isArray(run.items)) throw new Error('Run record unavailable.');
			state.run = run;
			state.rows = run.items.map(toResultRow).filter(Boolean);
			state.status = 'ready';
			stateEl.hidden = true;
			renderAll();
			schedulePolling();
		} catch (error) {
			state.status = 'error';
			stateEl.textContent = `Could not load the QA run (${error?.message ?? 'network error'}).`;
			stateEl.hidden = false;
			retryEl.hidden = false;
		}
	}

	function schedulePolling() {
		clearTimeout(state.pollTimer);
		if (!state.run) return;
		const active = ['pending', 'running'].includes(state.run.status)
			|| state.rows.some((row) => ['PENDING', 'QUEUED', 'RUNNING'].includes(row.status));
		if (!active) {
			onRunFinished?.(state.run);
			return;
		}
		state.pollTimer = setTimeout(() => {
			void load(state.runId, { keepView: true });
		}, state.pollMs);
	}

	function stop() {
		clearTimeout(state.pollTimer);
	}

	// ---- rendering --------------------------------------------------------
	function renderAll() {
		const run = state.run;
		title.textContent = run.title ?? 'QA run';
		const target = run.targetUrl ? ` · ${run.targetUrl}` : '';
		subtitle.textContent = `${run.itemCount ?? state.rows.length} configurations · Runs one browser at a time${target}`;
		cancelBtn.hidden = !['pending', 'running'].includes(run.status);

		renderTotals();
		renderFilters();
		renderBoard();
	}

	function renderTotals() {
		const totals = computeTotals(state.run.items ?? []);
		totalsEl.replaceChildren();
		const entries = [
			['Planned', totals.planned, ''],
			['Completed', totals.completed, 'qmr-t-done'],
			['Passed', totals.passed, 'qmr-t-pass'],
			['Failed', totals.failed, 'qmr-t-fail'],
			['Blocked', totals.blocked, 'qmr-t-block'],
			['Skipped', totals.skipped, 'qmr-t-skip'],
			['Cancelled', totals.cancelled, 'qmr-t-cancel']
		];
		if (totals.running || totals.queued || totals.pending) {
			entries.push(['In flight', totals.running + totals.queued + totals.pending, 'qmr-t-live']);
		}
		for (const [label, value, cls] of entries) {
			const chip = el('span', `qmr-chip ${cls}`);
			chip.append(el('span', 'qmr-chip-label', label), el('span', 'qmr-chip-value', String(value)));
			totalsEl.append(chip);
		}
		// Coverage gaps: configurations that never reached a terminal state.
		if (totals.coverageGaps.length) {
			gapsEl.hidden = false;
			gapsEl.replaceChildren(
				el('p', 'qmr-gaps-title', `Coverage gaps — ${totals.coverageGaps.length} configuration(s) without a final result:`)
			);
			const list = el('ul', 'qmr-gaps-list');
			for (const gap of totals.coverageGaps.slice(0, 12)) {
				const label = [gap.device, gap.requestedBrowser, gap.browserVersion].filter(Boolean).join(' · ');
				const reason = gap.reason ? ` — ${gap.reason}` : '';
				list.append(el('li', 'qmr-gap', `${label}: ${gap.statusLabel}${reason}`));
			}
			if (totals.coverageGaps.length > 12) {
				list.append(el('li', 'qmr-gap qmr-gap-more', `… and ${totals.coverageGaps.length - 12} more`));
			}
			gapsEl.append(list);
		} else {
			gapsEl.hidden = true;
		}
	}

	function renderFilters() {
		const facets = facetValues(state.rows);
		syncOptions(statusSel, facets.statuses, 'All statuses');
		syncOptions(browserSel, facets.browsers, 'All browsers');
		syncOptions(execSel, facets.executionTypes, 'All execution types');
	}

	function syncOptions(select, values, placeholder) {
		const current = state.filters[select === statusSel ? 'status' : select === browserSel ? 'browser' : 'executionType'];
		select.replaceChildren(new Option(placeholder, ''));
		for (const value of values) {
			select.append(new Option(STATUS_LABELS[value] ?? value, value));
		}
		select.value = current;
		if (select.value !== current) {
			state.filters[select === statusSel ? 'status' : select === browserSel ? 'browser' : 'executionType'] = '';
		}
	}

	function renderBoard() {
		board.replaceChildren();
		const filtered = filterResults(state.rows, state.filters);
		const visible = filtered.slice(0, state.renderedRows || ROW_PAGE_SIZE);
		state.renderedRows = Math.max(state.renderedRows, visible.length);
		moreBtn.hidden = filtered.length <= visible.length;

		if (!filtered.length) {
			board.append(el('p', 'qmr-empty', 'No configurations match the current filters.'));
			return;
		}
		for (const group of groupResults(visible)) {
			const section = el('div', 'qmr-group');
			const groupHead = el('h4', 'qmr-group-title', platformLabel(group.platform));
			section.append(groupHead);
			for (const device of group.devices) {
				const deviceHead = el('h5', 'qmr-device-title', device.device);
				section.append(deviceHead);
				for (const row of device.rows) {
					section.append(renderRow(row));
				}
			}
			board.append(section);
		}
	}

	function renderRow(row) {
		const node = el('div', `qmr-row qmr-s-${String(row.status).toLowerCase()}`);
		node.setAttribute('role', 'listitem');
		const identity = el('span', 'qmr-ident', [
			row.requestedBrowser, row.requestedBrowserVersion
		].filter(Boolean).join(' '));
		const osInfo = el('span', 'qmr-os', [row.os, row.osVersion].filter(Boolean).join(' '));
		const exec = el('span', 'qmr-exec', row.executionType ?? '—');
		const status = el('span', `qmr-status qmr-st-${String(row.status).toLowerCase()}`, row.statusLabel);
		node.append(identity, osInfo, exec, status);

		// Actual runner identity — never the requested one.
		const facts = [];
		if (row.engine) facts.push(`engine: ${row.engine}`);
		if (row.actualBrowser && row.actualBrowser !== row.requestedBrowser) facts.push(`browser: ${row.actualBrowser}`);
		if (row.actualBrowserVersion && row.actualBrowserVersion !== row.requestedBrowserVersion) facts.push(`version: ${row.actualBrowserVersion}`);
		if (facts.length) node.append(el('span', 'qmr-facts', facts.join(' · ')));

		const meta = [];
		if (row.reason) meta.push(row.reason);
		if (row.error) meta.push(row.error);
		if (row.durationMs != null) meta.push(`${Math.round(row.durationMs / 100) / 10}s`);
		if (row.retryCount) meta.push(`retried ×${row.retryCount}`);
		if (meta.length) node.append(el('span', 'qmr-meta', meta.join(' · ')));

		// Evidence stays on the row that produced it.
		const evidence = el('span', 'qmr-evidence');
		if (row.artifacts.length) evidence.append(el('span', 'qmr-ev', `📎 ${row.artifacts.length}`));
		if (row.defects.length) evidence.append(el('span', 'qmr-ev', `🐞 ${row.defects.length}`));
		if (evidence.children.length) node.append(evidence);

		// Drill-in to the session that produced this result.
		if (row.sessionId && selectSession) {
			const open = el('button', 'btn btn-ghost btn-sm qmr-open');
			open.type = 'button';
			open.textContent = 'Open';
			open.setAttribute('aria-label', `Open session for ${row.device} ${row.requestedBrowser}`);
			open.addEventListener('click', () => {
				void selectSession(row.sessionId);
			});
			node.append(open);
		}
		// Bounded per-item retry for failed/errored/blocked/cancelled rows.
		if (['FAILED', 'ERROR', 'BLOCKED', 'CANCELLED'].includes(row.status) && row.retryCount < 2) {
			const retry = el('button', 'btn btn-ghost btn-sm qmr-retry');
			retry.type = 'button';
			retry.textContent = 'Retry';
			retry.setAttribute('aria-label', `Retry ${row.device} ${row.requestedBrowser}`);
			retry.addEventListener('click', async () => {
				retry.disabled = true;
				try {
					await api(`/matrix-runs/${encodeURIComponent(state.runId)}/items/${encodeURIComponent(row.id)}/retry`, { method: 'POST' });
					toast?.('Configuration re-queued.');
					await load(state.runId, { keepView: true });
				} catch (error) {
					toast?.(`Could not retry: ${error?.message ?? error}`);
					retry.disabled = false;
				}
				});
				node.append(retry);
			}

		return node;
	}

	return { load, stop, get runId() { return state.runId; } };
}

function platformLabel(platform) {
	return ({
		ios: 'iPhone', ipados: 'iPad', android: 'Android',
		windows: 'Windows', macos: 'macOS'
	})[platform] ?? (platform ? platform[0].toUpperCase() + platform.slice(1) : 'Unknown');
}
