import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerProbe } from './workerProbe.js';

test('worker probe exposes minimal liveness and dependency-aware drain readiness', async t => {
	let state = { started: false, stopping: false, working: false };
	let queueReady = true;
	const probe = createWorkerProbe({
		worker: { getState: () => state },
		queue: {
			check: async () => queueReady,
			stats: async () => ({ queued: 0, leased: 0, oldestQueuedAgeSeconds: 0, expiredLeases: 0 })
		},
		environment: {},
		port: 0
	});
	const server = await probe.listen();
	t.after(() => probe.close());
	const origin = `http://127.0.0.1:${server.address().port}`;
	assert.equal((await fetch(`${origin}/healthz`)).status, 200);
	assert.equal((await fetch(`${origin}/readyz`)).status, 503);
	state = { started: true, stopping: false, working: false };
	assert.equal((await fetch(`${origin}/readyz`)).status, 200);
	queueReady = false;
	assert.equal((await fetch(`${origin}/readyz`)).status, 503);
	queueReady = true;
	state = { started: true, stopping: true, working: true };
	assert.equal((await fetch(`${origin}/readyz`)).status, 503);
});

test('worker probe validates its narrow listener configuration', () => {
	const dependencies = { worker: { getState() {} }, queue: { check() {} } };
	assert.throws(() => createWorkerProbe({ ...dependencies, port: -1 }), /0 to 65535/);
	assert.throws(() => createWorkerProbe({ ...dependencies, port: 70_000 }), /0 to 65535/);
});
