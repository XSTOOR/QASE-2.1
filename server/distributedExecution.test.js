import assert from 'node:assert/strict';
import test from 'node:test';
import { createDistributedApiAgent, createExecutionWorker } from './distributedExecution.js';
import { runWithRequestActor } from './requestActor.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from './tenancy.js';

const RUN = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const JOB = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';
const LEASE = '9e2fb678-423e-41a0-ae19-e9cae143c606';

test('distributed API adapter persists queued state and attributes work to the request actor', async () => {
	const calls = [];
	const session = { id: RUN };
	const agent = createDistributedApiAgent({
		queue: {
			enqueue: async value => { calls.push(['enqueue', value]); return { id: JOB }; },
			cancelRun: async id => { calls.push(['cancel', id]); return 'cancel_requested'; }
		},
		realtime: { getLiveState: id => ({ running: true, frame: { id } }) },
		runs: { setStatus: async (...args) => calls.push(['status', ...args]) },
		tenantContext: TENANT
	});
	const actorUserId = '5b198555-7a63-42b7-a36d-dddc5a4a3d60';
	await runWithRequestActor({ actorUserId }, () => agent.runTurn(session, { task: 'test' }));
	assert.equal(calls[0][0], 'enqueue');
	assert.equal(calls[0][1].requestedByUserId, actorUserId);
	assert.equal(calls[1][0], 'status');
	assert.equal(calls[1][2], 'running');
	assert.deepEqual(agent.getLiveState(RUN), { running: true, frame: { id: RUN } });
	assert.equal(await agent.stop(RUN), 'cancel_requested');
});

test('worker claims a lease, runs the existing agent under requester identity, and completes', async () => {
	const calls = [];
	const session = { id: RUN };
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'test' }
		}),
		heartbeat: async () => 'leased',
		complete: async value => { calls.push(['complete', value]); return 'succeeded'; },
		fail: async value => calls.push(['fail', value])
	};
	const services = {
		runs: { get: async () => session, addMessage: async () => {}, setStatus: async () => {} },
		secrets: { store: async () => [], clear: async () => {} },
		agent: {
			ensureRuntime: value => calls.push(['ensure', value.id]),
			runTurn: async (value, payload) => calls.push(['run', value.id, payload]),
			stop: async id => calls.push(['stop', id])
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(calls.slice(0, 2), [['ensure', RUN], ['run', RUN, { task: 'test' }]]);
	assert.equal(calls[2][0], 'complete');
	assert.equal(calls.some(call => call[0] === 'fail'), false);
});

test('worker retries infrastructure failures and marks exhausted runs visibly', async () => {
	const calls = [];
	const session = { id: RUN };
	const queue = {
		reapExhausted: async () => [RUN],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'test' }
		}),
		heartbeat: async () => 'leased',
		complete: async () => {},
		fail: async value => { calls.push(['fail', value]); return 'failed'; }
	};
	const services = {
		runs: {
			get: async () => session,
			addMessage: async (_session, message) => calls.push(['message', message]),
			setStatus: async (_session, status) => calls.push(['status', status])
		},
		secrets: { store: async () => [], clear: async () => {} },
		agent: {
			ensureRuntime() { throw Object.assign(new Error('browser unavailable'), { code: 'BROWSER_DOWN' }); },
			runTurn: async () => {}, stop: async () => {}
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	await worker.runOnce();
	assert.equal(calls[0][0], 'message');
	assert.deepEqual(calls[1], ['status', 'error']);
	assert.equal(calls[2][0], 'fail');
	assert.equal(calls[2][1].error.code, 'BROWSER_DOWN');
	assert.equal(calls[3][0], 'message');
	assert.deepEqual(calls[4], ['status', 'error']);
});

test('worker cleanup failures do not overturn an acknowledged job', async () => {
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'test' }
		}),
		heartbeat: async () => 'leased',
		complete: async () => 'succeeded',
		fail: async () => { throw new Error('must not fail acknowledged work'); }
	};
	const services = {
		runs: { get: async () => ({ id: RUN, status: 'done' }), addMessage: async () => {}, setStatus: async () => {} },
		secrets: { store: async () => [], clear: async () => { throw new Error('local cleanup unavailable'); } },
		agent: { ensureRuntime() {}, runTurn: async () => {}, stop: async () => {} }
	};
	const credentialVault = {
		values: async () => ({}),
		clear: async () => { throw new Error('shared cleanup unavailable'); }
	};
	const worker = createExecutionWorker({ queue, services, credentialVault, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
});
