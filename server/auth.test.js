import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import express from 'express';
import { createAuthentication } from './auth.js';

const PASSWORD = 'correct horse battery staple';
const openFixtures = new Set();

function cookieFrom(response) {
	const header = response.headers.get('set-cookie');
	assert.ok(header, 'expected the response to set an authentication cookie');
	return { header, value: header.split(';', 1)[0] };
}

async function closeServer(server) {
	server.closeIdleConnections?.();
	server.closeAllConnections?.();
	await new Promise((resolve, reject) => {
		server.close(error => (error ? reject(error) : resolve()));
	});
}

async function createFixture(options = {}) {
	const { trustProxy = false, ...authOptions } = options;
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-auth-test-'));
	const filePath = path.join(directory, 'auth.json');
	const app = express();
	if (trustProxy) app.set('trust proxy', 1);
	app.use(express.json({ limit: '1mb' }));
	createAuthentication({ filePath, cookieSecure: false, ...authOptions }).mount(app);

	// These probes stand in for every application route registered after auth.
	app.get('/api/protected', (_request, response) => response.json({ ok: true }));
	app.post('/api/protected', (_request, response) => response.json({ ok: true }));

	const server = await new Promise((resolve, reject) => {
		const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
		candidate.once('error', reject);
	});
	const address = server.address();
	assert.ok(address && typeof address === 'object');

	const fixture = {
		directory,
		filePath,
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
		async request(pathname, options = {}) {
			const headers = new Headers(options.headers);
			if (options.cookie) headers.set('cookie', options.cookie);
			if (options.csrf) headers.set('x-qase-csrf-token', options.csrf);
			let body;
			if (Object.hasOwn(options, 'json')) {
				headers.set('content-type', 'application/json');
				body = JSON.stringify(options.json);
			}
			const response = await fetch(`${this.baseUrl}${pathname}`, {
				method: options.method ?? (body === undefined ? 'GET' : 'POST'),
				headers,
				body
			});
			const text = await response.text();
			let result;
			if (text) {
				try {
					result = JSON.parse(text);
				} catch {
					result = text;
				}
			}
			return { response, body: result };
		},
		async cleanup() {
			openFixtures.delete(fixture);
			await closeServer(server);
			const expectedPrefix = path.join(os.tmpdir(), 'qase-auth-test-');
			assert.ok(directory.startsWith(expectedPrefix), 'refusing to remove a non-test directory');
			fs.rmSync(directory, { recursive: true, force: true });
		}
	};
	openFixtures.add(fixture);
	return fixture;
}

afterEach(async () => {
	await Promise.all([...openFixtures].map(fixture => fixture.cleanup()));
});

async function setupOwner(fixture, overrides = {}) {
	return fixture.request('/api/auth/setup', {
		json: {
			email: 'Owner@Example.com',
			password: PASSWORD,
			remember: false,
			...overrides
		}
	});
}

test('an unconfigured instance exposes auth status but protects application APIs', async () => {
	const fixture = await createFixture();

	const status = await fixture.request('/api/auth/session');
	assert.equal(status.response.status, 200);
	assert.deepEqual(status.body, { authenticated: false, configured: false });
	assert.equal(fs.existsSync(fixture.filePath), false);

	const read = await fixture.request('/api/protected');
	assert.equal(read.response.status, 401);
	assert.deepEqual(read.body, { error: 'Authentication required.' });

	const mutation = await fixture.request('/api/protected', { json: { value: true } });
	assert.equal(mutation.response.status, 401);
});

test('setup stores a password hash, issues a safe session cookie, and authorizes it', async () => {
	const fixture = await createFixture();
	const setup = await setupOwner(fixture, { email: '  Owner@Example.com  ' });

	assert.equal(setup.response.status, 201);
	assert.equal(setup.body.authenticated, true);
	assert.equal(setup.body.configured, true);
	assert.deepEqual(setup.body.user, { email: 'owner@example.com' });
	assert.match(setup.body.csrfToken, /^[A-Za-z0-9_-]{40,}$/);

	const cookie = cookieFrom(setup.response);
	assert.match(cookie.header, /(?:^|; )Path=\//i);
	assert.match(cookie.header, /(?:^|; )HttpOnly(?:;|$)/i);
	assert.match(cookie.header, /(?:^|; )SameSite=Strict(?:;|$)/i);
	assert.doesNotMatch(cookie.header, /(?:^|; )Max-Age=/i);
	assert.doesNotMatch(cookie.header, /(?:^|; )Secure(?:;|$)/i);

	const persistedText = fs.readFileSync(fixture.filePath, 'utf8');
	const persisted = JSON.parse(persistedText);
	assert.equal(persisted.user.email, 'owner@example.com');
	assert.equal(persisted.user.password.algorithm, 'scrypt');
	assert.notEqual(persisted.user.password.hash, PASSWORD);
	assert.equal(persistedText.includes(PASSWORD), false);
	assert.equal(persistedText.includes(cookie.value.split('=')[1]), false, 'raw session tokens must not be persisted');

	const status = await fixture.request('/api/auth/session', { cookie: cookie.value });
	assert.equal(status.response.status, 200);
	assert.equal(status.body.authenticated, true);
	assert.deepEqual(status.body.user, { email: 'owner@example.com' });
	assert.equal(status.body.csrfToken, setup.body.csrfToken);

	const protectedRead = await fixture.request('/api/protected', { cookie: cookie.value });
	assert.equal(protectedRead.response.status, 200);
	assert.deepEqual(protectedRead.body, { ok: true });
});

test('only one concurrent owner setup can succeed', async () => {
	const fixture = await createFixture();
	const attempts = await Promise.all([
		setupOwner(fixture),
		setupOwner(fixture, { email: 'other@example.com' })
	]);

	assert.deepEqual(attempts.map(attempt => attempt.response.status).sort(), [201, 409]);
	const persisted = JSON.parse(fs.readFileSync(fixture.filePath, 'utf8'));
	assert.ok(['owner@example.com', 'other@example.com'].includes(persisted.user.email));
	assert.equal(persisted.sessions.length, 1);

	const duplicate = await setupOwner(fixture);
	assert.equal(duplicate.response.status, 409);
	assert.deepEqual(duplicate.body, { error: 'The owner account has already been created.' });
});

test('authenticated mutations require CSRF and cross-origin mutations are rejected', async () => {
	const fixture = await createFixture();
	const setup = await setupOwner(fixture);
	const cookie = cookieFrom(setup.response).value;

	const missing = await fixture.request('/api/protected', { cookie, json: { value: true } });
	assert.equal(missing.response.status, 403);
	assert.deepEqual(missing.body, { error: 'Invalid security token.' });

	const invalid = await fixture.request('/api/protected', {
		cookie,
		csrf: 'not-the-token',
		json: { value: true }
	});
	assert.equal(invalid.response.status, 403);

	const valid = await fixture.request('/api/protected', {
		cookie,
		csrf: setup.body.csrfToken,
		json: { value: true }
	});
	assert.equal(valid.response.status, 200);

	const foreignOrigin = await fixture.request('/api/protected', {
		cookie,
		csrf: setup.body.csrfToken,
		headers: { origin: 'https://attacker.example' },
		json: { value: true }
	});
	assert.equal(foreignOrigin.response.status, 403);
	assert.deepEqual(foreignOrigin.body, { error: 'Cross-origin request rejected.' });

	const fetchMetadata = await fixture.request('/api/auth/login', {
		headers: { 'sec-fetch-site': 'cross-site' },
		json: { email: 'owner@example.com', password: PASSWORD }
	});
	assert.equal(fetchMetadata.response.status, 403);
});

test('logout requires CSRF, revokes the server session, and defeats cookie replay', async () => {
	const fixture = await createFixture();
	const setup = await setupOwner(fixture);
	const cookie = cookieFrom(setup.response).value;

	const rejected = await fixture.request('/api/auth/logout', { method: 'POST', cookie });
	assert.equal(rejected.response.status, 403);
	assert.equal((await fixture.request('/api/protected', { cookie })).response.status, 200);

	const logout = await fixture.request('/api/auth/logout', {
		method: 'POST',
		cookie,
		csrf: setup.body.csrfToken
	});
	assert.equal(logout.response.status, 204);
	const cleared = logout.response.headers.get('set-cookie');
	assert.match(cleared, /qase_session=;/);
	assert.match(cleared, /Max-Age=0/i);
	assert.match(cleared, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i);

	const replay = await fixture.request('/api/protected', { cookie });
	assert.equal(replay.response.status, 401);
	const status = await fixture.request('/api/auth/session', { cookie });
	assert.deepEqual(status.body, { authenticated: false, configured: true });
});

test('login rejects bad credentials generically and supports session and remembered cookies', async () => {
	const rememberMs = 2 * 24 * 60 * 60 * 1000;
	const fixture = await createFixture({ rememberMs });
	const setup = await setupOwner(fixture);
	const initialCookie = cookieFrom(setup.response).value;
	await fixture.request('/api/auth/logout', {
		method: 'POST',
		cookie: initialCookie,
		csrf: setup.body.csrfToken
	});

	const wrongPassword = await fixture.request('/api/auth/login', {
		json: { email: 'owner@example.com', password: 'incorrect password' }
	});
	const wrongEmail = await fixture.request('/api/auth/login', {
		json: { email: 'somebody@example.com', password: PASSWORD }
	});
	assert.equal(wrongPassword.response.status, 401);
	assert.equal(wrongEmail.response.status, 401);
	assert.deepEqual(wrongPassword.body, { error: 'Email or password is incorrect.' });
	assert.deepEqual(wrongEmail.body, wrongPassword.body);

	const sessionLogin = await fixture.request('/api/auth/login', {
		json: { email: ' OWNER@example.com ', password: PASSWORD, remember: false }
	});
	assert.equal(sessionLogin.response.status, 200);
	const sessionCookie = cookieFrom(sessionLogin.response);
	assert.doesNotMatch(sessionCookie.header, /(?:^|; )Max-Age=/i);
	assert.notEqual(sessionCookie.value, initialCookie);

	await fixture.request('/api/auth/logout', {
		method: 'POST',
		cookie: sessionCookie.value,
		csrf: sessionLogin.body.csrfToken
	});
	const rememberedLogin = await fixture.request('/api/auth/login', {
		json: { email: 'owner@example.com', password: PASSWORD, remember: true }
	});
	assert.equal(rememberedLogin.response.status, 200);
	const rememberedCookie = cookieFrom(rememberedLogin.response);
	assert.match(rememberedCookie.header, /(?:^|; )Max-Age=172800(?:;|$)/i);
	assert.equal((await fixture.request('/api/protected', { cookie: rememberedCookie.value })).response.status, 200);
});

test('repeated failed logins are rate limited per address and normalized email', async () => {
	const fixture = await createFixture({ maxFailures: 2, failureWindowMs: 60_000 });
	await setupOwner(fixture);

	for (const email of ['owner@example.com', ' OWNER@EXAMPLE.COM ']) {
		const attempt = await fixture.request('/api/auth/login', {
			json: { email, password: 'wrong password' }
		});
		assert.equal(attempt.response.status, 401);
	}

	const blocked = await fixture.request('/api/auth/login', {
		json: { email: 'owner@example.com', password: PASSWORD }
	});
	assert.equal(blocked.response.status, 429);
	assert.deepEqual(blocked.body, { error: 'Too many sign-in attempts. Try again later.' });
	assert.equal(blocked.response.headers.get('retry-after'), '60');
});

test('rotating email addresses cannot bypass the address-wide login limit', async () => {
	const fixture = await createFixture({ maxFailures: 2, failureWindowMs: 60_000 });
	await setupOwner(fixture);

	for (const email of ['owner@example.com', 'different@example.com']) {
		const attempt = await fixture.request('/api/auth/login', {
			json: { email, password: 'wrong password' }
		});
		assert.equal(attempt.response.status, 401);
	}

	const blocked = await fixture.request('/api/auth/login', {
		json: { email: 'owner@example.com', password: PASSWORD }
	});
	assert.equal(blocked.response.status, 429);
});

test('remote first-owner setup requires the configured one-time setup token', async () => {
	const remote = { 'x-forwarded-for': '203.0.113.10' };
	const fixture = await createFixture({ trustProxy: true, setupToken: 'a-long-one-time-setup-token' });

	const status = await fixture.request('/api/auth/session', { headers: remote });
	assert.deepEqual(status.body, {
		authenticated: false,
		configured: false,
		setupTokenRequired: true
	});

	const rejected = await fixture.request('/api/auth/setup', {
		headers: remote,
		json: { email: 'owner@example.com', password: PASSWORD }
	});
	assert.equal(rejected.response.status, 403);

	const accepted = await fixture.request('/api/auth/setup', {
		headers: { ...remote, 'x-qase-setup-token': 'a-long-one-time-setup-token' },
		json: { email: 'owner@example.com', password: PASSWORD }
	});
	assert.equal(accepted.response.status, 201);
});

test('expired server sessions fail closed and Secure cookies can be forced', async () => {
	let clock = 1_900_000_000_000;
	const fixture = await createFixture({
		now: () => clock,
		sessionMs: 15 * 60 * 1000,
		cookieSecure: true
	});
	const setup = await setupOwner(fixture);
	const cookie = cookieFrom(setup.response);
	assert.match(cookie.header, /(?:^|; )Secure(?:;|$)/i);
	assert.equal((await fixture.request('/api/protected', { cookie: cookie.value })).response.status, 200);

	clock += 15 * 60 * 1000 + 1;
	assert.equal((await fixture.request('/api/protected', { cookie: cookie.value })).response.status, 401);
	assert.deepEqual((await fixture.request('/api/auth/session', { cookie: cookie.value })).body, {
		authenticated: false,
		configured: true
	});
});
