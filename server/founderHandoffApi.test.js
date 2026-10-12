import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { randomUUID } from 'node:crypto';

const TEST_TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

function recommendationFixture(id) {
	return {
		id, category: 'growth', title: `Rec ${id}`,
		opportunity: 'Opportunity', proposedFeature: `Feature ${id}`,
		whyItMatters: 'Why', intendedOutcome: 'Outcome',
		priority: 'P1', priorityReason: 'Highest leverage',
		actions: ['a'], implementationScope: 'Server: endpoint; client: component; no schema change.',
		dependencies: ['d'],
		acceptanceCriteria: ['AC1', 'AC2'], impact: 'high', effort: 'small',
		confidence: 'medium', evidenceObservationIds: ['obs-1'], assumptions: []
	};
}

/** Minimal app fixture with a founder project state + configurable handoff delivery. */
async function startFixture({ deliveries = [], deliveryError } = {}) {
	let founderState = {
		schemaVersion: 1,
		updatedAt: '2026-10-05T10:00:00.000Z',
		ownerUserId: 'user-test',
		targetUrl: 'https://demo.test/',
		context: { targetUrl: 'https://demo.test/', description: 'Demo' },
		goals: { primaryGoal: 'Grow signups' },
		recommendationSet: {
			setVersion: 3, generatedAt: '2026-10-05T10:00:00.000Z',
			recommendations: [recommendationFixture('rec-1'), recommendationFixture('rec-2'), recommendationFixture('rec-3')]
		},
		selections: ['rec-1', 'rec-3'],
		handoff: undefined
	};
	const deliveryClient = {
		async deliver(target, payload, opts) {
			if (deliveryError) throw deliveryError;
			const receipt = { status: 202, reference: `job-${deliveries.length + 1}` };
			deliveries.push({ target, payload, opts, receipt });
			return receipt;
		}
	};
	const memoryRuns = {
		load() {}, create() {}, get() { return undefined; }, list() { return []; },
		getAny() { return undefined; }, delete() { return true; },
		commit(session) { return session; },
		addMessage(_session, message) { return message; },
		addActivity(_session, activity) { return activity; },
		updateActivity(_session, _id, patch) { return patch; },
		setStatus() {},
		aggregateFindings() { return Promise.resolve([]); },
		setFindingStatus() { return Promise.resolve(undefined); },
		async getFounderProjectState() { return founderState; },
		async saveFounderProjectState(state) { founderState = state; return state; }
	};
	const services = {
		runs: memoryRuns,
		events: { publish() {}, subscribe() { return () => {}; } },
		configuration: {
			getPublic: () => ({ ready: true }),
			save(patch) { return { ready: true, ...patch }; },
			testConnection() { return Promise.resolve({ ok: true }); }
		},
		secrets: { clear() {}, names: () => [], store() { return []; } },
		reports: { buildMarkdown: session => `# ${session?.title ?? ''}` },
		feedback: {
			create() { return Promise.resolve({}); },
			get() { return Promise.resolve(undefined); },
			list() { return Promise.resolve([]); },
			update() { return Promise.resolve({}); },
			remove() { return Promise.resolve(true); },
			stats() { return Promise.resolve({}); },
			forRun() { return Promise.resolve(undefined); }
		},
		agent: {
			ensureRuntime() {}, getLiveState: () => ({ frame: undefined }),
			runTurn() { return Promise.resolve(); },
			invalidateIdleRuntimes() { return 0; },
			closeBrowser() { return Promise.resolve(); },
			stop() {}
		},
		readiness: { check: () => ({ ready: true, checks: {} }) },
		lifecycle: { close() { return Promise.resolve(); } },
		tenantContext: TEST_TENANT
	};
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TEST_TENANT }),
		environment: {},
		drytisDelivery: { deliveryClient, ticketsTarget: '/tickets', founderHandoffTarget: '/founder-handoff' }
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const address = server.address();
	const origin = `http://127.0.0.1:${address.port}`;

	async function request(path, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		let bodyContent = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			bodyContent = JSON.stringify(requestOptions.json);
		}
		return fetch(`${origin}${path}`, { ...requestOptions, headers, body: bodyContent });
	}

	return {
		...application, server, request, deliveries,
		get state() { return founderState; },
		async seedHandoff(handoff) { founderState = { ...founderState, handoff }; },
		close: async () => {
			await application.whenIdle();
			await new Promise(resolve => server.close(resolve));
		}
	};
}

test('founder handoff route delivers only the selected ids via the signed client', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const response = await fixture.request('/api/founder/handoff', {
		method: 'POST',
		json: { selectedRecommendationIds: ['rec-2', 'rec-1'] }
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.ok, true);
	assert.equal(result.handoff.status, 'succeeded');
	assert.match(result.handoff.reference, /^job-\d+$/);
	// Only selected ids in the payload, in recommendation-set order
	assert.equal(fixture.deliveries.length, 1);
	assert.equal(fixture.deliveries[0].target, '/founder-handoff');
	assert.deepEqual(fixture.deliveries[0].payload.ordered, ['rec-1', 'rec-2']);
	assert.equal(fixture.deliveries[0].payload.source, 'founder');
	assert.equal(fixture.deliveries[0].payload.projectId, 'f2964599-fb3a-4c4e-acec-ee84d74fab55');
	assert.equal(fixture.deliveries[0].payload.recommendationSet.setVersion, 3);
	// state records the handoff; selections untouched
	assert.equal(fixture.state.handoff.status, 'succeeded');
	assert.deepEqual(fixture.state.selections, ['rec-1', 'rec-3']);
});

test('empty, unknown, or malformed selections are rejected with 400', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	for (const json of [
		{},
		{ selectedRecommendationIds: [] },
		{ selectedRecommendationIds: 'rec-1' },
		{ selectedRecommendationIds: ['nope'] }
	]) {
		const response = await fixture.request('/api/founder/handoff', { method: 'POST', json });
		assert.equal(response.status, 400, JSON.stringify(json));
	}
	assert.equal(fixture.deliveries.length, 0);
});

test('a pending handoff blocks duplicate submissions with 409', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	// Seed the pending record a concurrent request would have written.
	const seeded = await fixture.request('/api/founder/handoff', {
		method: 'POST', json: { selectedRecommendationIds: ['rec-1'] }
	});
	assert.equal(seeded.status, 200);
	// The saved state now records a succeeded handoff; simulate the pending
	// window by re-sending while the state records pending.
	await fixture.seedHandoff({ status: 'pending', requestedAt: new Date().toISOString(), selectedRecommendationIds: ['rec-1'] });
	const second = await fixture.request('/api/founder/handoff', {
		method: 'POST', json: { selectedRecommendationIds: ['rec-2'] }
	});
	assert.equal(second.status, 409);
	const result = await second.json();
	assert.equal(result.code, 'handoff_pending');
	assert.equal(fixture.deliveries.length, 1); // the first send only
});

test('failed delivery preserves selections and reports an actionable error', async t => {
	const fixture = await startFixture({ deliveryError: new Error('upstream offline') });
	t.after(() => fixture.close());

	const response = await fixture.request('/api/founder/handoff', {
		method: 'POST', json: { selectedRecommendationIds: ['rec-1'] }
	});
	assert.equal(response.status, 502);
	const result = await response.json();
	assert.match(result.error, /did not complete/i);
	assert.equal(fixture.state.handoff.status, 'failed');
	assert.deepEqual(fixture.state.selections, ['rec-1', 'rec-3']); // preserved
});

test('export fallback returns the ready payload without delivering', async t => {
	const fixture = await startFixture();
	t.after(() => fixture.close());

	const response = await fixture.request('/api/founder/handoff', {
		method: 'POST', json: { selectedRecommendationIds: ['rec-3'], export: true }
	});
	assert.equal(response.status, 200);
	const result = await response.json();
	assert.equal(result.ok, false);
	assert.equal(result.unavailable, true);
	assert.deepEqual(result.payload.ordered, ['rec-3']);
	assert.equal(fixture.deliveries.length, 0);
	// Export must not claim a build started
	const text = JSON.stringify(result);
	assert.ok(!/build (has )?start/i.test(text));
});
