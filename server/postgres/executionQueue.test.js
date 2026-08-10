import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresExecutionQueue } from './executionQueue.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from '../tenancy.js';

const RUN = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const JOB = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';
const LEASE = '9e2fb678-423e-41a0-ae19-e9cae143c606';

function row(overrides = {}) {
	return {
		id: JOB, run_id: RUN, requested_by_user_id: TENANT.actorUserId, kind: 'turn',
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
			pool: { connect: async () => client }, tenantContext: TENANT, leaseMs: 20_000
		})
	};
}

test('enqueue is tenant scoped, stores only structured turn input, and rejects an active-run conflict', async () => {
	const target = fixture(call => call.text.startsWith('INSERT INTO qa_execution_jobs')
		? { rows: [row()], rowCount: 1 } : { rows: [], rowCount: 1 });
	const job = await target.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId,
		turnOptions: { task: 'test example.com' }, idempotencyKey: JOB
	});
	assert.equal(job.runId, RUN);
	const insert = target.calls.find(call => call.text.startsWith('INSERT INTO qa_execution_jobs'));
	assert.deepEqual(insert.params.slice(0, 5), [JOB, TENANT.organizationId, TENANT.projectId, RUN, TENANT.actorUserId]);
	assert.equal(insert.params[5], JSON.stringify({ task: 'test example.com' }));
	assert.equal(target.calls.at(-2).text, 'COMMIT');

	const duplicate = fixture(call => {
		if (call.text.startsWith('INSERT INTO qa_execution_jobs')) throw Object.assign(new Error('duplicate'), { code: '23505' });
		return { rows: [], rowCount: 1 };
	});
	await assert.rejects(() => duplicate.queue.enqueue({
		runId: RUN, requestedByUserId: TENANT.actorUserId, turnOptions: { task: 'x' }
	}), error => error.code === 'QASE_RUN_ALREADY_QUEUED');
	assert.equal(duplicate.calls.at(-2).text, 'ROLLBACK');
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
