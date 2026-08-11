import { createLocalApplicationServices } from './localServices.js';
import { createPostgresApplicationServices } from './postgresServices.js';
import { runPostgresMigrations } from './postgres/migrations.js';
import { createPostgresPool } from './postgres/pool.js';
import { createPostgresRunRepository } from './postgres/runRepository.js';
import { createTenantContext } from './tenancy.js';
import { createRedisEventTransport } from './redisEvents.js';
import { createPostgresExecutionQueue } from './postgres/executionQueue.js';
import { createDistributedApiAgent } from './distributedExecution.js';
import { createDistributedSecrets } from './distributedSecrets.js';

export const RUN_STORE_MODES = Object.freeze(['local', 'postgres']);
export const EXECUTION_MODES = Object.freeze(['local', 'distributed']);

export function configuredExecutionMode(environment = process.env) {
	const mode = String(environment.QASE_EXECUTION_MODE ?? 'local').trim().toLowerCase();
	if (!EXECUTION_MODES.includes(mode)) {
		throw new TypeError(`QASE_EXECUTION_MODE must be one of: ${EXECUTION_MODES.join(', ')}.`);
	}
	return mode;
}

export function configuredRunStore(environment = process.env) {
	const mode = String(environment.QASE_RUN_STORE ?? 'local').trim().toLowerCase();
	if (!RUN_STORE_MODES.includes(mode)) {
		throw new TypeError(`QASE_RUN_STORE must be one of: ${RUN_STORE_MODES.join(', ')}.`);
	}
	return mode;
}

export function migrateOnPostgresStartup(environment = process.env) {
	const configured = environment.QASE_DATABASE_MIGRATE_ON_START;
	if (configured === undefined || configured === '') {
		return environment.NODE_ENV !== 'production';
	}
	const value = String(configured).trim().toLowerCase();
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new TypeError('QASE_DATABASE_MIGRATE_ON_START must be true or false.');
}

export function recoverPostgresRunsOnStartup(environment = process.env) {
	const configured = environment.QASE_POSTGRES_RECOVER_ACTIVE_RUNS;
	if (configured === undefined || configured === '') {
		return environment.NODE_ENV !== 'production';
	}
	const value = String(configured).trim().toLowerCase();
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new TypeError('QASE_POSTGRES_RECOVER_ACTIVE_RUNS must be true or false.');
}

/**
 * Selects exactly one authoritative run store. PostgreSQL failures are fatal;
 * silently falling back to local JSON would create split-brain run histories.
 */
export async function createConfiguredApplicationServices(options = {}) {
	const environment = options.environment ?? process.env;
	const mode = configuredRunStore(environment);
	const executionMode = configuredExecutionMode(environment);
	const executionRole = options.executionRole ?? 'api';
	if (!['api', 'worker'].includes(executionRole)) throw new TypeError('executionRole must be api or worker.');
	const tenantContext = createTenantContext(environment);

	if (mode === 'local') {
		if (executionMode === 'distributed') throw new Error('Distributed execution requires QASE_RUN_STORE=postgres.');
		const services = (options.createLocalServices ?? createLocalApplicationServices)();
		services.tenantContext = tenantContext;
		await services.runs.load();
		return { mode, executionMode, services, tenantContext, pool: undefined };
	}

	const pool = options.pool ?? (options.createPool ?? createPostgresPool)({ environment });
	let repository;
	let eventTransport;
	let services;
	let credentialVault;
	try {
		if (migrateOnPostgresStartup(environment)) {
			await (options.runMigrations ?? runPostgresMigrations)(pool);
		}
		repository = (options.createRepository ?? createPostgresRunRepository)({
			pool,
			tenantContext,
			runRetentionDays: environment.QASE_RUN_RETENTION_DAYS
				? Number(environment.QASE_RUN_RETENTION_DAYS)
				: undefined
		});
		if (executionMode === 'distributed') {
			eventTransport = (options.createEventTransport ?? createRedisEventTransport)({
				environment, tenantContext
			});
			credentialVault = (options.createCredentialVault ?? createDistributedSecrets)({
				environment, tenantContext
			});
		}
		services = (options.createPostgresServices ?? createPostgresApplicationServices)({
			repository,
			tenantContext,
			eventTransport,
			hydrateAll: executionMode !== 'distributed',
			recoverActiveRuns: executionMode === 'distributed' ? false : recoverPostgresRunsOnStartup(environment)
		});
		await services.runs.load();
		await credentialVault?.load();
		let executionQueue;
		if (executionMode === 'distributed') {
			executionQueue = (options.createExecutionQueue ?? createPostgresExecutionQueue)({
				pool, tenantContext,
				leaseMs: environment.QASE_WORKER_LEASE_MS ? Number(environment.QASE_WORKER_LEASE_MS) : undefined,
				maxAttempts: environment.QASE_JOB_MAX_ATTEMPTS ? Number(environment.QASE_JOB_MAX_ATTEMPTS) : undefined,
				retentionDays: environment.QASE_JOB_RETENTION_DAYS ? Number(environment.QASE_JOB_RETENTION_DAYS) : undefined,
				maxActiveJobs: environment.QASE_QUEUE_MAX_ACTIVE_JOBS ? Number(environment.QASE_QUEUE_MAX_ACTIVE_JOBS) : undefined
			});
			if (executionRole === 'api') {
				services.agent = (options.createDistributedAgent ?? createDistributedApiAgent)({
					queue: executionQueue, realtime: eventTransport, runs: services.runs, tenantContext
				});
				services.secrets = credentialVault;
			}
			const baseReadiness = services.readiness.check;
			services.readiness.check = async () => {
				const result = await baseReadiness();
				const [secretsReady, queueReady] = await Promise.all([
					credentialVault.check(), executionQueue.check()
				]);
				return {
					...result,
					ready: result.ready === true && secretsReady && queueReady,
					checks: {
						...(result.checks ?? {}),
						distributedQueue: queueReady ? 'ready' : 'error',
						distributedSecrets: secretsReady ? 'ready' : 'error'
					}
				};
			};
			const baseClose = services.lifecycle.close;
			services.lifecycle.close = async () => {
				await Promise.allSettled([credentialVault.close(), baseClose()]);
			};
		}
		return {
			mode, executionMode, executionRole, services, tenantContext, pool,
			executionQueue, eventTransport, credentialVault
		};
	} catch (error) {
		if (services) {
			await services.lifecycle.close().catch(() => undefined);
		} else {
			await Promise.allSettled([
				credentialVault?.close(),
				eventTransport?.close(),
				repository?.close() ?? (typeof pool.end === 'function' ? Promise.resolve(pool.end()) : undefined)
			]);
		}
		throw error;
	}
}
