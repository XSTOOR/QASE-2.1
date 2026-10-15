import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createAuthThrottle, authThrottleKey } from './authThrottle.js';
import { AuthError } from './auth.js';
import { envKeyDestinationProblem, withUserConfiguration } from './config.js';

const TEST_TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

/**
 * In-memory auth service compatible with the app's auth usage. Login fails for
 * everything except the seeded credential so the throttle path is exercised.
 */
function createMemoryAuth({ maxAccountAttempts = 10 } = {}) {
	const user = {
		userId: 'auth-user-1', email: 'owner@example.com', displayName: 'Owner', role: 'owner'
	};
	const tokens = new Map();
	const throttle = createAuthThrottle();
	let consumeRef = undefined;
	return {
		async load() {},
		async register(body) {
			const email = String(body?.email ?? '').trim().toLowerCase();
			if (!email || !body?.password) throw new Error('email and password are required');
			const token = `reg-token-${email}`;
			tokens.set(token, { userId: `user-${email}`, email });
			return { token, csrf: `csrf-${token}`, user: { userId: `user-${email}`, email, role: 'developer' } };
		},
		async login(body) {
			if (body?.email === 'owner@example.com' && body?.password === 'correct horse battery staple') {
				const token = 'live-token';
				tokens.set(token, { userId: user.userId, email: user.email });
				return { token, csrf: 'live-csrf', user };
			}
			throw new AuthError('Invalid credentials.', 'invalid_credentials', 401);
		},
		async authenticate(token) {
			return tokens.get(token) && { ...user };
		},
		async listMemory() { return []; },
		async logout(token) { tokens.delete(token); },
		async consumeAuthAttempt(key, limit) {
			// createAuthThrottle() returns the consume function itself.
			return throttle(key, limit ?? maxAccountAttempts);
		},
		_throttle: throttle
	};
}

function createMemoryServices() {
	return {
		runs: {
			load: async () => [],
			create: async () => ({ id: 'run-1', messages: [] }),
			get: async id => (id === 'run-1' ? { id: 'run-1', messages: [], activities: [] } : undefined),
			list: async () => [],
			delete: async () => {}, commit: async () => ({}),
			addMessage: async () => {}, addActivity: async () => {},
			updateActivity: async () => {}, setStatus: async () => {}
		},
		events: { publish: async () => {}, subscribe: () => () => {} },
		configuration: {
			getPublic: async () => ({ provider: 'custom', ready: true, hasApiKey: true }),
			save: async () => {}, testConnection: async () => ({ ok: true })
		},
		secrets: { clear: async () => {}, names: async () => [], store: async () => {} },
		reports: { buildMarkdown: () => '# report' },
		agent: {
			ensureRuntime: async () => ({}), runTurn: async () => {},
			closeBrowser: async () => {}, getLiveState: () => ({ frame: undefined }),
			stop: async () => {}, invalidateIdleRuntimes: async () => {}
		},
		readiness: { check: () => ({ ready: true, checks: {} }) },
		// DEV added a feedback service group to the runtime contract.
		feedback: { create: async () => ({}), get: async () => undefined, list: async () => [], update: async () => ({}), remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		lifecycle: { close: () => Promise.resolve() },
		// PUSHKAR added an environments service group to the runtime contract.
		environments: { seed: async () => ({ inserted: 0 }), list: async () => ({ rows: [], total: 0 }), get: async () => null, create: async () => ({}), update: async () => ({}), facets: async () => ({ total: 0 }), availability: () => ({ ready: [] }), catalogVersion: () => '0' }
	};
}

async function startApp(options = {}) {
	const application = createApplication({
		services: { ...createMemoryServices(), auth: options.auth ?? createMemoryAuth() },
		access: createInstanceAccess({ tenantContext: TEST_TENANT }),
		authRequired: true,
		trustProxy: true,
		environment: { NODE_ENV: 'production', ...options.environment },
		...options
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const jar = new Map(); // cookie jar shared across requests in a fixture
	async function request(path, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		if (!headers.has('cookie') && jar.size) {
			headers.set('cookie', [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '));
		}
		let body = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(requestOptions.json);
		}
		const method = requestOptions.method ?? (body !== undefined ? 'POST' : 'GET');
		const init = { method, headers, body };
		for (const key of Object.keys(requestOptions)) {
			if (!(key in init)) init[key] = requestOptions[key];
		}
		return fetch(`${origin}${path}`, init);
	}
	async function close() {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
	}
	return { application, origin, request, close };
}

test('cross-site state-changing requests are rejected without the CSRF double submit', async () => {
	const fixture = await startApp();
	try {
		const login = await fixture.request('/api/auth/login', {
			json: { email: 'owner@example.com', password: 'correct horse battery staple' }
		});
		assert.equal(login.status, 200, await login.text());
		const cookies = String(login.headers.get('set-cookie') ?? '');
		const token = /qase_session=([^;]+)/i.exec(cookies)?.[1];
		assert.ok(token, 'auth cookie should be set on login');
		const rawCookie = cookies.split(/,(?=[^;]+=)/).map(c => c.split(';')[0]).join('; ');

		// Attacker page: browser sends the auth cookie automatically, but cannot
		// read the CSRF cookie (same-origin JS) nor set the header.
		const forged = await fixture.request('/api/sessions', {
			method: 'POST',
			json: { targetUrl: 'https://example.com' },
			headers: { cookie: rawCookie }
		});
		assert.equal(forged.status, 403);
		assert.match(await forged.text(), /CSRF/);

		// With the matching double-submit header the same request is accepted.
		const csrfCookie = /qase_csrf=([^;]+)/i.exec(cookies)?.[1];
		assert.ok(csrfCookie, 'csrf cookie should be set on login');
		const legitimate = await fixture.request('/api/sessions', {
			method: 'POST',
			json: { targetUrl: 'https://example.com' },
			headers: {
				cookie: rawCookie,
				'x-csrf-token': decodeURIComponent(csrfCookie)
			}
		});
		// Route returns 201 Created.
		assert.equal(legitimate.status, 201);
	} finally { await fixture.close(); }
});

test('auth cookies carry HttpOnly, SameSite=Lax and Secure in production', async () => {
	const fixture = await startApp({ environment: { NODE_ENV: 'production', QASE_X_FORWARDED_PROTO: 'https' } });
	try {
		const login = await fixture.request('/api/auth/login', {
			json: { email: 'owner@example.com', password: 'correct horse battery staple' },
			headers: { 'x-forwarded-proto': 'https' }
		});
		assert.equal(login.status, 200, await login.text());
		const setCookies = String(login.headers.get('set-cookie') ?? '');
		for (const cookie of setCookies.split(/,(?=[^;]+=)/)) {
			const name = cookie.split('=')[0].trim();
			assert.match(cookie, /SameSite=Lax/i, `${name} must be SameSite=Lax`);
			if (/qase_session/i.test(name)) {
				assert.match(cookie, /HttpOnly/i, 'the session cookie must be HttpOnly');
			} else {
				// The CSRF cookie is deliberately readable by same-origin JS:
				// the double-submit pattern needs the client to echo it back.
				assert.doesNotMatch(cookie, /HttpOnly/i, 'the CSRF cookie must stay JS-readable');
			}
		}
		const sessionCookie = setCookies.split(/,(?=[^;]+=)/).find(c => /qase_session/i.test(c)) ?? '';
		assert.match(sessionCookie, /Secure/i, 'session cookie must be Secure in production');
	} finally { await fixture.close(); }
});

test('failed logins throttle per submitted account, not per instance owner', async () => {
	const auth = createMemoryAuth();
	const fixture = await startApp({ auth });
	try {
		// Burn the full account window for one victim address.
		for (let i = 0; i < 10; i++) {
			const attempt = await fixture.request('/api/auth/login', {
				json: { email: 'victim@example.com', password: `wrong ${i}` }
			});
			assert.equal(attempt.status, 401, `attempt ${i} should be a normal auth failure`);
		}
		// Victim's account is now throttled...
		const throttled = await fixture.request('/api/auth/login', {
			json: { email: 'victim@example.com', password: 'correct horse battery staple' }
		});
		assert.equal(throttled.status, 429);

		// ...but an unrelated account still authenticates normally. Under the old
		// instance-owner key, this would have returned 429 for everyone.
		const other = await fixture.request('/api/auth/login', {
			json: { email: 'owner@example.com', password: 'correct horse battery staple' }
		});
		assert.equal(other.status, 200);
	} finally { await fixture.close(); }
});

test('production registration is closed unless the operator opts in', async () => {
	const fixture = await startApp({ environment: { NODE_ENV: 'production' } });
	try {
		const closed = await fixture.request('/api/auth/register', {
			json: { email: 'anyone@example.com', password: 'a long enough password' }
		});
		assert.equal(closed.status, 403, await closed.text());
	} finally { await fixture.close(); }

	const open = await startApp({ environment: { NODE_ENV: 'production', QASE_OPEN_REGISTRATION: 'true' } });
	try {
		const allowed = await open.request('/api/auth/register', {
			json: { email: 'anyone@example.com', password: 'a long enough password' }
		});
		assert.equal(allowed.status, 201);
	} finally { await open.close(); }
});

test('SSE event stream requires an authenticated session', async () => {
	const fixture = await startApp();
	try {
		// Unauthenticated: the stream must not hand over run events.
		const anonymous = await fixture.request('/api/sessions/run-1/events', { headers: { accept: 'text/event-stream' } });
		assert.equal(anonymous.status, 401);

		const login = await fixture.request('/api/auth/login', {
			json: { email: 'owner@example.com', password: 'correct horse battery staple' }
		});
		assert.equal(login.status, 200);
		const cookies = String(login.headers.get('set-cookie') ?? '');
		const cookieHeader = cookies.split(',').map(c => c.split(';')[0]).join('; ');
		// The stream stays open by design — abort it once headers are verified.
		const streamAbort = new AbortController();
		const authenticated = await fixture.request('/api/sessions/run-1/events', {
			headers: { accept: 'text/event-stream', cookie: cookieHeader },
			signal: streamAbort.signal
		});
		assert.equal(authenticated.status, 200, 'authenticated SSE stream should open');
		assert.match(authenticated.headers.get('content-type') ?? '', /text\/event-stream/);
		streamAbort.abort();
		try { await authenticated.arrayBuffer(); } catch { /* aborted mid-stream */ }
	} finally { await fixture.close(); }
});

test('env model key refuses non-allowlisted destinations and allows declared hosts', async () => {
	const environment = {
		QASE_API_KEY: 'env-gateway-key',
		QASE_BASE_URL: 'https://llm.example.com'
	};
	// No key of their own: the effective key is the env gateway key, so a
	// foreign host is refused (it would exfiltrate the env key in requests).
	assert.match(
		envKeyDestinationProblem({ baseUrl: 'https://attacker.example.com' }, environment) ?? '',
		/shared model key/i
	);
	// The env base host is always allowed.
	assert.equal(
		envKeyDestinationProblem({ baseUrl: 'https://llm.example.com' }, environment),
		undefined
	);
	// QASE_ALLOWED_MODEL_HOSTS widens the allowlist for the env key.
	assert.equal(
		envKeyDestinationProblem(
			{ baseUrl: 'https://peer-gateway.example.com' },
			{ ...environment, QASE_ALLOWED_MODEL_HOSTS: 'peer-gateway.example.com' }
		),
		undefined
	);
	// With no env key at stake, the user's own key may go anywhere.
	assert.equal(
		envKeyDestinationProblem(
			{ baseUrl: 'https://anywhere.example.com', apiKey: 'user-own-key' },
			{}
		),
		undefined
	);
});

test('merged configs carrying the env key cannot launder it to a foreign host', async () => {
	// Regression for the reviewer-proven bypass: getConfig() folds the env key
	// into apiKey, so a merged config always says apiKey === env key. The guard
	// must decide on the STORED layer: no stored key (or a stored copy of the
	// env key) means the env key is in use and the host must be allowlisted.
	const environment = {
		QASE_API_KEY: 'env-gateway-key',
		QASE_BASE_URL: 'https://llm.example.com'
	};
	// Simulates testConnection({baseUrl: attacker}) with nothing stored: the
	// merged config's apiKey IS the env key — must still be refused.
	await withUserConfiguration({}, async () => {}, async () => {
		assert.match(
			envKeyDestinationProblem(
				{ baseUrl: 'https://attacker.example.com', apiKey: 'env-gateway-key' },
				environment
			) ?? '',
			/shared model key/i
		);
	});
	// A stored mirror of the env key is still the env key — refused.
	await withUserConfiguration({ apiKey: 'env-gateway-key' }, async () => {}, async () => {
		assert.match(
			envKeyDestinationProblem(
				{ baseUrl: 'https://attacker.example.com', apiKey: 'env-gateway-key' },
				environment
			) ?? '',
			/shared model key/i
		);
	});
	// The user stored a genuinely different key: anywhere goes, even though the
	// merged config now carries THEIR key.
	await withUserConfiguration({ apiKey: 'user-own-key' }, async () => {}, async () => {
		assert.equal(
			envKeyDestinationProblem(
				{ baseUrl: 'https://anywhere.example.com', apiKey: 'user-own-key' },
				environment
			),
			undefined
		);
	});
});

test('a mismatched CSRF header is rejected alongside an absent one', async () => {
	const fixture = await startApp();
	try {
		const login = await fixture.request('/api/auth/login', {
			json: { email: 'owner@example.com', password: 'correct horse battery staple' }
		});
		assert.equal(login.status, 200, await login.text());
		const cookies = String(login.headers.get('set-cookie') ?? '');
		const rawCookie = cookies.split(/,(?=[^;]+=)/).map(c => c.split(';')[0]).join('; ');
		const mismatched = await fixture.request('/api/sessions', {
			method: 'POST',
			json: { targetUrl: 'https://example.com' },
			headers: { cookie: rawCookie, 'x-csrf-token': 'attacker-guess' }
		});
		assert.equal(mismatched.status, 403);
	} finally { await fixture.close(); }
});

test('auth throttle keys isolate accounts even when normalized emails differ by case or padding', () => {
	const consume = createAuthThrottle({ now: () => 0 });
	const a = authThrottleKey('account:victim@example.com');
	const b = authThrottleKey('account:VICTIM@Example.com   '.trim().toLowerCase());
	const c = authThrottleKey('account:other@example.com');
	assert.equal(a, b, 'case/padding normalization must converge on one key');
	assert.notEqual(a, c, 'different accounts must use different throttle keys');
});
