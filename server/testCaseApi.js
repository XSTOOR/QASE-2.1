/**
 * Test case REST surface (Phase 4): /api/test-cases — CRUD with server-side
 * TC-XXXX numbering and multi-environment assignment, mounted like catalogApi.
 */
import { TestCaseValidationError } from './testCaseService.js';

export function createTestCaseRoutes({ testCases, runs, autogen, onError }) {
	return (app) => {
		app.get('/api/test-cases', async (request, response) => {
			try {
				const query = request.query ?? {};
				const filters = {};
				if (query.search) filters.search = String(query.search);
				if (query.tag) filters.tag = String(query.tag);
				if (query.environmentId) filters.environmentId = String(query.environmentId);
				if (query.source) filters.source = String(query.source);
				if (query.sourceRunId) filters.sourceRunId = String(query.sourceRunId);
				const rows = await testCases.list(filters);
				response.set('Cache-Control', 'no-store');
				response.json({ total: rows.length, testCases: rows });
			} catch (error) {
				onError(request, response, error);
			}
		});

		app.post('/api/test-cases', async (request, response) => {
			try {
				// Provenance is server-controlled: the public API always creates
				// manual cases; source fields from the client are ignored.
				const body = { ...(request.body ?? {}) };
				delete body.source;
				delete body.sourceRunId;
				delete body.sourceUrl;
				const record = await testCases.create(body);
				response.status(201).json(record);
			} catch (error) {
				if (error?.code === 'QASE_TESTCASE_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				if (error?.code === 'QASE_TESTCASE_CONFLICT') {
					response.status(409).json({ error: error.message, code: error.code });
					return;
				}
				onError(request, response, error);
			}
		});

		app.get('/api/test-cases/:caseNumber', async (request, response) => {
			try {
				const record = await testCases.get(request.params.caseNumber);
				if (!record) {
					response.status(404).json({ error: 'Unknown test case.' });
					return;
				}
				response.set('Cache-Control', 'no-store');
				response.json(record);
			} catch (error) {
				onError(request, response, error);
			}
		});

		app.patch('/api/test-cases/:caseNumber', async (request, response) => {
			try {
				const record = await testCases.update(request.params.caseNumber, request.body ?? {});
				if (!record) {
					response.status(404).json({ error: 'Unknown test case.' });
					return;
				}
				response.json(record);
			} catch (error) {
				if (error?.code === 'QASE_TESTCASE_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				onError(request, response, error);
			}
		});

		app.delete('/api/test-cases/:caseNumber', async (request, response) => {
			try {
				const record = await testCases.remove(request.params.caseNumber);
				if (!record) {
					response.status(404).json({ error: 'Unknown test case.' });
					return;
				}
				response.status(204).end();
			} catch (error) {
				onError(request, response, error);
			}
		});

		// Agent generation on demand: derive test cases from a completed run.
		// Idempotent — the engine skips runs it already generated cases for.
		app.post('/api/test-cases/generate', async (request, response) => {
			try {
				if (!autogen) {
					response.status(501).json({ error: 'Generation is not available on this deployment.' });
					return;
				}
				const runId = String(request.body?.runId ?? '').trim();
				if (!runId) {
					response.status(422).json({ error: 'runId is required.' });
					return;
				}
				const session = runs?.get ? await runs.get(runId) : null;
				if (!session) {
					response.status(404).json({ error: 'Unknown run.' });
					return;
				}
				if (!session.report) {
					response.status(409).json({ error: 'This run has no published report yet.' });
					return;
				}
				const result = await autogen.generateForRun(session);
				response.json({
					created: result.created,
					count: result.created.length,
					skipped: result.skipped ?? null,
					path: result.path ?? null
				});
			} catch (error) {
				if (error?.code === 'QASE_TESTCASE_INVALID') {
					response.status(422).json({ error: error.message, code: error.code });
					return;
				}
				onError(request, response, error);
			}
		});
	};
}
