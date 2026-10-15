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
import { createLocalAuthService, createPostgresAuthService } from './auth.js';
import { createEnvironmentService, createLocalEnvironmentBackend } from './environmentService.js';
import { registerCatalogProvider } from './catalogProviderRegistry.js';
import { createBrowserstackCatalogProvider } from './browserstackCatalogProvider.js';
import { createPostgresEnvironmentRepository } from './postgres/environmentRepository.js';
import { createLocalDeviceCatalogBackend } from './localDeviceCatalog.js';
import { createPostgresDeviceCatalogRepository } from './postgres/deviceCatalogRepository.js';
import { createDeviceRuntimeManager } from './deviceRuntime/manager.js';
import { createLocalSimulationProvider } from './deviceRuntime/localSimulationProvider.js';
import { createBrowserstackRuntimeProvider } from './deviceRuntime/browserstackRuntimeProvider.js';
import { createNullRealDeviceProvider } from './deviceRuntime/nullRealDeviceProvider.js';
import { createTestCaseService, createLocalTestCaseBackend } from './testCaseService.js';
import { createPostgresTestCaseRepository } from './postgres/testCaseRepository.js';
import { createBugService, createLocalBugBackend } from './bugService.js';
import { createPostgresBugRepository } from './postgres/bugRepository.js';
import { createCoverageService } from './coverageService.js';
import { createMatrixService, createLocalMatrixBackend } from './matrixService.js';
import { createPostgresMatrixRepository } from './postgres/matrixRunRepository.js';
import { createTestCaseAutogen, autogenSettingsFromEnv } from './testCaseAutogen.js';
import { getConfig as readModelConfig } from './config.js';

export const RUN_STORE_MODES = Object.freeze(['local', 'postgres']);
export const EXECUTION_MODES = Object.freeze(['local', 'distributed']);

/**
 * Auto-generate test cases when a QA run publishes its report. Subscribes to
 * the run bus; failures are logged and swallowed so generation can never
 * affect the run itself. Called for both local and postgres service paths.
 */
function attachTestCaseAutogen({ services, environment, getConfig }) {
	if (!services?.testCases || typeof services.runs?.subscribeGlobal !== 'function') return;
	const configProvider = getConfig ?? readModelConfig;
	// Reusable engine for the API surface ("Generate from run"); the same
	// settings and config resolution the bus trigger uses.
	services.testCaseAutogen = {
		async generateForRun(session) {
			const engine = createTestCaseAutogen({
				testCases: services.testCases,
				settings: autogenSettingsFromEnv(environment),
				config: configProvider(),
				logger: (line) => console.log(line)
			});
			return engine.generateForSession(session);
		}
	};
	services.runs.subscribeGlobal(async (sessionId, event) => {
		try {
			if (event?.type !== 'report') return;
			const session = services.runs.get ? await services.runs.get(sessionId) : null;
			if (!session) return;
			await services.testCaseAutogen.generateForRun(session);
		} catch (error) {
			console.log(`[autogen] generation failed for run ${sessionId}: ${error?.message ?? error}`);
		}
	});
}

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
 * The selected store also receives the matching account/profile adapter so
 * authentication and run ownership cannot diverge between environments.
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
		// Phase 21: create the manager FIRST so every run turn can consult it.
		// RT1 (#14680): no external device-testing provider participates in
		// availability or execution. QASE's own runtime = the local simulation
		// provider (real local binaries + emulated device profiles). The
		// BrowserStack provider is registered ONLY when credentials are
		// explicitly configured AND the operator opts in via
		// QASE_ENABLE_EXTERNAL_PROVIDERS=true — otherwise it stays dormant and
		// never upgrades availability.
		const externalEnabled = String(process.env.QASE_ENABLE_EXTERNAL_PROVIDERS ?? '').trim().toLowerCase() === 'true';
		const stackCredentials = Boolean(String(process.env.BROWSERSTACK_USERNAME ?? '').trim())
			&& Boolean(String(process.env.BROWSERSTACK_ACCESS_KEY ?? '').trim());
		const runtimeProviders = [createLocalSimulationProvider()];
		if (externalEnabled && stackCredentials) runtimeProviders.push(createBrowserstackRuntimeProvider());
		runtimeProviders.push(createNullRealDeviceProvider());
		const deviceRuntime = options.createDeviceRuntimeManager?.() ?? createDeviceRuntimeManager({
			providers: runtimeProviders
		});
		const services = (options.createLocalServices ?? createLocalApplicationServices)({ tenantContext, deviceRuntime });
		services.tenantContext = tenantContext;
		await services.auth?.load?.();
		await services.runs.load();
		const deviceCatalog = options.createLocalDeviceCatalog?.() ?? createLocalDeviceCatalogBackend();
		await deviceCatalog.seed();
		services.environments = createEnvironmentService(
			options.createLocalEnvironmentBackend?.({ catalogBackend: deviceCatalog }) ?? createLocalEnvironmentBackend({ catalogBackend: deviceCatalog }),

			{ tenantContext }
		);
		// #14275 (Phase 2): register the BrowserStack catalog provider
		// (inert without credentials) BEFORE seeding so the registry-sourced
		// seed can merge provider overlays.
		registerCatalogProvider(createBrowserstackCatalogProvider());
		await services.environments.seed();
		services.environments.attachCatalog(deviceCatalog);
		services.deviceCatalog = deviceCatalog;
		services.testCases = createTestCaseService(
			options.createLocalTestCaseBackend?.() ?? createLocalTestCaseBackend(),
			{ environments: services.environments, tenantContext }
		);
		// Phase 6: bug reports with BUG-XXXX ids + auto environment association.
		services.bugs = createBugService(
			options.createLocalBugBackend?.() ?? createLocalBugBackend(),
			{ environments: services.environments, runs: services.runs, tenantContext }
		);
		// Phase 21: device runtime manager with the three honest providers.
		services.deviceRuntime = deviceRuntime;
		// #14633 (NI02 Phase 1): server-side matrix runs — orchestrator hooks
		// are bound by app.js where the session-creation machinery lives.
		// Created BEFORE coverage so the coverage service can bind its list.
		services.matrix = createMatrixService(
			options.createLocalMatrixBackend?.() ?? createLocalMatrixBackend(),
			{ environments: services.environments, runs: services.runs, testCases: services.testCases }
		);
		// Phase 7: coverage dashboard aggregation (test cases × environments × runs).
		services.coverage = createCoverageService({
			testCases: services.testCases,
			environments: services.environments,
			runs: services.runs,
			listRuns: services.runs.listAll?.bind(services.runs),
			listMatrixRuns: services.matrix?.list?.bind(services.matrix),
			tenantContext
		});
		attachTestCaseAutogen({ services, environment, getConfig: options.getConfig });
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
		const auth = options.createAuthService
			? options.createAuthService({ pool, tenantContext })
			: typeof pool.connect === 'function' ? createPostgresAuthService({ pool, tenantContext }) : undefined;
		if (auth) await auth.load?.();
		if (executionMode === 'distributed') {
			eventTransport = (options.createEventTransport ?? createRedisEventTransport)({
				environment, tenantContext
			});
			credentialVault = (options.createCredentialVault ?? createDistributedSecrets)({
				environment, tenantContext
			});
		}
		// Phase 21: create the manager before services so run turns can consult it.
		// RT1 (#14680): same external-provider demotion as the local branch.
		const externalEnabled = String(process.env.QASE_ENABLE_EXTERNAL_PROVIDERS ?? '').trim().toLowerCase() === 'true';
		const stackCredentials = Boolean(String(process.env.BROWSERSTACK_USERNAME ?? '').trim())
			&& Boolean(String(process.env.BROWSERSTACK_ACCESS_KEY ?? '').trim());
		const runtimeProviders = [createLocalSimulationProvider()];
		if (externalEnabled && stackCredentials) runtimeProviders.push(createBrowserstackRuntimeProvider());
		runtimeProviders.push(createNullRealDeviceProvider());
		const deviceRuntime = options.createDeviceRuntimeManager?.() ?? createDeviceRuntimeManager({
			providers: runtimeProviders
		});
		services = (options.createPostgresServices ?? createPostgresApplicationServices)({
			repository,
			tenantContext,
			deviceRuntime,
			 eventTransport,
			auth,
			hydrateAll: executionMode !== 'distributed',
			recoverActiveRuns: executionMode === 'distributed' ? false : recoverPostgresRunsOnStartup(environment)
		});
		await services.runs.load();
		await credentialVault?.load();
		const deviceCatalog = (options.createDeviceCatalogRepository ?? createPostgresDeviceCatalogRepository)(pool);
		await deviceCatalog.seed();
		const environmentRepository = (options.createEnvironmentRepository ?? createPostgresEnvironmentRepository)(
			pool,
			{ tenantContext, catalogBackend: deviceCatalog }
		);
		services.environments = createEnvironmentService(environmentRepository, { tenantContext });
		// #14275 (Phase 2): register the BrowserStack catalog provider BEFORE
		// seeding so the registry-sourced seed can merge provider overlays.
		// Without BROWSERSTACK_* credentials it is connected:false and
		// contributes nothing — the builtin catalog stands alone.
		registerCatalogProvider(createBrowserstackCatalogProvider());
		await services.environments.seed();
		services.environments.attachCatalog(deviceCatalog);
		services.deviceCatalog = deviceCatalog;
		services.testCases = createTestCaseService(
			(options.createTestCaseRepository ?? createPostgresTestCaseRepository)(pool, { tenantContext }),
			{ environments: services.environments, tenantContext }
		);
		services.bugs = createBugService(
			(options.createBugRepository ?? createPostgresBugRepository)(pool, { tenantContext }),
			{ environments: services.environments, runs: services.runs, tenantContext }
		);
		// #14633 (NI02 Phase 1): matrix runs over the postgres backend.
		// Created BEFORE coverage so the coverage service can bind its list.
		services.matrix = createMatrixService(
			(options.createMatrixRepository ?? createPostgresMatrixRepository)(pool, { tenantContext }),
			{ environments: services.environments, runs: services.runs, testCases: services.testCases }
		);
		// Phase 7: coverage dashboard aggregation (test cases × environments × runs).
		services.coverage = createCoverageService({
			testCases: services.testCases,
			environments: services.environments,
			runs: services.runs,
			listRuns: services.runs.listAll?.bind(services.runs),
			listMatrixRuns: services.matrix?.list?.bind(services.matrix),
			tenantContext
		});
		attachTestCaseAutogen({ services, environment, getConfig: options.getConfig });
		// Phase 21: device runtime manager with the three honest providers.
		services.deviceRuntime = deviceRuntime;
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
