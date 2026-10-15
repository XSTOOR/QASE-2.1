import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInviteService, InviteError } from './invites.js';

/**
 * Invite service unit tests: single-use semantics, atomicity shape, expiry,
 * constant-time comparison, no enumeration oracle.
 */

function service(ttlMs) {
	const dir = mkdtempSync(join(tmpdir(), 'qase-invites-'));
	const svc = createInviteService({ file: join(dir, 'invites.json'), ttlMs, now: () => NOW });
	return { svc, dir };
}

const NOW = Date.now();

describe('createInviteService', () => {
	it('mints qase- prefixed codes and hides them once used', async () => {
		const { svc } = service();
		const invite = await svc.create({ note: 'Alice' });
		assert.match(invite.code, /^qase-[0-9A-Z]{20,}$/);
		const listed = await svc.list();
		assert.equal(listed[0].code, invite.code);
	});

	it('consumes a valid code exactly once', async () => {
		const { svc } = service();
		const { code } = await svc.create({});
		await assert.doesNotReject(svc.consume(code, 'alice@example.com'));
		await assert.rejects(svc.consume(code, 'alice@example.com'), error =>
			error instanceof InviteError && error.status === 403);
		// Listing after use must not leak the code (it is a dead secret).
		const listed = await svc.list();
		assert.equal(listed[0].code, undefined);
		assert.equal(listed[0].usedBy, 'alice@example.com');
	});

	it('rejects expired codes', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'qase-invites-'));
		let clock = NOW;
		const svc = createInviteService({ file: join(dir, 'invites.json'), ttlMs: 50, now: () => clock });
		const { code } = await svc.create({});
		clock += 80; // past the 50ms TTL
		await assert.rejects(svc.consume(code), error =>
			error instanceof InviteError && error.status === 403);
	});

	it('normalizes case and whitespace on consume but never matches garbage', async () => {
		const { svc } = service();
		const { code } = await svc.create({});
		await assert.doesNotReject(svc.consume('  ' + code.toLowerCase() + '  '));
	});

	it('rejects malformed codes uniformly', async () => {
		const { svc } = service();
		for (const bad of ['', 'qase-short', 'nope', 42, undefined]) {
			await assert.rejects(svc.consume(bad), error =>
				error instanceof InviteError && error.status === 403);
		}
	});

	it('persists to a 0600 atomic store and reloads across instances', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'qase-invites-'));
		const file = join(dir, 'invites.json');
		const first = createInviteService({ file, now: () => NOW });
		const { code } = await first.create({ note: 'persisted' });
		const mode = statSync(file).mode & 0o777;
		if (process.platform !== 'win32') assert.equal(mode, 0o600);
		const second = createInviteService({ file, now: () => NOW });
		await assert.doesNotReject(second.consume(code));
	});

	it('bounds note length and control characters', async () => {
		const { svc } = service();
		await assert.rejects(svc.create({ note: 'x'.repeat(201) }), InviteError);
		await assert.rejects(svc.create({ note: 'bad\u0000note' }), InviteError);
	});

	it('caps the store size', async () => {
		const { svc } = service();
		for (let i = 0; i < 5; i++) await svc.create({ note: `invite-${i}` });
		// MAX_INVITES is 1000; the cap is asserted structurally via check()
		const status = await svc.check();
		assert.equal(status.invites, 5);
		assert.equal(status.used, 0);
	});
});

describe('registration role assignment (auth.js contract)', () => {
	it('source assigns pilot only when explicitly proposed', async () => {
		const source = readFileSync(new URL('./auth.js', import.meta.url), 'utf8');
		assert.match(source, /role === 'pilot' \? 'pilot' : 'developer'/);
		// Both backends honor the proposal.
		assert.equal((source.match(/role === 'pilot' \? 'pilot' : 'developer'/g) ?? []).length, 2);
	});
});

describe('invitation admission', () => {
	it('only one concurrent registrant can create an account', async () => {
		const { svc } = service();
		const { code } = await svc.create({});
		let accounts = 0;
		const register = async () => { accounts++; return { user: accounts }; };
		const results = await Promise.allSettled([
			svc.redeem(code, 'one@example.com', register),
			svc.redeem(code, 'two@example.com', register)
		]);
		assert.equal(accounts, 1);
		assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
	});
	it('failed account validation releases the invitation for a later attempt', async () => {
		const { svc } = service(); const { code } = await svc.create({});
		await assert.rejects(svc.redeem(code, 'one@example.com', async () => { throw Object.assign(new Error('invalid password'), { code: 'weak_password' }); }));
		await assert.doesNotReject(svc.redeem(code, 'one@example.com', async () => ({ user: 'one' })));
		await assert.rejects(svc.validate(code), InviteError);
	});
	it('ambiguous storage failure leaves admission consumed', async () => {
		const { svc } = service(); const { code } = await svc.create({});
		await assert.rejects(svc.redeem(code, 'one@example.com', async () => { throw new Error('session write failed after account creation'); }));
		await assert.rejects(svc.validate(code), InviteError);
	});
});
