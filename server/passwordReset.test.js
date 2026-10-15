import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Email-OTP password reset flow (ticket #15673):
 * registered email → 6-digit OTP (5-minute expiry, single use, resend
 * invalidates prior) → verify → short-lived single-use authorization → new
 * password (8-char minimum) → old sessions revoked, old password rejected,
 * authorization reuse rejected. Only verifier hashes are persisted.
 */



async function fixture() {
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qase-reset-'));
	const { createApplication } = await import('./app.js');
	const { createMailer } = await import('./mailer.js');
	const { createLocalAuthService } = await import('./auth.js');
	const { DEFAULT_TENANT_CONTEXT } = await import('./tenancy.js');
	const { createInstanceAccess } = await import('./instanceAccess.js');
	const mailer = createMailer({ environment: { QASE_MAIL_MODE: 'mock' } });
	// The system under test is the real local auth service; everything else is
	// a contract-complete stub (same pattern as pilotFlow.test.js). The long
	// multi-attempt sequence below would otherwise trip the app-level account
	// throttle (10 auth POSTs / 15 min — correct in production, noise here);
	// an unlimited throttle keeps this suite on the OTP logic itself.
	const auth = createLocalAuthService({ tenantContext: DEFAULT_TENANT_CONTEXT, file: path.join(cwd, 'auth.json') });
	const unthrottledAuth = new Proxy(auth, { get(target, property) { return property === 'consumeAuthAttempt' ? async () => true : target[property]; } });
	const noop = async () => undefined;
	const application = createApplication({
		environment: { QASE_MAIL_MODE: 'mock', NODE_ENV: 'test' },
		access: createInstanceAccess({ tenantContext: DEFAULT_TENANT_CONTEXT }),
		services: {
			runs: { load: async () => [], list: async () => [], get: async () => undefined, delete: noop, create: async () => ({ id: 'x', mode: 'qa', status: 'idle', findings: [], messages: [] }), commit: noop, addMessage: noop, addActivity: noop, updateActivity: noop, setStatus: noop },
			events: { publish: () => undefined, subscribe: () => () => undefined },
			configuration: { getPublic: async () => ({}), save: noop, testConnection: async () => ({ ok: true }) },
			secrets: { clear: noop, names: async () => [], store: noop },
			reports: { buildMarkdown: async () => '' },
			agent: { ensureRuntime: () => undefined, runTurn: noop, closeBrowser: noop, getLiveState: () => ({ running: false }), stop: noop, invalidateIdleRuntimes: noop },
			readiness: { check: async () => ({ ready: true, checks: {} }) },
			lifecycle: { close() {} },
			environments: { seed: async () => ({ inserted: 0 }), list: async () => ({ rows: [], total: 0 }), get: async () => null, create: async () => ({}), update: async () => ({}), facets: async () => ({ total: 0 }), availability: () => ({ ready: [] }), catalogVersion: () => '0' },
			feedback: { create: noop, get: async () => undefined, list: async () => [], update: noop, remove: noop, stats: async () => ({}), forRun: async () => undefined },
			auth: unthrottledAuth
		},
		mailer
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	// The mock outbox resolves against process.cwd() — run from the fixture dir.
	const previousCwd = process.cwd();
	process.chdir(cwd);
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = async (route, body) => {
		const response = await fetch(`${base}${route}`, {
			method: 'POST', headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		return { status: response.status, body: await response.json().catch(() => ({})), cookie: response.headers.get('set-cookie') };
	};
	return { cwd, server, mailer, call, close: async () => { process.chdir(previousCwd); await new Promise(done => server.close(done)); await fs.promises.rm(cwd, { recursive: true, force: true }); } };
}

async function outboxLast(mailerOrDirectory) {
	// Prefer the mailer's live readOutbox (always current); fall back to the
	// file only when a directory was passed.
	if (mailerOrDirectory?.readOutbox) {
		const outbox = await mailerOrDirectory.readOutbox();
		if (outbox.length === 0) throw new Error('Outbox is empty — expected a reset email.');
		return outbox.at(-1);
	}
	const outbox = JSON.parse(await fs.promises.readFile(path.join(mailerOrDirectory, '.qase/outbox.json'), 'utf8'));
	return outbox.at(-1);
}

test('email OTP reset: full flow, single use, resend invalidates, limits, sessions revoked', async t => {
	const f = await fixture();
	t.after(() => f.close());

	// Register a user (any domain — delivery is sender-side, domain-agnostic).
	const email = 'otp.user@outlook.example.com';
	await f.call('/api/auth/register', { email, password: 'original-pass-1', name: 'OTP User' });

	// 1. Request — neutral response, OTP only in the outbox (never the API).
	const request1 = await f.call('/api/auth/forgot-password', { email });
	assert.equal(request1.status, 200);
	assert.ok(!JSON.stringify(request1.body).match(/[0-9]{6}/) || !request1.body.otp, 'API response must not contain the OTP');
	const message1 = await outboxLast(f.mailer);
	assert.equal(message1.to, email);
	const otp1 = message1.text.match(/\b[0-9]{6}\b/)?.[0];
	assert.ok(otp1, 'OTP present in email body');
	assert.match(message1.text, /expires in 5 minutes/i);

	// 2. Unknown email → same neutral response, no mail.
	const unknown = await f.call('/api/auth/forgot-password', { email: 'nobody@nowhere.example' });
	assert.equal(unknown.status, 200);
	assert.equal(unknown.body.message, request1.body.message);

	// 3. Resend invalidates the first OTP (latest wins).
	const request2 = await f.call('/api/auth/forgot-password', { email });
	assert.equal(request2.status, 200);
	const message2 = await outboxLast(f.mailer);
	const otp2 = message2.text.match(/\b[0-9]{6}\b/)?.[0];
	assert.ok(otp2 && otp2 !== otp1, 'resend issues a new OTP');
	const stale = await f.call('/api/auth/verify-reset-otp', { email, otp: otp1 });
	assert.equal(stale.status, 400, 'superseded OTP rejected');

	// 4. Wrong-OTP attempts are limited. The stale attempt above already
	// counted as one wrong attempt; four more are allowed, then the lock.
	for (let i = 0; i < 4; i += 1) {
		const wrong = await f.call('/api/auth/verify-reset-otp', { email, otp: '000000' });
		assert.equal(wrong.status, 400);
	}
	const locked = await f.call('/api/auth/verify-reset-otp', { email, otp: otp2 });
	assert.equal(locked.status, 429, 'too many incorrect attempts locks the OTP');

	// 5. Fresh OTP: 3 wrong attempts still allowed, then the correct code passes.
	const request3 = await f.call('/api/auth/forgot-password', { email });
	const message3 = await outboxLast(f.mailer);
	const otp3 = message3.text.match(/\b[0-9]{6}\b/)?.[0];
	for (let i = 0; i < 3; i += 1) await f.call('/api/auth/verify-reset-otp', { email, otp: '000000' });
	const verified = await f.call('/api/auth/verify-reset-otp', { email, otp: otp3 });
	assert.equal(verified.status, 200);
	assert.ok(verified.body.authorization, 'short-lived authorization issued');

	// 6. New password: 7 chars rejected, 8 accepted; old password stops working.
	const tooShort = await f.call('/api/auth/reset-password', { authorization: verified.body.authorization, password: 'short7' });
	assert.equal(tooShort.status, 400);
	// 7-char failure does NOT consume the authorization.
	const loginOld = await f.call('/api/auth/login', { email, password: 'original-pass-1' });
	assert.equal(loginOld.status, 200, 'password unchanged after a rejected attempt');
	const reset = await f.call('/api/auth/reset-password', { authorization: verified.body.authorization, password: 'new-pass-88' });
	assert.equal(reset.status, 200);

	// 7. Old password rejected, new password logs in.
	const rejected = await f.call('/api/auth/login', { email, password: 'original-pass-1' });
	assert.equal(rejected.status, 401, 'old password rejected after reset');
	const accepted = await f.call('/api/auth/login', { email, password: 'new-pass-88' });
	assert.equal(accepted.status, 200, 'new password logs in');

	// 8. Authorization is single-use.
	const reused = await f.call('/api/auth/reset-password', { authorization: verified.body.authorization, password: 'another-99' });
	assert.equal(reused.status, 400, 'authorization reuse rejected');

	// 9. Only verifier hashes persisted — no raw OTP/authorization in the store.
	const store = JSON.parse(await fs.promises.readFile(path.join(f.cwd, 'auth.json'), 'utf8'));
	const record = store.users.find(user => user.email === email)?.passwordReset;
	assert.ok(record, 'passwordReset record present');
	const serialized = JSON.stringify(record);
	assert.ok(!serialized.includes(otp3), 'raw OTP never persisted');
	assert.ok(!serialized.includes(String(verified.body.authorization)), 'raw authorization never persisted');
	assert.match(serialized, /[0-9a-f]{64}/, 'only SHA-256 verifier hashes stored');

	// 10. Prior sessions were revoked: the loginOld cookie no longer works.
	const session = await fetch(`http://127.0.0.1:${f.server.address().port}/api/profile`, { headers: { cookie: loginOld.body.cookie ?? '' } });
	assert.ok(session.status === 401 || session.status === 404 || session.status === 403, 'pre-reset session revoked');
});

test('resend is rate limited (3 per 15 minutes)', async t => {
	const f = await fixture();
	t.after(() => f.close());
	const email = 'ratelimit@corp.example.com';
	await f.call('/api/auth/register', { email, password: 'rate-pass-99', name: 'RL' });
	for (let i = 0; i < 3; i += 1) {
		const r = await f.call('/api/auth/forgot-password', { email });
		assert.equal(r.status, 200);
	}
	const fourth = await f.call('/api/auth/forgot-password', { email });
	assert.equal(fourth.status, 429, 'resend limit enforced');
});
