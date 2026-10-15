/**
 * Analytics view (UX U5): an in-app dashboard over the run history the user
 * owns. Pure presentation — data comes from existing endpoints:
 *
 *   GET /api/sessions              → per-run rows (status, mode, engine, tokens,
 *                                    findingCount, startedAt/completedAt, feedback)
 *   GET /api/analytics/durations   → duration aggregates + per-target breakdown
 *
 * All DOM text goes through textContent (XSS-safe). Pure helpers are exported
 * for unit tests; the view factory wires a <dialog> the same way
 * testCaseView / deviceMatrixView do.
 */

/** Reducer over run rows → the single dashboard model. Pure. */
export function aggregateRunStats(runs = []) {
	const counts = {
		total: 0,
		byStatus: {},
		byMode: {},
		byEngine: {},
		completed: 0,
		blocked: 0,
		running: 0,
		findings: 0,
		criticalFindings: 0
	};
	for (const run of runs ?? []) {
		if (!run || typeof run !== 'object') continue;
		counts.total += 1;
		const status = String(run.status ?? 'unknown');
		counts.byStatus[status] = (counts.byStatus[status] ?? 0) + 1;
		const mode = run.mode === 'sqa' || run.mode === 'founder' ? run.mode : 'qa';
		counts.byMode[mode] = (counts.byMode[mode] ?? 0) + 1;
		const engine = typeof run.engine === 'string' && run.engine ? run.engine : 'chromium';
		counts.byEngine[engine] = (counts.byEngine[engine] ?? 0) + 1;
		if (status === 'completed') counts.completed += 1;
		if (status === 'blocked' || status === 'error' || status === 'failed') counts.blocked += 1;
		if (status === 'running' || status === 'paused') counts.running += 1;
		counts.findings += Number(run.findingCount ?? 0) || 0;
		counts.criticalFindings += Number(run.criticalCount ?? 0) || 0;
	}
	return counts;
}

/** Thumbs summary: up / down counts from run rows carrying session.feedback. */
export function aggregateThumbs(runs = []) {
	const up = (runs ?? []).filter(run => run?.feedback?.rating === 'up').length;
	const down = (runs ?? []).filter(run => run?.feedback?.rating === 'down').length;
	return { up, down, total: up + down };
}

/** Relative share (0–100) of a numerator within total; 0 when total is 0. */
export function percentOf(numerator, total) {
	if (!Number.isFinite(numerator) || !Number.isFinite(total) || total <= 0) return 0;
	return Math.round((numerator / total) * 100);
}

/** h:mm:ss clock text for a seconds count. */
export function clockText(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return '—';
	const s = Math.floor(seconds % 60);
	const m = Math.floor((seconds / 60) % 60);
	const h = Math.floor(seconds / 3600);
	const two = n => String(n).padStart(2, '0');
	return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * Merge durations aggregate with run rows so the "quick view" shows real
 * avg/median when present and '—' otherwise. Pure.
 */
export function durationSummary(aggregate = undefined, runs = []) {
	const completed = (runs ?? []).filter(run => run.status === 'completed' && Number.isFinite(run.durationSeconds));
	if (aggregate && Number.isFinite(aggregate.avgDurationSeconds)) {
		return {
			runCount: aggregate.runCount ?? completed.length,
			avg: aggregate.avgDurationSeconds,
			median: aggregate.medianDurationSeconds,
			min: aggregate.minDurationSeconds,
			max: aggregate.maxDurationSeconds
		};
	}
	if (completed.length === 0) {
		return { runCount: 0, avg: undefined, median: undefined, min: undefined, max: undefined };
	}
	const sorted = completed.map(run => run.durationSeconds).sort((a, b) => a - b);
	const mean = values => values.length ? values.reduce((s, v) => s + v, 0) / values.length : undefined;
	return {
		runCount: completed.length,
		avg: mean(sorted),
		median: sorted[Math.floor(sorted.length / 2)],
		min: sorted[0],
		max: sorted[sorted.length - 1]
	};
}

/** Per-target rows from the durations aggregate's byTarget array. Pure. */
export function targetRows(byTarget = [], limit = 8) {
	return [...(byTarget ?? [])]
		.filter(entry => entry && typeof entry.targetUrl === 'string')
		.map(entry => ({
			targetUrl: entry.targetUrl,
			runCount: Number(entry.runCount ?? 0),
			avg: entry.avgDurationSeconds
		}))
		.sort((a, b) => b.runCount - a.runCount)
		.slice(0, Math.max(1, limit));
}

function hostOf(url) {
	try { return new URL(url).host; } catch { return url; }
}

function statCard(label, value, accent = '') {
	const card = document.createElement('div');
	card.className = `stat-card${accent ? ` stat-${accent}` : ''}`;
	const b = document.createElement('b');
	b.textContent = value;
	const span = document.createElement('span');
	span.textContent = label;
	card.append(b, span);
	return card;
}

function barRow(label, count, total, tone = 'accent') {
	const row = document.createElement('div');
	row.className = 'analytics-bar-row';
	const name = document.createElement('span');
	name.className = 'analytics-bar-label';
	name.textContent = label;
	const track = document.createElement('div');
	track.className = 'analytics-bar-track';
	const fill = document.createElement('div');
	fill.className = `analytics-bar-fill is-${tone}`;
	fill.style.width = `${percentOf(count, total)}%`;
	track.append(fill);
	const value = document.createElement('span');
	value.className = 'analytics-bar-value';
	value.textContent = String(count);
	row.append(name, track, value);
	return row;
}

function sectionEl(title) {
	const section = document.createElement('section');
	section.className = 'analytics-section';
	const h3 = document.createElement('h3');
	h3.textContent = title;
	section.append(h3);
	return section;
}

/**
 * Renders the whole dashboard body from a prepared model:
 *   { runs, durations }  — runs = /api/sessions rows, durations =
 *   /api/analytics/durations payload. No network here (unit-testable).
 */
export function renderAnalyticsBody(container, { runs = [], durations = undefined } = {}) {
	container.replaceChildren();

	const counts = aggregateRunStats(runs);
	const thumbs = aggregateThumbs(runs);
	const durationsSummary = durationSummary(durations, runs);

	if (counts.total === 0) {
		const empty = document.createElement('div');
		empty.className = 'analytics-empty feed-empty';
		const b = document.createElement('b');
		b.textContent = 'No analytics yet';
		const p = document.createElement('p');
		p.textContent = 'Complete a QA run and your usage history will appear here.';
		empty.append(b, p);
		container.append(empty);
		return;
	}

	// Overview stat cards.
	const grid = document.createElement('div');
	grid.className = 'analytics-stats';
	grid.append(
		statCard('total runs', String(counts.total)),
		statCard('completed', String(counts.completed), 'good'),
		statCard('blocked / failed', String(counts.blocked), 'bad'),
		statCard('findings', String(counts.findings), 'warn'),
		statCard('avg duration', clockText(durationsSummary.avg))
	);
	container.append(grid);

	// Thumbs row.
	const thumbsSection = sectionEl('Your feedback');
	const thumbsRow = document.createElement('div');
	thumbsRow.className = 'analytics-thumbs';
	const up = document.createElement('span');
	up.className = 'analytics-thumb is-up';
	up.textContent = `👍 ${thumbs.up} up`;
	const down = document.createElement('span');
	down.className = 'analytics-thumb is-down';
	down.textContent = `👎 ${thumbs.down} down`;
	const share = document.createElement('span');
	share.className = 'analytics-thumb-share';
	share.textContent = thumbs.total === 0
		? 'No run ratings yet'
		: `${percentOf(thumbs.up, thumbs.total)}% positive`;
	thumbsRow.append(up, down, share);
	thumbsSection.append(thumbsRow);
	container.append(thumbsSection);

	// Mix by mode / engine as horizontal bars.
	const mixSection = sectionEl('Run mix');
	for (const [label, countsByKey, tone] of [
		['mode', counts.byMode, 'accent'],
		['engine', counts.byEngine, 'alt']
	]) {
		const group = document.createElement('div');
		group.className = 'analytics-mix';
		const caption = document.createElement('span');
		caption.className = 'analytics-mix-label';
		caption.textContent = `by ${label}`;
		group.append(caption);
		const entries = Object.entries(countsByKey).sort((a, b) => b[1] - a[1]);
		for (const [key, count] of entries) {
			group.append(barRow(key, count, counts.total, tone));
		}
		mixSection.append(group);
	}
	container.append(mixSection);

	// Per-target table from the durations aggregate (fallback: derive from runs).
	let targets = targetRows(durations?.byTarget);
	if (targets.length === 0) {
		const byUrl = new Map();
		for (const run of runs) {
			if (!run.targetUrl) continue;
			const entry = byUrl.get(run.targetUrl) ?? { targetUrl: run.targetUrl, runCount: 0, avg: 0 };
			entry.runCount += 1;
			entry.avg += Number(run.durationSeconds ?? 0) || 0;
			byUrl.set(run.targetUrl, entry);
		}
		targets = [...byUrl.values()]
			.map(entry => ({ ...entry, avg: entry.runCount ? entry.avg / entry.runCount : 0 }))
			.sort((a, b) => b.runCount - a.runCount)
			.slice(0, 8);
	}
	if (targets.length > 0) {
		const targetSection = sectionEl('Top targets');
		const table = document.createElement('table');
		table.className = 'analytics-table';
		const thead = document.createElement('thead');
		thead.innerHTML = '';
		const headRow = document.createElement('tr');
		for (const label of ['Target', 'Runs', 'Avg duration']) {
			const th = document.createElement('th');
			th.scope = 'col';
			th.textContent = label;
			headRow.append(th);
		}
		thead.append(headRow);
		const tbody = document.createElement('tbody');
		for (const entry of targets) {
			const tr = document.createElement('tr');
			const tdTarget = document.createElement('td');
			tdTarget.textContent = hostOf(entry.targetUrl);
			const tdRuns = document.createElement('td');
			tdRuns.textContent = String(entry.runCount);
			const tdAvg = document.createElement('td');
			tdAvg.textContent = clockText(entry.avg);
			tr.append(tdTarget, tdRuns, tdAvg);
			tbody.append(tr);
		}
		table.append(thead, tbody);
		targetSection.append(table);
		container.append(targetSection);
	}
}

/**
 * Factory matching the other view modules: wires a <dialog>, exposes
 * open()/close(). `load` returns { runs, durations } — injectable for tests.
 */
export function createAnalyticsView({ api, fail, elements, load }) {
	const { dialog, navButton, closeButton, body, refreshButton } = elements;
	const fetchModel = load ?? (async () => {
		const [runs, durations] = await Promise.all([
			api('/sessions').catch(() => []),
			api('/analytics/durations').catch(() => undefined)
		]);
		return { runs, durations };
	});

	async function refresh() {
		if (body) {
			body.setAttribute('aria-busy', 'true');
			const loading = document.createElement('p');
			loading.className = 'analytics-loading';
			loading.textContent = 'Loading…';
			body.replaceChildren(loading);
		}
		try {
			const model = await fetchModel();
			if (body) renderAnalyticsBody(body, model);
		} catch (error) {
			fail?.(error);
			if (body) {
				const errorP = document.createElement('p');
				errorP.className = 'analytics-empty feed-empty';
				errorP.textContent = 'Analytics could not be loaded. Try again.';
				body.replaceChildren(errorP);
			}
		} finally {
			body?.removeAttribute('aria-busy');
		}
	}

	async function open() {
		dialog?.showModal?.();
		await refresh();
	}

	navButton?.addEventListener('click', () => { void open(); });
	closeButton?.addEventListener('click', () => dialog?.close());
	refreshButton?.addEventListener('click', () => { void refresh(); });

	return { open, close: () => dialog?.close(), refresh };
}
