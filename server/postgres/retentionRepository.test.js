import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
	AUTH_CLEANUP_ACKNOWLEDGEMENT,
	CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
	DELETION_MANIFEST_VERSION,
	PURGE_ACKNOWLEDGEMENT,
	createPostgresRetentionRepository
} from './retentionRepository.js';

const NOW = 1_900_000_000_000;
const TENANT = Object.freeze({
	organizationId: '8c135239-cc6d-4e29-9f31-d40755137811',
	projectId: '63e57ec3-5a83-4491-9706-2ce61763f7d1'
});
const RUN_A = 'f24010d2-78bf-43f7-a1e1-8f127df3042c';
const RUN_B = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const CORRELATION = 'fb139801-54e8-4289-ad10-f70c92967967';
const REQUEST = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';
const LEASE = '9e2fb678-423e-41a0-ae19-e9cae143c606';
const USER = '5f75d329-68f5-4599-b235-f0d47f34a4a1';

function fixture(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	let connects = 0;
	const client = {
		async query(text, params = []) {
			const call = { text: text.trim(), params };
			calls.push(call);
			if (call.text === 'SELECT CURRENT_TIMESTAMP AS current_timestamp') {
				return { rows: [{ current_timestamp: new Date(NOW) }], rowCount: 1 };
			}
			return await handler(call, calls) ?? { rows: [], rowCount: 0 };
		},
		release() { calls.push({ text: 'RELEASE', params: [] }); }
	};
	return {
		calls,
		get connects() { return connects; },
		pool: { async connect() { connects++; return client; } }
	};
}

function repository(target, options = {}) {
	const ids = [...(options.ids ?? [REQUEST, LEASE])];
	return createPostgresRetentionRepository({
		pool: target.pool,
		tenantContext: options.tenantContext ?? TENANT,
		idFactory: () => ids.shift() ?? REQUEST
	});
}

function scopedTransaction(calls, readOnly = false) {
	assert.equal(calls[0].text, readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
	assert.match(calls[1].text, /set_config\('qase\.organization_id'/);
	assert.deepEqual(calls[1].params, [TENANT.organizationId, TENANT.projectId]);
	assert.equal(calls.at(-2).text, 'COMMIT');
	assert.equal(calls.at(-1).text, 'RELEASE');
}

test('constructor accepts only a frozen trusted tenant and validates bounded inputs before connecting', async () => {
	const target = fixture();
	assert.throws(() => createPostgresRetentionRepository({
		pool: target.pool,
		tenantContext: { ...TENANT }
	}), /frozen trusted tenant/);
	assert.throws(() => createPostgresRetentionRepository({
		pool: target.pool,
		tenantContext: Object.freeze({ ...TENANT, body: { projectId: RUN_A } })
	}), /request-supplied tenant/);
	const value = repository(target);
	await assert.rejects(() => value.previewRuns({ batchSize: 0 }), /batchSize/);
	await assert.rejects(() => value.previewRuns({ retentionDays: 3651 }), /retentionDays/);
	await assert.rejects(() => value.placeHold({ runId: 'not-a-uuid' }), /canonical UUID/);
	await assert.rejects(() => value.placeHold({ runId: RUN_A, referenceId: 'case/123' }), /reasonCode/);
	await assert.rejects(() => value.placeHold({ runId: RUN_A, reasonCode: 'legal' }), /referenceId/);
	await assert.rejects(() => value.placeHold({
		runId: RUN_A, actorType: 'user', reasonCode: 'legal', referenceId: 'case/123',
		policyVersion: 'qase-data-lifecycle/v1'
	}), /actorUserId/);
	assert.equal(target.connects, 0);
});

test('preview is a bounded tenant-scoped read-only path that excludes holds and active jobs', async () => {
	const deletedAt = new Date(NOW - 40 * 86_400_000);
	const target = fixture(call => call.text.startsWith('SELECT run.id')
		? {
			rows: [
				{ id: RUN_A, status: 'done', deleted_at: deletedAt },
				{ id: RUN_B, status: 'interrupted', deleted_at: deletedAt }
			],
			rowCount: 2
		}
		: { rows: [], rowCount: 0 });
	const result = await repository(target).previewRuns({ retentionDays: 30, batchSize: 1 });

	assert.equal(result.dryRun, true);
	assert.equal(result.candidateCount, 1);
	assert.equal(result.hasMore, true);
	assert.deepEqual(result.candidates, [{ runId: RUN_A, status: 'done', deletedAt: deletedAt.getTime() }]);
	const select = target.calls.find(call => call.text.startsWith('SELECT run.id'));
	assert.match(select.text, /run\.organization_id = \$1 AND run\.project_id = \$2/);
	assert.match(select.text, /run\.deleted_at IS NOT NULL AND run\.deleted_at < \$3/);
	assert.match(select.text, /deletion_request\.action = 'soft_delete'/);
	assert.match(select.text, /deletion_request\.status = 'completed'/);
	assert.match(select.text, /deletion_request\.purge_after <= \$4/);
	assert.match(select.text, /deletion_request\.policy_version = \$5/);
	assert.match(select.text, /FROM qase_run_cleanup cleanup/);
	assert.match(select.text, /cleanup\.status = 'completed'/);
	assert.match(select.text, /cleanup\.policy_version = \$5/);
	assert.match(select.text, /FROM qa_run_legal_holds/);
	assert.match(select.text, /hold_release\.event_type = 'legal_hold\.released'/);
	assert.match(select.text, /job\.status IN \('queued', 'leased', 'cancel_requested'\)/);
	assert.doesNotMatch(select.text, /FOR UPDATE|SKIP LOCKED/);
	assert.equal(select.params[3].getTime(), NOW, 'eligibility uses the PostgreSQL transaction clock');
	assert.equal(select.params[4], 'qase-data-lifecycle/v1');
	assert.equal(select.params[5], 2, 'preview asks for one bounded look-ahead row');
	assert.equal(target.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), false);
	assert.equal(target.calls.some(call => call.text.includes('pg_try_advisory')), false);
	scopedTransaction(target.calls, true);
});

test('purge defaults to the same read-only preview and requires an exact execution acknowledgement', async () => {
	const target = fixture(call => call.text.startsWith('SELECT run.id')
		? { rows: [], rowCount: 0 }
		: { rows: [], rowCount: 0 });
	const value = repository(target);
	assert.equal((await value.purgeBatch()).dryRun, true);
	assert.equal(target.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), false);

	const rejected = fixture();
	await assert.rejects(() => repository(rejected).purgeBatch({ execute: true }), /acknowledgement/);
	await assert.rejects(() => repository(rejected).purgeBatch({
		execute: true, acknowledgement: PURGE_ACKNOWLEDGEMENT
	}), /referenceId/);
	await assert.rejects(() => repository(rejected).purgeBatch({
		execute: true, acknowledgement: PURGE_ACKNOWLEDGEMENT, referenceId: 'change/123'
	}), /idempotencyKey/);
	assert.equal(rejected.connects, 0);
});

test('execute purge locks, records request/tombstones/event, then deletes only parent runs atomically', async () => {
	const deletedAt = new Date(NOW - 40 * 86_400_000);
	const resourceCounts = {
		runs: 2, messages: 8, activities: 6, planItems: 4,
		findings: 3, reports: 2, runEvents: 10, executionJobs: 2
	};
	const target = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT run.id')) return {
			rows: [
				{ id: RUN_A, status: 'done', deleted_at: deletedAt },
				{ id: RUN_B, status: 'error', deleted_at: deletedAt }
			],
			rowCount: 2
		};
		if (call.text.startsWith('DELETE FROM qa_runs')) {
			return { rows: [{ id: RUN_A }, { id: RUN_B }], rowCount: 2 };
		}
		if (call.text.startsWith('INSERT INTO qase_lifecycle_requests')) {
			return { rows: [{ id: REQUEST }], rowCount: 1 };
		}
		if (call.text.startsWith('SELECT') && call.text.includes('AS execution_jobs')) {
			return { rows: [{
				messages: '8', activities: '6', plan_items: '4', findings: '3',
				reports: '2', run_events: '10', execution_jobs: '2'
			}], rowCount: 1 };
		}
		if (call.text.startsWith('UPDATE qase_lifecycle_requests')) return { rows: [], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	const result = await repository(target).purgeBatch({
		execute: true,
		acknowledgement: PURGE_ACKNOWLEDGEMENT,
		retentionDays: 30,
		batchSize: 2,
		correlationId: CORRELATION,
		reasonCode: 'retention_expired',
		referenceId: 'change/123',
		idempotencyKey: 'cycle-001'
	});

	assert.equal(result.purgedCount, 2);
	assert.deepEqual(result.runIds, [RUN_A, RUN_B]);
	assert.deepEqual(result.resourceCounts, resourceCounts);
	const expectedManifest = createHash('sha256').update(JSON.stringify({
		version: DELETION_MANIFEST_VERSION,
		policyVersion: 'qase-data-lifecycle/v1',
		runIds: [RUN_B, RUN_A].sort(),
		resourceCounts
	}), 'utf8').digest('hex');
	assert.equal(result.manifestSha256, expectedManifest);
	const lock = target.calls.find(call => call.text.startsWith('SELECT pg_try_advisory'));
	assert.equal(lock.params[0], `${TENANT.organizationId}:${TENANT.projectId}:retention`);
	const candidate = target.calls.find(call => call.text.startsWith('SELECT run.id'));
	assert.match(candidate.text, /FOR UPDATE OF run SKIP LOCKED/);
	const countQuery = target.calls.find(call => call.text.includes('AS execution_jobs'));
	assert.deepEqual(countQuery.params, [TENANT.organizationId, TENANT.projectId, [RUN_A, RUN_B]]);
	for (const table of [
		'qa_messages', 'qa_activities', 'qa_plan_items', 'qa_findings',
		'qa_reports', 'qa_run_events', 'qa_execution_jobs'
	]) assert.match(countQuery.text, new RegExp(`FROM ${table}`));
	const requestIndex = target.calls.findIndex(call => call.text.startsWith('INSERT INTO qase_lifecycle_requests'));
	const tombstoneIndex = target.calls.findIndex(call => call.text.startsWith('INSERT INTO qase_erasure_tombstones'));
	const eventIndex = target.calls.findIndex(call => call.text.startsWith('INSERT INTO qase_lifecycle_events'));
	const deleteIndex = target.calls.findIndex(call => call.text.startsWith('DELETE FROM qa_runs'));
	assert.ok(requestIndex < tombstoneIndex && tombstoneIndex < eventIndex && eventIndex < deleteIndex);
	assert.match(target.calls[requestIndex].text, /'project', \$3, 'purge'/);
	assert.match(target.calls[requestIndex].text, /ON CONFLICT[\s\S]+DO NOTHING RETURNING id/);
	assert.doesNotMatch(target.calls[requestIndex].text, /status/,
		'trigger-enforced requested status must come from the table default');
	assert.equal(target.calls[requestIndex].params[8], 'qase-data-lifecycle/v1');
	assert.deepEqual(target.calls[tombstoneIndex].params[2], [RUN_A, RUN_B]);
	assert.equal(target.calls[tombstoneIndex].params[7], expectedManifest);
	assert.equal(target.calls[eventIndex].params[7], JSON.stringify(resourceCounts));
	assert.equal(target.calls[eventIndex].params[8], expectedManifest);
	const deletion = target.calls[deleteIndex];
	assert.match(deletion.text, /^DELETE FROM qa_runs/);
	assert.match(deletion.text, /organization_id = \$1 AND project_id = \$2/);
	assert.equal(target.calls.some(call => /^DELETE FROM qa_(messages|activities|plan_items|findings|reports|run_events|execution_jobs)/.test(call.text)), false);
	scopedTransaction(target.calls);
});

test('purge idempotency returns an existing request safely and rejects metadata reuse', async () => {
	const existingRow = {
		id: REQUEST,
		status: 'completed',
		correlation_id: CORRELATION,
		reason_code: 'retention_expired',
		reference_id: 'change/123',
		policy_version: 'qase-data-lifecycle/v1'
	};
	const target = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT id, status, correlation_id')) {
			return { rows: [existingRow], rowCount: 1 };
		}
		return { rows: [], rowCount: 0 };
	});
	const value = repository(target);
	const duplicate = await value.purgeBatch({
		execute: true,
		acknowledgement: PURGE_ACKNOWLEDGEMENT,
		referenceId: 'change/123',
		idempotencyKey: 'cycle-001',
		correlationId: CORRELATION
	});
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicate.requestId, REQUEST);
	assert.equal(target.calls.some(call => call.text.startsWith('SELECT run.id')), false);
	assert.equal(target.calls.some(call => call.text.startsWith('DELETE FROM qa_runs')), false);

	const conflict = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT id, status, correlation_id')) {
			return { rows: [existingRow], rowCount: 1 };
		}
		return { rows: [], rowCount: 0 };
	});
	await assert.rejects(() => repository(conflict).purgeBatch({
		execute: true,
		acknowledgement: PURGE_ACKNOWLEDGEMENT,
		referenceId: 'change/other',
		idempotencyKey: 'cycle-001',
		correlationId: CORRELATION
	}), error => error.code === 'QASE_LIFECYCLE_IDEMPOTENCY_CONFLICT');
	assert.equal(conflict.calls.at(-2).text, 'ROLLBACK');
});

test('a busy purge is a committed no-op and a changed candidate set rolls everything back', async () => {
	const busy = fixture(call => call.text.startsWith('SELECT pg_try_advisory')
		? { rows: [{ acquired: false }], rowCount: 1 }
		: { rows: [], rowCount: 0 });
	const busyResult = await repository(busy).purgeBatch({
		execute: true, acknowledgement: PURGE_ACKNOWLEDGEMENT, correlationId: CORRELATION,
		referenceId: 'change/123', idempotencyKey: 'cycle-busy'
	});
	assert.deepEqual(busyResult, {
		dryRun: false, busy: true, purgedCount: 0, correlationId: CORRELATION
	});
	assert.equal(busy.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), false);
	scopedTransaction(busy.calls);

	const changed = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT run.id')) return {
			rows: [{ id: RUN_A, status: 'done', deleted_at: new Date(NOW - 40 * 86_400_000) }], rowCount: 1
		};
		if (call.text.startsWith('DELETE FROM qa_runs')) return { rows: [], rowCount: 0 };
		if (call.text.startsWith('INSERT INTO qase_lifecycle_requests')) {
			return { rows: [{ id: REQUEST }], rowCount: 1 };
		}
		if (call.text.startsWith('SELECT') && call.text.includes('AS execution_jobs')) {
			return { rows: [{
				messages: '0', activities: '0', plan_items: '0', findings: '0',
				reports: '0', run_events: '0', execution_jobs: '0'
			}], rowCount: 1 };
		}
		if (call.text.startsWith('UPDATE qase_lifecycle_requests')) return { rows: [], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	await assert.rejects(() => repository(changed).purgeBatch({
		execute: true, acknowledgement: PURGE_ACKNOWLEDGEMENT, correlationId: CORRELATION,
		referenceId: 'change/123', idempotencyKey: 'cycle-changed'
	}), /candidate set changed/);
	assert.equal(changed.calls.at(-2).text, 'ROLLBACK');
	assert.equal(changed.calls.some(call => call.text === 'COMMIT'), false);
});

test('legal hold placement and release share the project retention lock and append content-free audit events', async () => {
	const holds = new Map();
	const target = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT id FROM qa_runs')) return { rows: [{ id: RUN_A }], rowCount: 1 };
		if (call.text.startsWith('INSERT INTO qa_run_legal_holds')) {
			holds.set(call.params[5], call.params[0]);
			return { rows: [{ id: call.params[0], run_id: RUN_A }], rowCount: 1 };
		}
		if (call.text.startsWith('DELETE FROM qa_run_legal_holds')) {
			const id = holds.get(call.params[3]);
			if (!id) return { rows: [], rowCount: 0 };
			holds.delete(call.params[3]);
			return { rows: [{ id, policy_version: 'qase-data-lifecycle/v1' }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	const value = repository(target);
	const placed = await value.placeHold({
		runId: RUN_A,
		reasonCode: 'litigation',
		referenceId: 'case/123',
		actorType: 'user',
		actorUserId: USER,
		correlationId: CORRELATION
	});
	assert.equal(placed.placed, true);
	const firstHoldInsert = target.calls.find(call => call.text.startsWith('INSERT INTO qa_run_legal_holds'));
	assert.equal(firstHoldInsert.params[6], 'qase-data-lifecycle/v1');
	const second = await value.placeHold({
		runId: RUN_A,
		reasonCode: 'regulatory',
		referenceId: 'case/456',
		actorType: 'user',
		actorUserId: USER,
		correlationId: CORRELATION
	});
	assert.equal(second.placed, true);
	assert.equal(holds.size, 2, 'independent hold references coexist on one run');
	const released = await value.releaseHold({
		runId: RUN_A,
		reasonCode: 'case_closed',
		referenceId: 'case/123',
		actorType: 'user',
		actorUserId: USER,
		correlationId: CORRELATION
	});
	assert.equal(released.released, true);
	assert.equal(holds.size, 1, 'releasing one exact reference leaves the other hold active');
	const deletion = target.calls.find(call => call.text.startsWith('DELETE FROM qa_run_legal_holds'));
	assert.match(deletion.text, /reference_id = \$4/);
	assert.equal(deletion.params[3], 'case/123');
	const locks = target.calls.filter(call => call.text.startsWith('SELECT pg_try_advisory'));
	assert.ok(locks.every(call => call.params[0] === `${TENANT.organizationId}:${TENANT.projectId}:retention`));
	const events = target.calls.filter(call => call.text.startsWith('INSERT INTO qase_lifecycle_events'));
	assert.equal(events.length, 3);
	assert.match(events[0].text, /legal_hold\.placed/);
	assert.match(events[1].text, /legal_hold\.placed/);
	assert.match(events[2].text, /legal_hold\.released/);
	assert.equal(events.every(call => call.text.includes('resource_counts')), true);
});

test('cleanup attestation is apply-only, reference-bound, durable, audited, and idempotent', async () => {
	const rejected = fixture();
	const rejectedRepository = repository(rejected);
	await assert.rejects(() => rejectedRepository.attestRunCleanup({ runId: RUN_A }), /apply-only/);
	await assert.rejects(() => rejectedRepository.attestRunCleanup({
		execute: true, runId: RUN_A
	}), /acknowledgement/);
	await assert.rejects(() => rejectedRepository.attestRunCleanup({
		execute: true,
		acknowledgement: CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
		runId: RUN_A
	}), /referenceId/);
	assert.equal(rejected.connects, 0);

	const target = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT run.id FROM qa_runs')) return { rows: [{ id: RUN_A }], rowCount: 1 };
		if (call.text.startsWith('SELECT status, request_reference_id')) return {
			rows: [{
				status: 'pending', request_reference_id: 'cleanup-request/789',
				attestation_reference_id: null,
				policy_version: 'qase-data-lifecycle/v1', correlation_id: REQUEST
			}],
			rowCount: 1
		};
		if (call.text.startsWith('UPDATE qase_run_cleanup')) return {
			rows: [{ status: 'completed' }], rowCount: 1
		};
		return { rows: [], rowCount: 1 };
	});
	const result = await repository(target).attestRunCleanup({
		execute: true,
		acknowledgement: CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
		runId: RUN_A,
		referenceId: 'cleanup/123',
		correlationId: CORRELATION
	});
	assert.deepEqual(result, {
		attested: true, duplicate: false, busy: false, runId: RUN_A, correlationId: CORRELATION
	});
	const eligibility = target.calls.find(call => call.text.startsWith('SELECT run.id FROM qa_runs'));
	assert.match(eligibility.text, /deletion_request\.status = 'completed'/);
	assert.match(eligibility.text, /deletion_request\.policy_version = \$4/);
	assert.match(eligibility.text, /deletion_request\.finished_at <= \$5/);
	assert.equal(eligibility.params[3], 'qase-data-lifecycle/v1');
	assert.equal(eligibility.params[4].getTime(), NOW);
	assert.equal(target.calls.some(call => call.text.startsWith('INSERT INTO qase_run_cleanup')), false,
		'attestation requires the pending request created by soft-delete');
	const cleanupUpdate = target.calls.find(call => call.text.startsWith('UPDATE qase_run_cleanup'));
	assert.match(cleanupUpdate.text, /status = 'completed'/);
	assert.match(cleanupUpdate.text, /attempts = attempts \+ 1/);
	assert.match(cleanupUpdate.text, /attestation_reference_id = \$5/);
	assert.match(cleanupUpdate.text, /attestation_reference_id IS NULL/);
	assert.equal(cleanupUpdate.params[4], 'cleanup/123');
	assert.equal(cleanupUpdate.params[3].getTime(), NOW);
	const audit = target.calls.find(call => call.text.startsWith('INSERT INTO qase_lifecycle_events'));
	assert.match(audit.text, /run\.cleanup_attested/);
	assert.equal(audit.params[6], 'cleanup/123');
	assert.equal(audit.params[8], CORRELATION, 'audit correlates the attestation operation, not the delete request');

	const duplicateTarget = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('SELECT run.id FROM qa_runs')) return { rows: [{ id: RUN_A }], rowCount: 1 };
		if (call.text.startsWith('SELECT status, request_reference_id')) return {
			rows: [{
				status: 'completed', request_reference_id: 'cleanup-request/789',
				attestation_reference_id: 'cleanup/123',
				policy_version: 'qase-data-lifecycle/v1', correlation_id: CORRELATION
			}],
			rowCount: 1
		};
		return { rows: [], rowCount: 0 };
	});
	const duplicate = await repository(duplicateTarget).attestRunCleanup({
		execute: true,
		acknowledgement: CLEANUP_ATTESTATION_ACKNOWLEDGEMENT,
		runId: RUN_A,
		referenceId: 'cleanup/123',
		correlationId: CORRELATION
	});
	assert.equal(duplicate.duplicate, true);
	assert.equal(duplicateTarget.calls.some(call => call.text.startsWith('UPDATE qase_run_cleanup')), false);
	assert.equal(duplicateTarget.calls.some(call => call.text.startsWith('INSERT INTO qase_lifecycle_events')), false);
});

test('expired-auth preview never writes and execute deletes at most one total bounded batch with no raw identifiers in audit', async () => {
	const previewTarget = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qase_auth_sessions')) {
			return { rows: [{ id: RUN_A }, { id: RUN_B }], rowCount: 2 };
		}
		if (call.text.startsWith('SELECT issuer, jti')) return { rows: [{ issuer: 'issuer', jti: 'opaque' }], rowCount: 1 };
		return { rows: [], rowCount: 0 };
	});
	const preview = await repository(previewTarget).cleanupExpiredAuth({ batchSize: 3 });
	assert.deepEqual(preview, {
		dryRun: true, asOf: NOW, authSessions: 2, tokenExchanges: 1, hasMore: false
	});
	assert.equal(previewTarget.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), false);
	scopedTransaction(previewTarget.calls, true);

	const executeTarget = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('DELETE FROM qase_auth_sessions')) {
			return { rows: [{ id: RUN_A }, { id: RUN_B }], rowCount: 2 };
		}
		if (call.text.startsWith('DELETE FROM drytis_token_exchanges')) {
			return { rows: [{ issuer: 'must-not-enter-audit' }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	const executed = await repository(executeTarget).cleanupExpiredAuth({
		execute: true,
		acknowledgement: AUTH_CLEANUP_ACKNOWLEDGEMENT,
		batchSize: 3,
		correlationId: CORRELATION,
		policyVersion: 'policy-v1'
	});
	assert.equal(executed.authSessions + executed.tokenExchanges, 3);
	const sessionDelete = executeTarget.calls.find(call => call.text.startsWith('DELETE FROM qase_auth_sessions'));
	const exchangeDelete = executeTarget.calls.find(call => call.text.startsWith('DELETE FROM drytis_token_exchanges'));
	assert.match(sessionDelete.text, /FOR UPDATE SKIP LOCKED LIMIT \$4/);
	assert.equal(sessionDelete.params[3], 3);
	assert.equal(exchangeDelete.params[3], 1);
	const audit = executeTarget.calls.find(call => call.text.startsWith('INSERT INTO qase_lifecycle_events'));
	assert.equal(audit.params[6], JSON.stringify({ authSessions: 2, tokenExchanges: 1 }));
	assert.equal(JSON.stringify(audit.params).includes('must-not-enter-audit'), false);
	scopedTransaction(executeTarget.calls);
});

test('expired-auth preview checks the other queue when sessions exactly fill the batch', async () => {
	const target = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qase_auth_sessions')) {
			return { rows: [{ id: RUN_A }, { id: RUN_B }, { id: REQUEST }], rowCount: 3 };
		}
		if (call.text.startsWith('SELECT 1 FROM drytis_token_exchanges')) {
			return { rows: [{ '?column?': 1 }], rowCount: 1 };
		}
		return { rows: [], rowCount: 0 };
	});
	const result = await repository(target).cleanupExpiredAuth({ batchSize: 3 });
	assert.deepEqual(result, {
		dryRun: true, asOf: NOW, authSessions: 3, tokenExchanges: 0, hasMore: true
	});
	const existence = target.calls.find(call => call.text.startsWith('SELECT 1 FROM drytis_token_exchanges'));
	assert.equal(existence.params[2].getTime(), NOW);
	assert.equal(target.calls.some(call => /^(INSERT|UPDATE|DELETE)/.test(call.text)), false);
});

test('auth cleanup rejects write mode without acknowledgement and all execution failures roll back', async () => {
	const rejected = fixture();
	await assert.rejects(() => repository(rejected).cleanupExpiredAuth({ execute: true }), /acknowledgement/);
	assert.equal(rejected.connects, 0);

	const failed = fixture(call => {
		if (call.text.startsWith('SELECT pg_try_advisory')) return { rows: [{ acquired: true }], rowCount: 1 };
		if (call.text.startsWith('DELETE FROM qase_auth_sessions')) throw new Error('database unavailable');
		return { rows: [], rowCount: 0 };
	});
	await assert.rejects(() => repository(failed).cleanupExpiredAuth({
		execute: true,
		acknowledgement: AUTH_CLEANUP_ACKNOWLEDGEMENT,
		correlationId: CORRELATION
	}), /database unavailable/);
	assert.equal(failed.calls.at(-2).text, 'ROLLBACK');
	assert.equal(failed.calls.at(-1).text, 'RELEASE');
});
