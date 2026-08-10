import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createDrytisAuthentication } from './drytisAuth.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852', organizationSlug: 'drytis',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55', projectSlug: 'qase'
});
const CLAIMS = Object.freeze({
	issuer: 'https://identity.drytis.example', subject: 'user-42', jti: 'launch-42',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606', email: 'engineer@drytis.example',
	displayName: 'Drytis Engineer', role: 'developer', ...TENANT,
	organizationName: 'Drytis', projectName: 'Qase', expiresAt: 1_900_000_000
});

async function fixture(claims = CLAIMS) {
	const sessions = new Map();
	const calls = { exchanges: 0, revokes: 0 };
	const repository = {
		async exchange(identity, session) {
			calls.exchanges++;
			const record = { ...identity, sessionId: session.id, expiresAt: session.expiresAt };
			sessions.set(session.tokenHash, record);
		},
		async resolve(reference) { return sessions.get(reference.tokenHash); },
		async revoke(reference) { calls.revokes++; return sessions.delete(reference.tokenHash); }
	};
	const authentication = createDrytisAuthentication({
		repository, tenantContext: TENANT, verifier: { verify: async () => claims },
		loginUrl: 'https://studio.drytis.example/qase/launch', cookieSecure: false,
		publicUrl: 'https://qase.drytis.example',
		randomToken: () => 'A'.repeat(43), now: () => 1_800_000_000_000
	});
	const app = express();
	authentication.mount(app);
	app.post('/api/probe', (_request, response) => response.json({ ok: true }));
	const server = await new Promise(resolve => {
		const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
	});
	const base = `http://127.0.0.1:${server.address().port}`;
	return { authentication, calls, base, close: () => new Promise(resolve => server.close(resolve)) };
}

function cookieFrom(response) { return response.headers.get('set-cookie').split(';')[0]; }

async function start(target) {
	const response = await fetch(`${target.base}/auth/drytis/start`, { redirect: 'manual' });
	const cookie = cookieFrom(response);
	const destination = new URL(response.headers.get('location'));
	return { cookie, state: destination.searchParams.get('state'), destination };
}

test('exchanges a signed Drytis launch once, issues a shared session, and enforces CSRF', async t => {
	const target = await fixture();
	t.after(target.close);
	const launch = await start(target);
	assert.equal(launch.destination.origin, 'https://studio.drytis.example');
	assert.equal(launch.destination.searchParams.get('return_to'), 'https://qase.drytis.example/auth/drytis/exchange');
	const exchange = await fetch(`${target.base}/auth/drytis/exchange`, {
		method: 'POST', redirect: 'manual', headers: {
			'content-type': 'application/x-www-form-urlencoded', cookie: launch.cookie
		},
		body: new URLSearchParams({ launch_token: 'signed.jwt.value', state: launch.state })
	});
	assert.equal(exchange.status, 303);
	assert.equal(exchange.headers.get('location'), '/');
	const cookie = cookieFrom(exchange);
	assert.equal(target.calls.exchanges, 1);

	const sessionResponse = await fetch(`${target.base}/api/auth/session`, { headers: { cookie } });
	const session = await sessionResponse.json();
	assert.equal(session.authenticated, true);
	assert.equal(session.provider, 'drytis');
	assert.equal(session.user.email, CLAIMS.email);

	assert.equal((await fetch(`${target.base}/api/probe`, { method: 'POST', headers: { cookie } })).status, 403);
	assert.equal((await fetch(`${target.base}/api/probe`, {
		method: 'POST', headers: { cookie, 'x-qase-csrf-token': session.csrfToken }
	})).status, 200);
	assert.equal(await target.authentication.isSessionActive({
		organizationId: TENANT.organizationId, projectId: TENANT.projectId,
		tokenHash: 'a3'.repeat(32)
	}), false);
});

test('rejects even signed tokens for another configured Qase cell', async t => {
	const target = await fixture({ ...CLAIMS, projectId: '079418f5-25d9-4b75-9223-706f5b65db6a' });
	t.after(target.close);
	const launch = await start(target);
	const response = await fetch(`${target.base}/auth/drytis/exchange`, {
		method: 'POST', redirect: 'manual', headers: {
			'content-type': 'application/x-www-form-urlencoded', cookie: launch.cookie
		},
		body: new URLSearchParams({ launch_token: 'signed.jwt.value', state: launch.state })
	});
	assert.equal(response.status, 401);
	assert.equal(target.calls.exchanges, 0);
});

test('unauthenticated session discovery exposes only the configured Drytis login URL', async t => {
	const target = await fixture();
	t.after(target.close);
	const response = await fetch(`${target.base}/api/auth/session`);
	assert.deepEqual(await response.json(), {
		authenticated: false, configured: true, provider: 'drytis',
		loginUrl: '/auth/drytis/start'
	});
});

test('Drytis viewers are read-only and developers cannot change cell configuration', async t => {
	for (const role of ['viewer', 'developer']) {
		const target = await fixture({ ...CLAIMS, role, jti: `launch-${role}` });
		t.after(target.close);
		const launch = await start(target);
		const exchange = await fetch(`${target.base}/auth/drytis/exchange`, {
			method: 'POST', redirect: 'manual', headers: {
				'content-type': 'application/x-www-form-urlencoded', cookie: launch.cookie
			}, body: new URLSearchParams({ launch_token: 'signed.jwt.value', state: launch.state })
		});
		const cookie = cookieFrom(exchange);
		const session = await (await fetch(`${target.base}/api/auth/session`, { headers: { cookie } })).json();
		const probe = await fetch(`${target.base}/api/probe`, {
			method: 'POST', headers: { cookie, 'x-qase-csrf-token': session.csrfToken }
		});
		assert.equal(probe.status, role === 'viewer' ? 403 : 200);
		if (role === 'developer') {
			const config = await fetch(`${target.base}/api/config`, {
				method: 'PUT', headers: { cookie, 'x-qase-csrf-token': session.csrfToken }
			});
			assert.equal(config.status, 403);
		}
	}
});
