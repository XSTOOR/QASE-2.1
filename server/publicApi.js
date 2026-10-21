import { timingSafeEqual } from 'node:crypto';

/**
 * Public read-only API for external API-document connectors (e.g. Pulse).
 *
 * Unlike the internal /internal/v1/drytis data plane (five-header HMAC,
 * fail-closed service contract), this surface is intentionally small:
 * GET-only run summaries, findings, and markdown reports, protected by a
 * single static bearer token. It must be mounted BEFORE the /api auth gate
 * and before any JSON body middleware (same placement as the Drytis
 * integration mount) so its raw semantics stay independent of user sessions.
 *
 * Fail-closed: without QASE_PUBLIC_API_TOKEN configured, every data route
 * answers 503 — the API is never implicitly anonymous. /public/v1/health
 * is the only token-free route (it exposes no data).
 */

export const PUBLIC_API_BASE_PATH = '/public/v1';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const FINDING_STATUSES = ['open', 'in_progress', 'fixed', 'wont_fix'];
const RUN_STATUSES = ['idle', 'running', 'done', 'error', 'interrupted', 'awaiting_input'];

function configuredToken(environment) {
	const value = environment.QASE_PUBLIC_API_TOKEN;
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	// A padded/quoted placeholder is treated as unset — no accidental open API.
	if (trimmed.length < 16 || trimmed === 'changeme' || trimmed === 'disabled') return undefined;
	return trimmed;
}

function tokenMatches(expected, presented) {
	if (!presented) return false;
	const a = Buffer.from(expected, 'utf8');
	const b = Buffer.from(String(presented), 'utf8');
	if (a.length !== b.length) {
		// Constant-time on the expected length; compare against a dummy of the
		// same length so timing does not reveal the expected token length.
		timingSafeEqual(a, a);
		return false;
	}
	return timingSafeEqual(a, b);
}

function bearerToken(request) {
	const header = request.headers.authorization;
	if (typeof header !== 'string') return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : undefined;
}

function safeText(value, maxLength = 2000) {
	if (typeof value !== 'string') return undefined;
	const text = value.trim();
	if (!text) return undefined;
	return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function publicFinding(finding) {
	if (!finding || typeof finding !== 'object') return undefined;
	return {
		id: typeof finding.id === 'string' ? finding.id : undefined,
		ts: Number.isFinite(Number(finding.ts)) ? Number(finding.ts) : undefined,
		title: safeText(finding.title, 500) ?? '',
		severity: SEVERITIES.includes(finding.severity) ? finding.severity : 'info',
		category: safeText(finding.category, 200),
		url: safeText(finding.url, 2000),
		steps: Array.isArray(finding.steps)
			? finding.steps.slice(0, 12).map(step => safeText(step, 500)).filter(Boolean)
			: [],
		expected: safeText(finding.expected, 1500),
		actual: safeText(finding.actual, 1500),
		evidence: safeText(finding.evidence, 1500),
		status: FINDING_STATUSES.includes(finding.status) ? finding.status : 'open'
	};
}

function publicReport(report) {
	if (!report || typeof report !== 'object') return undefined;
	return {
		ts: Number.isFinite(Number(report.ts)) ? Number(report.ts) : undefined,
		verdict: ['pass', 'pass_with_issues', 'fail', 'blocked'].includes(report.verdict)
			? report.verdict
			: undefined,
		summary: safeText(report.summary),
		covered: Array.isArray(report.covered)
			? report.covered.slice(0, 25).map(item => safeText(item, 500)).filter(Boolean)
			: [],
		notCovered: Array.isArray(report.notCovered)
			? report.notCovered.slice(0, 25).map(item => safeText(item, 500)).filter(Boolean)
			: [],
		recommendations: Array.isArray(report.recommendations)
			? report.recommendations.slice(0, 25).map(item => safeText(item, 500)).filter(Boolean)
			: []
	};
}

function publicRunSummary(session) {
	return {
		id: session.id,
		title: safeText(session.title, 200) ?? '',
		status: RUN_STATUSES.includes(session.status) ? session.status : 'idle',
		mode: ['qa', 'sqa', 'founder'].includes(session.mode) ? session.mode : 'qa',
		targetUrl: safeText(session.targetUrl, 2000),
		device: safeText(session.device, 200),
		engine: safeText(session.engine, 200),
		createdAt: session.createdAt,
		updatedAt: session.updatedAt,
		startedAt: session.startedAt,
		completedAt: session.completedAt,
		findingCount: Array.isArray(session.findings) ? session.findings.length : 0,
		reportVerdict: session.report?.verdict ?? undefined
	};
}

function publicRunDetail(session) {
	const findings = (Array.isArray(session.findings) ? session.findings : [])
		.map(publicFinding)
		.filter(Boolean);
	return {
		...publicRunSummary(session),
		findings,
		report: publicReport(session.report),
		serverNow: Date.now()
	};
}

function errorResponse(response, status, message) {
	response.status(status).set('Cache-Control', 'no-store').json({ error: { code: `public_api_${status}`, message, retryable: false } });
}

export function createPublicApi(options = {}) {
	const environment = options.environment ?? process.env;
	const services = options.services;
	const logger = options.logger;

	function mount(app) {
		const api = app;

		api.get(`${PUBLIC_API_BASE_PATH}/health`, (_request, response) => {
			response.set('Cache-Control', 'no-store').json({ ok: true, serverNow: Date.now() });
		});

		// Everything below requires the bearer token. The token is verified
		// before any run lookup so responses cannot act as an existence oracle.
		api.use(PUBLIC_API_BASE_PATH, (request, response, next) => {
			if (request.method !== 'GET' && request.method !== 'HEAD') {
				errorResponse(response, 404, 'Only GET requests are supported on the public API.');
				return;
			}
			const expected = configuredToken(environment);
			if (!expected) {
				errorResponse(response, 503, 'The public API is not configured on this deployment.');
				return;
			}
			if (!tokenMatches(expected, bearerToken(request))) {
				response.set('WWW-Authenticate', 'Bearer').status(401)
					.set('Cache-Control', 'no-store')
					.json({ error: { code: 'public_api_401', message: 'A valid bearer token is required.', retryable: false } });
				return;
			}
			next();
		});

		api.get(`${PUBLIC_API_BASE_PATH}/runs`, async (request, response) => {
			try {
				const rawLimit = request.query.limit;
				let limit = DEFAULT_LIMIT;
				if (rawLimit !== undefined) {
					limit = Number(rawLimit);
					if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
						errorResponse(response, 400, `limit must be an integer from 1 through ${MAX_LIMIT}.`);
						return;
					}
				}
				let rows = await services.runs.list({ limit });
				const statusFilter = request.query.status;
				if (typeof statusFilter === 'string' && statusFilter.trim() !== '') {
					const status = statusFilter.trim();
					if (!RUN_STATUSES.includes(status)) {
						errorResponse(response, 400, `status must be one of: ${RUN_STATUSES.join(', ')}.`);
						return;
					}
					rows = rows.filter(row => row.status === status);
				}
				response.set('Cache-Control', 'no-store')
					.json({ runs: rows.map(publicRunSummary), count: rows.length, serverNow: Date.now() });
			} catch (error) {
				logger?.error?.('public api runs list failed', error);
				errorResponse(response, 500, 'The run list is temporarily unavailable.');
			}
		});

		async function requireRun(request, response) {
			const session = await services.runs.get(request.params.id);
			if (!session) {
				errorResponse(response, 404, 'No such run.');
				return undefined;
			}
			return session;
		}

		api.get(`${PUBLIC_API_BASE_PATH}/runs/:id`, async (request, response) => {
			try {
				const session = await requireRun(request, response);
				if (!session) return;
				response.set('Cache-Control', 'no-store').json(publicRunDetail(session));
			} catch (error) {
				logger?.error?.('public api run detail failed', error);
				errorResponse(response, 500, 'The run detail is temporarily unavailable.');
			}
		});

		api.get(`${PUBLIC_API_BASE_PATH}/runs/:id/findings`, async (request, response) => {
			try {
				const session = await requireRun(request, response);
				if (!session) return;
				const findings = (Array.isArray(session.findings) ? session.findings : [])
					.map(publicFinding)
					.filter(Boolean);
				response.set('Cache-Control', 'no-store').json({ findings, count: findings.length, serverNow: Date.now() });
			} catch (error) {
				logger?.error?.('public api findings failed', error);
				errorResponse(response, 500, 'The findings are temporarily unavailable.');
			}
		});

		api.get(`${PUBLIC_API_BASE_PATH}/runs/:id/report.md`, async (request, response) => {
			try {
				const session = await requireRun(request, response);
				if (!session) return;
				let markdown;
				if (session.mode === 'sqa') {
					const { buildSqaReportMarkdown } = await import('./sqaAssessment.js');
					// finalizedAt guard mirrors the internal /api route: an
					// in-progress assessment is never published publicly.
					markdown = session.sqa?.assessment && session.sqa?.finalizedAt
						? buildSqaReportMarkdown(session.sqa.assessment) : undefined;
				} else if (session.mode === 'founder') {
					const { buildFounderReportMarkdown } = await import('./founderService.js');
					markdown = session.founder?.report && session.founder?.finalizedAt
						? buildFounderReportMarkdown(session) : undefined;
				} else {
					markdown = services.reports?.buildMarkdown
						? services.reports.buildMarkdown(session)
						: undefined;
				}
				if (typeof markdown !== 'string' || markdown.length === 0) {
					errorResponse(response, 409, 'This run has no finalized report yet.');
					return;
				}
				response.set('Cache-Control', 'no-store').type('text/markdown').send(markdown);
			} catch (error) {
				logger?.error?.('public api report failed', error);
				errorResponse(response, 500, 'The report is temporarily unavailable.');
			}
		});
	}

	return { mount };
}
