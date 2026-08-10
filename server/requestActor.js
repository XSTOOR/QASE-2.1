import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithRequestActor(authentication, callback) {
	const actorUserId = authentication?.actorUserId;
	const requestId = authentication?.requestId;
	return actorUserId || requestId
		? storage.run(Object.freeze({ ...(actorUserId ? { actorUserId } : {}), ...(requestId ? { requestId } : {}) }), callback)
		: callback();
}

export function currentRequestActor() {
	return storage.getStore();
}
