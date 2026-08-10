import { currentRequestActor, runWithRequestActor } from './requestActor.js';

export function createDistributedApiAgent({ queue, realtime, runs, tenantContext }) {
	if (!queue || !realtime || !runs || !tenantContext) throw new TypeError('Distributed API execution dependencies are required.');
	return Object.freeze({
		isRemote: true,
		ensureRuntime() {},
		async runTurn(session, turnOptions) {
			const actor = currentRequestActor();
			const requestedByUserId = actor?.actorUserId ?? tenantContext.actorUserId;
			const job = await queue.enqueue({
				runId: session.id, requestedByUserId, turnOptions, correlationId: actor?.requestId
			});
			try {
				await runs.setStatus(session, 'running', 'Queued for an execution worker.');
				return job;
			} catch (error) {
				await queue.cancelRun(session.id).catch(() => undefined);
				throw error;
			}
		},
		getLiveState(sessionId) { return realtime.getLiveState(sessionId); },
		async stop(sessionId) { return queue.cancelRun(sessionId); },
		async closeBrowser() {},
		async invalidateIdleRuntimes() { return 0; }
	});
}

export function createExecutionWorker(options = {}) {
	const queue = options.queue;
	const services = options.services;
	const workerId = options.workerId;
	const credentialVault = options.credentialVault;
	if (!queue || !services || typeof workerId !== 'string') throw new TypeError('Worker queue, services, and workerId are required.');
	const pollMs = Math.max(100, Math.min(30_000, Number(options.pollMs) || 1_000));
	const leaseMs = Math.max(5_000, Math.min(300_000, Number(options.leaseMs) || 30_000));
	let stopping = false;
	let current;
	let loopPromise;
	let started = false;

	async function markExhausted() {
		for (const runId of await queue.reapExhausted()) {
			const session = await services.runs.get(runId);
			if (!session) continue;
			await services.runs.addMessage(session, {
				role: 'system', kind: 'error', text: 'Execution stopped after repeated worker lease failures.'
			});
			await services.runs.setStatus(session, 'error', 'Worker lease attempts exhausted.');
		}
	}

	async function runOnce() {
		await markExhausted();
		const job = await queue.claim(workerId, leaseMs);
		if (!job) return false;
		current = job;
		let heartbeatBusy = false;
		const heartbeat = setInterval(async () => {
			if (heartbeatBusy) return;
			heartbeatBusy = true;
			try {
				const status = await queue.heartbeat({
					jobId: job.id, leaseToken: job.leaseToken, workerId, leaseMs
				});
				if (!status || status === 'cancel_requested') await services.agent.stop(job.runId);
			} catch {
				await services.agent.stop(job.runId);
			} finally { heartbeatBusy = false; }
		}, Math.max(1_000, Math.floor(leaseMs / 3)));
		heartbeat.unref?.();
		let session;
		try {
			session = await services.runs.get(job.runId);
			if (!session) {
				await queue.complete({ jobId: job.id, leaseToken: job.leaseToken, workerId });
				return true;
			}
			await runWithRequestActor({
				actorUserId: job.requestedByUserId,
				requestId: job.correlationId
			}, async () => {
				if (credentialVault) {
					const values = await credentialVault.values(job.runId);
					await services.secrets.store(job.runId, values);
				}
				services.agent.ensureRuntime(session);
				await services.agent.runTurn(session, job.payload);
			});
			await queue.complete({ jobId: job.id, leaseToken: job.leaseToken, workerId });
		} catch (error) {
			const outcome = await queue.fail({
				jobId: job.id, leaseToken: job.leaseToken, workerId, error, retryable: !stopping
			});
			if (outcome === 'failed' && session) {
				await services.runs.addMessage(session, {
					role: 'system', kind: 'error', text: 'Execution failed after the configured retry attempts.'
				});
				await services.runs.setStatus(session, 'error', 'Execution worker retries exhausted.');
			}
		} finally {
			clearInterval(heartbeat);
			const cleanup = [Promise.resolve().then(() => services.secrets.clear(job.runId))];
			if (credentialVault && session && ['done', 'error', 'idle'].includes(session.status)) {
				cleanup.push(Promise.resolve().then(() => credentialVault.clear(job.runId)));
			}
			await Promise.allSettled(cleanup);
			current = undefined;
		}
		return true;
	}

	async function loop() {
		while (!stopping) {
			let worked = false;
			try { worked = await runOnce(); } catch (error) { options.onError?.(error); }
			if (!worked && !stopping) await new Promise(resolve => setTimeout(resolve, pollMs));
		}
	}

	return Object.freeze({
		runOnce,
		start() { started = true; loopPromise ??= loop(); return loopPromise; },
		getState() { return Object.freeze({ started, stopping, working: Boolean(current), jobId: current?.id }); },
		async stop() {
			stopping = true;
			if (current) await services.agent.stop(current.runId);
			await loopPromise;
		}
	});
}
