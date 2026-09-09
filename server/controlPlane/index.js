import 'dotenv/config';
import { createControlPlaneApplication } from './app.js';
import { runControlPlaneMigrations } from './migrations.js';
import { createControlPlaneRepository } from './repository.js';
import { createOperationalControls } from '../operations.js';
import { createOperationalLogger } from '../operationalLogger.js';
import { createPostgresPool } from '../postgres/pool.js';
import { drainHttpServer, installShutdownHandlers } from '../processLifecycle.js';

const environment = process.env;
const logger = createOperationalLogger({ component: 'qase-control', environment });
const databaseUrl = String(environment.QASE_CONTROL_DATABASE_URL ?? '').trim();
if (!databaseUrl) throw new Error('Control plane requires QASE_CONTROL_DATABASE_URL.');
const operations = createOperationalControls({ environment, mutationPrefixes: ['/internal/'], logger });
const databaseEnvironment = {
	...environment,
	QASE_DATABASE_URL: databaseUrl,
	QASE_DATABASE_SSL: environment.QASE_CONTROL_DATABASE_SSL ?? environment.QASE_DATABASE_SSL,
	QASE_DATABASE_POOL_MIN: environment.QASE_CONTROL_DATABASE_POOL_MIN ?? environment.QASE_DATABASE_POOL_MIN,
	QASE_DATABASE_POOL_MAX: environment.QASE_CONTROL_DATABASE_POOL_MAX ?? environment.QASE_DATABASE_POOL_MAX
};
const pool = createPostgresPool({
	environment: databaseEnvironment,
	applicationName: 'qase-control-plane'
});
let repository;
let server;
let closing = false;
try {
	const migrate = String(environment.QASE_CONTROL_DATABASE_MIGRATE_ON_START
		?? (environment.NODE_ENV === 'production' ? 'false' : 'true')).toLowerCase() === 'true';
	if (migrate) await runControlPlaneMigrations(pool);
	repository = createControlPlaneRepository({
		pool,
		staleAfterSeconds: environment.QASE_CONTROL_CELL_STALE_SECONDS
			? Number(environment.QASE_CONTROL_CELL_STALE_SECONDS) : undefined
	});
	const { app } = createControlPlaneApplication({ repository, environment, operations, logger, isDraining: () => closing });
	const host = String(environment.QASE_CONTROL_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
	const port = Number(environment.QASE_CONTROL_PORT ?? 5180);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError('QASE_CONTROL_PORT is invalid.');
	server = await new Promise((resolve, reject) => {
		const onError = error => reject(error);
		const candidate = app.listen(port, host, () => {
			candidate.off('error', onError);
			resolve(candidate);
		});
		candidate.once('error', onError);
	});
	logger.info('process.started', { host, port });
} catch (error) {
	await (repository?.close() ?? pool.end()).catch(() => undefined);
	throw error;
}

installShutdownHandlers({
	logger, timeoutMs: 20_000,
	onDraining: signal => {
		closing = true;
		logger.info('process.draining', { signal });
	},
	steps: [() => drainHttpServer(server), () => repository.close()]
});
