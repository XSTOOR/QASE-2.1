import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * User feedback store: one feedback record per run per user.
 *
 * Feedback is captured after a run reaches a terminal status (done/error) and
 * is deliberately kept OUTSIDE the run aggregate — a feedback submission must
 * never touch the run record, its report or its timing. Persistence mirrors
 * the sessions store: in-memory Map with an atomic JSON mirror on disk.
 */

const STATE_DIR = path.join(process.cwd(), '.qase');
const STATE_FILE = path.join(STATE_DIR, 'feedback.json');

export const FEEDBACK_CATEGORIES = Object.freeze([
	'test_accuracy', 'test_coverage', 'execution_speed', 'results',
	'ui_ux', 'automation_quality', 'error_handling', 'ease_of_use',
	'overall', 'other'
]);

export const FEEDBACK_STATUSES = Object.freeze([
	'new', 'reviewed', 'in_progress', 'resolved', 'closed'
]);

export const TERMINAL_RUN_STATUSES = Object.freeze(['done', 'error']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const records = new Map();
let loaded = false;

function persistNow() {
	let tmp;
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		// Atomic write (temp + rename) so a crash can never leave a truncated
		// feedback.json behind.
		tmp = `${STATE_FILE}.tmp-${process.pid}-${randomUUID()}`;
		fs.writeFileSync(tmp, JSON.stringify([...records.values()], undefined, '\t'), { mode: 0o600 });
		fs.renameSync(tmp, STATE_FILE);
	} catch (error) {
		if (tmp) {
			try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
		}
		console.error(`[qase-feedback] failed to persist feedback: ${error?.code ?? error?.message ?? 'unknown'}`);
	}
}

export function loadFeedback() {
	if (loaded) return;
	loaded = true;
	try {
		const raw = fs.readFileSync(STATE_FILE, 'utf8');
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const record of parsed) {
				if (record && UUID_PATTERN.test(String(record.id))) {
					records.set(record.id, record);
				}
			}
		}
	} catch {
		// Missing or corrupt file starts empty; nothing to recover.
	}
}

function safeText(value, maxLength) {
	if (typeof value !== 'string') return undefined;
	const stripped = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
	if (stripped === '') return undefined;
	if (stripped.length > maxLength) return stripped.slice(0, maxLength);
	return stripped;
}

/**
 * Validate and normalize a feedback payload. Throws PublicInputError-shaped
 * field errors (code 'invalid_input') with a `fields` map so routes can return
 * a 400 without echoing user content.
 */
export function normalizeFeedbackInput(input = {}) {
	const fields = {};
	const rating = Number(input.rating);
	if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
		fields.rating = 'Rating must be an integer from 1 to 5.';
	}
	// Category is optional; unrated feedback defaults to "overall".
	const category = input.category === undefined || input.category === '' || input.category === null
		? 'overall'
		: input.category;
	if (!FEEDBACK_CATEGORIES.includes(category)) {
		fields.category = 'Unknown feedback category.';
	}
	// Description is optional per spec: a rating alone is valid feedback.
	const comments = safeText(input.comments, 4000) ?? '';
	const improvement = safeText(input.improvement, 4000);
	if (Object.keys(fields).length > 0) {
		const error = new Error('Feedback validation failed.');
		error.code = 'invalid_input';
		error.fields = fields;
		throw error;
	}
	const normalized = { rating, category, comments };
	if (improvement !== undefined) normalized.improvement = improvement;
	return normalized;
}

/**
 * Create (or return the existing) feedback for a run by a user. The run's
 * context fields (targetUrl, runStatus, durationSeconds) are supplied by the
 * caller — never by the submitting user.
 */
export function createFeedback({ runId, submittedBy, context, ...input }) {
	loadFeedback();
	if (!UUID_PATTERN.test(String(runId))) {
		throw Object.assign(new Error('Unknown test run.'), { code: 'not_found' });
	}
	const existing = findFeedbackForRun(runId, submittedBy);
	if (existing) {
		const error = new Error('Feedback already exists for this test run.');
		error.code = 'duplicate_feedback';
		error.existingId = existing.id;
		throw error;
	}
	const now = Date.now();
	const record = {
		id: randomUUID(),
		runId,
		submittedBy: submittedBy ?? null,
		targetUrl: typeof context?.targetUrl === 'string' ? context.targetUrl : undefined,
		runStatus: typeof context?.runStatus === 'string' ? context.runStatus : undefined,
		durationSeconds: Number.isFinite(context?.durationSeconds) ? context.durationSeconds : undefined,
		...normalizeFeedbackInput(input),
		status: 'new',
		submittedAt: now,
		updatedAt: now
	};
	records.set(record.id, record);
	persistNow();
	return structuredClone(record);
}

export function getFeedback(id) {
	loadFeedback();
	const record = records.get(id);
	return record ? structuredClone(record) : undefined;
}

export function findFeedbackForRun(runId, submittedBy) {
	loadFeedback();
	for (const record of records.values()) {
		if (record.runId === runId && (submittedBy === undefined || record.submittedBy === submittedBy)) {
			return structuredClone(record);
		}
	}
	return undefined;
}

export function listFeedback({ runId, submittedBy, targetUrl, rating, category, status, since, until, q, limit = 100 } = {}) {
	loadFeedback();
	let filtered = [...records.values()];
	if (runId !== undefined) filtered = filtered.filter(record => record.runId === runId);
	if (submittedBy !== undefined) filtered = filtered.filter(record => record.submittedBy === submittedBy);
	if (targetUrl !== undefined && targetUrl !== '') {
		const needle = String(targetUrl).toLowerCase();
		filtered = filtered.filter(record => String(record.targetUrl ?? '').toLowerCase().includes(needle));
	}
	if (rating !== undefined) filtered = filtered.filter(record => record.rating === Number(rating));
	if (category !== undefined && category !== '') filtered = filtered.filter(record => record.category === category);
	if (status !== undefined && status !== '') filtered = filtered.filter(record => record.status === status);
	if (Number.isFinite(Number(since))) {
		filtered = filtered.filter(record => record.submittedAt >= Number(since));
	}
	if (Number.isFinite(Number(until))) {
		filtered = filtered.filter(record => record.submittedAt <= Number(until));
	}
	if (q !== undefined && String(q).trim() !== '') {
		const needle = String(q).toLowerCase();
		filtered = filtered.filter(record =>
			String(record.comments ?? '').toLowerCase().includes(needle)
			|| String(record.improvement ?? '').toLowerCase().includes(needle));
	}
	filtered.sort((a, b) => b.submittedAt - a.submittedAt);
	return filtered.slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
		.map(record => structuredClone(record));
}

/** Review workflow edits: status transitions plus optional content fixes. */
export function updateFeedback(id, patch = {}) {
	loadFeedback();
	const record = records.get(id);
	if (!record) throw Object.assign(new Error('Feedback not found.'), { code: 'not_found' });
	const next = { ...record };
	if (patch.status !== undefined) {
		if (!FEEDBACK_STATUSES.includes(patch.status)) {
			throw Object.assign(
				new Error('Unknown feedback status.'),
				{ code: 'invalid_input', fields: { status: 'Unknown feedback status.' } }
			);
		}
		next.status = patch.status;
	}
	if (patch.rating !== undefined || patch.category !== undefined || patch.comments !== undefined) {
		Object.assign(next, normalizeFeedbackInput({
			rating: patch.rating ?? next.rating,
			category: patch.category ?? next.category,
			comments: patch.comments ?? next.comments,
			improvement: patch.improvement ?? next.improvement
		}));
	}
	next.updatedAt = Date.now();
	records.set(id, next);
	persistNow();
	return structuredClone(next);
}

export function deleteFeedback(id) {
	loadFeedback();
	const existed = records.delete(id);
	if (existed) persistNow();
	return existed;
}

/** Aggregates for the admin panel: totals, average, per-category/status. */
export function feedbackStats() {
	loadFeedback();
	const all = [...records.values()];
	const average = all.length
		? all.reduce((sum, record) => sum + record.rating, 0) / all.length
		: undefined;
	const byCategory = {};
	for (const category of FEEDBACK_CATEGORIES) byCategory[category] = 0;
	const byStatus = {};
	for (const status of FEEDBACK_STATUSES) byStatus[status] = 0;
	const byRating = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
	for (const record of all) {
		byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;
		byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
		byRating[record.rating] += 1;
	}
	return {
		total: all.length,
		averageRating: average === undefined ? undefined : Math.round(average * 100) / 100,
		byCategory,
		byStatus,
		byRating
	};
}

export function closeFeedbackStore() {
	if (records.size > 0) persistNow();
}
