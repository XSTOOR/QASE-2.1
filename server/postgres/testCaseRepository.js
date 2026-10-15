/**
 * PostgreSQL test-case repository (migration 017). Same contract as the local
 * JSON backend in testCaseService.js. Tenant-scoped via RLS set_config, mirroring
 * environmentRepository.js.
 */
import { randomUUID } from 'node:crypto';

const CASE_COLUMNS = [
	'case_number', 'title', 'description', 'steps', 'expected', 'tags', 'environment_ids', 'deleted',
	'source', 'source_run_id', 'source_url'
];

function requireTenant(tenant) {
	if (!tenant?.organizationId || !tenant?.projectId) {
		throw new Error('A tenant context (organizationId, projectId) is required.');
	}
	return tenant;
}

export function createPostgresTestCaseRepository(pool, { tenantContext } = {}) {
	async function withTenant(client, tenant) {
		const resolved = requireTenant(tenant);
		await client.query("SELECT set_config('qase.organization_id', $1, true)", [resolved.organizationId]);
		await client.query("SELECT set_config('qase.project_id', $1, true)", [resolved.projectId]);
	}

	/** Next TC-XXXX number inside the tenant. */
	async function nextCaseNumber(client, tenant) {
		const result = await client.query(
			`SELECT case_number FROM test_cases
			 WHERE organization_id = $1 AND project_id = $2
			   AND case_number ~ '^TC-[0-9]+$'`,
			[tenant.organizationId, tenant.projectId]
		);
		let max = 0;
		for (const row of result.rows) {
			max = Math.max(max, Number(row.case_number.slice(3)));
		}
		return `TC-${String(max + 1).padStart(4, '0')}`;
	}

	return {
		async list(tenant, filters = {}) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const clauses = ['deleted = false'];
				const params = [resolved.organizationId, resolved.projectId];
				if (filters.search) {
					params.push(`%${String(filters.search).toLowerCase()}%`);
					clauses.push(`(lower(case_number) LIKE $3 OR lower(title) LIKE $3)`);
				}
				if (filters.tag) {
					params.push(String(filters.tag).toLowerCase());
					clauses.push(`$${params.length} = ANY(tags)`);
				}
				if (filters.environmentId) {
					params.push(String(filters.environmentId));
					clauses.push(`$${params.length} = ANY(environment_ids)`);
				}
				if (filters.source) {
					params.push(String(filters.source));
					clauses.push(`source = $${params.length}`);
				}
				if (filters.sourceRunId) {
					params.push(String(filters.sourceRunId));
					clauses.push(`source_run_id = $${params.length}`);
				}
				const result = await client.query(
					`SELECT * FROM test_cases
					 WHERE organization_id = $1 AND project_id = $2 AND ${clauses.join(' AND ')}
					 ORDER BY case_number ASC`,
					params
				);
				return result.rows;
			} finally {
				client.release();
			}
		},
		async get(tenant, caseNumber) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const result = await client.query(
					'SELECT * FROM test_cases WHERE organization_id = $1 AND project_id = $2 AND case_number = $3 AND deleted = false',
					[resolved.organizationId, resolved.projectId, String(caseNumber)]
				);
				return result.rows[0] ?? null;
			} finally {
				client.release();
			}
		},
		async create(tenant, input) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await withTenant(client, resolved);
				const caseNumber = await nextCaseNumber(client, resolved);
				const params = [randomUUID(), resolved.organizationId, resolved.projectId, caseNumber,
					input.title, input.description ?? null,
					JSON.stringify(input.steps ?? []), input.expected ?? null,
					input.tags ?? [], input.environmentIds ?? [],
					input.source === 'auto' ? 'auto' : 'manual',
					input.sourceRunId ?? null, input.sourceUrl ?? null];
				const result = await client.query(
					`INSERT INTO test_cases (id, organization_id, project_id, case_number, title, description, steps, expected, tags, environment_ids, source, source_run_id, source_url)
					 VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})
					 RETURNING *`,
					params
				);
				await client.query('COMMIT');
				return result.rows[0];
			} catch (error) {
				await client.query('ROLLBACK').catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		async update(tenant, caseNumber, patch) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await withTenant(client, resolved);
				const assignments = [];
				const params = [resolved.organizationId, resolved.projectId, String(caseNumber)];
				const push = (column, value) => {
					params.push(value);
					assignments.push(`${column} = $${params.length}`);
				};
				if (patch.title !== undefined) push('title', patch.title);
				if (patch.description !== undefined) push('description', patch.description);
				if (patch.expected !== undefined) push('expected', patch.expected);
				if (patch.steps !== undefined) push('steps', JSON.stringify(patch.steps));
				if (patch.tags !== undefined) push('tags', patch.tags);
				if (Array.isArray(patch.addEnvironmentIds) || Array.isArray(patch.removeEnvironmentIds)) {
					const additions = patch.addEnvironmentIds ?? [];
					const removals = patch.removeEnvironmentIds ?? [];
					params.push(additions, removals);
					assignments.push(`environment_ids = (
						SELECT COALESCE(array_agg(DISTINCT env_id), '{}')
						FROM (
							SELECT UNNEST(environment_ids) AS env_id FROM test_cases
							WHERE organization_id = $1 AND project_id = $2 AND case_number = $3
							UNION SELECT UNNEST($${params.length - 1}::text[])
							EXCEPT SELECT UNNEST($${params.length}::text[])
						) combined
					)`);
				}
				push('updated_at', new Date());
				const result = await client.query(
					`UPDATE test_cases SET ${assignments.join(', ')}
					 WHERE organization_id = $1 AND project_id = $2 AND case_number = $3 AND deleted = false
					 RETURNING *`,
					params
				);
				await client.query('COMMIT');
				return result.rows[0] ?? null;
			} catch (error) {
				await client.query('ROLLBACK').catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		async remove(tenant, caseNumber) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const result = await client.query(
					`UPDATE test_cases SET deleted = true, updated_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2 AND case_number = $3 AND deleted = false
					 RETURNING *`,
					[resolved.organizationId, resolved.projectId, String(caseNumber)]
				);
				return result.rows[0] ?? null;
			} finally {
				client.release();
			}
		}
	};
}
