import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from './app.js';

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

function createAnalyticsServices() {
	const runs = [
		{
			id: 'aaaaaaaa-0000-4000-8000-000000000001',
			title: 'Run one', status: 'done', mode: 'qa',
			targetUrl: 'https://a.example', createdAt: 1_000, updatedAt: 2_000,
			startedAt: 60_000, completedAt: 120_000, durationSeconds: 60,
			findings: [], messages: []
		},
		{
			id: 'aaaaaaaa-0000-4000-8000-000000000002',
			title: 'Run two', status: 'running', mode: 'qa',
			targetUrl: 'https://a.example', createdAt: 3_000, updatedAt: 4_000,
			startedAt: 100_000,
			findings: [], messages: []
		}
	];
	const services = {
		readiness: { check: () => ({ ready: true, checks: {} }) },
		environments: {
			seed: async () => ({ inserted: 0 }),
			list: async () => [],
			get: async () => null,
			create: async input => input,
			update: async (envId, patch) => ({ envId, ...patch }),
			facets: async () => ({ total: 0, platform: [], device: [], os: [], osVersion: [], browser: [], browserVersion: [], deviceType: [], executionProvider: [], isRealDevice: [], active: [] }),
			availability: () => [],
			catalogVersion: () => 'test'
		},
		lifecycle: { close() {} },
		feedback: {
			create: async input => input,
			get: async () => undefined,
			list: async () => [],
			update: async (id, patch) => ({ id, ...patch }),
			remove: async () => true,
			stats: async () => ({ total: 0 }),
			forRun: async () => undefined
		},
		runs: {
			load() {},
			create: async title => ({ id: runs[0].id, title }),
			async get(id) { return runs.find(run => run.id === id); },
			async list() { return runs; },
			delete: async () => true,
			commit: async (session, type, payload) => payload,
			addMessage: async (session, message) => message,
			addActivity: async (session, activity) => activity,
			updateActivity: async () => undefined,
			setStatus: async () => undefined,
			durationAnalytics: async ({ targetUrl } = {}) => ({
				runCount: targetUrl ? 1 : 1,
				minDurationSeconds: 60, maxDurationSeconds: 60,
				avgDurationSeconds: 60, medianDurationSeconds: 60,
				avgSecondsPerItem: undefined,
				byTarget: [{ targetUrl: 'https://a.example', runCount: 1, avgDurationSeconds: 60 }]
			}),
			targetDurationHistory: async targetUrl => targetUrl === 'https://a.example'
				? [{ id: runs[0].id, status: 'done', startedAt: 60_000, completedAt: 120_000, durationSeconds: 60 }]
				: []
		},
		secrets: {
			names: async () => [],
			clear() {},
			store() {}
		},
		reports: { buildMarkdown: () => '# report' },
		configuration: {
			getPublic: () => ({}),
			save(patch) { return { ...patch }; },
			testConnection: () => Promise.resolve({ ok: true })
		},
		agent: {
			getLiveState: () => ({ running: false }),
			ensureRuntime() {},
			stop() {},
			closeBrowser: () => Promise.resolve(),
			purgeArtifacts: () => Promise.resolve(),
			invalidateIdleRuntimes: () => 0,
			runTurn: () => Promise.resolve()
		},
		events: { publish() {}, subscribe: () => () => {} }
	};
	return { services, runs };
}

test('session snapshot includes serverNow for timer skew correction', async () => {
	const { services } = createAnalyticsServices();
	const application = createApplication({ services, access: createInstanceAccess({ tenantContext: TEST_TENANT }) });
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	try {
		const origin = `http://127.0.0.1:${server.address().port}`;
		const response = await fetch(`${origin}/api/sessions/aaaaaaaa-0000-4000-8000-000000000002`);
		assert.equal(response.status, 200);
		const payload = await response.json();
		assert.ok(Number.isFinite(payload.serverNow));
		assert.ok(Math.abs(payload.serverNow - Date.now()) < 5_000);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});

test('analytics endpoints return server-computed aggregates', async () => {
	const { services } = createAnalyticsServices();
	const application = createApplication({ services, access: createInstanceAccess({ tenantContext: TEST_TENANT }) });
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	try {
		const origin = `http://127.0.0.1:${server.address().port}`;
		const aggregate = await (await fetch(`${origin}/api/analytics/durations`)).json();
		assert.equal(aggregate.runCount, 1);
		assert.equal(aggregate.avgDurationSeconds, 60);
		assert.ok(Array.isArray(aggregate.byTarget));
		const history = await (await fetch(`${origin}/api/analytics/targets/durations?targetUrl=https://a.example`)).json();
		assert.equal(history.length, 1);
		assert.equal(history[0].durationSeconds, 60);
		const missing = await fetch(`${origin}/api/analytics/targets/durations`);
		assert.equal(missing.status, 400);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});

test('in-memory services without analytics support degrade to empty aggregates', async () => {
	const { services } = createAnalyticsServices();
	delete services.runs.durationAnalytics;
	delete services.runs.targetDurationHistory;
	const application = createApplication({ services, access: createInstanceAccess({ tenantContext: TEST_TENANT }) });
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	try {
		const origin = `http://127.0.0.1:${server.address().port}`;
		const aggregate = await (await fetch(`${origin}/api/analytics/durations`)).json();
		assert.deepEqual(aggregate, { runCount: 0, byTarget: [] });
		const history = await (await fetch(`${origin}/api/analytics/targets/durations?targetUrl=https://a.example`)).json();
		assert.deepEqual(history, []);
	} finally {
		await new Promise(resolve => server.close(resolve));
	}
});
