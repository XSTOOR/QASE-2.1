/**
 * Bug reports view (Phase 6): reads the /api/bugs surface into the dashboard
 * "Bugs" tab — filterable list of BUG-XXXX records with severity, status,
 * frozen environment snapshot and the honest execution level.
 */
const STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix', 'reopened'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];

function h(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function flag(...values) {
	return values.filter(Boolean).join(' · ');
}

function envText(snapshot) {
	if (!snapshot) return '';
	const os = snapshot.os
		? `${snapshot.os}${snapshot.osVersion ? ` ${snapshot.osVersion}` : ''}`
		: '';
	const browser = snapshot.browser
		? `${snapshot.browser}${snapshot.browserVersion ? ` ${snapshot.browserVersion}` : ''}` : '';
	return flag(snapshot.device, os, browser);
}

function execText(level) {
	if (!level) return '';
	return `exec: ${String(level).toLowerCase().replace(/_/g, '-')}`;
}

function matches(bug, { search, status, severity }) {
	if (status && bug.status !== status) return false;
	if (severity && bug.severity !== severity) return false;
	if (search) {
		const haystack = [bug.bugNumber, bug.title, bug.category, bug.environmentSnapshot?.device]
			.filter(Boolean).join(' ').toLowerCase();
		if (!haystack.includes(search.toLowerCase())) return false;
	}
	return true;
}

export { matches as bugMatches };

/**
 * Create the Bugs tab view. `api` is app.js's fetch helper (path, options).
 * `openRun(runId)` navigates to a run; `toast(message)` surfaces feedback.
 */
export function createBugView({ api, toast, openRun } = {}) {
	/** @type {Array<any>} */
	let bugs = [];
	const filters = { search: '', status: '', severity: '' };
	const notify = toast ?? (() => {});

	return {
		filters,
		setFilter(patch) {
			Object.assign(filters, patch);
		},
		matchesAll(bug) {
			return matches(bug, filters);
		},
		async refresh() {
			try {
				const payload = await api('/bugs');
				bugs = Array.isArray(payload?.bugs) ? payload.bugs : [];
			} catch {
				bugs = [];
			}
			return bugs.length;
		},
		/**
		 * Paint the list into `bodyNode`; update the tab count into `countNode`.
		 */
		render(bodyNode, countNode) {
			const filtered = bugs.filter((bug) => matches(bug, filters));
			bodyNode.replaceChildren();
			countNode.textContent = bugs.length > 0
				? (filtered.length === bugs.length ? `${bugs.length}` : `${filtered.length}/${bugs.length}`)
				: '';
			countNode.classList.toggle('is-alert', bugs.some((bug) => bug.status === 'open' || bug.status === 'reopened'));
			if (!filtered.length) {
				bodyNode.append(h('div', 'feed-empty', bugs.length
					? 'No bugs match the current filters'
					: 'No bugs filed yet — use Report bug on a run with findings.'));
				return;
			}
			const rows = [...filtered].sort((a, b) =>
				SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
			for (const bug of rows) bodyNode.append(renderBug(bug, { api, notify, openRun }));
		}
	};
}

function renderBug(bug, { api, notify, openRun }) {
	const node = h('article', 'bug');
	node.dataset.sev = bug.severity;

	const head = h('button', 'finding-head bug-head');
	head.type = 'button';
	head.setAttribute('aria-expanded', 'false');
	const id = `bug-body-${bug.bugNumber}`;
	head.setAttribute('aria-controls', id);
	head.append(
		h('span', 'finding-title bug-title', `${bug.bugNumber} · ${bug.title}`),
		h('span', 'sev', bug.severity),
		h('span', 'bug-status', bug.status.replace(/_/g, ' ')),
		h('span', 'finding-chevron', '›')
	);
	const body = h('div', 'finding-body bug-body');
	body.id = id;
	head.onclick = () => {
		const open = node.classList.toggle('is-open');
		head.setAttribute('aria-expanded', String(open));
	};

	body.append(h('div', 'finding-meta bug-meta', flag(
		bug.category,
		envText(bug.environmentSnapshot),
		execText(bug.executionLevel),
		bug.createdAt ? new Date(bug.createdAt).toLocaleString() : null
	)));

	if (bug.expected || bug.actual) {
		const block = h('div', 'bug-block');
		if (bug.expected) block.append(h('p', null, `Expected: ${bug.expected}`));
		if (bug.actual) block.append(h('p', null, `Actual: ${bug.actual}`));
		body.append(block);
	}
	if (bug.description) {
		const desc = h('div', 'bug-block');
		desc.append(h('p', null, bug.description));
		body.append(desc);
	}
	if (Array.isArray(bug.steps) && bug.steps.length) {
		const ol = h('ol', 'bug-steps');
		for (const step of bug.steps) ol.append(h('li', null, step));
		body.append(ol);
	}

	const actions = h('div', 'bug-actions');
	if (bug.linkedRunId) {
		const jump = h('button', 'bug-jump', 'Open linked run');
		jump.type = 'button';
		jump.onclick = () => {
			if (openRun) openRun(bug.linkedRunId);
			else notify('Linked run navigation is not available.');
		};
		actions.append(jump);
	}
	const statusSelect = h('select', 'bug-status-select');
	statusSelect.setAttribute('aria-label', `Status for ${bug.bugNumber}`);
	for (const value of STATUSES) {
		const option = h('option', null, value.replace(/_/g, ' '));
		option.value = value;
		statusSelect.append(option);
	}
	statusSelect.value = bug.status;
	statusSelect.onchange = async () => {
		const next = statusSelect.value;
		try {
			const updated = await api(`/bugs/${encodeURIComponent(bug.bugNumber)}`, {
				method: 'PATCH',
				body: JSON.stringify({ status: next })
			});
			bug.status = updated?.status ?? next;
			node.querySelector('.bug-status').textContent = bug.status.replace(/_/g, ' ');
			notify(`${bug.bugNumber} marked ${bug.status.replace(/_/g, ' ')}.`);
		} catch {
			statusSelect.value = bug.status;
			notify('Could not update the bug — try again.');
		}
	};
	actions.append(statusSelect);
	body.append(actions);

	node.append(head, body);
	return node;
}
