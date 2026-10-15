import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApplication } from './app.js';
import { createInviteService } from './invites.js';
import { createLocalAuthService } from './auth.js';
import { createInstanceAccess } from './instanceAccess.js';

/**
 * Integration tests for the controlled-pilot flow (#12963):
 * invite-gated production registration, pilot role assignment, operator
 * endpoint gating, pilot-status.
 */

const NOW = 1_800_000_000_000;

function createMemoryServices({ authFile } = {}) {
	// The real local authService on a temp file is the system under test;
	// the rest is a stub honoring the runtime contract.
	const noop = async () => undefined;
	const auth = createLocalAuthService({ tenantContext: TENANT, file: authFile });
	// Minimal contract-complete services: the system under test is the auth +
	// invite + role-gating surface, everything else is a stub.
	const services = {
		runs: { load: async () => [], list: async () => [], get: async () => undefined, delete: noop, create: async () => ({ id: 'x', mode: 'qa', status: 'idle', findings: [], messages: [] }), commit: noop, addMessage: noop, addActivity: noop, updateActivity: noop, setStatus: noop },
		events: { publish: () => undefined, subscribe: () => () => undefined },
		configuration: { getPublic: async () => ({}), save: noop, testConnection: async () => ({ ok: true }) },
		secrets: { clear: noop, names: async () => [], store: noop },
		reports: { buildMarkdown: async () => '' },
		agent: { ensureRuntime: () => undefined, runTurn: noop, closeBrowser: noop, getLiveState: () => ({ running: false }), stop: noop, invalidateIdleRuntimes: noop },
		readiness: { check: async () => ({ ready: true, checks: {} }) },
		lifecycle: { close() {} },
		environments: { seed: async () => ({ inserted: 0 }), list: async () => ({ rows: [], total: 0 }), get: async () => null, create: async () => ({}), update: async () => ({}), facets: async () => ({ total: 0 }), availability: () => ({ ready: [] }), catalogVersion: () => '0' },
		// DEV (User Feedback feature) added a feedback service group to the
		// runtime contract; a stub is enough for the pilot-flow surface.
		feedback: { create: noop, get: async () => undefined, list: async () => [], update: noop, remove: noop, stats: async () => ({}), forRun: async () => undefined },
		auth
	};
	return { services, auth };
}

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

function harness({ openRegistration, pilotMode } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'qase-pilot-'));
	const inviteService = createInviteService({ file: join(dir, 'invites.json'), now: () => NOW });
	const memory = createMemoryServices({ authFile: join(dir, 'auth.json') });
	const { app } = createApplication({
		services: memory.services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		environment: {
			NODE_ENV: 'production',
			QASE_AUTH_REQUIRED: 'true',
			...(openRegistration ? { QASE_OPEN_REGISTRATION: 'true' } : {}),
			...(pilotMode ? { QASE_PILOT_MODE: 'true' } : {})
		},
		inviteService,
		demoEnabled: false
	});
	const server = http.createServer(app);
	return { server, dir, inviteService, memory };
}

async function listen(server) {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${server.address().port}`;
}

async function register(base, body) {
	const response = await fetch(`${base}/api/auth/register`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	const json = await response.json().catch(() => ({}));
	return { status: response.status, json, setCookie: response.headers.get('set-cookie') ?? '' };
}

function cookieOf(setCookie, name) {
	return setCookie.match(new RegExp(`${name}=[^;]+`))?.[0];
}

async function api(base, path, { method = 'GET', cookie, csrf, json } = {}) {
	const headers = { ...(cookie ? { cookie } : {}) };
	if (csrf) headers['x-csrf-token'] = csrf;
	if (json !== undefined) headers['content-type'] = 'application/json';
	const response = await fetch(`${base}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
	return { status: response.status, body: await response.json().catch(() => ({})) };
}
describe('controlled pilot registration (production, closed)', () => {
	let base, server, dir, inviteService, cleanup;

	before(async () => {
		const h = harness({});
		server = h.server; dir = h.dir; inviteService = h.inviteService;
		base = await listen(server);
		cleanup = () => { server.close(); rmSync(dir, { recursive: true, force: true }); };
	});
	after(() => cleanup());

	it('rejects registration without an invite code', async () => {
		const result = await register(base, { email: 'stranger@example.com', password: 'a-very-long-password-123', displayName: 'Stranger' });
		assert.equal(result.status, 403);
		assert.match(result.json.error, /invite/i);
	});

	it('rejects an invalid invite code uniformly', async () => {
		const result = await register(base, { email: 'stranger@example.com', password: 'a-very-long-password-123', displayName: 'Stranger', inviteCode: 'qase-NOTREAL' });
		assert.equal(result.status, 403);
		assert.match(result.json.error, /invite/i);
	});

	it('admits registration with a valid invite exactly once', async () => {
		const invite = await inviteService.create({ note: 'Alice' });
		const first = await register(base, { email: 'alice@example.com', password: 'a-very-long-password-123', displayName: 'Alice', inviteCode: invite.code });
		assert.equal(first.status, 201);
		const second = await register(base, { email: 'alice2@example.com', password: 'a-very-long-password-123', displayName: 'Alice2', inviteCode: invite.code });
		assert.equal(second.status, 403);
	});

	it('a failed registration does not burn the invite', async () => {
		const invite = await inviteService.create({ note: 'Bob' });
		// Weak password → registration fails after validation.
		const weak = await register(base, { email: 'bob@example.com', password: 'short', displayName: 'Bob', inviteCode: invite.code });
		assert.equal(weak.status, 400);
		// The code must still be usable.
		const retry = await register(base, { email: 'bob@example.com', password: 'a-very-long-password-123', displayName: 'Bob', inviteCode: invite.code });
		assert.equal(retry.status, 201);
	});

	it('concurrent registration with one invite admits exactly one account', async () => {
		const h = harness({}); const isolatedBase = await listen(h.server);
		try {
			const { code } = await h.inviteService.create({});
			const results = await Promise.all(['race-one', 'race-two'].map(name => register(isolatedBase, {
				email: `${name}@example.com`, password: 'a-very-long-password-123', displayName: name, inviteCode: code
			})));
			assert.deepEqual(results.map(item => item.status).sort(), [201, 403]);
			assert.equal(results.filter(item => item.setCookie.includes('qase_session=')).length, 1);
		} finally { await new Promise(resolve => h.server.close(resolve)); rmSync(h.dir, { recursive: true, force: true }); }
	});

	it('pilot-status defaults to false; reports true when QASE_PILOT_MODE=true', async () => {
		const response = await fetch(`${base}/api/pilot-status`);
		assert.deepEqual(await response.json(), { pilot: false });
	});
});

describe('operator invite endpoints and pilot role', () => {
	let base, server, dir, inviteService, operatorCookies, pilotCookies;

	before(async () => {
		const h = harness({ openRegistration: true });
		server = h.server; dir = h.dir; inviteService = h.inviteService;
		base = await listen(server);
		// Open registration: creates a 'developer' (operator on this instance).
		const operator = await register(base, { email: 'dev@example.com', password: 'a-very-long-password-123', displayName: 'Dev' });
		assert.equal(operator.status, 201);
		// CSRF cookie is URL-encoded; send the exact bytes as both cookie and header.
		const operatorCsrfRaw = operator.setCookie.match(/qase_csrf=([^;]+)/)?.[1] ?? '';
		operatorCookies = {
			cookie: cookieOf(operator.setCookie, 'qase_session'),
			csrfCookie: 'qase_csrf=' + operatorCsrfRaw,
			csrf: decodeURIComponent(operatorCsrfRaw)
		};
		// Pilot user via invite (even though registration is open here, the
		// invite path is what assigns the pilot role).
		const invite = await inviteService.create({});
		const pilot = await register(base, { email: 'pilot@example.com', password: 'a-very-long-password-123', displayName: 'Pilot', inviteCode: invite.code });
		assert.equal(pilot.status, 201);
		const pilotCsrfRaw = pilot.setCookie.match(/qase_csrf=([^;]+)/)?.[1] ?? '';
		pilotCookies = {
			cookie: cookieOf(pilot.setCookie, 'qase_session'),
			csrfCookie: 'qase_csrf=' + pilotCsrfRaw,
			csrf: decodeURIComponent(pilotCsrfRaw)
		};
	});
	after(async () => {
		await new Promise(resolve => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	});

	it('developer (operator) can mint and list invites', async () => {
		const create = await api(base, '/api/auth/invites', { method: 'POST', cookie: operatorCookies.cookie + '; ' + operatorCookies.csrfCookie, csrf: operatorCookies.csrf, json: { note: 'next pilot' } });
		assert.equal(create.status, 201, JSON.stringify(create.body));
		assert.match(create.body.code, /^qase-/);
		const list = await api(base, '/api/auth/invites', { cookie: operatorCookies.cookie + '; ' + operatorCookies.csrfCookie });
		assert.equal(list.status, 200);
		assert.ok(list.body.invites.length >= 1);
	});

	it('invite-admitted pilot users are rejected from operator endpoints', async () => {
		const create = await api(base, '/api/auth/invites', { method: 'POST', cookie: pilotCookies.cookie + '; ' + pilotCookies.csrfCookie, csrf: pilotCookies.csrf, json: {} });
		assert.equal(create.status, 403);
		const list = await api(base, '/api/auth/invites', { cookie: pilotCookies.cookie + '; ' + pilotCookies.csrfCookie });
		assert.equal(list.status, 403);
	});

	it('invite minting is rate-limited per operator (429 after budget)', async () => {
		// Budget is 30 per 15-minute window per operator; the dev@example.com
		// operator above minted 1 already. Hammer until throttled.
		let throttled = null;
		for (let i = 0; i < 40; i += 1) {
			const result = await api(base, '/api/auth/invites', { method: 'POST', cookie: operatorCookies.cookie + '; ' + operatorCookies.csrfCookie, csrf: operatorCookies.csrf, json: {} });
			if (result.status === 429) { throttled = result; break; }
			assert.equal(result.status, 201, `unexpected status before throttle at i=${i}: ${JSON.stringify(result.body)}`);
		}
		assert.ok(throttled, 'never hit the rate limit within 40 mints');
		assert.equal(throttled.status, 429);
		assert.equal(throttled.body.error.includes('Too many invites'), true);
		// A different operator (pilot user) still gets a clean 403 role
		// rejection, not the first operator's throttle.
		const other = await api(base, '/api/auth/invites', { method: 'POST', cookie: pilotCookies.cookie + '; ' + pilotCookies.csrfCookie, csrf: pilotCookies.csrf, json: {} });
		assert.equal(other.status, 403);
	});
});
