import { createHash, randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]*$/;
const REFERENCE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;
const POLICY_VERSION_PATTERN = /^[a-z0-9][a-z0-9_.:/-]*$/;
const UNTRUSTED_CONTEXT_KEYS = ['body', 'headers', 'params', 'query', 'request', 'tenant', 'tenantId'];
const DAY_MS = 86_400_000;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLICY_VERSION = 'qase-data-lifecycle/v1';

export const PURGE_ACKNOWLEDGEMENT = 'PURGE_EXPIRED_RUNS';
export const AUTH_CLEANUP_ACKNOWLEDGEMENT = 'DELETE_EXPIRED_AUTH';
export const CLEANUP_ATTESTATION_ACKNOWLEDGEMENT = 'ATTEST_RUN_CLEANUP_COMPLETED';
export const DELETION_MANIFEST_VERSION = 1;

function canonicalUuid(value, label) {
	if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
		throw new TypeError(`${label} must be a canonical UUID.`);
	}
	return value.toLowerCase();
}

function trustedTenantContext(value) {
	if (!value || typeof value !== 'object' || !Object.isFrozen(value)) {
		throw new TypeError('Retention storage requires a frozen trusted tenant context.');
	}
	for (const key of UNTRUSTED_CONTEXT_KEYS) {
		if (Object.hasOwn(value, key)) {
			throw new TypeError('Retention storage rejects request-supplied tenant context.');
		}
	}
	return Object.freeze({
		organizationId: canonicalUuid(value.organizationId, 'organizationId'),
		projectId: canonicalUuid(value.projectId, 'projectId')
	});
}

function integer(value, fallback, minimum, maximum, label) {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
	}
	return parsed;
}

function code(value, fallback, maximum, label) {
	const result = String(value ?? fallback ?? '').trim();
	if (!result || result.length > maximum || !CODE_PATTERN.test(result)) {
		throw new TypeError(`${label} must be a bounded machine-readable code.`);
	}
	return result;
}

function reference(value) {
	if (value === undefined || value === null || value === '') return null;
	const result = String(value).trim();
	if (result.length > 200 || !REFERENCE_PATTERN.test(result)) {
		throw new TypeError('referenceId must be a bounded opaque reference.');
	}
	return result;
}

function requiredReference(value) {
	const result = reference(value);
	if (!result) throw new TypeError('referenceId is required.');
	return result;
}

function policyVersion(value) {
	const result = String(value ?? DEFAULT_POLICY_VERSION).trim();
	if (!result || result.length > 64 || !POLICY_VERSION_PATTERN.test(result)) {
		throw new TypeError('policyVersion must be a bounded machine-readable version.');
	}
	return result;
}

function actor(options = {}) {
	const type = code(options.actorType, 'system', 20, 'actorType');
	if (!['user', 'system', 'worker'].includes(type)) {
		throw new TypeError('actorType must be user, system, or worker.');
	}
	if (type === 'user') {
		return { type, userId: canonicalUuid(options.actorUserId, 'actorUserId') };
	}
	if (options.actorUserId !== undefined && options.actorUserId !== null) {
		throw new TypeError('Non-user lifecycle actors cannot include actorUserId.');
	}
	return { type, userId: null };
}

function timestamp(value, label = 'PostgreSQL transaction timestamp') {
	const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (Number.isNaN(result.getTime())) throw new TypeError(`${label} is invalid.`);
	return result;
}

function cutoffFrom(options, timestamp) {
	const retentionDays = integer(
		options.retentionDays,
		DEFAULT_RETENTION_DAYS,
		1,
		3650,
		'retentionDays'
	);
	return { retentionDays, cutoff: new Date(timestamp.getTime() - retentionDays * DAY_MS) };
}

function batchSize(options) {
	return integer(options.batchSize, DEFAULT_BATCH_SIZE, 1, 1000, 'batchSize');
}

function mutationMetadata(options, idFactory) {
	const lifecycleActor = actor(options);
	const correlationId = options.correlationId === undefined
		? canonicalUuid(idFactory(), 'generated correlationId')
		: canonicalUuid(options.correlationId, 'correlationId');
	return {
		actor: lifecycleActor,
		correlationId,
		reasonCode: code(options.reasonCode, 'retention_expired', 100, 'reasonCode'),
		referenceId: reference(options.referenceId),
		policyVersion: policyVersion(options.policyVersion)
	};
}

async function setScope(client, tenant) {
	await client.query(
		"SELECT set_config('qase.organization_id', $1, true), set_config('qase.project_id', $2, true)",
		[tenant.organizationId, tenant.projectId]
	);
}

async function databaseTimestamp(client) {
	const result = await client.query('SELECT CURRENT_TIMESTAMP AS current_timestamp');
	if (!result.rows?.[0]?.current_timestamp) {
		throw new Error('PostgreSQL did not return its transaction timestamp.');
	}
	return timestamp(result.rows[0].current_timestamp);
}

function acquired(result) {
	const value = result.rows?.[0]?.acquired;
	return value === true || value === 't' || value === 1 || value === '1';
}

function epoch(value) {
	return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function boundedCount(value, label) {
	const result = Number(value ?? 0);
	if (!Number.isSafeInteger(result) || result < 0) {
		throw new Error(`PostgreSQL returned an invalid ${label} deletion count.`);
	}
	return result;
}

function deletionManifest(runIds, resourceCounts, policyVersion) {
	const certificate = {
		version: DELETION_MANIFEST_VERSION,
		policyVersion,
		runIds: [...runIds].sort(),
		resourceCounts
	};
	return createHash('sha256').update(JSON.stringify(certificate), 'utf8').digest('hex');
}

/**
 * Tenant-scoped lifecycle operations. The tenant is constructor-bound and all
 * SQL also repeats the scope predicates so application checks and PostgreSQL
 * FORCE RLS independently fail closed.
 */
export function createPostgresRetentionRepository(options = {}) {
	const pool = options.pool;
	if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required.');
	const tenant = trustedTenantContext(options.tenantContext);
	const idFactory = options.idFactory ?? randomUUID;

	async function transaction({ readOnly = false } = {}, work) {
		const client = await pool.connect();
		if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
			throw new TypeError('The PostgreSQL pool returned an invalid client.');
		}
		try {
			await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
			await setScope(client, tenant);
			const result = await work(client);
			await client.query('COMMIT');
			return result;
		} catch (error) {
			await client.query('ROLLBACK').catch(() => undefined);
			throw error;
		} finally {
			client.release();
		}
	}

	async function tryLock(client, suffix) {
		const result = await client.query(
			'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired',
			[`${tenant.organizationId}:${tenant.projectId}:${suffix}`]
		);
		return acquired(result);
	}

	async function selectRunCandidates(client, cutoff, currentTimestamp, policyVersion, limit, lockRows) {
		const result = await client.query(
			`SELECT run.id, run.status, run.deleted_at
			 FROM qa_runs run
			 WHERE run.organization_id = $1 AND run.project_id = $2
				AND run.deleted_at IS NOT NULL AND run.deleted_at < $3
				AND EXISTS (
					SELECT 1 FROM qase_lifecycle_requests deletion_request
					WHERE deletion_request.organization_id = $1 AND deletion_request.project_id = $2
						AND deletion_request.subject_type = 'run'
						AND deletion_request.subject_id = run.id
						AND deletion_request.action = 'soft_delete'
						AND deletion_request.status = 'completed'
						AND deletion_request.purge_after <= $4
						AND deletion_request.policy_version = $5
				)
				AND EXISTS (
					SELECT 1 FROM qase_run_cleanup cleanup
					WHERE cleanup.organization_id = $1 AND cleanup.project_id = $2
						AND cleanup.run_id = run.id AND cleanup.status = 'completed'
						AND cleanup.completed_at <= $4 AND cleanup.policy_version = $5
				)
				AND NOT EXISTS (
					SELECT 1 FROM qa_run_legal_holds hold
					WHERE hold.organization_id = $1 AND hold.project_id = $2 AND hold.run_id = run.id
				)
				AND NOT EXISTS (
					SELECT 1 FROM qa_execution_jobs job
					WHERE job.organization_id = $1 AND job.project_id = $2 AND job.run_id = run.id
						AND job.status IN ('queued', 'leased', 'cancel_requested')
				)
				AND NOT EXISTS (
					SELECT 1 FROM qase_lifecycle_events hold_release
					WHERE hold_release.organization_id = $1 AND hold_release.project_id = $2
						AND hold_release.subject_type = 'run'
						AND hold_release.subject_id = run.id
						AND hold_release.event_type = 'legal_hold.released'
						AND hold_release.created_at >= $3
				)
			 ORDER BY run.deleted_at, run.id
			 ${lockRows ? 'FOR UPDATE OF run SKIP LOCKED' : ''}
			 LIMIT $6`,
			[tenant.organizationId, tenant.projectId, cutoff, currentTimestamp, policyVersion, limit]
		);
		return result.rows ?? [];
	}

	async function countPurgeResources(client, runIds) {
		const result = await client.query(
			`SELECT
				(SELECT COUNT(*)::bigint FROM qa_messages child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS messages,
				(SELECT COUNT(*)::bigint FROM qa_activities child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS activities,
				(SELECT COUNT(*)::bigint FROM qa_plan_items child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS plan_items,
				(SELECT COUNT(*)::bigint FROM qa_findings child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS findings,
				(SELECT COUNT(*)::bigint FROM qa_reports child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS reports,
				(SELECT COUNT(*)::bigint FROM qa_run_events child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS run_events,
				(SELECT COUNT(*)::bigint FROM qa_execution_jobs child
				 WHERE child.organization_id = $1 AND child.project_id = $2 AND child.run_id = ANY($3::uuid[])) AS execution_jobs`,
			[tenant.organizationId, tenant.projectId, runIds]
		);
		const row = result.rows?.[0];
		if (!row) throw new Error('PostgreSQL did not return purge resource counts.');
		return {
			runs: runIds.length,
			messages: boundedCount(row.messages, 'message'),
			activities: boundedCount(row.activities, 'activity'),
			planItems: boundedCount(row.plan_items, 'plan item'),
			findings: boundedCount(row.findings, 'finding'),
			reports: boundedCount(row.reports, 'report'),
			runEvents: boundedCount(row.run_events, 'run event'),
			executionJobs: boundedCount(row.execution_jobs, 'execution job')
		};
	}

	async function previewRuns(options = {}) {
		const retentionDays = integer(options.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650, 'retentionDays');
		const limit = batchSize(options);
		const selectedPolicyVersion = policyVersion(options.policyVersion);
		return transaction({ readOnly: true }, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			const cutoff = new Date(currentTimestamp.getTime() - retentionDays * DAY_MS);
			const rows = await selectRunCandidates(
				client, cutoff, currentTimestamp, selectedPolicyVersion, limit + 1, false
			);
			return {
				dryRun: true,
				retentionDays,
				cutoff: cutoff.getTime(),
				asOf: currentTimestamp.getTime(),
				policyVersion: selectedPolicyVersion,
				candidateCount: Math.min(rows.length, limit),
				hasMore: rows.length > limit,
				candidates: rows.slice(0, limit).map(row => ({
					runId: row.id,
					status: row.status,
					deletedAt: epoch(row.deleted_at)
				}))
			};
		});
	}

	async function existingPurgeRequest(client, idempotencyKey) {
		const result = await client.query(
			`SELECT id, status, correlation_id, reason_code, reference_id, policy_version
			 FROM qase_lifecycle_requests
			 WHERE organization_id = $1 AND project_id = $2 AND action = 'purge'
				AND subject_type = 'project' AND subject_id = $2 AND idempotency_key = $3
			 FOR UPDATE`,
			[tenant.organizationId, tenant.projectId, idempotencyKey]
		);
		return result.rows?.[0];
	}

	function duplicatePurge(row, metadata) {
		const correlationId = row.correlation_id ? canonicalUuid(row.correlation_id, 'stored correlationId') : null;
		if (row.reason_code !== metadata.reasonCode
			|| row.reference_id !== metadata.referenceId
			|| row.policy_version !== metadata.policyVersion
			|| correlationId !== metadata.correlationId) {
			const error = new Error('The purge idempotency key is already bound to different request metadata.');
			error.code = 'QASE_LIFECYCLE_IDEMPOTENCY_CONFLICT';
			throw error;
		}
		return {
			dryRun: false,
			busy: false,
			duplicate: true,
			purgedCount: 0,
			requestId: row.id,
			status: row.status,
			correlationId: metadata.correlationId
		};
	}

	async function purgeBatch(options = {}) {
		if (options.execute !== true) return previewRuns(options);
		if (options.acknowledgement !== PURGE_ACKNOWLEDGEMENT) {
			throw new TypeError(`Executing purge requires acknowledgement=${PURGE_ACKNOWLEDGEMENT}.`);
		}
		const retentionDays = integer(options.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650, 'retentionDays');
		const limit = batchSize(options);
		const purgeReference = requiredReference(options.referenceId);
		const selectedPolicyVersion = policyVersion(options.policyVersion);
		const metadata = mutationMetadata({
			...options,
			referenceId: purgeReference,
			policyVersion: selectedPolicyVersion
		}, idFactory);
		const requestId = canonicalUuid(idFactory(), 'generated lifecycle request id');
		const leaseToken = canonicalUuid(idFactory(), 'generated lifecycle lease token');
		const idempotencyKey = code(options.idempotencyKey, undefined, 200, 'idempotencyKey');

		return transaction({}, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			const cutoff = new Date(currentTimestamp.getTime() - retentionDays * DAY_MS);
			const leaseExpiresAt = new Date(currentTimestamp.getTime() + 300_000);
			if (!await tryLock(client, 'retention')) {
				return { dryRun: false, busy: true, purgedCount: 0, correlationId: metadata.correlationId };
			}
			const existing = await existingPurgeRequest(client, idempotencyKey);
			if (existing) return duplicatePurge(existing, metadata);
			const rows = await selectRunCandidates(
				client, cutoff, currentTimestamp, metadata.policyVersion, limit, true
			);
			const runIds = rows.map(row => canonicalUuid(row.id, 'candidate run id'));
			if (runIds.length === 0) {
				return {
					dryRun: false, busy: false, purgedCount: 0, hasMore: false,
					correlationId: metadata.correlationId
				};
			}
			const resourceCounts = await countPurgeResources(client, runIds);
			const manifestSha256 = deletionManifest(
				runIds,
				resourceCounts,
				metadata.policyVersion
			);

			const insertedRequest = await client.query(
				`INSERT INTO qase_lifecycle_requests (
					id, organization_id, project_id, subject_type, subject_id, action,
					idempotency_key, requested_by_actor_type, requested_by_user_id,
					reason_code, reference_id, policy_version, purge_after, available_at,
					correlation_id, created_at, updated_at
				) VALUES ($1, $2, $3, 'project', $3, 'purge', $4, $5, $6, $7, $8, $9, $10, $10, $11, $10, $10)
				ON CONFLICT (organization_id, project_id, action, subject_type, subject_id, idempotency_key)
				DO NOTHING RETURNING id`,
				[
					requestId, tenant.organizationId, tenant.projectId, idempotencyKey,
					metadata.actor.type, metadata.actor.userId, metadata.reasonCode,
					metadata.referenceId, metadata.policyVersion, currentTimestamp, metadata.correlationId
				]
			);
			if (!insertedRequest.rows?.length) {
				const duplicate = await existingPurgeRequest(client, idempotencyKey);
				if (!duplicate) throw new Error('Purge idempotency conflict could not be resolved.');
				return duplicatePurge(duplicate, metadata);
			}
			await client.query(
				`UPDATE qase_lifecycle_requests SET status = 'approved', updated_at = $4
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND status = 'requested'`,
				[tenant.organizationId, tenant.projectId, requestId, currentTimestamp]
			);
			await client.query(
				`UPDATE qase_lifecycle_requests SET status = 'processing', attempts = attempts + 1,
					lease_owner = 'qase-retention', lease_token = $5, lease_expires_at = $6,
					started_at = COALESCE(started_at, $4), updated_at = $4
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3 AND status = 'approved'`,
				[tenant.organizationId, tenant.projectId, requestId, currentTimestamp, leaseToken, leaseExpiresAt]
			);

			await client.query(
				`INSERT INTO qase_erasure_tombstones (
					organization_id, project_id, subject_type, subject_id, lifecycle_request_id,
					erased_at, reason_code, reference_id, manifest_sha256, policy_version, correlation_id
				)
				SELECT $1, $2, 'run', candidate.run_id, $4, $5, $6, $7, $8, $9, $10
				FROM unnest($3::uuid[]) AS candidate(run_id)`,
				[
					tenant.organizationId, tenant.projectId, runIds, requestId, currentTimestamp,
					metadata.reasonCode, metadata.referenceId, manifestSha256,
					metadata.policyVersion, metadata.correlationId
				]
			);
			await client.query(
				`INSERT INTO qase_lifecycle_events (
					organization_id, project_id, request_id, subject_type, subject_id,
					action, event_type, from_status, to_status, actor_type, actor_user_id,
					reason_code, reference_id, resource_counts, manifest_sha256,
					correlation_id, policy_version, created_at
				) VALUES ($1, $2, $3, 'project', $2, 'purge', 'retention.purge_completed',
					'processing', 'completed', $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
				[
					tenant.organizationId, tenant.projectId, requestId, metadata.actor.type,
					metadata.actor.userId, metadata.reasonCode, metadata.referenceId,
					JSON.stringify(resourceCounts), manifestSha256, metadata.correlationId,
					metadata.policyVersion, currentTimestamp
				]
			);

			const deleted = await client.query(
				`DELETE FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])
					AND deleted_at IS NOT NULL
				 RETURNING id`,
				[tenant.organizationId, tenant.projectId, runIds]
			);
			if (deleted.rowCount !== runIds.length) {
				throw new Error('Retention purge candidate set changed before deletion.');
			}
			const completed = await client.query(
				`UPDATE qase_lifecycle_requests SET status = 'completed', finished_at = $4,
					lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = $4
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3
					AND status = 'processing' AND lease_token = $5`,
				[tenant.organizationId, tenant.projectId, requestId, currentTimestamp, leaseToken]
			);
			if (completed.rowCount !== 1) throw new Error('Lifecycle request could not be completed.');
			return {
				dryRun: false,
				busy: false,
				retentionDays,
				cutoff: cutoff.getTime(),
				purgedCount: runIds.length,
				hasMore: runIds.length === limit,
				requestId,
				correlationId: metadata.correlationId,
				runIds,
				resourceCounts,
				manifestSha256
			};
		});
	}

	async function placeHold(options = {}) {
		const runId = canonicalUuid(options.runId, 'runId');
		const holdReference = requiredReference(options.referenceId);
		const holdReasonCode = code(options.reasonCode, undefined, 100, 'reasonCode');
		const metadata = mutationMetadata({
			...options,
			reasonCode: holdReasonCode,
			referenceId: holdReference
		}, idFactory);
		const holdId = canonicalUuid(idFactory(), 'generated legal hold id');
		return transaction({}, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			if (!await tryLock(client, 'retention')) {
				return { placed: false, busy: true, runId, correlationId: metadata.correlationId };
			}
			const run = await client.query(
				`SELECT id FROM qa_runs
				 WHERE organization_id = $1 AND project_id = $2 AND id = $3
				 FOR UPDATE`,
				[tenant.organizationId, tenant.projectId, runId]
			);
			if (!run.rows?.length) {
				return { placed: false, busy: false, reason: 'not_found', runId, correlationId: metadata.correlationId };
			}
			const inserted = await client.query(
				`INSERT INTO qa_run_legal_holds (
					id, organization_id, project_id, run_id, reason_code, reference_id,
					policy_version, placed_by_actor_type, placed_by_user_id, placed_at, correlation_id
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				ON CONFLICT (organization_id, project_id, run_id, reference_id) DO NOTHING
				RETURNING id, run_id`,
				[
					holdId, tenant.organizationId, tenant.projectId, runId, metadata.reasonCode,
					metadata.referenceId, metadata.policyVersion, metadata.actor.type,
					metadata.actor.userId, currentTimestamp, metadata.correlationId
				]
			);
			if (!inserted.rows?.length) {
				return { placed: false, busy: false, reason: 'already_held', runId, correlationId: metadata.correlationId };
			}
			await client.query(
				`INSERT INTO qase_lifecycle_events (
					organization_id, project_id, subject_type, subject_id, action, event_type,
					to_status, actor_type, actor_user_id, reason_code, reference_id,
					resource_counts, correlation_id, policy_version, created_at
				) VALUES ($1, $2, 'run', $3, 'legal_hold', 'legal_hold.placed', 'held',
					$4, $5, $6, $7, '{}'::jsonb, $8, $9, $10)`,
				[
					tenant.organizationId, tenant.projectId, runId, metadata.actor.type,
					metadata.actor.userId, metadata.reasonCode, metadata.referenceId,
					metadata.correlationId, metadata.policyVersion, currentTimestamp
				]
			);
			return { placed: true, busy: false, holdId, runId, correlationId: metadata.correlationId };
		});
	}

	async function releaseHold(options = {}) {
		const runId = canonicalUuid(options.runId, 'runId');
		const holdReference = requiredReference(options.referenceId);
		const metadata = mutationMetadata({
			...options,
			referenceId: holdReference,
			reasonCode: options.reasonCode ?? 'legal_hold_released'
		}, idFactory);
		return transaction({}, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			if (!await tryLock(client, 'retention')) {
				return { released: false, busy: true, runId, correlationId: metadata.correlationId };
			}
			const removed = await client.query(
				`DELETE FROM qa_run_legal_holds
				 WHERE organization_id = $1 AND project_id = $2 AND run_id = $3 AND reference_id = $4
				 RETURNING id, policy_version`,
				[tenant.organizationId, tenant.projectId, runId, metadata.referenceId]
			);
			if (!removed.rows?.length) {
				return { released: false, busy: false, reason: 'not_held', runId, correlationId: metadata.correlationId };
			}
			await client.query(
				`INSERT INTO qase_lifecycle_events (
					organization_id, project_id, subject_type, subject_id, action, event_type,
					from_status, actor_type, actor_user_id, reason_code, reference_id,
					resource_counts, correlation_id, policy_version, created_at
				) VALUES ($1, $2, 'run', $3, 'legal_hold', 'legal_hold.released', 'held',
					$4, $5, $6, $7, '{}'::jsonb, $8, $9, $10)`,
				[
					tenant.organizationId, tenant.projectId, runId, metadata.actor.type,
					metadata.actor.userId, metadata.reasonCode, metadata.referenceId,
					metadata.correlationId, removed.rows[0].policy_version, currentTimestamp
				]
			);
			return {
				released: true, busy: false, holdId: removed.rows[0].id,
				runId, correlationId: metadata.correlationId
			};
		});
	}

	async function attestRunCleanup(options = {}) {
		if (options.execute !== true) {
			throw new TypeError('Cleanup attestation is apply-only and requires execute=true.');
		}
		if (options.acknowledgement !== CLEANUP_ATTESTATION_ACKNOWLEDGEMENT) {
			throw new TypeError(
				`Cleanup attestation requires acknowledgement=${CLEANUP_ATTESTATION_ACKNOWLEDGEMENT}.`
			);
		}
		const runId = canonicalUuid(options.runId, 'runId');
		const cleanupReference = requiredReference(options.referenceId);
		const selectedPolicyVersion = policyVersion(options.policyVersion);
		const metadata = mutationMetadata({
			...options,
			referenceId: cleanupReference,
			policyVersion: selectedPolicyVersion,
			reasonCode: options.reasonCode ?? 'external_cleanup_completed'
		}, idFactory);
		return transaction({}, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			if (!await tryLock(client, 'retention')) {
				return { attested: false, busy: true, runId, correlationId: metadata.correlationId };
			}
			const eligible = await client.query(
				`SELECT run.id FROM qa_runs run
				 WHERE run.organization_id = $1 AND run.project_id = $2 AND run.id = $3
					AND run.deleted_at IS NOT NULL
					AND EXISTS (
						SELECT 1 FROM qase_lifecycle_requests deletion_request
						WHERE deletion_request.organization_id = $1 AND deletion_request.project_id = $2
							AND deletion_request.subject_type = 'run' AND deletion_request.subject_id = run.id
							AND deletion_request.action = 'soft_delete'
							AND deletion_request.status = 'completed'
							AND deletion_request.policy_version = $4
							AND deletion_request.finished_at <= $5
					)
				 FOR UPDATE OF run`,
				[
					tenant.organizationId, tenant.projectId, runId,
					metadata.policyVersion, currentTimestamp
				]
			);
			if (!eligible.rows?.length) {
				return {
					attested: false, busy: false, reason: 'not_eligible',
					runId, correlationId: metadata.correlationId
				};
			}

			const cleanup = await client.query(
				`SELECT status, request_reference_id, attestation_reference_id,
					policy_version, correlation_id
				 FROM qase_run_cleanup
				 WHERE organization_id = $1 AND project_id = $2 AND run_id = $3
				 FOR UPDATE`,
				[tenant.organizationId, tenant.projectId, runId]
			);
			const row = cleanup.rows?.[0];
			if (!row) {
				return {
					attested: false, busy: false, reason: 'cleanup_not_requested',
					runId, correlationId: metadata.correlationId
				};
			}
			if (row.policy_version !== metadata.policyVersion) {
				const error = new Error('Run cleanup is bound to a different lifecycle policy.');
				error.code = 'QASE_CLEANUP_ATTESTATION_CONFLICT';
				throw error;
			}
			if (row.status === 'completed') {
				if (row.attestation_reference_id !== metadata.referenceId) {
					const error = new Error('Run cleanup is already attested by a different reference.');
					error.code = 'QASE_CLEANUP_ATTESTATION_CONFLICT';
					throw error;
				}
				return {
					attested: true, duplicate: true, busy: false,
					runId, correlationId: metadata.correlationId
				};
			}
			if (row.attestation_reference_id !== null && row.attestation_reference_id !== undefined) {
				throw new Error('Pending run cleanup unexpectedly contains an attestation reference.');
			}
			const completed = await client.query(
				`UPDATE qase_run_cleanup SET status = 'completed', attempts = attempts + 1,
					last_attempt_at = $4, completed_at = $4, last_error_code = NULL,
					attestation_reference_id = $5
				 WHERE organization_id = $1 AND project_id = $2 AND run_id = $3
					AND status IN ('pending', 'failed') AND attestation_reference_id IS NULL
					AND policy_version = $6
				 RETURNING status`,
				[
					tenant.organizationId, tenant.projectId, runId, currentTimestamp,
					metadata.referenceId, metadata.policyVersion
				]
			);
			if (completed.rowCount !== 1) throw new Error('Run cleanup attestation could not be completed.');
			await client.query(
				`INSERT INTO qase_lifecycle_events (
					organization_id, project_id, subject_type, subject_id, action, event_type,
					to_status, actor_type, actor_user_id, reason_code, reference_id,
					resource_counts, correlation_id, policy_version, created_at
				) VALUES ($1, $2, 'run', $3, 'external_cleanup', 'run.cleanup_attested',
					'completed', $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
				[
					tenant.organizationId, tenant.projectId, runId, metadata.actor.type,
					metadata.actor.userId, metadata.reasonCode, metadata.referenceId,
					JSON.stringify({ cleanupAttestations: 1 }), metadata.correlationId,
					metadata.policyVersion, currentTimestamp
				]
			);
			return {
				attested: true, duplicate: false, busy: false,
				runId, correlationId: metadata.correlationId
			};
		});
	}

	async function previewExpiredAuth(client, timestamp, limit) {
		const sessions = await client.query(
			`SELECT id FROM qase_auth_sessions
			 WHERE organization_id = $1 AND project_id = $2
				AND (expires_at < $3 OR (revoked_at IS NOT NULL AND revoked_at < $3 - INTERVAL '7 days'))
			 ORDER BY LEAST(expires_at, COALESCE(revoked_at, expires_at)), id
			 LIMIT $4`,
			[tenant.organizationId, tenant.projectId, timestamp, limit + 1]
		);
		const sessionCount = Math.min(sessions.rows?.length ?? 0, limit);
		if ((sessions.rows?.length ?? 0) > limit) {
			return { authSessions: sessionCount, tokenExchanges: 0, hasMore: true };
		}
		const remaining = limit - sessionCount;
		if (remaining === 0) {
			const exchangeExists = await client.query(
				`SELECT 1 FROM drytis_token_exchanges
				 WHERE organization_id = $1 AND project_id = $2 AND expires_at < $3
				 LIMIT 1`,
				[tenant.organizationId, tenant.projectId, timestamp]
			);
			return {
				authSessions: sessionCount,
				tokenExchanges: 0,
				hasMore: (exchangeExists.rows?.length ?? 0) > 0
			};
		}
		const exchanges = await client.query(
			`SELECT issuer, jti FROM drytis_token_exchanges
			 WHERE organization_id = $1 AND project_id = $2 AND expires_at < $3
			 ORDER BY expires_at, issuer, jti
			 LIMIT $4`,
			[tenant.organizationId, tenant.projectId, timestamp, remaining + 1]
		);
		return {
			authSessions: sessionCount,
			tokenExchanges: Math.min(exchanges.rows?.length ?? 0, remaining),
			hasMore: (exchanges.rows?.length ?? 0) > remaining
		};
	}

	async function cleanupExpiredAuth(options = {}) {
		const limit = batchSize(options);
		if (options.execute !== true) {
			return transaction({ readOnly: true }, async client => {
				const currentTimestamp = await databaseTimestamp(client);
				return {
					dryRun: true,
					asOf: currentTimestamp.getTime(),
					...(await previewExpiredAuth(client, currentTimestamp, limit))
				};
			});
		}
		if (options.acknowledgement !== AUTH_CLEANUP_ACKNOWLEDGEMENT) {
			throw new TypeError(`Executing auth cleanup requires acknowledgement=${AUTH_CLEANUP_ACKNOWLEDGEMENT}.`);
		}
		const metadata = mutationMetadata({
			...options,
			reasonCode: options.reasonCode ?? 'auth_retention_expired'
		}, idFactory);
		return transaction({}, async client => {
			const currentTimestamp = await databaseTimestamp(client);
			if (!await tryLock(client, 'auth-retention')) {
				return {
					dryRun: false, busy: true, authSessions: 0, tokenExchanges: 0,
					correlationId: metadata.correlationId
				};
			}
			const sessions = await client.query(
				`DELETE FROM qase_auth_sessions WHERE ctid IN (
					SELECT ctid FROM qase_auth_sessions
					WHERE organization_id = $1 AND project_id = $2
						AND (expires_at < $3 OR (revoked_at IS NOT NULL AND revoked_at < $3 - INTERVAL '7 days'))
					ORDER BY LEAST(expires_at, COALESCE(revoked_at, expires_at)), id
					FOR UPDATE SKIP LOCKED LIMIT $4
				) RETURNING id`,
				[tenant.organizationId, tenant.projectId, currentTimestamp, limit]
			);
			const authSessions = Number(sessions.rowCount ?? sessions.rows?.length ?? 0);
			const remaining = Math.max(0, limit - authSessions);
			let tokenExchanges = 0;
			if (remaining > 0) {
				const exchanges = await client.query(
					`DELETE FROM drytis_token_exchanges WHERE ctid IN (
						SELECT ctid FROM drytis_token_exchanges
						WHERE organization_id = $1 AND project_id = $2 AND expires_at < $3
						ORDER BY expires_at, issuer, jti
						FOR UPDATE SKIP LOCKED LIMIT $4
					) RETURNING issuer`,
					[tenant.organizationId, tenant.projectId, currentTimestamp, remaining]
				);
				tokenExchanges = Number(exchanges.rowCount ?? exchanges.rows?.length ?? 0);
			}
			if (authSessions + tokenExchanges > 0) {
				await client.query(
					`INSERT INTO qase_lifecycle_events (
						organization_id, project_id, subject_type, subject_id, action, event_type,
						actor_type, actor_user_id, reason_code, reference_id, resource_counts,
						correlation_id, policy_version, created_at
					) VALUES ($1, $2, 'project', $2, 'auth_retention', 'auth.expired_cleanup_completed',
						$3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
					[
						tenant.organizationId, tenant.projectId, metadata.actor.type,
						metadata.actor.userId, metadata.reasonCode, metadata.referenceId,
						JSON.stringify({ authSessions, tokenExchanges }), metadata.correlationId,
						metadata.policyVersion, currentTimestamp
					]
				);
			}
			return {
				dryRun: false, busy: false, authSessions, tokenExchanges,
				hasMore: authSessions + tokenExchanges === limit,
				correlationId: metadata.correlationId
			};
		});
	}

	return Object.freeze({
		previewRuns,
		purgeBatch,
		placeHold,
		releaseHold,
		attestRunCleanup,
		cleanupExpiredAuth
	});
}
