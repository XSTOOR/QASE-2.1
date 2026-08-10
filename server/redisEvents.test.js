import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisEventTransport } from './redisEvents.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from './tenancy.js';

function broker() {
	const listeners = new Map();
	function client() {
		return {
			on() {}, async connect() {}, async ping() { return 'PONG'; }, async close() {},
			async subscribe(channel, listener) {
				let group = listeners.get(channel);
				if (!group) { group = new Set(); listeners.set(channel, group); }
				group.add(listener);
			},
			async publish(channel, message) {
				for (const listener of listeners.get(channel) ?? []) listener(message);
			},
			duplicate() { return client(); }
		};
	}
	return { client };
}

function transport(shared, id) {
	return createRedisEventTransport({
		tenantContext: TENANT, instanceId: id, url: 'redis://test',
		publisher: shared.client(), subscriber: shared.client(), allowInsecure: true
	});
}

test('Redis transport delivers cross-replica events once and retains the latest live frame', async () => {
	const shared = broker();
	const worker = transport(shared, 'worker');
	const api = transport(shared, 'api');
	await Promise.all([worker.load(), api.load()]);
	const received = [];
	const unsubscribe = api.subscribe('run-1', event => received.push(event));
	worker.publish({ type: 'status', sessionId: 'run-1', status: 'running', ts: 1 });
	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { data: 'image' }, ts: 2 });
	await Promise.resolve();
	assert.equal(received.length, 2);
	assert.deepEqual(api.getLiveState('run-1'), { running: true, frame: { data: 'image' } });
	unsubscribe();
	await Promise.all([worker.close(), api.close()]);
});

test('Redis transport ignores its own pub/sub echo and reports readiness', async () => {
	const shared = broker();
	const value = transport(shared, 'one');
	await value.load();
	let count = 0;
	value.subscribe('run-1', () => count++);
	value.publish({ type: 'status', sessionId: 'run-1', status: 'done' });
	await Promise.resolve();
	assert.equal(count, 1);
	assert.equal(await value.check(), true);
	await Promise.all([value.close(), value.close()]);
});

test('production Redis transport requires TLS unless explicitly controlled', () => {
	assert.throws(() => createRedisEventTransport({
		tenantContext: TENANT,
		environment: { NODE_ENV: 'production', QASE_REDIS_URL: 'redis://cache.internal' }
	}), /requires a TLS rediss/);
});
