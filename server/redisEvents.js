import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createClient } from 'redis';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

async function closeClient(client) {
	if (client.isReady === false && typeof client.destroy === 'function') {
		client.destroy();
		return;
	}
	// Readiness can change between this check and close(). The Redis client's
	// graceful drain otherwise waits indefinitely on commands queued offline.
	let timer;
	try {
		await Promise.race([
			Promise.resolve().then(() => client.close()),
			new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					try { client.destroy?.(); resolve(); } catch (error) { reject(error); }
				}, 1000);
			})
		]);
	} finally { clearTimeout(timer); }
}

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
	const frameChannelPrefix = `qase:v1:${tenant.organizationId}:${tenant.projectId}:frames:`;
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	const live = new Map();
	const frameSubscriptions = new Map();
	const framePublications = new Map();
	let loaded = false;
	let closed = false;
	let lastError;
	let closePromise;
	let healthProbe;

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

	function frameChannel(sessionId) {
		return `${frameChannelPrefix}${Buffer.from(String(sessionId), 'utf8').toString('base64url')}`;
	}

	function receive(message) {
		try {
			const envelope = JSON.parse(message);
			if (envelope.source !== instanceId) accept(envelope.event);
		} catch { /* malformed pub/sub messages are ignored */ }
	}

	async function activateFrameSubscription(entry) {
		if (!loaded || closed) return;
		if (entry.activation) return entry.activation;
		if (entry.active) return;
		entry.active = true;
		entry.activation = subscriber.subscribe(entry.channel, receive).catch(error => {
			entry.active = false;
			lastError = error;
			throw error;
		}).finally(() => {
			entry.activation = undefined;
		});
		return entry.activation;
	}

	function publishFrame(sessionId, message) {
		let state = framePublications.get(sessionId);
		if (!state) {
			state = { inFlight: false, pending: undefined };
			framePublications.set(sessionId, state);
		}
		if (state.inFlight) {
			// Redis is slower than capture. Keep only the newest unsent frame;
			// intermediate JPEGs would already be stale when delivered.
			state.pending = message;
			return;
		}

		const flush = async initial => {
			state.inFlight = true;
			let current = initial;
			while (current && loaded && !closed) {
				try {
					await publisher.publish(frameChannel(sessionId), current);
				} catch (error) {
					lastError = error;
				}
				current = state.pending;
				state.pending = undefined;
			}
			state.inFlight = false;
			framePublications.delete(sessionId);
		};
		void flush(message);
	}

	return Object.freeze({
		/** Observes every event from every run in this tenant (metrics, keepalive). */
		subscribeGlobal(listener) {
			bus.on('*', listener);
			return () => bus.off('*', listener);
		},
		async load() {
			if (loaded) return;
			publisher.on?.('error', error => { lastError = error; });
			subscriber.on?.('error', error => { lastError = error; });
			await publisher.connect();
			await subscriber.connect();
			await subscriber.subscribe(channel, receive);
			loaded = true;
			await Promise.all([...frameSubscriptions.values()].map(activateFrameSubscription));
			lastError = undefined;
		},
		publish(event) {
			accept(event);
			let message;
			try { message = JSON.stringify({ source: instanceId, event }); } catch { return; }
			if (Buffer.byteLength(message, 'utf8') > MAX_EVENT_BYTES || !loaded || closed) return;
			if (event?.type === 'frame' && typeof event.sessionId === 'string') {
				publishFrame(event.sessionId, message);
				return;
			}
			void publisher.publish(channel, message).catch(error => { lastError = error; });
		},
		async subscribe(sessionId, listener) {
			if (typeof listener !== 'function') throw new TypeError('Event listener must be a function.');
			if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Session id is required.');
			bus.on(sessionId, listener);
			let entry = frameSubscriptions.get(sessionId);
			if (!entry) {
				entry = { channel: frameChannel(sessionId), count: 0, active: false, activation: undefined };
				frameSubscriptions.set(sessionId, entry);
			}
			entry.count += 1;
			try {
				await activateFrameSubscription(entry);
			} catch (error) {
				bus.off(sessionId, listener);
				entry.count -= 1;
				if (entry.count === 0) frameSubscriptions.delete(sessionId);
				throw error;
			}
			let subscribed = true;
			return () => {
				if (!subscribed) return;
				subscribed = false;
				bus.off(sessionId, listener);
				entry.count -= 1;
				if (entry.count > 0) return;
				frameSubscriptions.delete(sessionId);
				if (entry.active && loaded && !closed) {
					entry.active = false;
					void subscriber.unsubscribe(entry.channel).catch(error => { lastError = error; });
				}
			};
		},
		subscribeAll(listener) {
			bus.on('*', listener);
			return () => bus.off('*', listener);
		},
		getLiveState(sessionId) {
			return { running: Boolean(live.get(sessionId)?.running), frame: live.get(sessionId)?.frame };
		},
		async check() {
			if (!loaded || closed || publisher.isReady===false || subscriber.isReady===false) return false;
			let timer;
			let offline;
			try {
				// One outstanding probe at most. An unavailable server must not
				// queue unlimited health checks or hang HTTP readiness requests.
				healthProbe??=Promise.resolve().then(()=>publisher.ping()).then(value=>value==='PONG').catch(error=>{lastError=error;return false;}).finally(()=>{healthProbe=undefined;});
				const disconnected=new Promise(resolve=>{offline=()=>resolve(false);for(const client of [publisher,subscriber]){client.on?.('reconnecting',offline);client.on?.('end',offline);}});
				const ready = await Promise.race([healthProbe,disconnected,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);timer.unref?.();})]);
				if (ready) lastError = undefined;
				return ready;
			} catch (error) { lastError = error; return false; }
			finally{clearTimeout(timer);if(offline)for(const client of [publisher,subscriber]){client.off?.('reconnecting',offline);client.off?.('end',offline);}}
		},
		close() {
			closePromise ??= (async () => {
				closed = true;
				await Promise.allSettled([subscriber,publisher].map(closeClient));
				bus.removeAllListeners();
				live.clear();
				frameSubscriptions.clear();
				framePublications.clear();
			})();
			return closePromise;
		}
	});
}
