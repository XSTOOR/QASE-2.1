import 'dotenv/config';
import os from 'node:os';
import { createExecutionWorker } from './distributedExecution.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';
import { createOperationalLogger } from './operationalLogger.js';
import { createOperationalControls } from './operations.js';
import { createWorkerProbe } from './workerProbe.js';

const logger = createOperationalLogger({ component: 'qase-worker' });
const result = await createConfiguredApplicationServices({ executionRole: 'worker' });
if (result.executionMode !== 'distributed' || !result.executionQueue) {
	await result.services.lifecycle.close();
	throw new Error('Qase worker requires QASE_EXECUTION_MODE=distributed and QASE_RUN_STORE=postgres.');
}

const configuredId = String(process.env.QASE_WORKER_ID ?? '').trim();
const workerId = configuredId || `${os.hostname().replace(/[^A-Za-z0-9._:-]/g, '-')}:${process.pid}`;
const worker = createExecutionWorker({
	queue: result.executionQueue,
	services: result.services,
	credentialVault: result.credentialVault,
	workerId,
	onError: error => logger.error('worker.execution.failed', { errorName: error?.name ?? 'Error', workerId }),
	pollMs: Number(process.env.QASE_WORKER_POLL_MS) || 1_000,
	leaseMs: Number(process.env.QASE_WORKER_LEASE_MS) || 30_000
});
let probe;
let probeServer;
try {
	probe = createWorkerProbe({
		worker, queue: result.executionQueue,
		operations: createOperationalControls({ logger })
	});
	probeServer = await probe.listen();
} catch (error) {
	await result.services.lifecycle.close();
	throw error;
}

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		logger.info('process.draining', { signal, workerId });
		await worker.stop();
		await probe.close();
		await result.services.lifecycle.close();
		process.exit(0);
	});
}

logger.info('process.started', { workerId, host: probe.host, port: probeServer.address().port });
try {
	await worker.start();
} catch (error) {
	logger.error('worker.stopped', { errorName: error?.name ?? 'Error', workerId });
	await probe.close();
	await result.services.lifecycle.close();
	process.exitCode = 1;
}
