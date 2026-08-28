import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresDrytisNonceStore } from './drytisNonceStore.js';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');
const TENANT = Object.freeze({
	organizationId: '8c135239-cc6d-4e29-9f31-d40755137811',
	projectId: '63e57ec3-5a83-4491-9706-2ce61763f7d1'
});
const NONCE = 'a3'.repeat(32);

function fixture(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	let connects = 0;
	const client = {
		async query(text, params = []) {
			const call = { text: text.trim(), params };
			calls.push(call);
			return await handler(call, calls) ?? { rows: [], rowCount: 0 };
		},
		release() { calls.push({ text: 'RELEASE', params: [] }); }
	};
	return {
		calls,
		get connects() { return connects; },
		pool: { async connect() { connects++; return client; } }
	};
}

function store(target, options = {}) {
	return createPostgresDrytisNonceStore({
		pool: target.pool,
		tenantContext: options.tenantContext ?? TENANT,
		now: options.now ?? (() => NOW)
	});
}

test('nonce reservation is tenant-scoped, bounded, atomic, and commits only the digest', async () => {
	const target = fixture(call => call.text.startsWith('INSERT INTO qase_drytis_request_nonces')
		? { rows: [{ nonce_sha256: NONCE }], rowCount: 1 }
		: { rows: [], rowCount: 0 });
	const expiresAtMs = NOW + 301_000;
	assert.equal(await store(target).consume(NONCE, expiresAtMs), true);

	assert.equal(target.calls[0].text, 'BEGIN');
	assert.match(target.calls[1].text, /set_config\('qase\.organization_id'/);
	assert.deepEqual(target.calls[1].params, [TENANT.organizationId, TENANT.projectId]);
	const cleanup = target.calls.find(call => call.text.startsWith('WITH expired AS'));
	assert.match(cleanup.text, /organization_id = \$1 AND project_id = \$2/);
	assert.match(cleanup.text, /ORDER BY expires_at, nonce_sha256/);
	assert.match(cleanup.text, /LIMIT 1000 FOR UPDATE SKIP LOCKED/);
	assert.deepEqual(cleanup.params, [TENANT.organizationId, TENANT.projectId]);
	const insert = target.calls.find(call => call.text.startsWith('INSERT INTO qase_drytis_request_nonces'));
	assert.match(insert.text, /ON CONFLICT DO NOTHING RETURNING nonce_sha256/);
	assert.deepEqual(insert.params.slice(0, 3), [TENANT.organizationId, TENANT.projectId, NONCE]);
	assert.equal(insert.params[3].getTime(), expiresAtMs);
	assert.equal(target.calls.at(-2).text, 'COMMIT');
	assert.equal(target.calls.at(-1).text, 'RELEASE');
});

test('a conflicting nonce returns false while preserving transaction cleanup', async () => {
	const target = fixture(call => call.text.startsWith('INSERT INTO qase_drytis_request_nonces')
		? { rows: [], rowCount: 0 }
		: { rows: [], rowCount: 0 });
	assert.equal(await store(target).consume(NONCE, NOW + 1000), false);
	assert.equal(target.calls.at(-2).text, 'COMMIT');
	assert.equal(target.calls.at(-1).text, 'RELEASE');
});

test('constructor and reservations reject untrusted or unbounded input before connecting', async () => {
	const target = fixture();
	assert.throws(() => createPostgresDrytisNonceStore({
		pool: target.pool, tenantContext: { ...TENANT }, now: () => NOW
	}), /frozen trusted tenant/);
	assert.throws(() => createPostgresDrytisNonceStore({
		pool: target.pool,
		tenantContext: Object.freeze({ ...TENANT, headers: { 'x-project-id': TENANT.projectId } }),
		now: () => NOW
	}), /request-supplied tenant/);
	assert.throws(() => createPostgresDrytisNonceStore({
		pool: target.pool, tenantContext: TENANT, organizationId: TENANT.organizationId, now: () => NOW
	}), /tenant selectors/);
	assert.throws(() => createPostgresDrytisNonceStore({
		pool: target.pool,
		tenantContext: Object.freeze({ ...TENANT, projectId: 'not-a-uuid' }),
		now: () => NOW
	}), /canonical UUID/);

	const value = store(target);
	await assert.rejects(() => value.consume(NONCE.toUpperCase(), NOW + 1000), /lowercase SHA-256/);
	await assert.rejects(() => value.consume(NONCE, NOW), /future timestamp/);
	await assert.rejects(() => value.consume(NONCE, NOW + 3_600_001), /one hour/);
	assert.equal(target.connects, 0);
});

test('database errors roll back and always release the client', async () => {
	const failure = Object.assign(new Error('database unavailable'), { code: '57P01' });
	const target = fixture(call => {
		if (call.text.startsWith('INSERT INTO qase_drytis_request_nonces')) throw failure;
		return { rows: [], rowCount: 0 };
	});
	await assert.rejects(() => store(target).consume(NONCE, NOW + 1000), failure);
	assert.equal(target.calls.at(-2).text, 'ROLLBACK');
	assert.equal(target.calls.at(-1).text, 'RELEASE');
});
