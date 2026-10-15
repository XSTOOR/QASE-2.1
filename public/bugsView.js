/**
 * Bug tracker view — the cross-run backlog.
 *
 * The controller (app.js) supplies state access, API helpers, and navigation.
 * This module owns only DOM construction and filter state, so it can never
 * mutate run state or the SSE stream. Status changes are optimistic: the row
 * updates immediately and rolls back with a toast if the server rejects it.
 */

export const BUG_STATUS_LABELS = Object.freeze({
	open: 'Open',
	in_progress: 'In progress',
	fixed: 'Fixed',
	wont_fix: "Won't fix"
});

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];
const REFRESH_COALESCE_MS = 4_000;

export function createBugsView({
	documentRef = globalThis.document,
	elements,
	api,
	toast,
	fail,
	openRun,
	humanizeRunTitle
}) {
	const doc = documentRef;
	const filters = { status: '', severity: '', runId: '', search: '' };
	let rows = [];
	let refreshTimer;
	let searchDebounce;

	function filterParams() {
		const params = new URLSearchParams();
		if (filters.status) params.set('status', filters.status);
		if (filters.severity) params.set('severity', filters.severity);
		if (filters.runId) params.set('run', filters.runId);
		if (filters.search) params.set('q', filters.search);
		return params;
	}

	async function load() {
		const query = filterParams().toString();
		const payload = await api(`/findings${query ? `?${query}` : ''}`);
		rows = payload.findings ?? [];
		render();
	}

	function scheduleRefresh() {
		if (refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = undefined;
			load().catch(() => undefined);
		}, REFRESH_COALESCE_MS);
	}

	function statusCounts() {
		const counts = { open: 0, in_progress: 0, fixed: 0, wont_fix: 0 };
		for (const row of rows) {
			if (counts[row.status] !== undefined) counts[row.status] += 1;
		}
		return counts;
	}

	function severityChip(severity) {
		const chip = doc.createElement('span');
		chip.className = 'sev';
		chip.textContent = severity;
		return chip;
	}

	function statusCell(row) {
		const cell = doc.createElement('td');
		cell.className = 'bugs-col-status';
		const select = doc.createElement('select');
		select.className = 'bugs-status-select';
		select.dataset.status = row.status;
		select.setAttribute('aria-label', `Status of “${row.title}”`);
		for (const [value, label] of Object.entries(BUG_STATUS_LABELS)) {
			const option = doc.createElement('option');
			option.value = value;
			option.textContent = label;
			option.selected = row.status === value;
			select.append(option);
		}
		select.onchange = () => setStatus(row, select.value, select);
		cell.append(select);
		return cell;
	}

	async function setStatus(row, status, select) {
		const previous = row.status;
		row.status = status;
		select.dataset.status = status;
		try {
			const payload = await api(`/sessions/${row.runId}/findings/${row.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ status })
			});
			row.statusTs = payload.finding?.statusTs ?? Date.now();
			row.statusNote = payload.finding?.statusNote ?? row.statusNote;
			toast(`Marked “${row.title}” as ${BUG_STATUS_LABELS[status]?.toLowerCase() ?? status}.`);
			// Keep the summary strip counts in step with the visible row.
			renderSummary();
		} catch (error) {
			row.status = previous;
			select.value = previous;
			select.dataset.status = previous;
			fail(error);
		}
	}

	function titleCell(row) {
		const cell = doc.createElement('td');
		cell.className = 'bugs-col-title';
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'bugs-title';
		button.setAttribute('aria-expanded', 'false');
		button.textContent = row.title;
		button.onclick = () => toggleDetail(row, button);
		const category = doc.createElement('span');
		category.className = 'bugs-category';
		category.textContent = row.category;
		cell.append(button, category);
		return cell;
	}

	function toggleDetail(row, button) {
		const open = button.getAttribute('aria-expanded') === 'true';
		button.setAttribute('aria-expanded', String(!open));
		const detailId = `bugs-detail-${row.id}`;
		let detail = doc.getElementById(detailId);
		if (open && detail) {
			detail.remove();
			return;
		}
		detail = buildDetail(row, detailId);
		button.closest('tr').after(detail);
	}

	function buildDetail(row, detailId) {
		const tr = doc.createElement('tr');
		tr.className = 'bugs-detail-row';
		tr.id = detailId;
		const cell = doc.createElement('td');
		cell.colSpan = 6;
		const card = doc.createElement('div');
		card.className = 'bugs-detail';
		card.dataset.sev = row.severity;

		const head = doc.createElement('header');
		const title = doc.createElement('h3');
		title.textContent = row.title;
		const meta = doc.createElement('p');
		meta.className = 'bugs-detail-meta';
		const parts = [];
		if (row.runTitle) parts.push(humanizeRunTitle ? humanizeRunTitle(row.runTitle) : row.runTitle);
		if (row.url) parts.push(row.url);
		if (row.statusNote) parts.push(`note: ${row.statusNote}`);
		meta.textContent = parts.join(' · ');
		head.append(title, meta);

		const grid = doc.createElement('dl');
		grid.className = 'bugs-detail-grid';
		for (const [label, value] of [
			['Expected', row.expected],
			['Actual', row.actual],
			['Category', row.category],
			['Evidence', row.evidence]
		]) {
			if (value === undefined || value === null || value === '') continue;
			const term = doc.createElement('dt');
			term.textContent = label;
			const desc = doc.createElement('dd');
			desc.textContent = String(value);
			grid.append(term, desc);
		}
		if (Array.isArray(row.steps) && row.steps.length) {
			const term = doc.createElement('dt');
			term.textContent = 'Steps';
			const desc = doc.createElement('dd');
			const list = doc.createElement('ol');
			for (const step of row.steps) {
				const item = doc.createElement('li');
				item.textContent = String(step);
				list.append(item);
			}
			desc.append(list);
			grid.append(term, desc);
		}

		const actions = doc.createElement('footer');
		const openLink = doc.createElement('button');
		openLink.type = 'button';
		openLink.className = 'btn btn-ghost btn-sm';
		openLink.textContent = 'Open in run';
		openLink.onclick = () => openRun(row.runId);
		actions.append(openLink);

		card.append(head, grid, actions);
		cell.append(card);
		tr.append(cell);
		return tr;
	}

	function runCell(row) {
		const cell = doc.createElement('td');
		cell.className = 'bugs-col-run';
		const button = doc.createElement('button');
		button.type = 'button';
		button.className = 'bugs-run-link';
		button.title = row.runTitle ?? row.runId;
		button.textContent = row.runTitle ?? row.runId;
		button.onclick = () => openRun(row.runId);
		cell.append(button);
		return cell;
	}

	function pageCell(row) {
		const cell = doc.createElement('td');
		cell.className = 'bugs-col-page';
		// Only link http(s) URLs; anything else (including javascript:) renders
		// as inert text so an odd agent-supplied URL can never become a link.
		if (typeof row.url === 'string' && /^https?:\/\//i.test(row.url)) {
			const link = doc.createElement('a');
			link.href = row.url;
			link.target = '_blank';
			link.rel = 'noreferrer noopener';
			link.textContent = hostOf(row.url);
			link.title = row.url;
			cell.append(link);
		} else if (row.url) {
			cell.textContent = String(row.url).slice(0, 60);
		}
		return cell;
	}

	function hostOf(url) {
		try {
			return new URL(url).host;
		} catch {
			return url;
		}
	}

	function foundCell(row) {
		const cell = doc.createElement('td');
		cell.className = 'bugs-col-found';
		if (row.ts) {
			const time = doc.createElement('time');
			time.dateTime = new Date(row.ts).toISOString();
			time.textContent = relativeTime(row.ts);
			cell.append(time);
		}
		return cell;
	}

	function relativeTime(ts) {
		const delta = Date.now() - ts;
		const minutes = Math.round(delta / 60_000);
		if (minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `${hours}h ago`;
		const days = Math.round(hours / 24);
		if (days < 30) return `${days}d ago`;
		return new Date(ts).toLocaleDateString();
	}

	function render() {
		renderRunOptions();
		renderSummary();
		const body = elements.tbody;
		body.replaceChildren();
		const empty = rows.length === 0;
		elements.empty.hidden = !empty;
		elements.tableWrap.classList.toggle('is-empty', empty);
		for (const row of rows) {
			const tr = doc.createElement('tr');
			tr.className = 'bugs-row';
			tr.dataset.sev = row.severity;
			const sevCell = doc.createElement('td');
			sevCell.className = 'bugs-col-sev';
			sevCell.append(severityChip(row.severity));
			tr.append(sevCell, statusCell(row), titleCell(row), runCell(row), pageCell(row), foundCell(row));
			body.append(tr);
		}
	}

	function renderRunOptions() {
		const select = elements.runSelect;
		const seen = new Map();
		for (const row of rows) {
			if (!seen.has(row.runId)) seen.set(row.runId, row.runTitle ?? row.runId);
		}
		const current = filters.runId;
		select.replaceChildren();
		const all = doc.createElement('option');
		all.value = '';
		all.textContent = 'All runs';
		select.append(all);
		for (const [runId, title] of seen) {
			const option = doc.createElement('option');
			option.value = runId;
			option.textContent = title;
			option.selected = runId === current;
			select.append(option);
		}
	}

	function renderSummary() {
		const counts = statusCounts();
		const total = rows.length;
		const summary = elements.summary;
		if (total === 0) {
			summary.textContent = '';
			return;
		}
		summary.replaceChildren();
		const count = doc.createElement('span');
		count.className = 'bugs-summary-count';
		count.textContent = `${total} ${total === 1 ? 'bug' : 'bugs'}`;
		summary.append(count);
		for (const [status, label] of Object.entries(BUG_STATUS_LABELS)) {
			const chip = doc.createElement('span');
			chip.className = 'bugs-summary-chip';
			chip.dataset.status = status;
			chip.textContent = `${counts[status]} ${label.toLowerCase()}`;
			summary.append(chip);
		}
	}

	function bind() {
		elements.statusFilter.addEventListener('click', event => {
			const chip = event.target.closest('[data-status]');
			if (!chip || chip.parentElement !== elements.statusFilter) return;
			filters.status = chip.dataset.status;
			for (const sibling of elements.statusFilter.querySelectorAll('[data-status]')) {
				const active = sibling === chip;
				sibling.classList.toggle('is-active', active);
				sibling.setAttribute('aria-pressed', String(active));
			}
			load().catch(fail);
		});

		elements.severityFilter.addEventListener('click', event => {
			const chip = event.target.closest('[data-severity]');
			if (!chip || chip.parentElement !== elements.severityFilter) return;
			filters.severity = chip.dataset.severity;
			for (const sibling of elements.severityFilter.querySelectorAll('[data-severity]')) {
				const active = sibling === chip;
				sibling.classList.toggle('is-active', active);
				sibling.setAttribute('aria-pressed', String(active));
			}
			load().catch(fail);
		});

		elements.runSelect.addEventListener('change', () => {
			filters.runId = elements.runSelect.value;
			load().catch(fail);
		});

		elements.searchInput.addEventListener('input', () => {
			clearTimeout(searchDebounce);
			searchDebounce = setTimeout(() => {
				filters.search = elements.searchInput.value.trim();
				load().catch(fail);
			}, 300);
		});

		elements.refresh.addEventListener('click', () => load().catch(fail));
	}

	return {
		filters,
		load,
		scheduleRefresh,
		render,
		bind
	};
}
