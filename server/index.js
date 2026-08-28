import 'dotenv/config';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createOperationalControls } from './operations.js';
import { createOperationalLogger } from './operationalLogger.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';
import { createConfiguredDrytisIntegration } from './drytisIntegrationFactory.js';

// Validate process-local operational limits and metrics credentials before
// opening PostgreSQL or Redis clients.
const logger = createOperationalLogger({ component: 'qase-api' });
const operations = createOperationalControls({ logger });
const {
	services, mode: runStoreMode, executionMode, tenantContext, pool, executionQueue
} = await createConfiguredApplicationServices();
const access = createInstanceAccess({ tenantContext });
const drytisIntegration = createConfiguredDrytisIntegration({
	services,
	tenantContext,
	pool,
	runStoreMode,
	logger
});

let shuttingDown = false;
const { app, demoEnabled } = createApplication({
	services, access, executionQueue, operations, logger,
	drytisIntegrationApi: drytisIntegration?.api,
	isDraining: () => shuttingDown
});
const port = Number(process.env.PORT ?? 5173);
const host = String(process.env.QASE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';

// Chromium is a child process; without this it can outlive the server process.
let server;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		if (shuttingDown) {
			process.exit(1);
		}
		shuttingDown = true;
		logger.info('process.draining', { signal });
		let closeHttp = Promise.resolve();
		if (server) {
			closeHttp = new Promise(resolve => server.close(() => resolve()));
			const completed = await Promise.race([
				closeHttp.then(() => true),
				new Promise(resolve => setTimeout(() => resolve(false), 10_000))
			]);
			if (!completed) {
				server.closeAllConnections?.();
				await closeHttp;
			}
		}
		let summaries = [];
		try {
			summaries = await services.runs.list();
		} catch {
			// Database readiness may be the reason for shutdown; pool cleanup and
			// process-local browser cleanup must still continue.
		}
		await Promise.all(summaries.map(summary => {
			if (!services.agent.isRemote) services.agent.stop(summary.id);
			return services.agent.closeBrowser(summary.id);
		}));
		await services.lifecycle.close();
		process.exit(0);
	});
}

server = app.listen(port, host, () => {
	const config = services.configuration.getPublic();
	if (process.env.NODE_ENV === 'production') {
		logger.info('process.started', {
			host, port, storeMode: runStoreMode, executionMode,
			accessMode: 'embedded-instance', drytisIntegration: Boolean(drytisIntegration),
			provider: config.provider, model: config.model
		});
		if (config.problem) logger.warn('configuration.problem', { errorName: 'ConfigurationError' });
		return;
	}
	console.log('\n  Qase — autonomous QA agent');
	console.log(`  http://${host}:${port}`);
	console.log(`  run store: ${runStoreMode}`);
	console.log(`  execution: ${executionMode}`);
	console.log('  access: Drytis-owned embedded instance');
	console.log(`  Drytis integration: ${drytisIntegration ? 'enabled' : 'disabled'}`);
	console.log(`  ${config.provider} · ${config.model}${config.baseUrl ? ` · ${config.baseUrl}` : ''}`);
	if (demoEnabled) {
		console.log(`  practice target: http://${host}:${port}/demo  (demo@qase.dev / demo1234)`);
	}
	console.log('');
	if (config.problem) {
		console.log(`  ! ${config.problem} Set it in the dashboard under Settings, or in .env.\n`);
	}
});
