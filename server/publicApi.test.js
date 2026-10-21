import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from './app.js';

const TOKEN = 'public-api-test-token-0123456789abcdef';

const TEST_TENANT = {
	organizationId: '1b2b2b2b-0000-4000-8000-000000000001',
	projectId: '1b2b2b2b-0000-4000-8000-000000000002'
};

function createInstanceAccess({ tenantContext }) {
	return {
		mount(app) {
			app.use((request, _response, next) => {
				request.tenant = tenantContext;
				request.auth = { userId: 'owner', role: 'owner' };
				next();
			});
		}
	};
}

function createServices() {
	const runs = [
		{
			id: 'aaaaaaaa-0000-4000-8000-000000000001',
			title: 'Run one', status: 'done', mode: 'qa',
			targetUrl: 'https://a.example', createdAt: 1_000, updatedAt: 2_000,
			startedAt: 60_000, completedAt: 120_000,
			ownerUserId: 'secret-owner-id',
			secretNames: ['SUPER_SECRET'],
			messages: [{ role: 'user', text: 'secret prompt' }],
			activities: [{ id: 'act', toolName: 'browser_navigate' }],
			tokenUsage: { total: 100 },
			findings: [{
				id: 'f1', ts: 1_500, title: 'Login broken', severity: 'high',
				category: 'auth', url: 'https://a.example/login',
				expected: 'Login succeeds', actual: '500 error',
				steps: ['Open /login', 'Submit form'], evidence: 'screenshot',
				status: 'open'
			}],
			report: {
				ts: 2_000, verdict: 'pass_with_issues', summary: 'Two flows checked',
				covered: ['login page loads'], notCovered: ['password reset'],
				recommendations: ['Fix login 500']
			}
		},
		{
			id: 'aaaaaaaa-0000-4000-8000-000000000002',
			title: 'Run two', status: 'running', mode: 'qa',
			targetUrl: 'https://a.example', createdAt: 3_000, updatedAt: 4_000,
			findings: [], messages: []
		}
	];
	const services = {
		readiness: { check: () => ({ ready: true, checks: {} }) },
		__all: runs,
		lifecycle: { close() {} },
		feedback: { create: async i => i, get: async () => undefined, list: async () => [], update: async i => i, remove: async () => true, stats: async () => ({ total: 0 }), forRun: async () => undefined },
		events: { publish() {}, subscribe: () => () => {} },
		configuration: { getPublic: () => ({}), save(patch) { return { ...patch }; }, testConnection: () => Promise.resolve({ ok: true }) },
		secrets: { clear() {}, names: async () => [], store() {} },
		reports: { buildMarkdown: session => `# report ${session.title}` },
		agent: { ensureRuntime() {}, runTurn: () => Promise.resolve(), closeBrowser: () => Promise.resolve(), getLiveState: () => ({ running: false }), stop() {}, invalidateIdleRuntimes: () => 0 },
		runs: {
			load() {},
			create: async title => ({ id: runs[0].id, title }),
			async get(id) { return runs.find(run => run.id === id); },
			async list({ limit = 100 } = {}) { return runs.slice(0, limit); },
			delete: async () => true,
			commit: async () => undefined,
			addMessage: async (_s, message) => message,
			addActivity: async (_s, activity) => activity,
			updateActivity: async () => undefined,
			setStatus: async () => undefined
		}
	};
	services.runs.peek = async id => runs.find(run => run.id === id);
	services.runs.listAll = async () => runs;
	return { services, runs };
}

async function withServer({ environment, services }, run) {
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TEST_TENANT }),
		publicApi: { mount: app => {
			// Re-import-free wiring: build the same mount the app uses.
		} }
	});
	// NOTE: createApplication does not construct the public API itself —
	// index.js does. For tests, mount it the same way index.js does.
	const { createPublicApi } = await import('./publicApi.js');
	createPublicApi({ environment, services }).mount(application.app);
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	try {
		await run(`http://127.0.0.1:${server.address().port}`);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
}

function authHeaders(token) {
	return token ? { Authorization: `Bearer ${token}` } : {};
}

test('health responds without a token and reports ISO serverNow', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/health`);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.ok, true);
		assert.match(payload.serverNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});

test('data routes answer 503 when the token env is unset', async () => {
	const { services } = createServices();
	await withServer({ environment: {}, services }, async origin => {
		for (const path of ['/public/v1/runs', '/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001']) {
			const response = await fetch(`${origin}${path}`, { headers: authHeaders(TOKEN) });
			assert.equal(response.status, 503, path);
			const body = await response.json();
			assert.ok(body.error);
		}
	});
});

test('missing or wrong bearer token answers 401 without leaking run existence', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const noHeader = await fetch(`${origin}/public/v1/runs`);
		assert.equal(noHeader.status, 401);
		const wrong = await fetch(`${origin}/public/v1/runs`, { headers: authHeaders('wrong-token-entirely-1234567890') });
		assert.equal(wrong.status, 401);
		const unknownRun = await fetch(`${origin}/public/v1/runs/ffffffff-0000-4000-8000-000000000009`, { headers: authHeaders('wrong-token-entirely-1234567890') });
		assert.equal(unknownRun.status, 401); // token checked before lookup
		const body = await wrong.json();
		assert.ok(body.error);
	});
});

test('run list returns data/total envelopes, ISO timestamps, paging and filters', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs?page=1&page_size=1`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.data.length, 1);
		assert.equal(payload.total, 2, 'total ignores paging');
		assert.equal(payload.page, 1);
		assert.equal(payload.page_size, 1);
		assert.equal(payload.data[0].id, 'aaaaaaaa-0000-4000-8000-000000000001');
		assert.equal(payload.data[0].reportVerdict, 'pass_with_issues');
		assert.match(payload.data[0].createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'ISO createdAt');
		assert.match(payload.serverNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		// second page
		const page2 = await (await fetch(`${origin}/public/v1/runs?page=2&page_size=1`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(page2.data.length, 1);
		assert.equal(page2.data[0].id, 'aaaaaaaa-0000-4000-8000-000000000002');
		assert.equal(page2.total, 2);
		// page beyond last
		const page999 = await (await fetch(`${origin}/public/v1/runs?page=999`, { headers: authHeaders(TOKEN) })).json();
		assert.deepEqual(page999.data, []);
		assert.equal(page999.total, 2);
		// missing startedAt renders null, never epoch
		assert.equal(page2.data[0].startedAt, null);
		// invalid paging
		const badPage = await fetch(`${origin}/public/v1/runs?page=0`, { headers: authHeaders(TOKEN) });
		assert.equal(badPage.status, 400);
		const badPageSize = await fetch(`${origin}/public/v1/runs?page_size=101`, { headers: authHeaders(TOKEN) });
		assert.equal(badPageSize.status, 400);
		// status filter
		const statusFilter = await fetch(`${origin}/public/v1/runs?status=running`, { headers: authHeaders(TOKEN) });
		const filtered = await statusFilter.json();
		assert.equal(filtered.total, 1);
		assert.equal(filtered.data[0].status, 'running');
		const badStatus = await fetch(`${origin}/public/v1/runs?status=bogus`, { headers: authHeaders(TOKEN) });
		assert.equal(badStatus.status, 400);
		// mode filter with fallback (run two has no mode → qa)
		const modeFiltered = await (await fetch(`${origin}/public/v1/runs?mode=qa`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(modeFiltered.total, 2);
		const badMode = await fetch(`${origin}/public/v1/runs?mode=nope`, { headers: authHeaders(TOKEN) });
		assert.equal(badMode.status, 400);
		// device filter (fixture runs carry no device → 0 matches)
		const deviceFiltered = await (await fetch(`${origin}/public/v1/runs?device=desktop`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(deviceFiltered.total, 0);
		// date range on createdAt (run one: 1000ms epoch; run two: 3000ms)
		const inRange = await (await fetch(`${origin}/public/v1/runs?from=1970-01-01&to=1970-01-01`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(inRange.total, 2);
		const outOfRange = await (await fetch(`${origin}/public/v1/runs?from=2026-01-01`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(outOfRange.total, 0);
		const badDate = await fetch(`${origin}/public/v1/runs?from=notadate`, { headers: authHeaders(TOKEN) });
		assert.equal(badDate.status, 400);
	});
});

test('run list ignores the request-scoped actor: uses peek/listAll system readers (#17004)', async () => {
	// Regression for the production incident: with no ambient request actor,
	// runs.get/list filter by the tenant default owner and return NOTHING for
	// real runs. The public API must read through peek()/listAll().
	const { services } = createServices();
	const scopedCalls = [];
	services.runs.get = async id => { scopedCalls.push(`get:${id}`); return undefined; };
	services.runs.list = async (options) => { scopedCalls.push('list'); return []; };
	services.runs.peek = async id => services.__all.find(run => run.id === id);
	services.runs.listAll = async () => services.__all;
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const list = await fetch(`${origin}/public/v1/runs`, { headers: authHeaders(TOKEN) });
		assert.equal(list.status, 200);
		const payload = await list.json();
		assert.ok(payload.total > 0, 'listAll must be used so real runs appear');
		const detail = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001`, { headers: authHeaders(TOKEN) });
		assert.equal(detail.status, 200);
		assert.deepEqual(scopedCalls, [], 'request-scoped get/list must never be called');
	});
});

test('run detail exposes findings and report but never private fields', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		const text = await response.text();
		for (const forbidden of ['ownerUserId', 'secretNames', 'messages', 'activities', 'tokenUsage', 'SUPER_SECRET', 'secret prompt']) {
			assert.ok(!text.includes(forbidden), `response must not contain ${forbidden}`);
		}
		const payload = JSON.parse(text);
		assert.equal(payload.findings.length, 1);
		assert.equal(payload.findings[0].severity, 'high');
		assert.equal(payload.report.verdict, 'pass_with_issues');
		assert.match(payload.serverNow, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
		assert.match(payload.findings[0].ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'finding ts is ISO');
	});
});

test('findings endpoint returns the sanitized aggregate with filters and paging', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.total, 1);
		assert.equal(payload.data[0].title, 'Login broken');
		assert.equal(payload.page, 1);
		assert.equal(payload.page_size, 25);
		// severity filter — match and miss
		const high = await (await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings?severity=high`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(high.total, 1);
		const critical = await (await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings?severity=critical`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(critical.total, 0);
		assert.deepEqual(critical.data, []);
		const badSeverity = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings?severity=nope`, { headers: authHeaders(TOKEN) });
		assert.equal(badSeverity.status, 400);
		// finding status filter
		const fixed = await (await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings?status=fixed`, { headers: authHeaders(TOKEN) })).json();
		assert.equal(fixed.total, 0);
		const badFindingStatus = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings?status=nope`, { headers: authHeaders(TOKEN) });
		assert.equal(badFindingStatus.status, 400);
	});
});

test('report.md serves markdown for qa runs and 404 for unknown runs', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/report.md`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
		const markdown = await response.text();
		assert.match(markdown, /# report Run one/);
		const unknown = await fetch(`${origin}/public/v1/runs/ffffffff-0000-4000-8000-000000000009`, { headers: authHeaders(TOKEN) });
		assert.equal(unknown.status, 404);
	});
});

test('non-GET methods are rejected on the public API', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs`, {
			method: 'POST',
			headers: { ...authHeaders(TOKEN), 'Content-Type': 'application/json' },
			body: '{}'
		});
		assert.equal(response.status, 404);
	});
});
