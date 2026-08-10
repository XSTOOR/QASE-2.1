import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export function runWithRequestActor(authentication, callback) {
	const actorUserId = authentication?.actorUserId;
	return actorUserId
		? storage.run(Object.freeze({ actorUserId }), callback)
		: callback();
}

export function currentRequestActor() {
	return storage.getStore();
}
