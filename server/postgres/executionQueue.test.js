import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresExecutionQueue } from './executionQueue.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from '../tenancy.js';

const RUN = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const JOB = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';
const LEASE = '9e2fb678-423e-41a0-ae19-e9cae143c606';
const CORRELATION = 'fb139801-54e8-4289-ad10-f70c92967967';

function row(overrides = {}) {
	return {
		id: JOB, run_id: RUN, requested_by_user_id: TENANT.actorUserId, kind: 'turn',
		correlation_id: CORRELATION,
		payload: { task: 'test example.com' }, status: 'queued', attempts: 0,
		max_attempts: 3, ...overrides
	};
}

function fixture(handler) {
	const calls = [];
	const client = {
		async query(text, params = []) {
			const call = { text: text.trim(), params };
			calls.push(call);
			return handler?.(call, calls) ?? { rows: [], rowCount: 0 };
		},
		release() { calls.push({ text: 'RELEASE', params: [] }); }
	};
	return {
		calls,
		queue: createPostgresExecutionQueue({
			pool: { connect: async () => client }, tenantContext: TENANT, leaseMs: 20_000,
			maxActiveJobs: 5
		})
	};
}

test('enqueue is tenant scoped, stores only structured turn input, and rejects an active-run conflict', async () => {
	const target = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qa_runs')) return { rows: [{ id: RUN }], rowCount: 1 };
		if (call.text.startsWith('INSERT INTO qa_execution_jobs')) return { rows: [row()], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	const job = await target.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId,
		turnOptions: { task: 'test example.com' }, idempotencyKey: JOB, correlationId: CORRELATION
	});
	assert.equal(job.runId, RUN);
	assert.equal(job.correlationId, CORRELATION);
	const insert = target.calls.find(call => call.text.startsWith('INSERT INTO qa_execution_jobs'));
	assert.deepEqual(insert.params.slice(0, 5), [JOB, TENANT.organizationId, TENANT.projectId, RUN, TENANT.actorUserId]);
	assert.equal(insert.params[5], CORRELATION);
	assert.equal(insert.params[6], JSON.stringify({ task: 'test example.com' }));
	assert.equal(target.calls.at(-2).text, 'COMMIT');

	const duplicate = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qa_runs')) return { rows: [{ id: RUN }], rowCount: 1 };
		if (call.text.startsWith('INSERT INTO qa_execution_jobs')) throw Object.assign(new Error('duplicate'), { code: '23505' });
		return { rows: [], rowCount: 1 };
	});
	await assert.rejects(() => duplicate.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId, turnOptions: { task: 'x' }
	}), error => error.code === 'QASE_RUN_ALREADY_QUEUED');
	assert.equal(duplicate.calls.at(-2).text, 'ROLLBACK');
});

test('enqueue serializes capacity admission and fails closed when the cell is full', async () => {
	const full = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qa_runs')) return { rows: [{ id: RUN }], rowCount: 1 };
		if (call.text.startsWith('SELECT COUNT(*)::int AS count')) return { rows: [{ count: 5 }], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	await assert.rejects(() => full.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId, turnOptions: { task: 'x' }
	}), error => error.code === 'QASE_CELL_CAPACITY_EXCEEDED');
	assert.ok(full.calls.some(call => call.text.includes('pg_advisory_xact_lock')));
	assert.equal(full.calls.at(-2).text, 'ROLLBACK');
});

test('enqueue locks and rejects a soft-deleted or cross-tenant run before capacity admission', async () => {
	const unavailable = fixture(call => call.text.startsWith('SELECT id FROM qa_runs')
		? { rows: [], rowCount: 0 }
		: { rows: [], rowCount: 1 });

	await assert.rejects(() => unavailable.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId, turnOptions: { task: 'x' }
	}), error => error.code === 'QASE_RUN_NOT_AVAILABLE');
	const runRead = unavailable.calls.find(call => call.text.startsWith('SELECT id FROM qa_runs'));
	assert.match(runRead.text, /organization_id = \$1 AND project_id = \$2 AND id = \$3/);
	assert.match(runRead.text, /deleted_at IS NULL/);
	assert.match(runRead.text, /FOR SHARE/);
	assert.deepEqual(runRead.params, [TENANT.organizationId, TENANT.projectId, RUN]);
	assert.equal(unavailable.calls.some(call => call.text.includes('execution-capacity')), false);
	assert.equal(unavailable.calls.at(-2).text, 'ROLLBACK');
});

test('claim retention cleanup is deterministic, bounded, and preserves jobs for held runs', async () => {
	const target = fixture();
	assert.equal(await target.queue.claim('worker:cleanup'), undefined);

	const cleanup = target.calls.find(call => call.text.startsWith('DELETE FROM qa_execution_jobs'));
	assert.ok(cleanup);
	assert.match(cleanup.text, /SELECT job\.ctid FROM qa_execution_jobs job/);
	assert.match(cleanup.text, /job\.organization_id = \$1 AND job\.project_id = \$2/);
	assert.match(cleanup.text, /NOT EXISTS \([\s\S]*FROM qa_run_legal_holds hold/);
	assert.match(cleanup.text, /hold\.run_id = job\.run_id/);
	assert.match(cleanup.text, /ORDER BY job\.finished_at, job\.id/);
	assert.match(cleanup.text, /FOR UPDATE OF job SKIP LOCKED LIMIT 1000/);
	assert.deepEqual(cleanup.params, [TENANT.organizationId, TENANT.projectId, 30]);
});

test('claim uses skip-locked leasing and heartbeat exposes cancellation', async () => {
	const target = fixture(call => {
		if (call.text.startsWith('SELECT id FROM qa_execution_jobs')) return { rows: [{ id: JOB }], rowCount: 1 };
		if (call.text.startsWith("UPDATE qa_execution_jobs SET status = 'leased'")) {
			return { rows: [row({ status: 'leased', attempts: 1, lease_owner: 'worker:a', lease_token: LEASE })], rowCount: 1 };
		}
		if (call.text.includes('last_heartbeat_at = CURRENT_TIMESTAMP') && call.text.includes('RETURNING status')) {
			return { rows: [{ status: 'cancel_requested' }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	const claimed = await target.queue.claim('worker:a');
	assert.equal(claimed.status, 'leased');
	assert.ok(target.calls.some(call => call.text.includes('FOR UPDATE SKIP LOCKED')));
	const status = await target.queue.heartbeat({ jobId: JOB, leaseToken: LEASE, workerId: 'worker:a' });
	assert.equal(status, 'cancel_requested');
});

test('completion, retry failure, cancellation, and exhausted lease recovery require lease identity', async () => {
	const statuses = ['succeeded', 'queued', 'cancel_requested'];
	const target = fixture(call => {
		if (call.text.includes('RETURNING status')) return { rows: [{ status: statuses.shift() }], rowCount: 1 };
		if (call.text.includes('RETURNING run_id')) return { rows: [{ run_id: RUN }], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	assert.equal(await target.queue.complete({ jobId: JOB, leaseToken: LEASE, workerId: 'worker:a' }), 'succeeded');
	assert.equal(await target.queue.fail({
		jobId: JOB, leaseToken: LEASE, workerId: 'worker:a', error: new Error('temporary'), retryable: true
	}), 'queued');
	assert.equal(await target.queue.cancelRun(RUN), 'cancel_requested');
	assert.deepEqual(await target.queue.reapExhausted(), [RUN]);
	const mutations = target.calls.filter(call => call.text.startsWith('UPDATE qa_execution_jobs'));
	assert.deepEqual(mutations[0].params.slice(0, 3), [JOB, LEASE, 'worker:a']);
	assert.match(mutations[1].text, /attempts < max_attempts/);
});

test('stats returns tenant-scoped fixed-cardinality autoscaling signals', async () => {
	const target = fixture(call => {
		if (call.text.startsWith('SELECT status, COUNT')) {
			return { rows: [{ status: 'queued', count: 9 }, { status: 'leased', count: 3 }], rowCount: 2 };
		}
		if (call.text.startsWith('SELECT') && call.text.includes('oldest_queued_age_seconds')) {
			return { rows: [{ oldest_queued_age_seconds: 42.5, expired_leases: 2 }], rowCount: 1 };
		}
		return { rows: [], rowCount: 1 };
	});
	assert.deepEqual(await target.queue.stats(), {
		queued: 9, leased: 3, cancel_requested: 0, succeeded: 0, failed: 0, cancelled: 0,
		oldestQueuedAgeSeconds: 42.5, expiredLeases: 2
	});
	const scoped = target.calls.filter(call => call.text.includes('FROM qa_execution_jobs'));
	assert.ok(scoped.every(call => call.params[0] === TENANT.organizationId && call.params[1] === TENANT.projectId));
});
