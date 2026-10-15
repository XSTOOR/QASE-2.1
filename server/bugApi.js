/**
 * Bug report REST surface (Phase 6): /api/bugs — CRUD with server-side
 * BUG-XXXX numbering and auto environment association, mounted like testCaseApi.
 */
import { BugValidationError } from './bugService.js';

export function createBugRoutes({ bugs, onError }) {
	return (app) => {
		app.get('/api/bugs', async (request, response) => {
			try {
				const query = request.query ?? {};
				const filters = {};
				if (query.search) filters.search = String(query.search);
				if (query.status) filters.status = String(query.status);
				if (query.severity) filters.severity = String(query.severity);
				if (query.environmentId) filters.environmentId = String(query.environmentId);
				const rows = await bugs.list(filters);
				response.set('Cache-Control', 'no-store');
				response.json({ total: rows.length, bugs: rows });
			} catch (error) {
				onError(request, response, error);
			}
		});

		app.post('/api/bugs', async (request, response) => {
			try {
				const record = await bugs.create(request.body ?? {});
				response.status(201).json(record);
			} catch (error) {
				if (error?.code === 'QASE_BUG_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				onError(request, response, error);
			}
		});

		app.get('/api/bugs/:bugNumber', async (request, response) => {
			try {
				const record = await bugs.get(request.params.bugNumber);
				if (!record) {
					response.status(404).json({ error: 'Unknown bug.' });
					return;
				}
				response.set('Cache-Control', 'no-store');
				response.json(record);
			} catch (error) {
				onError(request, response, error);
			}
		});

		app.patch('/api/bugs/:bugNumber', async (request, response) => {
			try {
				const record = await bugs.update(request.params.bugNumber, request.body ?? {});
				if (!record) {
					response.status(404).json({ error: 'Unknown bug.' });
					return;
				}
				response.json(record);
			} catch (error) {
				if (error?.code === 'QASE_BUG_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				onError(request, response, error);
			}
		});

		app.delete('/api/bugs/:bugNumber', async (request, response) => {
			try {
				const record = await bugs.remove(request.params.bugNumber);
				if (!record) {
					response.status(404).json({ error: 'Unknown bug.' });
					return;
				}
				response.status(204).end();
			} catch (error) {
				onError(request, response, error);
			}
		});
	};
}
