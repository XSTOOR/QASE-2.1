import 'dotenv/config';
import os from 'node:os';
import { createExecutionWorker } from './distributedExecution.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';
import { createWorkerProbe } from './workerProbe.js';

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
	onError: error => console.error('[Qase worker]', error instanceof Error ? error.message : String(error)),
	pollMs: Number(process.env.QASE_WORKER_POLL_MS) || 1_000,
	leaseMs: Number(process.env.QASE_WORKER_LEASE_MS) || 30_000
});
let probe;
let probeServer;
try {
	probe = createWorkerProbe({ worker, queue: result.executionQueue });
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
		await worker.stop();
		await probe.close();
		await result.services.lifecycle.close();
		process.exit(0);
	});
}

console.log(`Qase execution worker ${workerId} started; probes on http://${probe.host}:${probeServer.address().port}.`);
try {
	await worker.start();
} catch (error) {
	console.error('[Qase worker]', error instanceof Error ? error.message : String(error));
	await probe.close();
	await result.services.lifecycle.close();
	process.exitCode = 1;
}
