import { randomUUID } from 'node:crypto';
import {
	FEEDBACK_CATEGORIES, FEEDBACK_STATUSES, normalizeFeedbackInput
} from '../feedbackStore.js';

/**
 * PostgreSQL feedback repository. Mirrors the run repository's tenant scoping:
 * every statement filters by (organization_id, project_id) parameters, and RLS
 * (migration 015) enforces the same scope at the database.
 */

const CATEGORY_LIST = FEEDBACK_CATEGORIES.map(category => `'${category}'`).join(', ');

export function createPostgresFeedbackRepository({ pool, tenantContext }) {
	const tenant = tenantContext;

	function feedbackRow(record) {
		if (!record) return undefined;
		return {
			id: record.id,
			runId: record.run_id,
			submittedBy: record.submitted_by_user_id ?? undefined,
			targetUrl: record.target_url ?? undefined,
			runStatus: record.run_status ?? undefined,
			durationSeconds: record.duration_seconds === null ? undefined : Number(record.duration_seconds),
			rating: Number(record.rating),
			category: record.category,
			comments: record.comments ?? '',
			improvement: record.improvement ?? undefined,
			status: record.status,
			submittedAt: record.submitted_at.getTime(),
			updatedAt: record.updated_at.getTime()
		};
	}

	async function create({ runId, submittedBy, context, ...input }) {
		// Duplicate check: unique constraint (org, project, run, submitter).
		const existing = await forRun(runId, submittedBy);
		if (existing) {
			const error = new Error('Feedback already exists for this test run.');
			error.code = 'duplicate_feedback';
			error.existingId = existing.id;
			throw error;
		}
		const normalized = normalizeFeedbackInput(input);
		const id = randomUUID();
		const { rows } = await pool.query(
			`INSERT INTO qa_run_feedback (
				id, organization_id, project_id, run_id, submitted_by_user_id,
				target_url, run_status, duration_seconds, rating, category,
				comments, improvement, status
			) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new')
			RETURNING *`,
			[
				id, tenant.organizationId, tenant.projectId, runId, submittedBy ?? null,
				typeof context?.targetUrl === 'string' ? context.targetUrl : null,
				typeof context?.runStatus === 'string' ? context.runStatus : null,
				Number.isFinite(context?.durationSeconds) ? context.durationSeconds : null,
				normalized.rating, normalized.category, normalized.comments,
				normalized.improvement ?? null
			]
		);
		return feedbackRow(rows[0]);
	}

	async function get(id) {
		const { rows } = await pool.query(
			`SELECT * FROM qa_run_feedback
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
			[tenant.organizationId, tenant.projectId, id]
		);
		return feedbackRow(rows[0]);
	}

	async function forRun(runId, submittedBy) {
		const { rows } = await pool.query(
			`SELECT * FROM qa_run_feedback
			 WHERE organization_id = $1 AND project_id = $2 AND run_id = $3
			 AND ($4::uuid IS NULL AND submitted_by_user_id IS NULL OR submitted_by_user_id = $4)
			 LIMIT 1`,
			[tenant.organizationId, tenant.projectId, runId, submittedBy ?? null]
		);
		return feedbackRow(rows[0]);
	}

	async function list(filters = {}) {
		const clauses = ['organization_id = $1', 'project_id = $2'];
		const params = [tenant.organizationId, tenant.projectId];
		const add = (clause, value) => {
			params.push(value);
			clauses.push(clause.replace('?', `$${params.length}`));
		};
		if (filters.runId !== undefined) add('run_id = ?', filters.runId);
		if (filters.submittedBy !== undefined) add('submitted_by_user_id = ?', filters.submittedBy ?? null);
		if (filters.rating !== undefined) add('rating = ?', Number(filters.rating));
		if (filters.category) add('category = ?', filters.category);
		if (filters.status) add('status = ?', filters.status);
		if (filters.targetUrl) add('target_url ILIKE ?', `%${String(filters.targetUrl)}%`);
		if (Number.isFinite(Number(filters.since))) add('submitted_at >= to_timestamp(?)', Number(filters.since) / 1000);
		if (Number.isFinite(Number(filters.until))) add('submitted_at <= to_timestamp(?)', Number(filters.until) / 1000);
		if (filters.q && String(filters.q).trim() !== '') {
			const needle = `%${String(filters.q)}%`;
			params.push(needle);
			const p = `$${params.length}`;
			clauses.push(`(comments ILIKE ${p} OR improvement ILIKE ${p})`);
		}
		params.push(Math.min(500, Math.max(1, Number(filters.limit) || 100)));
		const { rows } = await pool.query(
			`SELECT * FROM qa_run_feedback WHERE ${clauses.join(' AND ')}
			 ORDER BY submitted_at DESC LIMIT $${params.length}`,
			params
		);
		return rows.map(feedbackRow);
	}

	async function update(id, patch = {}) {
		const current = await get(id);
		if (!current) throw Object.assign(new Error('Feedback not found.'), { code: 'not_found' });
		let content = null;
		if (patch.rating !== undefined || patch.category !== undefined || patch.comments !== undefined) {
			content = normalizeFeedbackInput({
				rating: patch.rating ?? current.rating,
				category: patch.category ?? current.category,
				comments: patch.comments ?? current.comments,
				improvement: patch.improvement ?? current.improvement
			});
		}
		if (patch.status !== undefined && !FEEDBACK_STATUSES.includes(patch.status)) {
			throw Object.assign(
				new Error('Unknown feedback status.'),
				{ code: 'invalid_input', fields: { status: 'Unknown feedback status.' } }
			);
		}
		const { rows } = await pool.query(
			`UPDATE qa_run_feedback SET
				rating = COALESCE($4, rating), category = COALESCE($5, category),
				comments = COALESCE($6, comments), improvement = COALESCE($7, improvement),
				status = COALESCE($8, status), updated_at = CURRENT_TIMESTAMP
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3
			 RETURNING *`,
			[
				tenant.organizationId, tenant.projectId, id,
				content?.rating ?? null, content?.category ?? null,
				content?.comments ?? null, content?.improvement ?? null,
				patch.status ?? null
			]
		);
		return feedbackRow(rows[0]);
	}

	async function remove(id) {
		const { rowCount } = await pool.query(
			`DELETE FROM qa_run_feedback
			 WHERE organization_id = $1 AND project_id = $2 AND id = $3`,
			[tenant.organizationId, tenant.projectId, id]
		);
		return rowCount > 0;
	}

	async function stats() {
		const { rows } = await pool.query(
			`SELECT
				COUNT(*)::int AS total,
				AVG(rating)::float AS average_rating,
				${FEEDBACK_CATEGORIES.map((category, index) =>
		`COUNT(*) FILTER (WHERE category = '${category}')::int AS cat_${index}`).join(',\n\t\t\t\t')},
				${FEEDBACK_STATUSES.map((status, index) =>
		`COUNT(*) FILTER (WHERE status = '${status}')::int AS st_${index}`).join(',\n\t\t\t\t')},
				${[1, 2, 3, 4, 5].map(rating =>
		`COUNT(*) FILTER (WHERE rating = ${rating})::int AS r_${rating}`).join(',\n\t\t\t\t')}
			 FROM qa_run_feedback
			 WHERE organization_id = $1 AND project_id = $2`,
			[tenant.organizationId, tenant.projectId]
		);
		const row = rows[0] ?? {};
		const byCategory = {};
		FEEDBACK_CATEGORIES.forEach((category, index) => { byCategory[category] = row[`cat_${index}`] ?? 0; });
		const byStatus = {};
		FEEDBACK_STATUSES.forEach((status, index) => { byStatus[status] = row[`st_${index}`] ?? 0; });
		const byRating = {};
		for (const rating of [1, 2, 3, 4, 5]) byRating[rating] = row[`r_${rating}`] ?? 0;
		return {
			total: row.total ?? 0,
			averageRating: row.average_rating === null || row.average_rating === undefined
				? undefined
				: Math.round(row.average_rating * 100) / 100,
			byCategory,
			byStatus,
			byRating
		};
	}

	return { create, get, forRun, list, update, remove, stats };
}
