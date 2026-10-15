import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * Recovery codes (#15725–#15727): unit + integration coverage mirroring the
 * passwordReset.test.js fixture pattern — real local auth service in a temp
 * cwd, contract-complete service stubs, and an unthrottled auth wrapper so
 * the tests exercise recovery logic rather than the app-level throttle.
 */

async function buildHarness() {
	const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'qase-recovery-'));
	const previousCwd = process.cwd();
	process.chdir(cwd);
	const { createLocalAuthService } = await import('../server/auth.js');
	const { DEFAULT_TENANT_CONTEXT } = await import('../server/tenancy.js');
	const authService = createLocalAuthService({ tenantContext: DEFAULT_TENANT_CONTEXT, file: path.join(cwd, 'auth.json') });
	return { cwd, previousCwd, authService };
}

async function teardown(harness) {
	process.chdir(harness.previousCwd);
	await fs.promises.rm(harness.cwd, { recursive: true, force: true });
}

// Unthrottled wrapper: the recovery logic enforces its own 5/15-min counter.
const unthrottled = service => new Proxy(service, {
	get(target, property) {
		if (property === 'consumeAuthAttempt') return async () => true;
		const value = target[property];
		return typeof value === 'function' ? value.bind(target) : value;
	}
});

test('recovery codes: full lifecycle — generation, hashes only, neutral failures, atomic consumption, reset, revocation', async () => {
	const harness = await buildHarness();
	try {
		const authService = unthrottled(harness.authService);
		const email = 'recovery-user@qase.dev';
		const password = 'hunter2secure';
		const user = (await authService.register({ email, password, displayName: 'Recovery User' })).user;

		// Generation requires the current password.
		await assert.rejects(() => authService.generateRecoveryCodes(user.id, { currentPassword: 'wrong' }), /Current password/);
		const generated = await authService.generateRecoveryCodes(user.id, { currentPassword: password });
		assert.equal(generated.codes.length, 10);
		assert.ok(generated.codes.every(code => /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)));
		// Status counts
		const status = await authService.recoveryCodeStatus(user.id);
		assert.deepEqual(status, { total: 10, unused: 10 });
		// Only hashes are persisted — no plaintext in the store file.
		const storeFile = path.join(harness.cwd, 'auth.json');
		const rawStore = fs.readFileSync(storeFile, 'utf8');
		for (const code of generated.codes) assert.ok(!rawStore.includes(code), 'plaintext code leaked into store');
		assert.ok(rawStore.includes('codeHash'), 'hash entries missing');
		// Unknown email and wrong code are neutral: identical AuthError shape.
		const unknownEmail = await authService.recoverWithCode({ email: 'nobody@qase.dev', code: generated.codes[0] }).catch(error => error);
		const wrongCode = await authService.recoverWithCode({ email, code: 'AAAA-BBBB-CCCC' }).catch(error => error);
		assert.equal(unknownEmail.status, 400);
		assert.equal(unknownEmail.message, wrongCode.message);
		// Valid code (entered lowercase + without dashes — normalized) → authorization.
		const recovered = await authService.recoverWithCode({ email, code: generated.codes[0].toLowerCase().replace(/-/g, '') });
		assert.ok(recovered.authorization, 'authorization missing');
		// Reuse of the same code is rejected.
		const reuse = await authService.recoverWithCode({ email, code: generated.codes[0] }).catch(error => error);
		assert.equal(reuse.status, 400);
		// 7-char password rejected WITHOUT consuming the authorization.
		await assert.rejects(() => authService.resetPassword({ token: recovered.authorization, password: 'short7' }), /8–200/);
		// 8-char password accepted; old password no longer works; sessions revoked.
		const session = await authService.login({ email, password });
		const newPassword = 'brand-new-pass-9';
		const resetUser = await authService.resetPassword({ token: recovered.authorization, password: newPassword });
		assert.equal(resetUser.id, user.id);
		await assert.rejects(() => authService.login({ email, password }), /incorrect/);
		// Sessions were revoked by the reset: authenticate() returns undefined
		// (the app layer maps that to 401) rather than throwing.
		assert.equal(await authService.authenticate(session.token), undefined);
		assert.ok(await authService.login({ email, password: newPassword }), 'login with new password failed');
		// Authorization is single-use.
		await assert.rejects(() => authService.resetPassword({ token: recovered.authorization, password: 'another-pass-77' }), /expired|invalid/i);
		// Store never saw the new plaintext either.
		const rawAfter = fs.readFileSync(storeFile, 'utf8');
		assert.ok(!rawAfter.includes(newPassword));
	} finally { await teardown(harness); }
});

test('recovery codes: regeneration invalidates all previous codes', async () => {
	const harness = await buildHarness();
	try {
		const authService = harness.authService;
		const email = 'regen-user@qase.dev';
		const password = 'initial-pass-88';
		const user = (await authService.register({ email, password, displayName: 'Regen User' })).user;
		const first = await authService.generateRecoveryCodes(user.id, { currentPassword: password });
		const second = await authService.generateRecoveryCodes(user.id, { currentPassword: password });
		// All previous codes rejected after regeneration (the neutral 400, or
		// the 429 lockout once the loop crosses 5 attempts — both rejections).
		for (const code of first.codes.slice(0, 3)) {
			const outcome = await authService.recoverWithCode({ email, code }).catch(error => error);
			assert.ok([400, 429].includes(outcome.status), `old code ${code} should be rejected, got ${outcome.status}`);
		}
		// Regeneration also resets the attempt counter, so a new code works.
		const recovered = await authService.recoverWithCode({ email, code: second.codes[0] });
		assert.ok(recovered.authorization);
	} finally { await teardown(harness); }
});

test('recovery codes: 5 wrong attempts lock the account; a valid code is accepted only after the counter resets', async () => {
	const harness = await buildHarness();
	try {
		const authService = harness.authService;
		const email = 'lockout-user@qase.dev';
		const password = 'lockout-pass-77';
		const user = (await authService.register({ email, password, displayName: 'Lockout User' })).user;
		const generated = await authService.generateRecoveryCodes(user.id, { currentPassword: password });
		for (let index = 0; index < 5; index += 1) {
			const outcome = await authService.recoverWithCode({ email, code: 'ZZZZ-ZZZZ-ZZZZ' }).catch(error => error);
			assert.equal(outcome.status, 400);
		}
		// Locked: even a VALID code is refused while the 15-minute window is live.
		const locked = await authService.recoverWithCode({ email, code: generated.codes[0] }).catch(error => error);
		assert.equal(locked.status, 429);
		// Regeneration is authenticated and resets the counter — recovery proceeds.
		const regenerated = await authService.generateRecoveryCodes(user.id, { currentPassword: password });
		const fresh = await authService.recoverWithCode({ email, code: regenerated.codes[0] });
		assert.ok(fresh.authorization);
	} finally { await teardown(harness); }
});
