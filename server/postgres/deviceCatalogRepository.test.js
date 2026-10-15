import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresDeviceCatalogRepository } from './deviceCatalogRepository.js';

function scriptedPool(handler = () => ({ rows: [], rowCount: 0 })) {
	const calls = [];
	const pool = {
		async connect() {
			const client = {
				async query(text, params) {
					calls.push({ text: String(text), params });
					const result = handler({ text: String(text), params }, calls.length);
					if (result === 'throw') throw new Error('scripted failure');
					return result ?? { rows: [], rowCount: 0 };
				},
				release() {}
			};
			return client;
		},
		async query(text, params) {
			calls.push({ text: String(text), params });
			const result = handler({ text: String(text), params }, calls.length);
			if (result === 'throw') throw new Error('scripted failure');
			return result ?? { rows: [], rowCount: 0 };
		}
	};
	pool._calls = calls;
	return pool;
}

test('seed upserts every catalog entity inside one transaction', async () => {
	const pool = scriptedPool();
	const repo = createPostgresDeviceCatalogRepository(pool);
	const result = await repo.seed();
	assert.ok(result.inserted > 100, `expected 100+ catalog rows, got ${result.inserted}`);
	const texts = pool._calls.map((call) => call.text);
	assert.ok(texts.includes('BEGIN'));
	assert.ok(texts.includes('COMMIT'));
	const inserts = texts.filter((text) => text.startsWith('INSERT INTO'));
	assert.equal(inserts.length, result.inserted);
	// every insert must be an upsert — idempotent re-seed
	for (const text of inserts) {
		assert.match(text, /ON CONFLICT/);
	}
	// device models seeded from the Apple catalog
	const modelInserts = pool._calls.filter((call) => call.text.startsWith('INSERT INTO device_models'));
	assert.ok(modelInserts.length >= 25, `expected device model inserts, got ${modelInserts.length}`);
});

test('seed rolls back the transaction on failure', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('INSERT INTO') ? 'throw' : { rows: [] }));
	const repo = createPostgresDeviceCatalogRepository(pool);
	await assert.rejects(() => repo.seed());
	const texts = pool._calls.map((call) => call.text);
	assert.ok(texts.includes('ROLLBACK'));
});

test('list builds parameterized filters on whitelisted columns only', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT * FROM device_models') ? { rows: [{ id: 'IP16PRO', display_name: 'iPhone 16 Pro' }] } : { rows: [] }));
	const repo = createPostgresDeviceCatalogRepository(pool);
	const rows = await repo.list('deviceModels', { category_id: 'iphone' });
	assert.equal(rows.length, 1);
	const select = pool._calls.find((call) => call.text.startsWith('SELECT * FROM device_models'));
	assert.ok(select.text.includes('category_id = $1'));
	// non-whitelisted keys are ignored (no SQL injection surface)
	await repo.list('deviceModels', { malicious: 'x; DROP TABLE users' });
	const second = pool._calls.filter((call) => call.text.startsWith('SELECT * FROM device_models')).pop();
	assert.ok(!second.text.includes('DROP TABLE'));
});

test('isCombinationSupported returns ok for a valid row set', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.includes('FROM device_models')) return { rows: [{ slug: 'IP16PRO', category_id: 'iphone', platform: 'ios' }] };
		if (text.includes('FROM device_os_compatibility')) return { rows: [{ 1: 1 }] };
		if (text.includes('FROM browser_platform_support')) return { rows: [{ supported: true }] };
		if (text.includes('FROM browsers')) return { rows: [{ independently_versioned: true }] };
		if (text.includes('FROM browser_versions')) return { rows: [{ 1: 1 }] };
		return { rows: [] };
	});
	const repo = createPostgresDeviceCatalogRepository(pool);
	const result = await repo.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'chrome', browserVersion: '140'
	});
	assert.deepEqual(result, { ok: true });
});

test('isCombinationSupported rejects an unsupported browser-platform pair', async () => {
	const pool = scriptedPool(({ text }) => {
		if (text.includes('FROM device_models')) return { rows: [{ slug: 'IP16PRO', category_id: 'iphone', platform: 'ios' }] };
		if (text.includes('FROM device_os_compatibility')) return { rows: [{ 1: 1 }] };
		if (text.includes('FROM browser_platform_support')) return { rows: [{ supported: false }] };
		return { rows: [] };
	});
	const repo = createPostgresDeviceCatalogRepository(pool);
	const result = await repo.isCombinationSupported({
		deviceSlug: 'IP16PRO', platform: 'ios', osVersion: '18.3', browserCode: 'firefox'
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /not available on ios/);
});

test('create derives the natural id for browser versions', async () => {
	const pool = scriptedPool(({ text }) => (text.startsWith('SELECT') ? { rows: [{ id: 'chrome:154', browser_id: 'chrome', version: '154' }] } : { rows: [] }));
	const repo = createPostgresDeviceCatalogRepository(pool);
	const row = await repo.create('browserVersions', { browser_id: 'chrome', version: '154', sort_key: '000154' });
	assert.equal(row.id, 'chrome:154');
	const insert = pool._calls.find((call) => call.text.startsWith('INSERT INTO browser_versions'));
	assert.equal(insert.params[0], 'chrome:154');
});
