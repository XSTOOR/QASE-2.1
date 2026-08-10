import 'dotenv/config';
import { createCellHeartbeatController } from './cellHeartbeat.js';
import { createCellHeartbeatProbe } from './cellHeartbeatProbe.js';

const controller = createCellHeartbeatController({
	onError: error => console.error('[Qase cell heartbeat]', error instanceof Error ? error.message : String(error))
});
const probe = createCellHeartbeatProbe({ controller });
const probeServer = await probe.listen();

let closing = false;
async function close() {
	if (closing) return;
	closing = true;
	controller.stop();
	await probe.close();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
	await close();
	process.exit(0);
});

console.log(`Qase cell heartbeat controller started; probes on http://${probe.host}:${probeServer.address().port}.`);
await controller.start();
