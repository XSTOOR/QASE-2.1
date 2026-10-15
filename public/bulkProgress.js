/**
 * Bulk-run batch tracking (Phase 12). One session = one environment, so a bulk
 * run is N sequential sessions; there is no server-side batch entity. This
 * module keeps the registry client-side (localStorage, survives reload) and
 * aggregates session snapshots into Completed/Running/Passed/Failed/Pending.
 *
 * Pure functions are exported for unit tests; createBatchTracker wires DOM.
 */

const REGISTRY_KEY = 'qase.bulkBatches';

/** Persisted registry read (defensive against JSON corruption). */
export function loadBatches(store = localStorage) {
	try {
		const raw = store.getItem(REGISTRY_KEY);
		const parsed = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

export function saveBatches(batches, store = localStorage) {
	try {
		store.setItem(REGISTRY_KEY, JSON.stringify(batches.slice(-5)));
	} catch { /* storage unavailable — progress just won't survive reload */ }
}

/** Record a launched batch. Batch of 1 is still recorded (rendered simply). */
export function recordBatch({ label, sessionIds, testCaseTitles = {} }, store = localStorage) {
	const batches = loadBatches(store);
	const batch = {
		id: `batch-${Date.now()}`,
		label: label ?? 'Bulk run',
		sessionIds: [...sessionIds],
		testCaseTitles: { ...testCaseTitles },
		createdAt: new Date().toISOString()
	};
	batches.push(batch);
	saveBatches(batches, store);
	return batch;
}

/**
 * Aggregate session snapshots into the five display states.
 *  - Completed: finished (any verdict) → split into Passed/Failed below
 *  - Passed/Failed: from report verdict or findings heuristic; sessions with
 *    no verdict are never fabricated as Passed.
 *  - Running: queued/running/awaiting_input/starting
 *  - Pending: not yet created or unknown status.
 * Accepts a map sessionId → session-like {status, findings?, report?}.
 */
export function aggregateBatch(batch, sessionsById) {
	let passed = 0, failed = 0, running = 0, pending = 0;
	for (const id of batch.sessionIds) {
		const session = sessionsById.get(id);
		if (!session) { pending += 1; continue; }
		const status = String(session.status ?? '').toLowerCase();
		if (['running', 'queued', 'starting', 'awaiting_input', 'resuming'].includes(status)) { running += 1; continue; }
			if (status === 'done') {
				const verdict = session.report?.verdict ?? session.verdict;
				if (verdict === 'pass') { passed += 1; continue; }
				if (verdict === 'fail') { failed += 1; continue; }
				// No verdict: findings heuristic — never fabricate a pass.
				// Accept findingCount from list payloads (no findings array).
				const hasFindings = Array.isArray(session.findings)
					? session.findings.length > 0
					: Number(session.findingCount ?? 0) > 0;
				if (hasFindings) failed += 1;
				else passed += 1;
				continue;
			}
		if (status === 'failed' || status === 'interrupted') { failed += 1; continue; }
		pending += 1;
	}
	const total = batch.sessionIds.length || 0;
	const completed = passed + failed;
	return {
		total, passed, failed, running, pending, completed,
		percent: total ? Math.round((completed / total) * 100) : 0
	};
}

/** Per-session display rows, newest first, status-sorted for scanning. */
export function batchRows(batch, sessionsById) {
	return batch.sessionIds.map((id) => {
		const session = sessionsById.get(id);
		const agg = aggregateBatch({ sessionIds: [id] }, sessionsById);
		const state = agg.failed ? 'Failed' : agg.passed ? 'Passed' : agg.running ? 'Running' : 'Pending';
		return {
			id,
			title: batch.testCaseTitles?.[id] ?? session?.title ?? id,
			state,
			env: session?.environmentSnapshot?.device ?? session?.environmentId ?? '',
			// Per-environment record (Phase 23): the honest execution level this
			// row ran at, from the run's recorded facts — never the requested one.
			executionLevel: session?.executionLevel ?? null
		};
	});
}

/**
 * Pick the batch run the live preview should follow (Phase 4):
 * the first session still executing (running/starting), else the most
 * recent non-done session. Returns a session id or null.
 * One live preview per batch — the ACTIVE run owns it, never a blend.
 */
export function activeBatchRunId(batch, sessionsById) {
	if (!batch?.sessionIds?.length) return null;
	const sessions = batch.sessionIds.map((id) => sessionsById.get(id)).filter(Boolean);
	if (sessions.length === 0) return null;
	const activeStates = new Set(['running', 'starting', 'awaiting_input']);
	const executing = sessions.find((s) => activeStates.has(String(s.status ?? '').toLowerCase()));
	if (executing) return executing.id;
	const open = sessions.filter((s) => {
		const status = String(s.status ?? '').toLowerCase();
		return !['done', 'error', 'interrupted', 'cancelled'].includes(status);
	});
	if (open.length > 0) return open[open.length - 1].id;
	return sessions[sessions.length - 1].id;
}

export function createBatchTracker({ api, elements, onTick }) {
	const { block, label, pct, bar, counts, list } = elements;
	let current = null;
	let timer = null;

	function paint(batch, sessionsById) {
		if (!block) return;
		if (!batch || batch.sessionIds.length === 0) { block.hidden = true; return; }
		// Degenerate batch of 1: render as a simple run, not a progress table.
		if (batch.sessionIds.length === 1) { block.hidden = true; return; }
		const agg = aggregateBatch(batch, sessionsById);
		block.hidden = false;
		if (label) label.textContent = batch.label;
		if (pct) pct.textContent = `${agg.percent}% · ${agg.completed}/${agg.total}`;
		if (bar) {
			bar.setAttribute('aria-valuenow', String(agg.percent));
			bar.querySelector('i')?.style.setProperty('width', `${agg.percent}%`);
		}
		if (counts) {
			counts.textContent = `Completed ${agg.completed} · Running ${agg.running} · Passed ${agg.passed} · Failed ${agg.failed} · Pending ${agg.pending}`;
		}
		if (list && !list.closest('details')?.open === false) {
			// list renders lazily when expanded; keep cheap here
		}
		if (list && list.closest('details')?.open) {
			list.innerHTML = '';
			const activeId = activeBatchRunId(batch, sessionsById);
			for (const row of batchRows(batch, sessionsById)) {
				const li = document.createElement('li');
				li.className = `bp-row bp-row-${row.state.toLowerCase()}` + (row.id === activeId ? ' bp-row-active' : '');
				const title = document.createElement('span');
				title.textContent = (row.id === activeId ? '▶ ' : '') + [row.title, row.env].filter(Boolean).join(' — ');
				const level = document.createElement('span');
				level.className = 'bp-exec-level';
				level.textContent = row.executionLevel ?? '';
				const state = document.createElement('span');
				state.textContent = row.state;
				li.append(title, level, state);
				list.append(li);
			}
		}
		if (agg.pending === 0 && agg.running === 0) stopPolling();
	}

	async function poll() {
		if (!current) return;
		try {
			const sessions = await api('/sessions?limit=100');
			const byId = new Map((Array.isArray(sessions) ? sessions : []).map((s) => [s.id, s]));
			paint(current, byId);
			onTick?.(current, byId);
		} catch { /* transient — next tick retries */ }
	}

	function startPolling() {
		stopPolling();
		timer = setInterval(poll, 4000);
	}
	function stopPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	/** Register a batch (or restore one after reload) and start tracking. */
	function track(batch) {
		current = batch;
		if (batch.sessionIds.length > 1) startPolling();
		void poll();
	}

	return {
		track,
		poll,
		paint,
		get current() { return current; },
		stop: stopPolling
	};
}
