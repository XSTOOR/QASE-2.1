/**
 * PostgreSQL bug repository (migration 020). Same contract as the local JSON
 * backend in bugService.js. Tenant-scoped via RLS set_config, mirroring
 * testCaseRepository.js.
 */
const BUG_COLUMNS = [
	'bug_number', 'title', 'description', 'severity', 'status', 'category',
	'expected', 'actual', 'steps', 'environment_id', 'environment_snapshot',
	'execution_level', 'linked_run_id', 'linked_test_case_id', 'evidence',
	'created_at', 'updated_at'
];

function requireTenant(tenant) {
	if (!tenant?.organizationId || !tenant?.projectId) {
		throw new Error('A tenant context (organizationId, projectId) is required.');
	}
	return tenant;
}

function json(value) {
	return value === undefined || value === null ? null : JSON.stringify(value);
}

export function createPostgresBugRepository(pool, { tenantContext } = {}) {
	async function withTenant(client, tenant) {
		const resolved = requireTenant(tenant);
		await client.query("SELECT set_config('qase.organization_id', $1, true)", [resolved.organizationId]);
		await client.query("SELECT set_config('qase.project_id', $1, true)", [resolved.projectId]);
	}

	/** Next BUG-XXXX number inside the tenant. */
	async function nextBugNumber(client, tenant) {
		const result = await client.query(
			`SELECT bug_number FROM bugs
			 WHERE organization_id = $1 AND project_id = $2
			   AND bug_number ~ '^BUG-[0-9]+$'`,
			[tenant.organizationId, tenant.projectId]
		);
		let max = 0;
		for (const row of result.rows) {
			max = Math.max(max, Number(row.bug_number.slice(4)));
		}
		return `BUG-${String(max + 1).padStart(4, '0')}`;
	}

	function rowToBug(row) {
		if (!row) return null;
		return {
			id: row.id,
			bugNumber: row.bug_number,
			title: row.title,
			description: row.description,
			severity: row.severity,
			status: row.status,
			category: row.category,
			expected: row.expected,
			actual: row.actual,
			steps: row.steps ?? [],
			environmentId: row.environment_id,
			environmentSnapshot: row.environment_snapshot,
			executionLevel: row.execution_level,
			linkedRunId: row.linked_run_id,
			linkedTestCaseId: row.linked_test_case_id,
			evidence: row.evidence ?? [],
			createdAt: row.created_at?.toISOString?.() ?? row.created_at ?? null,
			updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at ?? null
		};
	}

	return {
		async list(tenant, filters = {}) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const clauses = [];
				const params = [];
				if (filters.search) {
					params.push(`%${String(filters.search).toLowerCase()}%`);
					clauses.push(`(lower(bug_number) LIKE $1 OR lower(title) LIKE $1)`);
				}
				if (filters.status) {
					params.push(String(filters.status).toLowerCase());
					clauses.push(`status = $${params.length}`);
				}
				if (filters.severity) {
					params.push(String(filters.severity).toLowerCase());
					clauses.push(`severity = $${params.length}`);
				}
				if (filters.environmentId) {
					params.push(String(filters.environmentId));
					clauses.push(`environment_id = $${params.length}`);
				}
				const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
				const result = await client.query(
					`SELECT ${BUG_COLUMNS.join(', ')} FROM bugs ${where}
					 ORDER BY bug_number`,
					params
				);
				return result.rows.map(rowToBug);
			} finally {
				client.release();
			}
		},
		async get(tenant, bugNumber) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const result = await client.query(
					`SELECT ${BUG_COLUMNS.join(', ')} FROM bugs WHERE bug_number = $1`,
					[String(bugNumber)]
				);
				return rowToBug(result.rows[0] ?? null);
			} finally {
				client.release();
			}
		},
		async create(tenant, input) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const bugNumber = await nextBugNumber(client, resolved);
				const result = await client.query(
					`INSERT INTO bugs (bug_number, title, description, severity, status, category,
						expected, actual, steps, environment_id, environment_snapshot,
						execution_level, linked_run_id, linked_test_case_id, evidence)
					 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15::jsonb)
					 RETURNING ${BUG_COLUMNS.join(', ')}`,
					[
						bugNumber,
						input.title,
						input.description ?? null,
						input.severity ?? 'medium',
						input.status ?? 'open',
						input.category ?? null,
						input.expected ?? null,
						input.actual ?? null,
						json(input.steps ?? []),
						input.environmentId ?? null,
						json(input.environmentSnapshot),
						input.executionLevel ?? null,
						input.linkedRunId ?? null,
						input.linkedTestCaseId ?? null,
						json(input.evidence ?? [])
					]
				);
				return rowToBug(result.rows[0]);
			} finally {
				client.release();
			}
		},
		async update(tenant, bugNumber, patch) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const sets = [];
				const params = [];
				const push = (column, value) => {
					params.push(value);
					sets.push(`${column} = $${params.length}`);
				};
				if (patch.title !== undefined) push('title', patch.title);
				if (patch.description !== undefined) push('description', patch.description);
				if (patch.severity !== undefined) push('severity', String(patch.severity).toLowerCase());
				if (patch.status !== undefined) push('status', String(patch.status).toLowerCase());
				if (patch.category !== undefined) push('category', patch.category);
				if (patch.expected !== undefined) push('expected', patch.expected);
				if (patch.actual !== undefined) push('actual', patch.actual);
				if (patch.steps !== undefined) { params.push(json(patch.steps)); sets.push(`steps = $${params.length}::jsonb`); }
				params.push(new Date().toISOString());
				sets.push(`updated_at = $${params.length}`);
				params.push(String(bugNumber));
				const result = await client.query(
					`UPDATE bugs SET ${sets.join(', ')} WHERE bug_number = $${params.length}
					 RETURNING ${BUG_COLUMNS.join(', ')}`,
					params
				);
				return rowToBug(result.rows[0] ?? null);
			} finally {
				client.release();
			}
		},
		async remove(tenant, bugNumber) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const result = await client.query(
					`DELETE FROM bugs WHERE bug_number = $1 RETURNING ${BUG_COLUMNS.join(', ')}`,
					[String(bugNumber)]
				);
				return rowToBug(result.rows[0] ?? null);
			} finally {
				client.release();
			}
		}
	};
}
