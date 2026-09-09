import 'dotenv/config';
import { createCellHeartbeatController } from './cellHeartbeat.js';
import { createCellHeartbeatProbe } from './cellHeartbeatProbe.js';
import { createOperationalLogger } from './operationalLogger.js';
import { installShutdownHandlers } from './processLifecycle.js';

const logger = createOperationalLogger({ component: 'qase-heartbeat' });
const controller = createCellHeartbeatController({
	onError: error => logger.error('heartbeat.failed', {
		errorName: error?.name ?? 'Error',
		consecutiveFailures: controller?.getState().consecutiveFailures ?? 0
	})
});
const probe = createCellHeartbeatProbe({ controller });
const probeServer = await probe.listen();

installShutdownHandlers({
	logger, timeoutMs: 20_000,
	onDraining: signal => logger.info('process.draining', { signal }),
	steps: [() => controller.stop(), () => probe.close()]
});

logger.info('process.started', { host: probe.host, port: probeServer.address().port });
await controller.start();
