/** Stop accepting HTTP requests, then bound the wait for long-lived streams. */
export function drainHttpServer(server, timeoutMs = 10_000) {
	if (!server) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			server.closeAllConnections?.();
		}, timeoutMs);
		server.close(error => {
			clearTimeout(timer);
			if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
			else resolve();
		});
	});
}

/**
 * Run every cleanup stage even if an earlier one fails. The hard deadline is
 * shorter than the pod termination grace period so stuck network clients do
 * not leave Chromium or workers running until the orchestrator kills the pod.
 */
export function installShutdownHandlers({
	steps, onDraining = () => {}, logger, timeoutMs = 30_000, processLike = process
}) {
	let closing = false;
	let exited = false;
	let timer;
	function finish(code) {
		if (exited) return;
		exited = true;
		clearTimeout(timer);
		processLike.exit(code);
	}
	async function shutdown(signal) {
		if (closing) return finish(1);
		closing = true;
		timer = setTimeout(() => {
			logger?.error('process.shutdown.timeout', { errorName: 'ShutdownTimeoutError' });
			finish(1);
		}, timeoutMs);
		let failed = false;
		for (const step of [onDraining, ...steps]) {
			try { await step(signal); }
			catch (error) {
				failed = true;
				logger?.error('process.shutdown.failed', { errorName: error?.name ?? 'Error' });
			}
		}
		finish(failed ? 1 : 0);
	}
	for (const signal of ['SIGINT', 'SIGTERM']) processLike.on(signal, () => { void shutdown(signal); });
	return shutdown;
}

/** Enumerate process-local browser handles even when the durable store is down. */
export async function closeApplicationBrowsers(services) {
	if (services.agent.isRemote) return;
	const entries = typeof services.runs.listLive === 'function'
		? services.runs.listLive()
		: await services.runs.list();
	const outcomes = await Promise.allSettled(entries.map(async ({ id }) => {
		try { services.agent.stop(id); }
		finally { await services.agent.closeBrowser(id); }
	}));
	const errors = outcomes.filter(result => result.status === 'rejected').map(result => result.reason);
	if (errors.length) throw new AggregateError(errors, 'Browser cleanup failed.');
}
