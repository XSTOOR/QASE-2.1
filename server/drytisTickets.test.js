import assert from 'node:assert/strict';
import test from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';

/**
 * Dashboard-side Drytis ticket push: POST /api/sessions/:id/drytis/push.
 * Exercises the full contract — delivery-client payload shape, accept
 * filtering, error mapping, and the dormant (unconfigured) 409 path —
 * without touching the signed internal API (covered by
 * drytisIntegrationApi.test.js).
 */

function memoryServices(delivery) {
	const sessions = new Map();
	const listeners = new Map();
	const events = [];
	const publish = (session, type, payload = {}) => {
		events.push({ sessionId: session.id, type, payload });
		for (const listener of listeners.get(session.id) ?? []) {
			listener({ type, sessionId: session.id, ts: Date.now(), ...payload });
		}
	};
	return {
		services: {
			lifecycle: { close: async () => {} },
			environments: { seed: async () => ({ inserted: 0 }), list: async () => ({ rows: [], total: 0 }), get: async () => null, create: async () => ({}), update: async () => ({}), facets: async () => ({ total: 0 }), availability: () => ({ ready: [] }), catalogVersion: () => '0' },
			reports: { buildMarkdown: () => '# report' },
			events: {
				publish,
				subscribe(sessionId, listener) {
					const group = listeners.get(sessionId) ?? new Set();
					group.add(listener);
					listeners.set(sessionId, group);
					return () => group.delete(listener);
				},
				subscribeGlobal: () => () => {}
			},
			configuration: {
				getPublic: async () => ({ provider: 'custom', ready: true }),
				async save(body) { return body; },
				async testConnection() { return { ok: true }; }
			},
			runs: {
				async load() { return true; },
				async get(id) { return sessions.get(id); },
				async delete(id) { return sessions.delete(id); },
				async list() { return [...sessions.values()].map(s => ({ id: s.id, title: s.title })); },
				async create(_title, options = {}) {
					const session = {
						id: `tk-${sessions.size + 1}`, title: 'Drytis push target', status: 'done', mode: 'qa',
						messages: [], activities: [], findings: [], todos: [], secretNames: [],
						ownerUserId: options.ownerUserId
					};
					sessions.set(session.id, session);
					return session;
				},
				async commit(session, type, payload = {}) {
					publish(session, type, payload);
					return session;
				},
				async addMessage(session, message) { session.messages.push(message); return session; },
				async addActivity(session, activity) { session.activities.push(activity); return session; },
				async updateActivity() { return undefined; },
				setStatus(session, status) { session.status = status; }
			},
			secrets: { clear() {}, names() { return []; }, store() {} },
			agent: {
				ensureRuntime() { return {}; },
				runTurn() { return Promise.resolve(); },
				closeBrowser() { return Promise.resolve(); },
				getLiveState() { return { running: false }; },
				stop() { return Promise.resolve(); },
				invalidateIdleRuntimes() { return Promise.resolve(0); }
			},
			readiness: { check: async () => true },
			// DEV added a feedback service group to the runtime contract.
			feedback: { create: async () => ({}), get: async () => undefined, list: async () => [], update: async () => ({}), remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		},
		sessions,
		events
	};
}

async function startFixture(deliver) {
	const delivery = deliver ? {
		deliveryClient: { deliver },
		ticketsTarget: 'https://tickets.example/queue'
	} : undefined;
	const memory = memoryServices();
	const application = createApplication({
		services: memory.services,
		access: createInstanceAccess({ tenantContext: Object.freeze({
			organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
			projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
			actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
			actorEmail: 'owner@drytis.example',
			actorName: 'Drytis Owner'
		}) }),
		environment: {},
		drytisDelivery: delivery
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const { port } = server.address();
	return {
		...memory,
		request: (p, options = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
			...options,
			headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
		}),
		close: async () => {
			await application.whenIdle();
			await new Promise(resolve => server.close(resolve));
		}
	};
}

/** A session with two findings and a Drytis review attached. */
async function reviewedSession(fixture) {
	const session = await fixture.services.runs.create('Drytis review run');
	session.findings = [
		{ id: 'f-1', title: 'Login button invisible on mobile', severity: 'high',
			actual: 'Button renders 0px tall', expected: 'Button visible', steps: ['Open login', 'Resize to 375px'],
			url: 'https://example.com/login', engine: 'firefox' },
		{ id: 'f-2', title: 'Console error on dashboard', severity: 'low',
			actual: 'TypeError thrown', expected: 'No error', url: 'https://example.com/dash' }
	];
	session.drytisIntegration = {
		externalReviewId: 'rev-77',
		project: { id: 'proj-9', name: 'Acme' },
		updatedAt: new Date().toISOString()
	};
	return session;
}

test('drytis push rejects when delivery is not configured (dormant default)', async t => {
	const fixture = await startFixture(undefined);
	t.after(() => fixture.close());
	const session = await reviewedSession(fixture);
	const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['f-1'] })
	});
	assert.equal(response.status, 409);
	const body = await response.json();
	assert.match(body.error, /not configured/);
});

test('drytis push rejects sessions without an attached review', async t => {
	const fixture = await startFixture(undefined);
	t.after(() => fixture.close());
	const session = await fixture.services.runs.create('Plain QA run');
	// Without delivery configured the 409 hits first; with delivery, the
	// missing review is the rejection.
	const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['f-1'] })
	});
	assert.equal(response.status, 409);
	const body = await response.json();
	assert.match(body.error, /not configured|no Drytis review/);
});

test('drytis push rejects sessions without an attached review even when delivery is configured', async t => {
	const fixture = await startFixture(async () => ({ status: 202 }));
	t.after(() => fixture.close());
	const session = await fixture.services.runs.create('Plain QA run');
	const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['f-1'] })
	});
	assert.equal(response.status, 409);
	const body = await response.json();
	assert.match(body.error, /no Drytis review/);
});

test('drytis push validates acceptedFindingIds shape', async t => {
	const fixture = await startFixture(async () => ({ status: 202 }));
	t.after(() => fixture.close());
	const session = await reviewedSession(fixture);
	for (const body of [
		{ acceptedFindingIds: 'f-1' },
		{ acceptedFindingIds: ['f-1', 42] },
		{ acceptedFindingIds: [] },
		{}
	]) {
		const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
			method: 'POST', body: JSON.stringify(body)
		});
		assert.equal(response.status, 400, `body ${JSON.stringify(body)} must 400`);
	}
	// Unknown ids are a 400 (no accepted findings survive the filter).
	const unknown = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['nope'] })
	});
	assert.equal(unknown.status, 400);
});

test('drytis push delivers only accepted findings and persists delivered state', async t => {
	const deliveries = [];
	const fixture = await startFixture(async (target, payload, options) => {
		deliveries.push({ target, payload, options });
		return { status: 201 };
	});
	t.after(() => fixture.close());
	const session = await reviewedSession(fixture);

	const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['f-1'] })
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.ok, true);
	assert.equal(body.tickets.status, 'delivered');
	assert.equal(body.tickets.ticketCount, 1);
	assert.ok(body.tickets.deliveredAt);

	// Payload contract: one ticket, correct target, engine + markdown body carried.
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0].target, 'https://tickets.example/queue');
	const { payload, options } = deliveries[0];
	assert.equal(payload.schemaVersion, 1);
	assert.equal(payload.reviewId, 'rev-77');
	assert.equal(payload.project.id, 'proj-9');
	assert.equal(payload.tickets.length, 1);
	const ticket = payload.tickets[0];
	assert.equal(ticket.id, 'f-1');
	assert.equal(ticket.title, 'Login button invisible on mobile');
	assert.equal(ticket.engine, 'firefox', 'engine rides the ticket payload');
	assert.match(ticket.body, /\*\*Actual:\*\* Button renders 0px tall/);
	assert.match(ticket.body, /\*\*Steps:\*\*/);
	assert.ok(options.idempotencyKey.startsWith(`tickets-${session.id}-`));
	assert.ok(options.correlationId);

	// State persisted on the session blob (survives reload / SSE replay).
	const stored = fixture.sessions.get(session.id).drytisIntegration.tickets;
	assert.equal(stored.status, 'delivered');
	assert.deepEqual(stored.acceptedFindingIds, ['f-1']);
	assert.equal(stored.ticketCount, 1);

	// Events recorded for the audit trail.
	assert.ok(fixture.events.some(e => e.type === 'drytis.tickets.requested'));
	assert.ok(fixture.events.some(e => e.type === 'drytis.tickets.completed'));
});

test('drytis push maps delivery failure to 502 with retryable state', async t => {
	const fixture = await startFixture(async () => { throw new Error('upstream exploded'); });
	t.after(() => fixture.close());
	const session = await reviewedSession(fixture);

	const response = await fixture.request(`/api/sessions/${session.id}/drytis/push`, {
		method: 'POST', body: JSON.stringify({ acceptedFindingIds: ['f-1', 'f-2'] })
	});
	assert.equal(response.status, 502);
	const body = await response.json();
	assert.match(body.error, /did not complete/);

	const stored = fixture.sessions.get(session.id).drytisIntegration.tickets;
	assert.equal(stored.status, 'failed');
	assert.equal(stored.error.retryable, true);
	assert.ok(fixture.events.some(e => e.type === 'drytis.tickets.failed'));
});
