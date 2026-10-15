import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

// Isolated CWD so the local feedback store never touches real instance data.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'qase-feedback-api-')));

const { createApplication } = await import('../server/app.js');
const { createLocalApplicationServices } = await import('../server/localServices.js');
const { createInstanceAccess } = await import('../server/instanceAccess.js');

const TENANT = {
	organizationId: randomUUID(),
	projectId: randomUUID(),
	actorUserId: randomUUID(),
	actorEmail: 'owner@test.dev',
	actorName: 'Owner'
};

/**
 * In-memory auth service: one token per role. Mutating requests must also
 * carry the double-submit CSRF pair, mirroring production.
 */
function createFakeAuthService() {
	const tokens = new Map();
	return {
		authenticate: async token => tokens.get(token) ?? null,
		issue(role) {
			const token = `tok-${role}-${randomUUID()}`;
			tokens.set(token, { userId: TENANT.actorUserId, role, email: TENANT.actorEmail });
			return token;
		},
		listMemory: async () => [],
		check: async () => ({ ready: true })
	};
}

async function startServer({ auth, role } = {}) {
	const services = createLocalApplicationServices({ tenantContext: TENANT, auth });
	await services.runs.load();
	// The merged contract requires the environments service group even for
	// feedback-only fixtures; a minimal in-memory stub satisfies the routes
	// this suite never exercises.
	services.environments = {
		seed: async () => undefined,
		list: async () => ({ rows: [], total: 0 }),
		get: async () => null,
		create: async () => ({}),
		update: async () => ({}),
		facets: async () => ({ total: 0 }),
		availability: () => ({ ready: [] }),
		catalogVersion: () => '0'
	};
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		authRequired: Boolean(auth)
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const headers = {};
	if (auth) {
		const token = auth.issue(role ?? 'owner');
		headers.cookie = `qase_session=${token}; qase_csrf=test-csrf`;
		headers['x-csrf-token'] = 'test-csrf';
	}
	const call = (path, init = {}) => fetch(`${origin}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', ...(init.headers ?? {}), ...headers }
	});
	return { origin, call, close: () => new Promise(resolve => server.close(resolve)), services };
}

async function finishedRun(services, status = 'done') {
	const session = await services.runs.create('Feedback target', {
		ownerUserId: TENANT.actorUserId,
		eventType: 'run.created'
	});
	session.targetUrl = 'https://feedback-target.example/';
	await services.runs.setStatus(session, 'running');
	await new Promise(resolve => setTimeout(resolve, 30));
	await services.runs.setStatus(session, status);
	return session;
}

const VALID = { rating: 5, category: 'overall', comments: 'Excellent run.' };

test('POST /api/feedback submits against a finished run and returns the record', async () => {
	const fixture = await startServer({ auth: createFakeAuthService() });
	try {
		const session = await finishedRun(fixture.services);
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		});
		assert.equal(response.status, 201);
		const record = await response.json();
		assert.equal(record.runId, session.id);
		assert.equal(record.targetUrl, 'https://feedback-target.example/');
		assert.equal(record.runStatus, 'done');
		assert.ok(Number.isFinite(record.durationSeconds));
		assert.equal(record.status, 'new');
		// Run context came from the server, not the request body.
		assert.equal(record.submittedBy, TENANT.actorUserId);
	} finally {
		await fixture.close();
	}
});

test('POST /api/feedback rejects a run that is not finished', async () => {
	const fixture = await startServer();
	try {
		const session = await fixture.services.runs.create('Live run', { ownerUserId: TENANT.actorUserId });
		await fixture.services.runs.setStatus(session, 'running');
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		});
		assert.equal(response.status, 409);
	} finally {
		await fixture.close();
	}
});

test('POST /api/feedback accepts feedback for a FAILED run too', async () => {
	const fixture = await startServer();
	try {
		const session = await finishedRun(fixture.services, 'error');
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, rating: 2, category: 'error_handling', comments: 'Unclear failures.' })
		});
		assert.equal(response.status, 201);
		assert.equal((await response.json()).runStatus, 'error');
	} finally {
		await fixture.close();
	}
});

test('duplicate feedback is rejected with the existing record id', async () => {
	const fixture = await startServer();
	try {
		const session = await finishedRun(fixture.services);
		const first = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		});
		assert.equal(first.status, 201);
		const second = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, rating: 1, category: 'other', comments: 'second try' })
		});
		assert.equal(second.status, 409);
		const payload = await second.json();
		assert.equal(payload.existingId, (await first.json()).id);
	} finally {
		await fixture.close();
	}
});

test('invalid payloads return field errors without echoing content', async () => {
	const fixture = await startServer();
	try {
		const session = await finishedRun(fixture.services);
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, rating: 9, category: 'nope', comments: '' })
		});
		assert.equal(response.status, 400);
		const payload = await response.json();
		assert.ok(payload.fields.rating);
		assert.ok(payload.fields.category);
		// Comments are optional now — no comments field error.
		assert.equal(payload.fields.comments, undefined);
		assert.equal(JSON.stringify(payload).includes('Excellent'), false);
	} finally {
		await fixture.close();
	}
});

test('GET /api/sessions/:id/feedback returns the submitter record (or null)', async () => {
	const fixture = await startServer();
	try {
		const session = await finishedRun(fixture.services);
		const before = await (await fixture.call(`/api/sessions/${session.id}/feedback`)).json();
		assert.equal(before, null);
		await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		});
		const after = await (await fixture.call(`/api/sessions/${session.id}/feedback`)).json();
		assert.equal(after.runId, session.id);
	} finally {
		await fixture.close();
	}
});

test('feedback admin endpoints require owner/admin role', async () => {
	const fixture = await startServer({ auth: createFakeAuthService(), role: 'developer' });
	try {
		const session = await finishedRun(fixture.services);
		// A record owned by a DIFFERENT user: a developer may neither read it
		// as an admin nor edit someone else's feedback.
		const created = await fixture.services.feedback.create({
			runId: session.id, submittedBy: 'someone-else', context: {},
			rating: 3, category: 'overall', comments: 'not yours'
		});
		for (const [method, url, init] of [
			['GET', '/api/feedback', {}],
			['GET', '/api/feedback/stats', {}],
			['PUT', `/api/feedback/${created.id}`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ rating: 1 })
			}],
			['DELETE', `/api/feedback/${created.id}`, { method: 'DELETE' }]
		]) {
			const response = await fixture.call(url, { ...init, method });
			assert.equal(response.status, 403, `${method} ${url}`);
		}
	} finally {
		await fixture.close();
	}
});

test('submitter can edit their OWN feedback but not the review status', async () => {
	const fixture = await startServer({ auth: createFakeAuthService(), role: 'developer' });
	try {
		const session = await finishedRun(fixture.services);
		const created = await fixture.services.feedback.create({
			runId: session.id, submittedBy: TENANT.actorUserId, context: {},
			rating: 4, category: 'overall', comments: 'first take'
		});
		const edited = await fixture.call(`/api/feedback/${created.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ rating: 2, comments: 'changed my mind' })
		});
		assert.equal(edited.status, 200);
		const record = await edited.json();
		assert.equal(record.rating, 2);
		assert.equal(record.comments, 'changed my mind');
		// Review status is admin-only.
		const statusChange = await fixture.call(`/api/feedback/${created.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'resolved' })
		});
		assert.equal(statusChange.status, 403);
		// Editing content never created a duplicate.
		const own = await (await fixture.call(`/api/sessions/${session.id}/feedback`)).json();
		assert.equal(own.id, created.id);
	} finally {
		await fixture.close();
	}
});

test('rating-only submission succeeds with optional fields blank', async () => {
	const fixture = await startServer({ auth: createFakeAuthService() });
	try {
		const session = await finishedRun(fixture.services);
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, rating: 5 })
		});
		assert.equal(response.status, 201);
		const record = await response.json();
		assert.equal(record.category, 'overall');
		assert.equal(record.comments, '');
	} finally {
		await fixture.close();
	}
});

test('GET /feedback/mine returns only the submitter records for the listed runs', async () => {
	const fixture = await startServer({ auth: createFakeAuthService() });
	try {
		const sessionA = await finishedRun(fixture.services);
		const sessionB = await finishedRun(fixture.services);
		const sessionC = await finishedRun(fixture.services);
		await fixture.services.feedback.create({
			runId: sessionA.id, submittedBy: TENANT.actorUserId, context: {},
			rating: 5, category: 'overall', comments: 'mine A'
		});
		await fixture.services.feedback.create({
			runId: sessionC.id, submittedBy: 'other-user', context: {},
			rating: 1, category: 'other', comments: 'not mine'
		});
		const response = await fixture.call(`/api/feedback/mine?runs=${sessionA.id},${sessionB.id},${sessionC.id}`);
		assert.equal(response.status, 200);
		const records = await response.json();
		assert.equal(records.length, 1);
		assert.equal(records[0].runId, sessionA.id);
		assert.equal(records[0].rating, 5);
	} finally {
		await fixture.close();
	}
});

test('admins can list, read with run trace, update status, and delete', async () => {
	const fixture = await startServer({ role: 'owner' });
	try {
		const session = await finishedRun(fixture.services);
		const created = await (await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		})).json();

		const listed = await (await fixture.call('/api/feedback')).json();
		assert.ok(listed.some(row => row.id === created.id));

		const stats = await (await fixture.call('/api/feedback/stats')).json();
		assert.ok(stats.total >= 1);
		assert.ok(stats.averageRating >= 1 && stats.averageRating <= 5);

		const detail = await (await fixture.call(`/api/feedback/${created.id}`)).json();
		assert.equal(detail.run.id, session.id);
		assert.equal(detail.run.targetUrl, 'https://feedback-target.example/');

		const updated = await (await fixture.call(`/api/feedback/${created.id}`, {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ status: 'reviewed' })
		})).json();
		assert.equal(updated.status, 'reviewed');

		const removed = await fixture.call(`/api/feedback/${created.id}`, { method: 'DELETE' });
		assert.equal(removed.status, 204);
		const gone = await fixture.call(`/api/feedback/${created.id}`);
		assert.equal(gone.status, 404);
	} finally {
		await fixture.close();
	}
});

test('feedback filters apply: rating, category and search', async () => {
	const fixture = await startServer({ role: 'owner' });
	try {
		const session = await finishedRun(fixture.services);
		await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, rating: 4, category: 'ui_ux', comments: 'searchable-zeta-token' })
		});
		const byRating = await (await fixture.call('/api/feedback?rating=4')).json();
		assert.ok(byRating.length >= 1);
		const bySearch = await (await fixture.call('/api/feedback?q=searchable-zeta-token')).json();
		assert.equal(bySearch.length, 1);
		const byNothing = await (await fixture.call('/api/feedback?q=does-not-exist-anywhere')).json();
		assert.equal(byNothing.length, 0);
	} finally {
		await fixture.close();
	}
});

test('unknown run yields 404 and the run record is untouched by feedback', async () => {
	const fixture = await startServer();
	try {
		const response = await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: randomUUID(), ...VALID })
		});
		assert.equal(response.status, 404);

		const session = await finishedRun(fixture.services);
		await fixture.call('/api/feedback', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId: session.id, ...VALID })
		});
		const after = await fixture.services.runs.get(session.id);
		assert.equal(after.status, 'done');
		assert.equal(after.findings.length, 0);
		assert.equal(Object.keys(after).includes('feedback'), false, 'feedback never enters the run record');
	} finally {
		await fixture.close();
	}
});
