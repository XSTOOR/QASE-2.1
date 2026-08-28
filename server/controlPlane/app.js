import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { securityHeaders } from '../instanceAccess.js';
import { createOperationalControls } from '../operations.js';

function requiredToken(value, label) {
	const token = String(value ?? '').trim();
	if (Buffer.byteLength(token, 'utf8') < 32) throw new TypeError(`${label} must contain at least 32 bytes.`);
	return token;
}
function same(left, right) {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
function suppliedToken(request) {
	const value = String(request.headers.authorization ?? '');
	return value.startsWith('Bearer ') ? value.slice(7) : '';
}

export function createControlPlaneApplication(options = {}) {
	const repository = options.repository;
	if (!repository?.resolve || !repository?.place || !repository?.upsertCell) {
		throw new TypeError('Control-plane repository is required.');
	}
	const environment = options.environment ?? process.env;
	const readToken = requiredToken(options.readToken ?? environment.QASE_CONTROL_API_READ_TOKEN, 'QASE_CONTROL_API_READ_TOKEN');
	const writeToken = requiredToken(options.writeToken ?? environment.QASE_CONTROL_API_WRITE_TOKEN, 'QASE_CONTROL_API_WRITE_TOKEN');
	if (same(readToken, writeToken)) throw new TypeError('Control-plane read and write tokens must be different.');
	const operations = options.operations ?? createOperationalControls({ environment, mutationPrefixes: ['/internal/'] });
	const logger = options.logger;
	if (logger !== undefined && typeof logger?.error !== 'function') throw new TypeError('Control-plane logger is invalid.');
	const app = express();
	app.disable('x-powered-by');
	app.locals.qaseDemoEnabled = false;
	if (String(environment.QASE_CONTROL_TRUST_PROXY ?? '').toLowerCase() === 'true') app.set('trust proxy', 1);
	app.use(operations.middleware);
	app.use(securityHeaders);

	app.get('/healthz', (_request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		response.json({ status: 'ok' });
	});
	app.get('/readyz', async (_request, response) => {
		response.setHeader('Cache-Control', 'no-store');
		let ready = false;
		try { ready = await repository.check() === true; } catch { /* fail closed */ }
		response.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
	});
	operations.mount(app);
	app.use(express.json({ limit: '64kb' }));

	function authorize(scope) {
		return (request, response, next) => {
			const supplied = suppliedToken(request);
			const allowed = scope === 'write'
				? same(writeToken, supplied)
				: same(readToken, supplied) || same(writeToken, supplied);
			if (!allowed) {
				response.setHeader('Cache-Control', 'no-store');
				response.status(401).json({ error: 'Unauthorized.' });
				return;
			}
			next();
		};
	}

	app.get('/internal/v1/placements/:organizationId/:projectId', authorize('read'), async (request, response) => {
		const cell = await repository.resolve(request.params.organizationId, request.params.projectId);
		if (!cell) {
			response.status(404).json({ error: 'No healthy placement is available.' });
			return;
		}
		response.json({ cellId: cell.id, baseUrl: cell.baseUrl, region: cell.region });
	});

	app.put('/internal/v1/cells/:cellId', authorize('write'), async (request, response) => {
		const cell = await repository.upsertCell(
			{ ...request.body, id: request.params.cellId },
			{ requestId: request.qaseRequestId }
		);
		response.json(cell);
	});

	app.post('/internal/v1/cells/:cellId/heartbeat', authorize('write'), async (request, response) => {
		const cell = await repository.heartbeat(request.params.cellId, request.body);
		if (!cell) {
			response.status(404).json({ error: 'No such cell.' });
			return;
		}
		response.json({ ok: true, heartbeatAt: cell.heartbeatAt });
	});

	app.put('/internal/v1/placements/:organizationId/:projectId', authorize('write'), async (request, response) => {
		const placement = await repository.place({
			organizationId: request.params.organizationId,
			projectId: request.params.projectId,
			cellId: request.body?.cellId,
			preferredRegion: request.body?.preferredRegion,
			requestId: request.qaseRequestId
		});
		response.json({
			organizationId: placement.organizationId,
			projectId: placement.projectId,
			cellId: placement.cell.id,
			baseUrl: placement.cell.baseUrl,
			region: placement.cell.region
		});
	});

	app.delete('/internal/v1/placements/:organizationId/:projectId', authorize('write'), async (request, response) => {
		response.json({ disabled: await repository.disablePlacement(
			request.params.organizationId, request.params.projectId,
			{ requestId: request.qaseRequestId }
		) });
	});

	app.use('/internal', (_request, response) => response.status(404).json({ error: 'Internal route not found.' }));
	app.use((error, request, response, next) => {
		if (response.headersSent) return next(error);
		if (error?.type === 'entity.too.large') return response.status(413).json({ error: 'Request body is too large.' });
		if (error instanceof SyntaxError && error?.status === 400) return response.status(400).json({ error: 'Request body is not valid JSON.' });
		if (error instanceof TypeError) return response.status(400).json({ error: error.message });
		if (error?.code === 'QASE_NO_HEALTHY_CELL') return response.status(503).json({ error: error.message });
		if (error?.code === 'QASE_CELL_TENANT_MISMATCH') return response.status(409).json({ error: error.message });
		if (logger) logger.error('http.request.failed', {
			requestId: request.qaseRequestId,
			errorName: error?.name ?? 'Error'
		});
		else console.error(`[Qase control ${request.qaseRequestId ?? 'no-request-id'}]`, error instanceof Error ? error.message : String(error));
		response.status(500).json({ error: 'Unexpected control-plane error.' });
	});

	return Object.freeze({ app, operations });
}
