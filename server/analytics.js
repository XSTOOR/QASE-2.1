import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Minimal local analytics: event counters in an atomic JSON file. No PII —
 * only event names, dimensions (mode, status, bucket), and counts.
 *
 * Purpose: validate the Phase-4 hypotheses ("users hit select all",
 * "users don't watch the agent") from real usage.
 */

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_.]*$/;
const DIMENSION_KEYS = new Set(['mode', 'status', 'duration_bucket', 'rating', 'scope_selection', 'source', 'cohort']);
const MAX_DIMENSION_LENGTH = 64;

/** Loads the current counters; a missing or corrupt file restarts from zero. */
function loadFile(filePath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		if (parsed && typeof parsed === 'object' && Array.isArray(parsed.events)) return parsed;
	} catch {
		// Fall through — treat as empty.
	}
	return { schemaVersion: 1, events: [] };
}

function sanitizeDimensions(dimensions) {
	const clean = {};
	for (const [key, value] of Object.entries(dimensions ?? {})) {
		if (!DIMENSION_KEYS.has(key) || value === undefined || value === null) continue;
		const text = String(value).slice(0, MAX_DIMENSION_LENGTH);
		if (text) clean[key] = text;
	}
	return Object.keys(clean).length ? clean : undefined;
}

/** Atomically appends one counted event (count >= 1). */
export function recordEvent(stateDir, name, { dimensions, count = 1 } = {}) {
	if (!EVENT_NAME_PATTERN.test(String(name ?? ''))) {
		throw new TypeError('Analytics event name must be snake_case.');
	}
	if (!Number.isSafeInteger(count) || count < 1) {
		throw new TypeError('Analytics event count must be a positive integer.');
	}
	const file = path.join(stateDir, 'analytics.json');
	const state = loadFile(file);
	const key = JSON.stringify({ name, dimensions: sanitizeDimensions(dimensions) });
	let match = state.events.find(entry => entry.key === key);
	if (!match) {
		match = { key, count: 0 };
		state.events.push(match);
	}
	match.count += count;
	match.updatedAt = Date.now();
	fs.mkdirSync(stateDir, { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		fs.writeFileSync(tmp, JSON.stringify(state, undefined, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		throw error;
	}
	return match.count;
}

/** Aggregated counters, grouped by event name. */
export function summarize(stateDir) {
	const state = loadFile(path.join(stateDir, 'analytics.json'));
	const summary = {};
	let total = 0;
	for (const entry of state.events) {
		let parsed;
		try {
			parsed = JSON.parse(entry.key);
		} catch {
			continue;
		}
		summary[parsed.name] ??= { total: 0, byDimension: [] };
		summary[parsed.name].total += entry.count;
		total += entry.count;
		if (parsed.dimensions) {
			summary[parsed.name].byDimension.push({ ...parsed.dimensions, count: entry.count });
		}
	}
	return { schemaVersion: 1, totalEvents: total, events: summary };
}

/** Maps a run duration in ms to a coarse bucket label. */
export function durationBucket(ms) {
	if (!Number.isFinite(ms) || ms < 0) return 'unknown';
	const minutes = ms / 60_000;
	if (minutes < 1) return 'under_1m';
	if (minutes < 5) return '1m_to_5m';
	if (minutes < 15) return '5m_to_15m';
	if (minutes < 30) return '15m_to_30m';
	return 'over_30m';
}
