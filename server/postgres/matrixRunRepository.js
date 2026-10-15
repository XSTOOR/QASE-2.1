/**
 * PostgreSQL persistence for matrix runs (#14633 NI02 Phase 1).
 * Same backend interface as createLocalMatrixBackend in matrixService.js:
 * list/get/create/update/updateItem, tenant-scoped via qase.* settings.
 */

import { randomUUID } from 'node:crypto';

const RUN_COLUMNS = ['title', 'target_url', 'status', 'defaults_used', 'defaults_snapshot',
	'requested_profiles', 'requested_browsers', 'item_count', 'owner_user_id', 'started_at', 'finished_at'];
const ITEM_COLUMNS = ['test_case_id', 'environment_id', 'profile_id', 'platform', 'device', 'os',
	'os_version', 'browser', 'browser_code', 'browser_version', 'device_type', 'status', 'reason',
	'session_id', 'verdict', 'error', 'findings', 'started_at', 'finished_at', 'duration_ms',
	'execution_level', 'execution_provider', 'artifact_refs', 'fixture_verdicts', 'runtime_facts'];

function requireTenant(tenant) {
	if (!tenant?.organizationId || !tenant?.projectId) {
		throw new TypeError('Matrix storage requires tenant context (organizationId/projectId).');
	}
	return tenant;
}

async function withTenant(client, tenant) {
	await client.query("SELECT set_config('qase.organization_id', $1, true)", [tenant.organizationId]);
	await client.query("SELECT set_config('qase.project_id', $1, true)", [tenant.projectId]);
}

function rowToRun(row) {
	if (!row) return null;
	return {
		id: row.id,
		title: row.title,
		targetUrl: row.target_url,
		status: row.status,
		defaultsUsed: row.defaults_used,
		defaultsSnapshot: row.defaults_snapshot ?? null,
		requestedProfiles: row.requested_profiles ?? [],
		requestedBrowsers: row.requested_browsers ?? [],
		itemCount: row.item_count,
		ownerUserId: row.owner_user_id ?? null,
		createdAt: row.created_at?.toISOString?.() ?? row.created_at,
		startedAt: row.started_at?.toISOString?.() ?? row.started_at ?? null,
		finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at ?? null,
		updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
		items: []
	};
}

function rowToItem(row) {
	if (!row) return null;
	return {
		id: row.id,
		ordinal: row.ordinal,
		testCaseId: row.test_case_id,
		environmentId: row.environment_id,
		profileId: row.profile_id ?? null,
		platform: row.platform,
		device: row.device,
		os: row.os,
		osVersion: row.os_version,
		browser: row.browser,
		browserCode: row.browser_code,
		browserVersion: row.browser_version,
		deviceType: row.device_type ?? null,
		status: row.status,
		reason: row.reason ?? null,
		sessionId: row.session_id ?? null,
		verdict: row.verdict ?? null,
		error: row.error ?? null,
		findings: row.findings ?? [],
		startedAt: row.started_at?.toISOString?.() ?? row.started_at ?? null,
		finishedAt: row.finished_at?.toISOString?.() ?? row.finished_at ?? null,
		durationMs: row.duration_ms ?? null,
		executionLevel: row.execution_level ?? null,
		executionProvider: row.execution_provider ?? null,
		artifactRefs: row.artifact_refs ?? [],
		fixtureVerdicts: row.fixture_verdicts ?? [],
		runtimeFacts: row.runtime_facts ?? null,
		retryCount: row.retry_count ?? 0,
		updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
	};
}

export function createPostgresMatrixRepository(pool, { tenantContext } = {}) {
	async function loadItems(tenant, client, runIds) {
		if (!runIds.length) return new Map();
		const result = await client.query(
			`SELECT * FROM matrix_run_items
			 WHERE matrix_run_id = ANY($1::text[]) ORDER BY ordinal`,
			[runIds]
		);
		const grouped = new Map();
		for (const row of result.rows) {
			if (!grouped.has(row.matrix_run_id)) grouped.set(row.matrix_run_id, []);
			grouped.get(row.matrix_run_id).push(rowToItem(row));
		}
		return grouped;
	}

	return {
		async list(tenant) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const result = await client.query('SELECT * FROM matrix_runs ORDER BY created_at DESC LIMIT 200');
				const grouped = await loadItems(resolved, client, result.rows.map((row) => row.id));
				return result.rows.map((row) => ({ ...rowToRun(row), items: grouped.get(row.id) ?? [] }));
			} finally {
				client.release();
			}
		},
		async get(tenant, id) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const run = await client.query('SELECT * FROM matrix_runs WHERE id = $1 LIMIT 1', [id]);
				if (!run.rows.length) return null;
				const grouped = await loadItems(resolved, client, [run.rows[0].id]);
				return { ...rowToRun(run.rows[0]), items: grouped.get(run.rows[0].id) ?? [] };
			} finally {
				client.release();
			}
		},
		async create(tenant, record) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await client.query('BEGIN');
				await withTenant(client, resolved);
				const params = [record.id, resolved.organizationId, resolved.projectId];
				const values = [record.id, resolved.organizationId, resolved.projectId];
				const cols = ['id', 'organization_id', 'project_id'];
				for (const column of RUN_COLUMNS) {
					const field = {
						title: 'title', target_url: 'targetUrl', status: 'status',
						defaults_used: 'defaultsUsed', defaults_snapshot: 'defaultsSnapshot',
						requested_profiles: 'requestedProfiles', requested_browsers: 'requestedBrowsers',
						item_count: 'itemCount', owner_user_id: 'ownerUserId',
						started_at: 'startedAt', finished_at: 'finishedAt'
					}[column];
					cols.push(column);
					values.push(record[field] ?? null);
					params.push(record[field] ?? null);
				}
				// params == values here; build placeholders from values length
				const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
				const runRow = await client.query(
					`INSERT INTO matrix_runs (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
					values
				);
				for (const item of record.items ?? []) {
					const itemValues = [randomUUID(), resolved.organizationId, resolved.projectId, runRow.rows[0].id, item.ordinal];
					const itemCols = ['id', 'organization_id', 'project_id', 'matrix_run_id', 'ordinal'];
					for (const column of ITEM_COLUMNS) {
						const field = {
							test_case_id: 'testCaseId', environment_id: 'environmentId', profile_id: 'profileId',
							platform: 'platform', device: 'device', os: 'os', os_version: 'osVersion',
							browser: 'browser', browser_code: 'browserCode', browser_version: 'browserVersion',
							device_type: 'deviceType', status: 'status', reason: 'reason', session_id: 'sessionId',
							verdict: 'verdict', error: 'error', findings: 'findings', started_at: 'startedAt',
							finished_at: 'finishedAt', duration_ms: 'durationMs',
							execution_level: 'executionLevel', execution_provider: 'executionProvider',
							artifact_refs: 'artifactRefs', fixture_verdicts: 'fixtureVerdicts',
							runtime_facts: 'runtimeFacts'
						}[column];
						itemCols.push(column);
						itemValues.push(['findings', 'artifact_refs', 'fixture_verdicts'].includes(column)
							? JSON.stringify(item[field] ?? [])
							: (column === 'runtime_facts' && item[field] != null
								? JSON.stringify(item[field])
								: (item[field] ?? null)));
					}
					await client.query(
						`INSERT INTO matrix_run_items (${itemCols.join(', ')})
						 VALUES (${itemValues.map((_, index) => `$${index + 1}`).join(', ')})`,
						itemValues
					);
				}
				await client.query('COMMIT');
				return this.get(tenant, runRow.rows[0].id);
			} catch (error) {
				await client.query('ROLLBACK').catch(() => {});
				throw error;
			} finally {
				client.release();
			}
		},
		async update(tenant, id, patch) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const map = {
					status: 'status', startedAt: 'started_at', finishedAt: 'finished_at'
				};
				const sets = ['updated_at = now()'];
				const params = [];
				for (const [key, column] of Object.entries(map)) {
					if (patch?.[key] === undefined) continue;
					params.push(patch[key]);
					sets.push(`${column} = $${params.length}`);
				}
				params.push(id);
				await client.query(
					`UPDATE matrix_runs SET ${sets.join(', ')} WHERE id = $${params.length}`,
					params
				);
				return this.get(tenant, id);
			} finally {
				client.release();
			}
		},
		async updateItem(tenant, matrixRunId, itemId, patch) {
			const resolved = requireTenant(tenant ?? tenantContext);
			const client = await pool.connect();
			try {
				await withTenant(client, resolved);
				const map = {
					status: 'status', reason: 'reason', sessionId: 'session_id', verdict: 'verdict',
					error: 'error', findings: 'findings', startedAt: 'started_at',
					finishedAt: 'finished_at', durationMs: 'duration_ms',
					// #14650 (NI02 Phase 2): per-profile evidence columns.
				executionLevel: 'execution_level', executionProvider: 'execution_provider',
				artifactRefs: 'artifact_refs', fixtureVerdicts: 'fixture_verdicts',
				runtimeFacts: 'runtime_facts',
				// Bounded per-item retry ledger (#15043/#14937): must survive the
				// orchestrator restart, so it is a persisted column, not memory.
				retryCount: 'retry_count'
				};
				const sets = ['updated_at = now()'];
				const params = [];
				for (const [key, column] of Object.entries(map)) {
					if (patch?.[key] === undefined) continue;
					params.push(['findings', 'artifactRefs', 'fixtureVerdicts'].includes(key)
						? JSON.stringify(patch[key] ?? [])
						: (key === 'runtimeFacts' && patch[key] != null
							? JSON.stringify(patch[key])
							: patch[key]));
					sets.push(`${column} = $${params.length}`);
				}
				params.push(itemId);
				const result = await client.query(
					`UPDATE matrix_run_items SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
					params
				);
				return rowToItem(result.rows[0]) ?? null;
			} finally {
				client.release();
			}
		}
	};
}
