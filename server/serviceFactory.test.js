import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	RUN_STORE_MODES,
	configuredExecutionMode,
	configuredRunStore,
	createConfiguredApplicationServices
} from './serviceFactory.js';

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((accept, decline) => {
		resolve = accept;
		reject = decline;
	});
	return { promise, resolve, reject };
}

test('run-store selection defaults to local and rejects unsupported modes', () => {
	assert.equal(configuredRunStore({}), 'local');
	assert.equal(configuredRunStore({ QASE_RUN_STORE: ' local ' }), 'local');
	assert.equal(configuredRunStore({ QASE_RUN_STORE: 'POSTGRES' }), 'postgres');
	assert.ok(RUN_STORE_MODES);
	assert.throws(
		() => configuredRunStore({ QASE_RUN_STORE: 'automatic-fallback' }),
		/unsupported|unknown|QASE_RUN_STORE/i
	);
});

test('execution selection defaults to local and distributed mode refuses local persistence', async () => {
	assert.equal(configuredExecutionMode({}), 'local');
	assert.equal(configuredExecutionMode({ QASE_EXECUTION_MODE: ' DISTRIBUTED ' }), 'distributed');
	assert.throws(() => configuredExecutionMode({ QASE_EXECUTION_MODE: 'magic' }), /local, distributed/);
	await assert.rejects(() => createConfiguredApplicationServices({
		environment: { QASE_EXECUTION_MODE: 'distributed' }
	}), /requires QASE_RUN_STORE=postgres/);
});

test('local mode loads only local services and never constructs PostgreSQL infrastructure', async () => {
	const calls = [];
	const localServices = {
		runs: {
			async load() {
				calls.push('local:load');
			}
		},
		lifecycle: { close: async () => undefined }
	};
	const result = await createConfiguredApplicationServices({
		environment: {},
		createLocalServices() {
			calls.push('local:create');
			return localServices;
		},
		createPool() {
			calls.push('postgres:pool');
			throw new Error('PostgreSQL must not be constructed in local mode.');
		},
		runMigrations() {
			calls.push('postgres:migrate');
			throw new Error('PostgreSQL migrations must not run in local mode.');
		},
		createRepository() {
			calls.push('postgres:repository');
			throw new Error('PostgreSQL repository must not be constructed in local mode.');
		},
		createPostgresServices() {
			calls.push('postgres:services');
			throw new Error('PostgreSQL services must not be constructed in local mode.');
		}
	});

	assert.equal(result.mode, 'local');
	assert.equal(result.services, localServices);
	assert.ok(result.tenantContext);
	assert.deepEqual(calls, ['local:create', 'local:load']);
});

test('postgres mode awaits migrations and service loading before becoming available', async () => {
	const migration = deferred();
	const load = deferred();
	const calls = [];
	const pool = { end: async () => calls.push('pool:end') };
	const repository = { close: async () => pool.end() };
	const services = {
		runs: {
			async load() {
				calls.push('services:load:start');
				await load.promise;
				calls.push('services:load:done');
			}
		},
		lifecycle: { close: async () => repository.close() }
	};
	let settled = false;
	const creation = createConfiguredApplicationServices({
		environment: { QASE_RUN_STORE: 'postgres' },
		createLocalServices() {
			calls.push('local:create');
			throw new Error('Postgres mode must never fall back to local.');
		},
		createPool({ environment }) {
			assert.equal(environment.QASE_RUN_STORE, 'postgres');
			calls.push('pool:create');
			return pool;
		},
		async runMigrations(receivedPool) {
			assert.equal(receivedPool, pool);
			calls.push('migrate:start');
			await migration.promise;
			calls.push('migrate:done');
		},
		createRepository(options) {
			assert.equal(options.pool, pool);
			assert.ok(Object.isFrozen(options.tenantContext));
			calls.push('repository:create');
			return repository;
		},
		createPostgresServices(options) {
			assert.equal(options.repository, repository);
			assert.ok(options.tenantContext);
			calls.push('services:create');
			return services;
		}
	});
	void creation.finally(() => {
		settled = true;
	});

	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(calls, ['pool:create', 'migrate:start']);

	migration.resolve();
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(settled, false);
	assert.deepEqual(calls, [
		'pool:create', 'migrate:start', 'migrate:done',
		'repository:create', 'services:create', 'services:load:start'
	]);

	load.resolve();
	const result = await creation;
	assert.equal(result.mode, 'postgres');
	assert.equal(result.services, services);
	assert.equal(result.tenantContext, result.tenantContext);
	assert.deepEqual(calls, [
		'pool:create', 'migrate:start', 'migrate:done',
		'repository:create', 'services:create', 'services:load:start', 'services:load:done'
	]);
});

test('postgres startup failure closes its pool and never falls back to local', async () => {
	const failure = new Error('migration unavailable');
	let poolCloseCalls = 0;
	let localCalls = 0;
	const pool = {
		async end() {
			poolCloseCalls += 1;
		}
	};

	await assert.rejects(
		createConfiguredApplicationServices({
			environment: { QASE_RUN_STORE: 'postgres' },
			createLocalServices() {
				localCalls += 1;
				return { runs: { load: async () => undefined } };
			},
			createPool: () => pool,
			runMigrations: async () => {
				throw failure;
			},
			createRepository() {
				throw new Error('Repository must not be created after migration failure.');
			},
			createPostgresServices() {
				throw new Error('Services must not be created after migration failure.');
			}
		}),
		failure
	);
	assert.equal(poolCloseCalls, 1);
	assert.equal(localCalls, 0);
});

test('distributed API mode wires Redis, encrypted secrets, queue, and remote agent before readiness', async () => {
	const calls = [];
	const pool = { end: async () => calls.push('pool:end') };
	const repository = { close: async () => pool.end() };
	const eventTransport = {
		load: async () => calls.push('events:load'), check: async () => true,
		close: async () => calls.push('events:close')
	};
	const credentialVault = {
		load: async () => calls.push('secrets:load'), check: async () => true,
		close: async () => calls.push('secrets:close')
	};
	const executionQueue = { check: async () => true };
	const remoteAgent = { isRemote: true };
	let serviceOptions;
	const services = {
		runs: { load: async () => { await serviceOptions.eventTransport.load(); calls.push('runs:load'); } },
		readiness: { check: async () => ({ ready: true, checks: { postgres: 'ready' } }) },
		lifecycle: { close: async () => { await eventTransport.close(); await repository.close(); } },
		secrets: {}, agent: { local: true }
	};
	const result = await createConfiguredApplicationServices({
		environment: {
			QASE_RUN_STORE: 'postgres', QASE_EXECUTION_MODE: 'distributed',
			QASE_DATABASE_MIGRATE_ON_START: 'false'
		},
		pool,
		createRepository: () => repository,
		createEventTransport: () => eventTransport,
		createCredentialVault: () => credentialVault,
		createPostgresServices: options => {
			serviceOptions = options;
			assert.equal(options.hydrateAll, false);
			assert.equal(options.recoverActiveRuns, false);
			return services;
		},
		createExecutionQueue: options => { assert.equal(options.pool, pool); return executionQueue; },
		createDistributedAgent: options => {
			assert.equal(options.queue, executionQueue);
			assert.equal(options.realtime, eventTransport);
			return remoteAgent;
		}
	});
	assert.equal(result.executionMode, 'distributed');
	assert.equal(result.executionRole, 'api');
	assert.equal(result.services.agent, remoteAgent);
	assert.equal(result.services.secrets, credentialVault);
	assert.equal((await result.services.readiness.check()).ready, true);
	assert.deepEqual(calls.slice(0, 3), ['events:load', 'runs:load', 'secrets:load']);
	await result.services.lifecycle.close();
	assert.ok(calls.includes('secrets:close'));
});
