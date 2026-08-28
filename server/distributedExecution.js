import { currentRequestActor, runWithRequestActor } from './requestActor.js';

export function createDistributedApiAgent({ queue, realtime, runs, tenantContext }) {
	if (!queue || !realtime || !runs || !tenantContext) throw new TypeError('Distributed API execution dependencies are required.');
	return Object.freeze({
		isRemote: true,
		cleanupDeferred: true,
		ensureRuntime() {},
		async runTurn(session, turnOptions, executionOptions = {}) {
			const actor = currentRequestActor();
			const serviceActor = executionOptions.actorType === 'service' || executionOptions.actorType === 'system';
			const requestedByUserId = serviceActor ? undefined : actor?.actorUserId ?? tenantContext.actorUserId;
			const requestedByActorType = serviceActor ? executionOptions.actorType : 'user';
			const job = await queue.enqueue({
				runId: session.id, requestedByUserId, requestedByActorType, turnOptions,
				correlationId: actor?.requestId
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
		async purgeArtifacts(sessionId) {
			realtime.publish({ type: 'run.deleted', sessionId, ts: Date.now() });
		},
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
	const cancellationPollMs = Math.max(1_000, Math.min(30_000, Number(queue.cancelGraceMs) || 5_000));
	const heartbeatIntervalMs = Math.max(1_000, Math.min(cancellationPollMs, Math.floor(leaseMs / 3)));
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
		let heartbeatPromise = Promise.resolve();
		let executionFinished = false;
		let stopCompleted = false;
		let stopPromise;
		let leaseStatus = 'leased';

		function requestStop() {
			if (stopCompleted || executionFinished) return Promise.resolve();
			stopPromise ??= Promise.resolve()
				.then(() => services.agent.stop(job.runId))
				.then(() => { stopCompleted = true; })
				.finally(() => { stopPromise = undefined; });
			return stopPromise;
		}

		function pulseLease() {
			if (heartbeatBusy) return heartbeatPromise;
			heartbeatBusy = true;
			heartbeatPromise = (async () => {
				let status;
				try {
					status = await queue.heartbeat({
						jobId: job.id, leaseToken: job.leaseToken, workerId, leaseMs
					});
				} catch (error) {
					leaseStatus = undefined;
					await requestStop().catch(() => undefined);
					throw error;
				}
				leaseStatus = status;
				if (leaseStatus !== 'leased') await requestStop();
				return leaseStatus;
			})().finally(() => {
				heartbeatBusy = false;
			});
			return heartbeatPromise;
		}

		function scheduleHeartbeat() {
			if (heartbeatBusy || executionFinished) return;
			void pulseLease().catch(() => undefined);
		}

		// Poll no slower than the queue's cancellation grace so a stopped or
		// deleted run is observed before a cooperative worker's lease is fenced.
		const heartbeat = setInterval(scheduleHeartbeat, heartbeatIntervalMs);
		heartbeat.unref?.();
		let session;
		try {
			// A claim can be cancelled or invalidated immediately after its transaction
			// commits. Verify the lease before reading credentials or starting a runtime.
			if (await pulseLease() !== 'leased') {
				await queue.complete({ jobId: job.id, leaseToken: job.leaseToken, workerId });
				return true;
			}
			session = await services.runs.get(job.runId);
			if (!session) {
				await queue.complete({ jobId: job.id, leaseToken: job.leaseToken, workerId });
				return true;
			}
			await runWithRequestActor({
				...((job.requestedByActorType ?? 'user') === 'user' ? { actorUserId: job.requestedByUserId } : {}),
				requestId: job.correlationId
			}, async () => {
				if (credentialVault) {
					const values = await credentialVault.values(job.runId);
					// Credential retrieval may involve a remote vault. Revalidate before
					// making the secrets available to the local runtime.
					if (await pulseLease() !== 'leased') return;
					await services.secrets.store(job.runId, values);
				}
				if (await pulseLease() !== 'leased') return;
				services.agent.ensureRuntime(session);
				await services.agent.runTurn(session, job.payload);
			});
			executionFinished = true;
			await heartbeatPromise.catch(() => undefined);
			await queue.complete({ jobId: job.id, leaseToken: job.leaseToken, workerId });
		} catch (error) {
			const outcome = await queue.fail({
				jobId: job.id, leaseToken: job.leaseToken, workerId, error, retryable: !stopping
			});
			if (outcome === 'failed' && session) {
				const liveSession = await services.runs.get(job.runId);
				if (!liveSession) return true;
				await services.runs.addMessage(liveSession, {
					role: 'system', kind: 'error', text: 'Execution failed after the configured retry attempts.'
				});
				await services.runs.setStatus(liveSession, 'error', 'Execution worker retries exhausted.');
			}
		} finally {
			executionFinished = true;
			clearInterval(heartbeat);
			await heartbeatPromise.catch(() => undefined);
			let runDeleted = false;
			try {
				runDeleted = !(await services.runs.get(job.runId));
			} catch {
				// A database outage is not evidence that the run was deleted. Leave
				// the cleanup record pending for a later reconciliation attempt.
			}
			const cleanup = [Promise.resolve().then(() => services.secrets.clear(job.runId))];
			if (credentialVault && (runDeleted || (session && ['done', 'error', 'idle'].includes(session.status)))) {
				cleanup.push(Promise.resolve().then(() => credentialVault.clear(job.runId)));
			}
			if (runDeleted) {
				cleanup.push(Promise.resolve().then(() => services.agent.purgeArtifacts?.(job.runId)));
			}
			const cleanupResults = await Promise.allSettled(cleanup);
			if (runDeleted && typeof services.runs.recordCleanup === 'function') {
				const cleanupFailed = cleanupResults.some(result => result.status === 'rejected');
				try {
					await services.runs.recordCleanup(job.runId, cleanupFailed
						? {
							status: 'failed', errorCode: 'worker_cleanup_failed', actorType: 'worker',
							referenceId: `worker-job/${job.id}`
						}
						: { status: 'completed', actorType: 'worker', referenceId: `worker-job/${job.id}` });
				} catch (error) {
					options.onError?.(error);
				}
			}
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
