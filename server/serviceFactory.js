import { createLocalApplicationServices } from './localServices.js';
import { createPostgresApplicationServices } from './postgresServices.js';
import { runPostgresMigrations } from './postgres/migrations.js';
import { createPostgresPool } from './postgres/pool.js';
import { createPostgresRunRepository } from './postgres/runRepository.js';
import { createTenantContext } from './tenancy.js';

export const RUN_STORE_MODES = Object.freeze(['local', 'postgres']);

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
	const tenantContext = createTenantContext(environment);

	if (mode === 'local') {
		const services = (options.createLocalServices ?? createLocalApplicationServices)();
		services.tenantContext = tenantContext;
		await services.runs.load();
		return { mode, services, tenantContext, pool: undefined };
	}

	const pool = options.pool ?? (options.createPool ?? createPostgresPool)({ environment });
	let repository;
	try {
		if (migrateOnPostgresStartup(environment)) {
			await (options.runMigrations ?? runPostgresMigrations)(pool);
		}
		repository = (options.createRepository ?? createPostgresRunRepository)({
			pool,
			tenantContext
		});
		const services = (options.createPostgresServices ?? createPostgresApplicationServices)({
			repository,
			tenantContext,
			recoverActiveRuns: recoverPostgresRunsOnStartup(environment)
		});
		await services.runs.load();
		return { mode, services, tenantContext, pool };
	} catch (error) {
		if (repository) await repository.close().catch(() => undefined);
		else if (typeof pool.end === 'function') await Promise.resolve(pool.end()).catch(() => undefined);
		throw error;
	}
}
