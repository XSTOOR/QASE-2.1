import { randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function uuid(value, label) {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a canonical UUID.`);
	return value.toLowerCase();
}
function worker(value) {
	if (typeof value !== 'string' || !WORKER_PATTERN.test(value)) throw new TypeError('workerId is invalid.');
	return value;
}
function milliseconds(value, fallback, minimum, maximum, label) {
	const result = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(result) || result < minimum || result > maximum) throw new TypeError(`${label} is invalid.`);
	return result;
}
function trustedTenant(value) {
	if (!value || !Object.isFrozen(value)) throw new TypeError('Execution queue requires frozen tenant context.');
	return { organizationId: uuid(value.organizationId, 'organizationId'), projectId: uuid(value.projectId, 'projectId') };
}
async function setScope(client, tenant) {
	await client.query(
		"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
		[tenant.organizationId, tenant.projectId]
	);
}
function hydrate(row) {
	return row ? {
		id: row.id, runId: row.run_id, requestedByUserId: row.requested_by_user_id,
		correlationId: row.correlation_id ?? undefined,
		kind: row.kind, payload: row.payload ?? {}, status: row.status,
		attempts: Number(row.attempts), maxAttempts: Number(row.max_attempts),
		leaseOwner: row.lease_owner, leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : undefined
	} : undefined;
}

export function createPostgresExecutionQueue(options = {}) {
	const pool = options.pool;
	if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
	const tenant = trustedTenant(options.tenantContext);
	const defaultLeaseMs = milliseconds(options.leaseMs, 30_000, 5_000, 300_000, 'leaseMs');
	const defaultMaxAttempts = milliseconds(options.maxAttempts, 3, 1, 20, 'maxAttempts');
	const retentionDays = milliseconds(options.retentionDays, 30, 1, 365, 'retentionDays');
	const maxActiveJobs = milliseconds(options.maxActiveJobs, 5_000, 1, 100_000, 'maxActiveJobs');

	async function transaction(work) {
		const client = await pool.connect();
		try {
			await client.query('BEGIN');
			await setScope(client, tenant);
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally { client.release(); }
	}

	return Object.freeze({
		async enqueue({ runId, requestedByUserId, turnOptions, idempotencyKey, correlationId }) {
			uuid(runId, 'runId');
			uuid(requestedByUserId, 'requestedByUserId');
			if (correlationId !== undefined) uuid(correlationId, 'correlationId');
			const payload = structuredClone(turnOptions ?? {});
			const jobId = idempotencyKey ? uuid(idempotencyKey, 'idempotencyKey') : randomUUID();
			return transaction(async client => {
				const capacityScope = `${tenant.organizationId}:${tenant.projectId}:execution-capacity`;
				await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [capacityScope]);
				const capacity = await client.query(
					`SELECT COUNT(*)::int AS count FROM qa_execution_jobs
					 WHERE organization_id = $1 AND project_id = $2
					 AND status IN ('queued', 'leased', 'cancel_requested')`,
					[tenant.organizationId, tenant.projectId]
				);
				if (Number(capacity.rows[0]?.count ?? 0) >= maxActiveJobs) {
					const error = new Error('This Qase cell has reached its active execution capacity.');
					error.code = 'QASE_CELL_CAPACITY_EXCEEDED';
					throw error;
				}
				try {
					const result = await client.query(
						`INSERT INTO qa_execution_jobs
						 (id, organization_id, project_id, run_id, requested_by_user_id, correlation_id, kind, payload, max_attempts)
						 VALUES ($1, $2, $3, $4, $5, $6, 'turn', $7::jsonb, $8) RETURNING *`,
						[jobId, tenant.organizationId, tenant.projectId, runId, requestedByUserId,
						 correlationId ?? null, JSON.stringify(payload), defaultMaxAttempts]
					);
					return hydrate(result.rows[0]);
				} catch (error) {
					if (error?.code === '23505') {
						const conflict = new Error('This run already has active work.');
						conflict.code = 'QASE_RUN_ALREADY_QUEUED';
						throw conflict;
					}
					throw error;
				}
			});
		},

		async claim(workerId, leaseMs = defaultLeaseMs) {
			worker(workerId);
			milliseconds(leaseMs, defaultLeaseMs, 5_000, 300_000, 'leaseMs');
			return transaction(async client => {
				await client.query(
					`DELETE FROM qa_execution_jobs WHERE ctid IN (
					 SELECT ctid FROM qa_execution_jobs WHERE organization_id = $1 AND project_id = $2
					 AND status IN ('succeeded', 'failed', 'cancelled')
					 AND finished_at < CURRENT_TIMESTAMP - ($3 * INTERVAL '1 day') LIMIT 1000
					)`,
					[tenant.organizationId, tenant.projectId, retentionDays]
				);
				await client.query(
					`UPDATE qa_execution_jobs SET status = 'queued', available_at = CURRENT_TIMESTAMP,
					 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2 AND status = 'leased'
					 AND lease_expires_at <= CURRENT_TIMESTAMP AND attempts < max_attempts`,
					[tenant.organizationId, tenant.projectId]
				);
				await client.query(
					`UPDATE qa_execution_jobs SET status = 'cancelled', finished_at = CURRENT_TIMESTAMP,
					 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2
					 AND status = 'cancel_requested' AND lease_expires_at <= CURRENT_TIMESTAMP`,
					[tenant.organizationId, tenant.projectId]
				);
				const selected = await client.query(
					`SELECT id FROM qa_execution_jobs WHERE organization_id = $1 AND project_id = $2
					 AND status = 'queued' AND available_at <= CURRENT_TIMESTAMP AND attempts < max_attempts
					 ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
					[tenant.organizationId, tenant.projectId]
				);
				if (!selected.rows[0]) return undefined;
				const leaseToken = randomUUID();
				const result = await client.query(
					`UPDATE qa_execution_jobs SET status = 'leased', attempts = attempts + 1,
					 lease_owner = $2, lease_token = $3, lease_expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
					 last_heartbeat_at = CURRENT_TIMESTAMP, started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
					 updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
					[selected.rows[0].id, workerId, leaseToken, leaseMs]
				);
				return hydrate(result.rows[0]);
			});
		},

		async heartbeat({ jobId, leaseToken, workerId, leaseMs = defaultLeaseMs }) {
			uuid(jobId, 'jobId'); uuid(leaseToken, 'leaseToken'); worker(workerId);
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qa_execution_jobs SET lease_expires_at = CURRENT_TIMESTAMP + ($4 * INTERVAL '1 millisecond'),
					 last_heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
					 WHERE id = $1 AND lease_token = $2 AND lease_owner = $3
					 AND status IN ('leased', 'cancel_requested') RETURNING status`,
					[jobId, leaseToken, workerId, leaseMs]
				);
				return result.rows[0]?.status;
			});
		},

		async complete({ jobId, leaseToken, workerId }) {
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qa_execution_jobs SET status = CASE WHEN status = 'cancel_requested' THEN 'cancelled' ELSE 'succeeded' END,
					 finished_at = CURRENT_TIMESTAMP, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
					 updated_at = CURRENT_TIMESTAMP WHERE id = $1 AND lease_token = $2 AND lease_owner = $3
					 AND status IN ('leased', 'cancel_requested') RETURNING status`,
					[uuid(jobId, 'jobId'), uuid(leaseToken, 'leaseToken'), worker(workerId)]
				);
				return result.rows[0]?.status;
			});
		},

		async fail({ jobId, leaseToken, workerId, error, retryable = true }) {
			const detail = String(error instanceof Error ? error.message : error ?? 'Worker execution failed.').slice(0, 2000);
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qa_execution_jobs SET
					 status = CASE WHEN status = 'cancel_requested' THEN 'cancelled'
					  WHEN $4 AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
					 available_at = CASE WHEN status = 'leased' AND $4 AND attempts < max_attempts
					  THEN CURRENT_TIMESTAMP + (LEAST(60, POWER(2, attempts)) * INTERVAL '1 second') ELSE available_at END,
					 error_code = $5, error_detail = $6,
					 finished_at = CASE WHEN status = 'leased' AND $4 AND attempts < max_attempts THEN NULL ELSE CURRENT_TIMESTAMP END,
					 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
					 WHERE id = $1 AND lease_token = $2 AND lease_owner = $3 AND status IN ('leased', 'cancel_requested')
					 RETURNING status`,
					[uuid(jobId, 'jobId'), uuid(leaseToken, 'leaseToken'), worker(workerId), Boolean(retryable),
					 error?.code ? String(error.code).slice(0, 120) : null, detail]
				);
				return result.rows[0]?.status;
			});
		},

		async cancelRun(runId) {
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qa_execution_jobs SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancel_requested' END,
					 finished_at = CASE WHEN status = 'queued' THEN CURRENT_TIMESTAMP ELSE finished_at END,
					 updated_at = CURRENT_TIMESTAMP WHERE organization_id = $1 AND project_id = $2 AND run_id = $3
					 AND status IN ('queued', 'leased') RETURNING status`,
					[tenant.organizationId, tenant.projectId, uuid(runId, 'runId')]
				);
				return result.rows[0]?.status;
			});
		},

		async reapExhausted() {
			return transaction(async client => {
				const result = await client.query(
					`UPDATE qa_execution_jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
					 error_code = 'QASE_WORKER_LEASE_EXHAUSTED', error_detail = 'Worker lease expired after the maximum attempts.',
					 lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
					 WHERE organization_id = $1 AND project_id = $2 AND status = 'leased'
					 AND lease_expires_at <= CURRENT_TIMESTAMP AND attempts >= max_attempts RETURNING run_id`,
					[tenant.organizationId, tenant.projectId]
				);
				return result.rows.map(row => row.run_id);
			});
		},

		async check() {
			return transaction(async client => {
				await client.query('SELECT 1 FROM qa_execution_jobs WHERE organization_id = $1 AND project_id = $2 LIMIT 1',
					[tenant.organizationId, tenant.projectId]);
				return true;
			});
		},

		async stats() {
			return transaction(async client => {
				const counts = await client.query(
					`SELECT status, COUNT(*)::int AS count FROM qa_execution_jobs
					 WHERE organization_id = $1 AND project_id = $2 GROUP BY status`,
					[tenant.organizationId, tenant.projectId]
				);
				const timing = await client.query(
					`SELECT
					 COALESCE(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(available_at)
					  FILTER (WHERE status = 'queued' AND available_at <= CURRENT_TIMESTAMP))), 0)::float8
					  AS oldest_queued_age_seconds,
					 COUNT(*) FILTER (WHERE status IN ('leased', 'cancel_requested')
					  AND lease_expires_at <= CURRENT_TIMESTAMP)::int AS expired_leases
					 FROM qa_execution_jobs WHERE organization_id = $1 AND project_id = $2`,
					[tenant.organizationId, tenant.projectId]
				);
				const result = {
					queued: 0, leased: 0, cancel_requested: 0,
					succeeded: 0, failed: 0, cancelled: 0
				};
				for (const row of counts.rows) {
					if (Object.hasOwn(result, row.status)) result[row.status] = Number(row.count);
				}
				result.oldestQueuedAgeSeconds = Number(timing.rows[0]?.oldest_queued_age_seconds ?? 0);
				result.expiredLeases = Number(timing.rows[0]?.expired_leases ?? 0);
				return result;
			});
		}
	});
}
