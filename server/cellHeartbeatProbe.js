import express from 'express';
import { securityHeaders } from './auth.js';

function probePort(value) {
	const port = value === undefined || value === '' ? 9_175 : Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError('QASE_CELL_HEARTBEAT_PROBE_PORT must be an integer from 0 to 65535.');
	}
	return port;
}

export function createCellHeartbeatProbe(options = {}) {
	if (!options.controller?.getState) throw new TypeError('Heartbeat probe requires controller state.');
	const environment = options.environment ?? process.env;
	const host = String(options.host ?? environment.QASE_CELL_HEARTBEAT_PROBE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
	const port = probePort(options.port ?? environment.QASE_CELL_HEARTBEAT_PROBE_PORT);
	const app = express();
	app.disable('x-powered-by');
	app.use(securityHeaders);
	app.get('/healthz', (_request, response) => response.set('Cache-Control', 'no-store').json({ status: 'ok' }));
	app.get('/readyz', (_request, response) => {
		const ready = options.controller.getState().ready;
		response.set('Cache-Control', 'no-store').status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
	});
	let server;
	return Object.freeze({
		app, host, port,
		async listen() {
			if (server) return server;
			server = await new Promise((resolve, reject) => {
				const onError = error => reject(error);
				const candidate = app.listen(port, host, () => {
					candidate.off('error', onError);
					resolve(candidate);
				});
				candidate.once('error', onError);
			});
			return server;
		},
		async close() {
			if (!server) return;
			const closing = server;
			server = undefined;
			await new Promise((resolve, reject) => closing.close(error => error ? reject(error) : resolve()));
		}
	});
}
