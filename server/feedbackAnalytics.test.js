import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { recordEvent, summarize, durationBucket } from './analytics.js';

/* ── analytics module unit tests ─────────────────────────────────── */

test('recordEvent counts, merges dimensions, and persists atomically', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-analytics-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));

	recordEvent(directory, 'run_started', { dimensions: { mode: 'qa' } });
	recordEvent(directory, 'run_started', { dimensions: { mode: 'qa' } });
	recordEvent(directory, 'run_started', { dimensions: { mode: 'founder' } });

	const summary = summarize(directory);
	assert.equal(summary.events.run_started.total, 3);
	const qa = summary.events.run_started.byDimension.find(entry => entry.mode === 'qa');
	assert.equal(qa.count, 2);
	const founder = summary.events.run_started.byDimension.find(entry => entry.mode === 'founder');
	assert.equal(founder.count, 1);
});

test('recordEvent rejects malformed names and counts', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-analytics-invalid-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	assert.throws(() => recordEvent(directory, 'Not-Snake-Case'));
	assert.throws(() => recordEvent(directory, 'valid_name', { count: 0 }));
});

test('summarize survives a missing or corrupt analytics file', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-analytics-empty-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	assert.equal(summarize(directory).totalEvents, 0);
	await fs.writeFile(path.join(directory, 'analytics.json'), 'not json');
	assert.equal(summarize(directory).totalEvents, 0);
});

test('durationBucket maps durations to coarse labels', () => {
	assert.equal(durationBucket(20_000), 'under_1m');
	assert.equal(durationBucket(2 * 60_000), '1m_to_5m');
	assert.equal(durationBucket(10 * 60_000), '5m_to_15m');
	assert.equal(durationBucket(20 * 60_000), '15m_to_30m');
	assert.equal(durationBucket(45 * 60_000), 'over_30m');
	assert.equal(durationBucket(Number.NaN), 'unknown');
});

/* ── feedback endpoint contract ──────────────────────────────────── */

function memoryServices() {
	const sessions = new Map();
	const listeners = new Map();
	const publish = (session, type, payload = {}) => {
		for (const listener of listeners.get(session.id) ?? []) {
			listener({ type, sessionId: session.id, ts: Date.now(), ...payload });
		}
	};
	return {
		state: { sessions },
		services: {
			configuration: { getPublic: async () => ({ provider: 'custom', ready: true }) },
			lifecycle: { close: async () => {} },
		environments: { seed: async () => ({ inserted: 0 }), list: async () => [], get: async () => undefined, create: async () => ({}), update: async () => ({}), facets: async () => ({}), availability: () => [], catalogVersion: () => 'test' },
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
			runs: {
				async load() { return true; },
				async get(id) { return sessions.get(id); },
				async list() { return [...sessions.values()].map(s => ({ id: s.id, title: s.title })); },
				async delete(id) { return sessions.delete(id); },
				async create(_title, options = {}) {
					const session = {
						id: `fb-${sessions.size + 1}`, title: 'Feedback target', status: 'idle',
						messages: [], activities: [], findings: [], todos: [], secretNames: [],
						ownerUserId: options.ownerUserId
					};
					sessions.set(session.id, session);
					return session;
				},
				async commit(session, type, payload = {}) {
					if (type === 'feedback') session.feedback = payload.feedback;
					publish(session, type, payload);
					return session;
				},
				async addMessage(session, message) {
					const entry = { id: `m-${session.messages.length + 1}`, ts: Date.now(), ...message };
					session.messages.push(entry);
					publish(session, 'message', { message: entry });
					return entry;
				},
				async addActivity(session, activity) {
					const entry = { id: `a-${session.activities.length + 1}`, ts: Date.now(), status: 'done', ...activity };
					session.activities.push(entry);
					publish(session, 'activity', { activity: entry });
					return entry;
				},
				async updateActivity() { return undefined; },
				setStatus(session, status) { session.status = status; }
			},
			configuration: {
				getPublic: async () => ({ provider: 'custom', ready: true }),
				async save(body) { return body; },
				async testConnection() { return { ok: true }; }
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
			// PUSHKAR added an environments service group to the runtime contract.
			environments: { seed: async () => undefined, list: async () => ({ rows: [], total: 0 }), get: async () => null, create: async () => ({}), update: async () => ({}), facets: async () => ({ total: 0 }), availability: () => ({ ready: [] }), catalogVersion: () => '0' },
		}
	};
}

async function startFeedbackFixture() {
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
		environment: {}
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

test('feedback endpoint stores a rating, rejects unknown ratings, last vote wins', async t => {
	const fixture = await startFeedbackFixture();
	t.after(() => fixture.close());

	const session = await fixture.services.runs.create('Feedback run');

	const bad = await fixture.request(`/api/sessions/${session.id}/feedback`, {
		method: 'POST', body: JSON.stringify({ rating: 'sideways' })
	});
	assert.equal(bad.status, 400);

	const up = await fixture.request(`/api/sessions/${session.id}/feedback`, {
		method: 'POST', body: JSON.stringify({ rating: 'up' })
	});
	assert.equal(up.status, 200);
	assert.equal(fixture.state.sessions.get(session.id).feedback.rating, 'up');

	const down = await fixture.request(`/api/sessions/${session.id}/feedback`, {
		method: 'POST', body: JSON.stringify({ rating: 'down', note: 'missed mobile' })
	});
	assert.equal(down.status, 200);
	const stored = fixture.state.sessions.get(session.id).feedback;
	assert.equal(stored.rating, 'down', 'last rating wins');
	assert.equal(stored.note, 'missed mobile');

	const missing = await fixture.request('/api/sessions/nope/feedback', {
		method: 'POST', body: JSON.stringify({ rating: 'up' })
	});
	assert.equal(missing.status, 404);
});

test('analytics summary endpoint returns aggregated counters', async t => {
	const fixture = await startFeedbackFixture();
	t.after(() => fixture.close());

	const summary = await fixture.request('/api/analytics/summary');
	assert.equal(summary.status, 200);
	const payload = await summary.json();
	assert.equal(payload.schemaVersion, 1);
	assert.ok(typeof payload.totalEvents === 'number');
});
