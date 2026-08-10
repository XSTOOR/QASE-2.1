import assert from 'node:assert/strict';
import test from 'node:test';
import { createDistributedSecrets } from './distributedSecrets.js';
import { DEFAULT_TENANT_CONTEXT as TENANT } from './tenancy.js';

const RUN = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';

function redis() {
	const values = new Map();
	const calls = [];
	return {
		values, calls,
		client: {
			async connect() { calls.push(['connect']); },
			async set(key, value, options) { calls.push(['set', key, value, options]); values.set(key, value); },
			async get(key) { calls.push(['get', key]); return values.get(key) ?? null; },
			async del(key) { calls.push(['del', key]); values.delete(key); },
			async ping() { return 'PONG'; }, async close() { calls.push(['close']); }
		}
	};
}

function vault(target, key = Buffer.alloc(32, 7)) {
	return createDistributedSecrets({
		tenantContext: TENANT, key, url: 'redis://test', client: target.client, ttlSeconds: 600
	});
}

test('distributed vault encrypts values with authenticated cell/run binding and TTL', async () => {
	const target = redis();
	const value = vault(target);
	await value.load();
	assert.deepEqual(await value.store(RUN, { qa_username: 'person@example.com', 'QA password': 'never-store-plain' }), [
		'QA_USERNAME', 'QA_PASSWORD'
	]);
	const stored = [...target.values.values()][0];
	assert.equal(stored.includes('never-store-plain'), false);
	assert.equal(stored.includes('person@example.com'), false);
	assert.deepEqual(await value.values(RUN), {
		QA_USERNAME: 'person@example.com', QA_PASSWORD: 'never-store-plain'
	});
	assert.deepEqual(target.calls.find(call => call[0] === 'set')[3], { EX: 600 });
	assert.equal(await value.check(), true);
	await value.clear(RUN);
	assert.deepEqual(await value.names(RUN), []);
	await Promise.all([value.close(), value.close()]);
});

test('wrong key or altered envelope fails authenticated decryption', async () => {
	const target = redis();
	const first = vault(target, Buffer.alloc(32, 1));
	await first.load();
	await first.store(RUN, { PASSWORD: 'secret-value' });
	const second = vault(target, Buffer.alloc(32, 2));
	await second.load();
	await assert.rejects(() => second.values(RUN));
});

test('distributed vault rejects missing keys and oversized values', async () => {
	assert.throws(() => createDistributedSecrets({
		tenantContext: TENANT, environment: { QASE_REDIS_URL: 'redis://test' }
	}), /QASE_SECRETS_MASTER_KEY/);
	const target = redis();
	const value = vault(target);
	await value.load();
	assert.deepEqual(await value.store(RUN, { EMPTY: '', TOO_BIG: 'x'.repeat(20_000) }), []);
});
