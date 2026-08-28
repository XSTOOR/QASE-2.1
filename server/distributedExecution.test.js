import assert from 'node:assert/strict';
import test from 'node:test';
import { createDistributedApiAgent, createExecutionWorker } from './distributedExecution.js';
import { currentRequestActor, runWithRequestActor } from './requestActor.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from './tenancy.js';

const RUN = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';
const JOB = '08ddf3b0-4499-4101-a20f-d87d3eebcd52';
const LEASE = '9e2fb678-423e-41a0-ae19-e9cae143c606';
const CORRELATION = 'fb139801-54e8-4289-ad10-f70c92967967';

test('distributed API adapter persists queued state and attributes work to the request actor', async () => {
	const calls = [];
	const session = { id: RUN };
	const agent = createDistributedApiAgent({
		queue: {
			enqueue: async value => { calls.push(['enqueue', value]); return { id: JOB }; },
			cancelRun: async id => { calls.push(['cancel', id]); return 'cancel_requested'; }
		},
		realtime: {
			getLiveState: id => ({ running: true, frame: { id } }),
			publish: event => calls.push(['realtime', event])
		},
		runs: { setStatus: async (...args) => calls.push(['status', ...args]) },
		tenantContext: TENANT
	});
	assert.equal(agent.cleanupDeferred, true,
		'distributed API deletion must remain pending until a worker attests local cleanup');
	const actorUserId = '5b198555-7a63-42b7-a36d-dddc5a4a3d60';
	await runWithRequestActor({ actorUserId, requestId: CORRELATION }, () => agent.runTurn(session, { task: 'test' }));
	assert.equal(calls[0][0], 'enqueue');
	assert.equal(calls[0][1].requestedByUserId, actorUserId);
	assert.equal(calls[0][1].requestedByActorType, 'user');
	assert.equal(calls[0][1].correlationId, CORRELATION);
	assert.equal(calls[1][0], 'status');
	assert.equal(calls[1][2], 'running');
	assert.deepEqual(agent.getLiveState(RUN), { running: true, frame: { id: RUN } });
	assert.equal(await agent.stop(RUN), 'cancel_requested');
	await agent.purgeArtifacts(RUN);
	assert.equal(calls.at(-1)[0], 'realtime');
	assert.equal(calls.at(-1)[1].type, 'run.deleted');
	assert.equal(calls.at(-1)[1].sessionId, RUN);
});

test('distributed API adapter attributes trusted integration work to a service principal', async () => {
	const calls = [];
	const agent = createDistributedApiAgent({
		queue: {
			enqueue: async value => { calls.push(value); return { id: JOB }; },
			cancelRun: async () => 'cancel_requested'
		},
		realtime: { getLiveState: () => undefined, publish() {} },
		runs: { setStatus: async () => undefined },
		tenantContext: TENANT
	});
	await agent.runTurn({ id: RUN }, { task: 'integration test' }, { actorType: 'service' });
	assert.equal(calls[0].requestedByActorType, 'service');
	assert.equal(calls[0].requestedByUserId, undefined);
});

test('worker claims a lease, runs the existing agent under requester identity, and completes', async () => {
	const calls = [];
	const session = { id: RUN };
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, correlationId: CORRELATION, payload: { task: 'test' }
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
			runTurn: async (value, payload) => calls.push(['run', value.id, payload, currentRequestActor()]),
			stop: async id => calls.push(['stop', id])
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(calls[0], ['ensure', RUN]);
	assert.deepEqual(calls[1], ['run', RUN, { task: 'test' }, {
		actorUserId: TENANT.actorUserId,
		requestId: CORRELATION
	}]);
	assert.equal(calls[2][0], 'complete');
	assert.equal(calls.some(call => call[0] === 'fail'), false);
});

test('worker honors cancellation observed immediately after claim without starting a runtime', async () => {
	const calls = [];
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'must not run' }
		}),
		heartbeat: async () => 'cancel_requested',
		complete: async value => { calls.push(['complete', value]); return 'cancelled'; },
		fail: async value => calls.push(['fail', value])
	};
	const services = {
		runs: { get: async () => ({ id: RUN, status: 'running' }), addMessage: async () => {}, setStatus: async () => {} },
		secrets: { store: async () => calls.push(['store']), clear: async () => {} },
		agent: {
			ensureRuntime: () => calls.push(['ensure']),
			runTurn: async () => calls.push(['run']),
			stop: async id => calls.push(['stop', id])
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(calls.map(call => call[0]), ['stop', 'complete']);
	assert.equal(calls[1][1].leaseToken, LEASE);
});

test('worker revalidates its lease after remote credential retrieval before exposing secrets', async () => {
	const calls = [];
	const heartbeats = ['leased', undefined];
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'must not run' }
		}),
		heartbeat: async () => heartbeats.shift(),
		complete: async value => { calls.push(['complete', value]); return undefined; },
		fail: async value => calls.push(['fail', value])
	};
	const services = {
		runs: { get: async () => ({ id: RUN, status: 'running' }), addMessage: async () => {}, setStatus: async () => {} },
		secrets: {
			store: async () => calls.push(['store']),
			clear: async () => calls.push(['clear-local'])
		},
		agent: {
			ensureRuntime: () => calls.push(['ensure']),
			runTurn: async () => calls.push(['run']),
			stop: async id => calls.push(['stop', id])
		}
	};
	const credentialVault = {
		values: async () => { calls.push(['vault-read']); return { password: 'secret' }; },
		clear: async () => calls.push(['clear-vault'])
	};
	const worker = createExecutionWorker({
		queue, services, credentialVault, workerId: 'worker:test', leaseMs: 5_000
	});
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(calls.map(call => call[0]), ['vault-read', 'stop', 'complete', 'clear-local']);
	assert.equal(calls.some(call => ['store', 'ensure', 'run', 'fail'].includes(call[0])), false);
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

test('worker removes local artifacts after a concurrently deleted run', async () => {
	let readCount = 0;
	const calls = [];
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'test' }
		}),
		heartbeat: async () => 'leased',
		complete: async () => 'cancelled',
		fail: async () => 'cancelled'
	};
	const services = {
		runs: {
			get: async () => (++readCount === 1 ? { id: RUN, status: 'running' } : undefined),
			addMessage: async () => {}, setStatus: async () => {},
			recordCleanup: async (runId, options) => calls.push(['cleanup', runId, options])
		},
		secrets: { store: async () => [], clear: async () => {} },
		agent: {
			ensureRuntime() {}, runTurn: async () => {}, stop: async () => {},
			purgeArtifacts: async runId => calls.push(['artifacts', runId])
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(calls, [
		['artifacts', RUN],
		['cleanup', RUN, {
			status: 'completed', actorType: 'worker', referenceId: `worker-job/${JOB}`
		}]
	]);
});

test('worker records a sanitized failed cleanup attempt when deleted-run artifact removal fails', async () => {
	let readCount = 0;
	const cleanupCalls = [];
	const queue = {
		reapExhausted: async () => [],
		claim: async () => ({
			id: JOB, runId: RUN, requestedByUserId: TENANT.actorUserId,
			leaseToken: LEASE, payload: { task: 'test' }
		}),
		heartbeat: async () => 'leased',
		complete: async () => 'cancelled',
		fail: async () => 'cancelled'
	};
	const services = {
		runs: {
			get: async () => (++readCount === 1 ? { id: RUN, status: 'running' } : undefined),
			addMessage: async () => {}, setStatus: async () => {},
			recordCleanup: async (runId, options) => cleanupCalls.push({ runId, options })
		},
		secrets: { store: async () => [], clear: async () => {} },
		agent: {
			ensureRuntime() {}, runTurn: async () => {}, stop: async () => {},
			purgeArtifacts: async () => { throw new Error('C:\\private\\workspace secret'); }
		}
	};
	const worker = createExecutionWorker({ queue, services, workerId: 'worker:test', leaseMs: 5_000 });
	assert.equal(await worker.runOnce(), true);
	assert.deepEqual(cleanupCalls, [{
		runId: RUN,
		options: {
			status: 'failed', errorCode: 'worker_cleanup_failed', actorType: 'worker',
			referenceId: `worker-job/${JOB}`
		}
	}]);
	assert.equal(JSON.stringify(cleanupCalls).includes('private'), false);
});
