import express from 'express';
import { securityHeaders } from './instanceAccess.js';
import { createOperationalControls } from './operations.js';

function probePort(value) {
	const port = value === undefined || value === '' ? 9_174 : Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new TypeError('QASE_WORKER_PROBE_PORT must be an integer from 0 to 65535.');
	}
	return port;
}

export function createWorkerProbe(options = {}) {
	const worker = options.worker;
	const queue = options.queue;
	if (!worker?.getState || !queue?.check) throw new TypeError('Worker probe requires worker state and queue readiness.');
	const environment = options.environment ?? process.env;
	const host = String(options.host ?? environment.QASE_WORKER_PROBE_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
	const port = probePort(options.port ?? environment.QASE_WORKER_PROBE_PORT);
	const operations = options.operations ?? createOperationalControls({ environment });
	const app = express();
	app.disable('x-powered-by');
	app.use(operations.middleware);
	app.use(securityHeaders);
	app.get('/healthz', (_request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		response.json({ status: 'ok' });
	});
	app.get('/readyz', async (_request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		const state = worker.getState();
		let ready = state.started && !state.stopping;
		if (ready) {
			try { ready = await queue.check() === true; } catch { ready = false; }
		}
		response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
	});
	operations.mount(app, { queue });

	let server;
	return Object.freeze({
		app,
		host,
		port,
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
