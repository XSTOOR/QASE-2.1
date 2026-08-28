import assert from 'node:assert/strict';
import test from 'node:test';
import { createRedisEventTransport } from './redisEvents.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from './tenancy.js';

function broker(options = {}) {
	const listeners = new Map();
	const publications = [];
	const blockedPublishes = [];
	function client() {
		const ownSubscriptions = new Map();
		return {
			on() {}, async connect() {}, async ping() { return 'PONG'; },
			async close() {
				for (const [channel, listener] of ownSubscriptions) {
					const group = listeners.get(channel);
					group?.delete(listener);
					if (group?.size === 0) listeners.delete(channel);
				}
				ownSubscriptions.clear();
			},
			async subscribe(channel, listener) {
				let group = listeners.get(channel);
				if (!group) { group = new Set(); listeners.set(channel, group); }
				group.add(listener);
				ownSubscriptions.set(channel, listener);
			},
			async unsubscribe(channel) {
				const listener = ownSubscriptions.get(channel);
				const group = listeners.get(channel);
				if (listener) group?.delete(listener);
				if (group?.size === 0) listeners.delete(channel);
				ownSubscriptions.delete(channel);
			},
			async publish(channel, message) {
				publications.push({ channel, message });
				if (options.holdPublishes) {
					await new Promise(resolve => blockedPublishes.push(resolve));
				}
				for (const listener of listeners.get(channel) ?? []) listener(message);
			},
			duplicate() { return client(); }
		};
	}
	return {
		client,
		publications,
		releaseOne() { blockedPublishes.shift()?.(); },
		get blockedCount() { return blockedPublishes.length; }
	};
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
	const unsubscribe = await api.subscribe('run-1', event => received.push(event));
	worker.publish({ type: 'status', sessionId: 'run-1', status: 'running', ts: 1 });
	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { data: 'image' }, ts: 2 });
	await Promise.resolve();
	assert.equal(received.length, 2);
	assert.deepEqual(api.getLiveState('run-1'), { running: true, frame: { data: 'image' } });
	worker.publish({ type: 'run.deleted', sessionId: 'run-1', ts: 3 });
	await Promise.resolve();
	assert.equal(received.length, 3);
	assert.deepEqual(api.getLiveState('run-1'), { running: false, frame: undefined });
	unsubscribe();
	await Promise.all([worker.close(), api.close()]);
});

test('Redis transport ignores its own pub/sub echo and reports readiness', async () => {
	const shared = broker();
	const value = transport(shared, 'one');
	await value.load();
	let count = 0;
	await value.subscribe('run-1', () => count++);
	value.publish({ type: 'status', sessionId: 'run-1', status: 'done' });
	await Promise.resolve();
	assert.equal(count, 1);
	assert.equal(await value.check(), true);
	await Promise.all([value.close(), value.close()]);
});

test('Redis transport scopes frames to subscribed sessions while project events still fan out', async () => {
	const shared = broker();
	const worker = transport(shared, 'worker');
	const runOneApi = transport(shared, 'run-one-api');
	const runTwoApi = transport(shared, 'run-two-api');
	await Promise.all([worker.load(), runOneApi.load(), runTwoApi.load()]);

	const runOneEvents = [];
	const runTwoEvents = [];
	const unsubscribeOne = await runOneApi.subscribe('run-1', event => runOneEvents.push(event));
	const unsubscribeTwo = await runTwoApi.subscribe('run-2', event => runTwoEvents.push(event));

	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { base64: 'one' }, ts: 1 });
	worker.publish({ type: 'status', sessionId: 'run-2', status: 'running', ts: 2 });
	await Promise.resolve();

	assert.deepEqual(runOneEvents.map(event => event.type), ['frame']);
	assert.deepEqual(runTwoEvents.map(event => event.type), ['status']);
	assert.equal(runTwoApi.getLiveState('run-1').frame, undefined);
	assert.match(shared.publications[0].channel, /:frames:/);
	assert.match(shared.publications[1].channel, /:events$/);

	unsubscribeOne();
	unsubscribeTwo();
	await Promise.all([worker.close(), runOneApi.close(), runTwoApi.close()]);
});

test('Redis transport bounds slow frame publication to one in-flight and one latest frame', async () => {
	const shared = broker({ holdPublishes: true });
	const worker = transport(shared, 'worker');
	const api = transport(shared, 'api');
	await Promise.all([worker.load(), api.load()]);
	const received = [];
	const unsubscribe = await api.subscribe('run-1', event => received.push(event));

	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { base64: 'one' }, ts: 1 });
	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { base64: 'two' }, ts: 2 });
	worker.publish({ type: 'frame', sessionId: 'run-1', frame: { base64: 'three' }, ts: 3 });
	assert.equal(shared.publications.length, 1);
	assert.equal(shared.blockedCount, 1);

	shared.releaseOne();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(shared.publications.length, 2);
	assert.equal(shared.blockedCount, 1);
	shared.releaseOne();
	await new Promise(resolve => setImmediate(resolve));

	assert.deepEqual(received.map(event => event.frame.base64), ['one', 'three']);
	assert.equal(shared.publications.length, 2);
	unsubscribe();
	await Promise.all([worker.close(), api.close()]);
});

test('production Redis transport requires TLS unless explicitly controlled', () => {
	assert.throws(() => createRedisEventTransport({
		tenantContext: TENANT,
		environment: { NODE_ENV: 'production', QASE_REDIS_URL: 'redis://cache.internal' }
	}), /requires a TLS rediss/);
});
