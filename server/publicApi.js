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

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
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

function toIso(ms) {
	return Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null;
}

function publicFinding(finding) {
	if (!finding || typeof finding !== 'object') return undefined;
	return {
		id: typeof finding.id === 'string' ? finding.id : undefined,
		ts: toIso(finding.ts),
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
		ts: toIso(report.ts),
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
		createdAt: toIso(session.createdAt),
		updatedAt: toIso(session.updatedAt),
		startedAt: toIso(session.startedAt),
		completedAt: toIso(session.completedAt),
		findingCount: Array.isArray(session.findings) ? session.findings.length : 0,
		reportVerdict: ['pass', 'pass_with_issues', 'fail', 'blocked'].includes(session.report?.verdict)
			? session.report.verdict
			: undefined
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
		serverNow: new Date().toISOString()
	};
}

function paginate(rows, page, pageSize) {
	return rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
}

function parsePaging(request, response) {
	const rawPage = request.query.page;
	const rawPageSize = request.query.page_size;
	let page = DEFAULT_PAGE;
	let pageSize = DEFAULT_PAGE_SIZE;
	if (rawPage !== undefined) {
		page = Number(rawPage);
		if (!Number.isSafeInteger(page) || page < 1) {
			errorResponse(response, 400, 'page must be an integer of 1 or greater.');
			return undefined;
		}
	}
	if (rawPageSize !== undefined) {
		pageSize = Number(rawPageSize);
		if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
			errorResponse(response, 400, `page_size must be an integer from 1 through ${MAX_PAGE_SIZE}.`);
			return undefined;
		}
	}
	return { page, pageSize };
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
			response.set('Cache-Control', 'no-store').json({ ok: true, serverNow: new Date().toISOString() });
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

		// System-scope reads (#17004): the request-scoped runs.get/list filter by
		// the ambient actor, which for these token-authenticated routes is the
		// tenant default — hiding every real run. peek()/listAll() are the
		// unscoped readers reserved for system actors; this surface is exactly
		// that (read-only, bearer-token, allowlist-projected below).
		async function getRun(id) {
			if (typeof services.runs.peek === 'function') return services.runs.peek(id);
			return services.runs.get(id);
		}
		async function listRuns(limit) {
			if (typeof services.runs.listAll === 'function') {
				const rows = await services.runs.listAll();
				return Array.isArray(rows) ? rows.slice(0, limit) : [];
			}
			return services.runs.list({ limit });
		}

		api.get(`${PUBLIC_API_BASE_PATH}/runs`, async (request, response) => {
			try {
				const paging = parsePaging(request, response);
				if (!paging) return;
				const { page, pageSize } = paging;

				const statusFilter = request.query.status;
				let status;
				if (typeof statusFilter === 'string' && statusFilter.trim() !== '') {
					status = statusFilter.trim();
					if (!RUN_STATUSES.includes(status)) {
						errorResponse(response, 400, `status must be one of: ${RUN_STATUSES.join(', ')}.`);
						return;
					}
				}
				const modeFilter = request.query.mode;
				let mode;
				if (typeof modeFilter === 'string' && modeFilter.trim() !== '') {
					mode = modeFilter.trim();
					if (!['qa', 'sqa', 'founder'].includes(mode)) {
						errorResponse(response, 400, 'mode must be one of: qa, sqa, founder.');
						return;
					}
				}
				const deviceFilter = request.query.device;
				const device = typeof deviceFilter === 'string' && deviceFilter.trim() !== '' ? deviceFilter.trim() : undefined;

				let fromMs;
				let toMs;
				const fromRaw = request.query.from;
				if (typeof fromRaw === 'string' && fromRaw.trim() !== '') {
					const from = new Date(`${fromRaw.trim()}T00:00:00.000Z`);
					if (Number.isNaN(from.getTime())) {
						errorResponse(response, 400, 'from must be an ISO date (YYYY-MM-DD).');
						return;
					}
					fromMs = from.getTime();
				}
				const toRaw = request.query.to;
				if (typeof toRaw === 'string' && toRaw.trim() !== '') {
					const to = new Date(`${toRaw.trim()}T23:59:59.999Z`);
					if (Number.isNaN(to.getTime())) {
						errorResponse(response, 400, 'to must be an ISO date (YYYY-MM-DD).');
						return;
					}
					toMs = to.getTime();
				}

				const rows = (await listRuns(Number.MAX_SAFE_INTEGER)).filter(row => {
					if (status && row.status !== status) return false;
					if (mode && (row.mode === 'sqa' || row.mode === 'founder' ? row.mode : 'qa') !== mode) return false;
					if (device && row.device !== device) return false;
					if (fromMs !== undefined && !(row.createdAt >= fromMs)) return false;
					if (toMs !== undefined && !(row.createdAt <= toMs)) return false;
					return true;
				});
				response.set('Cache-Control', 'no-store')
					.json({
						data: paginate(rows, page, pageSize).map(publicRunSummary),
						total: rows.length,
						page,
						page_size: pageSize,
						serverNow: new Date().toISOString()
					});
			} catch (error) {
				logger?.error?.('public api runs list failed', error);
				errorResponse(response, 500, 'The run list is temporarily unavailable.');
			}
		});

		async function requireRun(request, response) {
			const session = await getRun(request.params.id);
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
				const paging = parsePaging(request, response);
				if (!paging) return;
				const { page, pageSize } = paging;

				const severityFilter = request.query.severity;
				let severity;
				if (typeof severityFilter === 'string' && severityFilter.trim() !== '') {
					severity = severityFilter.trim();
					if (!SEVERITIES.includes(severity)) {
						errorResponse(response, 400, `severity must be one of: ${SEVERITIES.join(', ')}.`);
						return;
					}
				}
				const findingStatusFilter = request.query.status;
				let findingStatus;
				if (typeof findingStatusFilter === 'string' && findingStatusFilter.trim() !== '') {
					findingStatus = findingStatusFilter.trim();
					if (!FINDING_STATUSES.includes(findingStatus)) {
						errorResponse(response, 400, `status must be one of: ${FINDING_STATUSES.join(', ')}.`);
						return;
					}
				}

				const findings = (Array.isArray(session.findings) ? session.findings : [])
					.map(publicFinding)
					.filter(Boolean)
					.filter(finding => {
						if (severity && finding.severity !== severity) return false;
						if (findingStatus && finding.status !== findingStatus) return false;
						return true;
					});
				response.set('Cache-Control', 'no-store').json({
					data: paginate(findings, page, pageSize),
					total: findings.length,
					page,
					page_size: pageSize,
					serverNow: new Date().toISOString()
				});
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
