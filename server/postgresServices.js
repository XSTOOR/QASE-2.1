import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRuntimeApplicationServices } from './localServices.js';
import { currentRequestActor } from './requestActor.js';
import { DEFAULT_DEVICE_ID, isDeviceId } from './deviceProfiles.js';

function clone(value) {
	return structuredClone(value);
}

function restore(target, snapshot) {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, clone(snapshot));
}

function createSession(title, now, options = {}) {
	const timestamp = now();
	const session = {
		id: options.id ?? randomUUID(),
		title: title || 'New test run',
		createdAt: timestamp,
		updatedAt: timestamp,
		status: 'idle',
		mode: 'qa',
		targetUrl: options.targetUrl,
		device: isDeviceId(options.device) ? options.device : DEFAULT_DEVICE_ID,
		deviceLandscape: options.deviceLandscape === true,
		messages: [],
		activities: [],
		findings: structuredClone(options.findings ?? []),
		todos: [],
		report: undefined,
		pendingQuestion: undefined,
		contextUsage: undefined,
		secretNames: [],
		ownerUserId: options.ownerUserId ?? currentRequestActor()?.actorUserId ?? options.tenantContext?.actorUserId
	};
	if (options.drytisIntegration !== undefined) {
		session.drytisIntegration = structuredClone(options.drytisIntegration);
	}
	return session;
}

function summary(session) {
	return {
		id: session.id,
		title: session.title,
		status: session.status,
		mode: session.mode === 'sqa' || session.mode === 'founder' ? session.mode : 'qa',
		targetUrl: session.targetUrl,
		device: isDeviceId(session.device) ? session.device : DEFAULT_DEVICE_ID,
		deviceLandscape: session.deviceLandscape === true,
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		findingCount: session.findings.length,
		messageCount: session.messages.length
	};
}

function eventActor(type, payload, tenantContext) {
	const messageRole = payload?.message?.role;
	if (payload?.message?.kind === 'integration') {
		return { actorType: 'system', actorUserId: undefined };
	}
	if (messageRole === 'user' || [
		'run.created', 'session', 'secrets', 'run.stop_requested', 'founder.created'
	].includes(type)) {
		return { actorType: 'user', actorUserId: currentRequestActor()?.actorUserId ?? tenantContext.actorUserId };
	}
	if (messageRole === 'system' || type === 'run.recovered' || type?.startsWith('drytis.')) {
		return { actorType: 'system', actorUserId: undefined };
	}
	return { actorType: 'agent', actorUserId: undefined };
}

/**
 * Compatibility adapter for the current single-process browser runtime.
 *
 * PostgreSQL is authoritative: every durable mutation is awaited and its SSE
 * event is published only after the database transaction commits. Hydrated run
 * objects stay process-local because the CleanSlate runtime closes over them;
 * worker leases and cross-process runtime ownership are intentionally deferred
 * to the later distributed-execution phase.
 */
export function createPostgresApplicationServices({
	repository,
	tenantContext,
	eventTransport,
	auth,
	hydrateAll = true,
	now = () => Date.now(),
	recoverActiveRuns = true
}) {
	if (!repository || typeof repository !== 'object') {
		throw new TypeError('A PostgreSQL run repository is required.');
	}
	if (!tenantContext || typeof tenantContext !== 'object') {
		throw new TypeError('A trusted tenant context is required.');
	}

	const sessions = new Map();
	const versions = new Map();
	const snapshots = new Map();
	const generations = new Map();
	const failedRuns = new Map();
	const live = new Map();
	const queues = new Map();
	const bus = new EventEmitter();
	bus.setMaxListeners(0);
	let initialized = false;
	let closing;
	let lastError;

	function liveFor(id) {
		let record = live.get(id);
		if (!record) {
			record = {};
			live.set(id, record);
		}
		return record;
	}

	function installRecord(record) {
		if (!record) return undefined;
		const incoming = record.session;
		const current = sessions.get(incoming.id);
		const currentVersion = versions.get(incoming.id);
		if (current && currentVersion !== undefined && Number(record.version) <= Number(currentVersion)) {
			return current;
		}
		let session = incoming;
		if (current && live.get(incoming.id)?.runtime) {
			restore(current, incoming);
			session = current;
		}
		sessions.set(session.id, session);
		versions.set(session.id, record.version);
		generations.set(session.id, 0);
		snapshots.set(session.id, clone(session));
		failedRuns.delete(session.id);
		return session;
	}

	function publish(session, type, payload = {}, timestamp = now()) {
		const event = { type, sessionId: session.id, ts: timestamp, ...payload };
		if (eventTransport) eventTransport.publish(event);
		else bus.emit(session.id, event);
	}

	function enqueue(id, operation) {
		const previous = queues.get(id) ?? Promise.resolve();
		const current = previous.then(operation);
		const tracked = current.then(() => undefined, () => undefined).finally(() => {
			if (queues.get(id) === tracked) queues.delete(id);
		});
		queues.set(id, tracked);
		return current;
	}

	async function commit(session, type, payload = {}) {
		if (sessions.get(session.id) !== session) {
			throw new Error('Cannot persist a run outside the selected tenant and project.');
		}
		const generation = (generations.get(session.id) ?? 0) + 1;
		generations.set(session.id, generation);
		const timestamp = now();
		session.updatedAt = timestamp;
		const candidate = clone(session);
		const eventPayload = clone(payload);
		const actor = eventActor(type, eventPayload, tenantContext);
		return enqueue(session.id, async () => {
			if (failedRuns.has(session.id)) throw failedRuns.get(session.id);
			const previous = snapshots.get(session.id);
			try {
				const result = await repository.save(candidate, {
					expectedVersion: versions.get(session.id),
					eventType: type,
					payload: eventPayload,
					eventTs: timestamp,
					...actor
				});
				candidate.updatedAt = result.updatedAt;
				if (generations.get(session.id) === generation) {
					session.updatedAt = result.updatedAt;
				}
				versions.set(session.id, result.version);
				snapshots.set(session.id, candidate);
				lastError = undefined;
				publish(session, type, eventPayload, timestamp);
				return session;
			} catch (error) {
				lastError = error;
				failedRuns.set(session.id, error);
				if (previous) restore(session, previous);
				throw error;
			}
		});
	}

	const runStore = {
		async load() {
			await eventTransport?.load();
			await repository.bootstrapTenant();
			const records = hydrateAll ? await repository.loadAll() : [];
			for (const { session, version } of records) {
				sessions.set(session.id, session);
				versions.set(session.id, version);
				generations.set(session.id, 0);
				snapshots.set(session.id, clone(session));
			}
			initialized = true;

			// Phase 2 retains one execution owner. A process restart cannot resume
			// its browser/model handles, so preserve the established interrupted
			// recovery behavior and clear vault names whose values no longer exist.
			for (const session of recoverActiveRuns ? sessions.values() : []) {
				const wasActive = session.status === 'running' || session.status === 'awaiting_input';
				const hadSecretNames = (session.secretNames?.length ?? 0) > 0;
				if (!wasActive && !hadSecretNames) continue;
				if (wasActive) {
					session.status = 'interrupted';
					session.pendingQuestion = undefined;
				}
				session.secretNames = [];
				await commit(session, 'run.recovered', {
					interrupted: wasActive,
					clearedSecretNames: hadSecretNames
				});
			}
		},
		async create(title = 'New test run', options = {}) {
			const session = createSession(title, now, { ...options, tenantContext });
			const eventType = options.eventType ?? 'run.created';
			const eventPayload = options.eventPayload ?? { title: session.title };
			const result = await repository.create(clone(session), {
				eventType,
				payload: eventPayload,
				...eventActor(eventType, eventPayload, tenantContext)
			});
			session.updatedAt = result.updatedAt;
			sessions.set(session.id, session);
			versions.set(session.id, result.version);
			generations.set(session.id, 0);
			snapshots.set(session.id, clone(session));
			publish(session, eventType, eventPayload, session.createdAt);
			return session;
		},
		async get(id) {
			// Keep this process's in-flight aggregate visible until its queued
			// transaction settles. Afterwards PostgreSQL is authoritative again.
			if (queues.has(id) && sessions.has(id)) return sessions.get(id);
			const record = typeof repository.get === 'function'
				? await repository.get(id)
				: (await repository.loadAll()).find(candidate => candidate.session.id === id);
			if (record) return installRecord(record);
			const runtime = live.get(id);
			if (!runtime?.running) {
				runtime?.dispose?.();
				live.delete(id);
				sessions.delete(id);
				versions.delete(id);
				snapshots.delete(id);
				generations.delete(id);
				failedRuns.delete(id);
			}
			return undefined;
		},
		async list(options) {
			if (typeof repository.list === 'function') return repository.list(options);
			return [...sessions.values()]
				.sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
				.slice(0, Math.min(100, Math.max(1, Number(options?.limit) || 100)))
				.map(summary);
		},
		async delete(id) {
			const session = sessions.get(id);
			if (!session) return false;
			const requestActor = currentRequestActor();
			const deleted = await enqueue(id, () => repository.delete(id, {
				expectedVersion: versions.get(id),
				eventType: 'run.deleted',
				payload: { reasonCode: 'user_request' },
				correlationId: requestActor?.requestId,
				...eventActor('session', {}, tenantContext)
			}));
			if (!deleted) return false;
			const record = live.get(id);
			record?.controller?.abort();
			record?.dispose?.();
			live.delete(id);
			sessions.delete(id);
			versions.delete(id);
			snapshots.delete(id);
			generations.delete(id);
			failedRuns.delete(id);
			return true;
		},
		async recordCleanup(id, options = {}) {
			if (typeof repository.recordCleanup !== 'function') {
				return { recorded: false, reason: 'unsupported', runId: id };
			}
			return repository.recordCleanup(id, options);
		},
		commit,
		async addMessage(session, message) {
			const entry = { id: randomUUID(), ts: now(), ...message };
			session.messages.push(entry);
			await commit(session, 'message', { message: entry });
			return entry;
		},
		async addActivity(session, activity) {
			const entry = { id: activity.id ?? randomUUID(), ts: now(), status: 'done', ...activity };
			session.activities.push(entry);
			if (session.activities.length > 500) {
				session.activities.splice(0, session.activities.length - 500);
			}
			await commit(session, 'activity', { activity: entry });
			return entry;
		},
		async updateActivity(session, id, patch) {
			const entry = session.activities.find(candidate => candidate.id === id);
			if (!entry) return undefined;
			Object.assign(entry, patch);
			await commit(session, 'activity', { activity: entry });
			return entry;
		},
		async setStatus(session, status, detail) {
			session.status = status;
			await commit(session, 'status', { status, detail });
		},
		publish,
		subscribe(sessionId, listener) {
			if (eventTransport) return eventTransport.subscribe(sessionId, listener);
			bus.on(sessionId, listener);
			return () => bus.off(sessionId, listener);
		},
		liveFor,
		peekLive(id) {
			return live.get(id);
		},
		dropLive(id) {
			return live.delete(id);
		},
		listLive() {
			return [...live.entries()].map(([id, record]) => ({ id, record }));
		},
		async check() {
			if (!initialized || closing || lastError) {
				return { ready: false, checks: { postgres: lastError ? 'error' : 'initializing' } };
			}
			try {
				await repository.check();
				const realtimeReady = eventTransport ? await eventTransport.check() : true;
				return {
					ready: realtimeReady,
					checks: { postgres: 'ready', ...(eventTransport ? { redis: realtimeReady ? 'ready' : 'error' } : {}) }
				};
			} catch (error) {
				lastError = error;
				return { ready: false, checks: { postgres: 'error' } };
			}
		},
		close() {
			closing ??= (async () => {
				await Promise.allSettled([...queues.values()]);
				for (const record of live.values()) record.dispose?.();
				live.clear();
				await eventTransport?.close();
				await repository.close();
			})();
			return closing;
		}
	};

	const services = createRuntimeApplicationServices(runStore, { auth });
	services.tenantContext = tenantContext;
	services.realtime = eventTransport;
	return services;
}
