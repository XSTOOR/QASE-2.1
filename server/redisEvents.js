import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createClient } from 'redis';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

function redisUrl(environment, allowInsecure) {
	const raw = String(environment.QASE_REDIS_URL ?? '').trim();
	if (!raw) throw new Error('Distributed execution requires QASE_REDIS_URL.');
	const url = new URL(raw);
	if (!['redis:', 'rediss:'].includes(url.protocol)) throw new TypeError('QASE_REDIS_URL must use redis:// or rediss://.');
	if (environment.NODE_ENV === 'production' && url.protocol !== 'rediss:' && !allowInsecure) {
		throw new Error('Production distributed execution requires a TLS rediss:// URL.');
	}
	return raw;
}

export function createRedisEventTransport(options = {}) {
	const environment = options.environment ?? process.env;
	const tenant = options.tenantContext;
	if (!tenant || !UUID_PATTERN.test(tenant.organizationId) || !UUID_PATTERN.test(tenant.projectId)) {
		throw new TypeError('Redis event transport requires trusted tenant UUIDs.');
	}
	const instanceId = options.instanceId ?? randomUUID();
	const url = options.url ?? redisUrl(environment, options.allowInsecure);
	const create = options.createClient ?? createClient;
	const publisher = options.publisher ?? create({ url });
	const subscriber = options.subscriber ?? publisher.duplicate();
	const channel = `qase:v1:${tenant.organizationId}:${tenant.projectId}:events`;
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	const live = new Map();
	let loaded = false;
	let closed = false;
	let lastError;
	let closePromise;

	function accept(event) {
		if (!event || typeof event !== 'object' || typeof event.sessionId !== 'string') return;
		if (event.type === 'run.deleted') {
			live.delete(event.sessionId);
		} else if (event.type === 'frame') {
			const current = live.get(event.sessionId) ?? {};
			current.frame = event.frame;
			live.set(event.sessionId, current);
		} else if (event.type === 'status') {
			const current = live.get(event.sessionId) ?? {};
			current.running = event.status === 'running';
			live.set(event.sessionId, current);
		}
		bus.emit(event.sessionId, event);
		bus.emit('*', event);
	}

	return Object.freeze({
		async load() {
			if (loaded) return;
			publisher.on?.('error', error => { lastError = error; });
			subscriber.on?.('error', error => { lastError = error; });
			await publisher.connect();
			await subscriber.connect();
			await subscriber.subscribe(channel, message => {
				try {
					const envelope = JSON.parse(message);
					if (envelope.source !== instanceId) accept(envelope.event);
				} catch { /* malformed pub/sub messages are ignored */ }
			});
			loaded = true;
			lastError = undefined;
		},
		publish(event) {
			accept(event);
			let message;
			try { message = JSON.stringify({ source: instanceId, event }); } catch { return; }
			if (Buffer.byteLength(message, 'utf8') > MAX_EVENT_BYTES || !loaded || closed) return;
			void publisher.publish(channel, message).catch(error => { lastError = error; });
		},
		subscribe(sessionId, listener) {
			bus.on(sessionId, listener);
			return () => bus.off(sessionId, listener);
		},
		subscribeAll(listener) {
			bus.on('*', listener);
			return () => bus.off('*', listener);
		},
		getLiveState(sessionId) {
			return { running: Boolean(live.get(sessionId)?.running), frame: live.get(sessionId)?.frame };
		},
		async check() {
			if (!loaded || closed) return false;
			try {
				const ready = await publisher.ping() === 'PONG';
				if (ready) lastError = undefined;
				return ready;
			} catch (error) { lastError = error; return false; }
		},
		close() {
			closePromise ??= (async () => {
				closed = true;
				await Promise.allSettled([subscriber.close(), publisher.close()]);
				bus.removeAllListeners();
				live.clear();
			})();
			return closePromise;
		}
	});
}
