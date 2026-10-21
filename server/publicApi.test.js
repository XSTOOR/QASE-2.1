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

test('health responds without a token', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/health`);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.ok, true);
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

test('run list returns sanitized summaries and clamps limit', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs?limit=1`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.runs.length, 1);
		assert.equal(payload.runs[0].id, 'aaaaaaaa-0000-4000-8000-000000000001');
		assert.equal(payload.runs[0].reportVerdict, 'pass_with_issues');
		const badLimit = await fetch(`${origin}/public/v1/runs?limit=0`, { headers: authHeaders(TOKEN) });
		assert.equal(badLimit.status, 400);
		const statusFilter = await fetch(`${origin}/public/v1/runs?status=running`, { headers: authHeaders(TOKEN) });
		const filtered = await statusFilter.json();
		assert.equal(filtered.runs.length, 1);
		assert.equal(filtered.runs[0].status, 'running');
		const badStatus = await fetch(`${origin}/public/v1/runs?status=bogus`, { headers: authHeaders(TOKEN) });
		assert.equal(badStatus.status, 400);
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
		assert.ok(Number.isFinite(payload.serverNow));
	});
});

test('findings endpoint returns the sanitized aggregate', async () => {
	const { services } = createServices();
	await withServer({ environment: { QASE_PUBLIC_API_TOKEN: TOKEN }, services }, async origin => {
		const response = await fetch(`${origin}/public/v1/runs/aaaaaaaa-0000-4000-8000-000000000001/findings`, { headers: authHeaders(TOKEN) });
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.equal(payload.count, 1);
		assert.equal(payload.findings[0].title, 'Login broken');
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
