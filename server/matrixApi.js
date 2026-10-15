/**
 * Matrix run API routes (#14633 NI02 Phase 1; #15043 B1 cancel/retry/qa start).
 *
 * POST /api/matrix-runs                      create + (optionally) start
 * GET  /api/matrix-runs                      list
 * GET  /api/matrix-runs/:id                  full run incl. items
 * POST /api/matrix-runs/:id/start            start execution of a pending run
 * POST /api/matrix-runs/:id/cancel           cancel: queued items → CANCELLED
 * POST /api/matrix-runs/:id/items/:itemId/retry   bounded single-item retry
 *
 * The orchestrator is wired by app.js (it needs the session-creation
 * machinery — startTurn, probeTargetReachability — that lives there).
 */

import { MatrixValidationError } from './matrixService.js';
import { TestCaseValidationError } from './testCaseService.js';

export function createMatrixRoutes({ matrix, orchestrator, bugs, onError, events }) {
	return (app) => {
		app.post('/api/matrix-runs', async (request, response) => {
			try {
				const record = await matrix.create(request.body, { ownerUserId: request.auth?.userId ?? null });
				if (request.body?.start !== false && orchestrator) {
					const started = orchestrator.start(record.id);
					if (!started.ok) {
						response.status(409).json({ error: started.error });
						return;
					}
				}
				response.status(201).json(await matrix.get(record.id));
			} catch (error) {
				if (error instanceof MatrixValidationError || error instanceof TestCaseValidationError) {
					response.status(422).json({ error: error.message });
					return;
				}
				onError?.(error, response);
			}
		});

		app.get('/api/matrix-runs', async (_request, response) => {
			try {
				const runs = await matrix.list();
				// Summaries only — items are fetched per-run (they can be large).
				response.json({
					runs: runs.map(({ items, ...summary }) => ({
						...summary,
						statusCounts: countByStatus(items)
					}))
				});
			} catch (error) {
				onError?.(error, response);
			}
		});

		app.get('/api/matrix-runs/:id', async (request, response) => {
			try {
				const run = await matrix.get(request.params.id);
				if (!run) {
					response.status(404).json({ error: 'Matrix run not found.' });
					return;
				}
				// #14942 Phase 4: link each item to the defects (BUG-XXX) already
				// associated with its environment — evidence belongs to the
				// configuration that produced it and is never merged. Bug store
				// may be absent (local mode); linkage is best-effort and never
				// blocks the run payload.
				let items = run.items;
				if (bugs?.list && Array.isArray(items)) {
					try {
						const byEnvironment = new Map();
						for (const item of items) {
							if (!item.environmentId) continue;
							if (!byEnvironment.has(item.environmentId)) {
								byEnvironment.set(item.environmentId,
									(await bugs.list({ environmentId: item.environmentId }))
										.map(({ bugNumber, title, severity, status }) => ({ bugNumber, title, severity, status })));
							}
						}
						items = items.map((item) => ({ ...item, defects: byEnvironment.get(item.environmentId) ?? [] }));
					} catch {
						// linkage is supplemental — ship the run without it
					}
				}
				response.json({ run: { ...run, items }, orchestratorActive: orchestrator ? orchestrator.isActive(run.id) : false });
			} catch (error) {
				onError?.(error, response);
			}
		});

		app.post('/api/matrix-runs/:id/start', async (request, response) => {
			try {
				const run = await matrix.get(request.params.id);
				if (!run) {
					response.status(404).json({ error: 'Matrix run not found.' });
					return;
				}
				// `error` runs swept by resume recovery (container restart) keep
				// their PENDING items — they may be restarted. `running`/`done`
				// runs may not.
				const restartable = run.status === 'pending'
					|| (run.status === 'error' && run.items.some((item) => item.status === 'PENDING'));
				if (!restartable) {
					response.status(409).json({ error: `Matrix run is ${run.status} with no pending profiles; only pending (or interrupted-with-pending) runs can start.` });
					return;
				}
				const started = orchestrator.start(run.id);
				if (!started.ok) {
					response.status(409).json({ error: started.error });
					return;
				}
				response.json({ ok: true });
			} catch (error) {
				onError?.(error, response);
			}
		});
		// #15043 (B1): cancel — queued/pending items become CANCELLED, the run
		// records status cancelled. Running items keep their honest outcome.
		app.post('/api/matrix-runs/:id/cancel', async (request, response) => {
			try {
				const run = await matrix.get(request.params.id);
				if (!run) {
					response.status(404).json({ error: 'Matrix run not found.' });
					return;
				}
				const result = await orchestrator.cancel(request.params.id);
				response.json({ ok: true, cancelled: result.cancelled });
			} catch (error) {
				onError?.(error, response);
			}
		});

		// #15043 (B1): bounded single-item retry.
		app.post('/api/matrix-runs/:id/items/:itemId/retry', async (request, response) => {
			try {
				const run = await matrix.get(request.params.id);
				if (!run) {
					response.status(404).json({ error: 'Matrix run not found.' });
					return;
				}
				const result = await orchestrator.retryItem(request.params.id, request.params.itemId);
				if (!result.ok) {
					response.status(409).json({ error: result.error });
					return;
				}
				response.json({ ok: true });
			} catch (error) {
				onError?.(error, response);
			}
		});

		// Pipeline Phase 5 (#15500): matrix-run SSE. The orchestrator emits
		// progress keyed by matrix-run id on the raw run bus (app.js wiring);
		// this exposes it over HTTP so the results board gets push updates
		// instead of pure polling. Mirrors the session events route's shape
		// (data: JSON\n\n + : ping heartbeat); matrix ids are NOT sessions so
		// the session route 404s them — this is the dedicated channel.
		app.get('/api/matrix-runs/:id/events', async (request, response) => {
			const run = await matrix.get(request.params.id);
			if (!run) {
				response.status(404).json({ error: 'Matrix run not found.' });
				return;
			}
			if (!events?.subscribe) {
				response.status(501).json({ error: 'Event transport unavailable.' });
				return;
			}
			let closed = false;
			let heartbeat = null;
			let unsubscribe;
			const cleanup = () => {
				closed = true;
				if (heartbeat) clearInterval(heartbeat);
				const dispose = unsubscribe;
				unsubscribe = undefined;
				if (typeof dispose === 'function') {
					try { Promise.resolve(dispose()).catch(() => {}); } catch { /* gone */ }
				}
			};
			const endStream = () => {
				cleanup();
				if (!response.destroyed && !response.writableEnded) response.end();
			};
			response.once('close', cleanup);
			response.once('error', cleanup);
			request.once('aborted', cleanup);

			response.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
				'X-Accel-Buffering': 'no'
			});
			const write = chunk => {
				if (closed || response.destroyed || response.writableEnded) {
					cleanup();
					return;
				}
				try { response.write(chunk); } catch { endStream(); }
			};
			write(': connected\n\n');
			try {
				unsubscribe = await events.subscribe(request.params.id, event => {
					if (closed) return;
					try { write(`data: ${JSON.stringify(event)}\n\n`); } catch { endStream(); }
				});
			} catch {
				endStream();
				return;
			}
			if (closed || response.destroyed || response.writableEnded) {
				cleanup();
				return;
			}
			heartbeat = setInterval(() => {
				if (!closed) write(': ping\n\n');
			}, 15000);
		});
	};
}

function countByStatus(items) {
	const counts = {};
	for (const item of items ?? []) {
		counts[item.status] = (counts[item.status] ?? 0) + 1;
	}
	return counts;
}
