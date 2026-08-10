import 'dotenv/config';
import { createCellHeartbeatController } from './cellHeartbeat.js';
import { createCellHeartbeatProbe } from './cellHeartbeatProbe.js';
import { createOperationalLogger } from './operationalLogger.js';

const logger = createOperationalLogger({ component: 'qase-heartbeat' });
const controller = createCellHeartbeatController({
	onError: error => logger.error('heartbeat.failed', {
		errorName: error?.name ?? 'Error',
		consecutiveFailures: controller?.getState().consecutiveFailures ?? 0
	})
});
const probe = createCellHeartbeatProbe({ controller });
const probeServer = await probe.listen();

let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	logger.info('process.draining');
	controller.stop();
	await probe.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
	await close();
	process.exit(0);
});

logger.info('process.started', { host: probe.host, port: probeServer.address().port });
await controller.start();
