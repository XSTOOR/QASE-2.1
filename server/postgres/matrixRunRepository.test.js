/**
 * Matrix run PostgreSQL repository tests (#14649 NI02 Phase 1 — store parity).
 *
 * Fake-client based (same pattern as environmentRepository.test.js): verifies
 * the repository implements the backend interface the matrix service expects
 * (list/get/create/update/updateItem), stores the service's text `matrix-*`
 * id format, persists every item field including the honest statuses, and
 * keeps tenant scoping on every statement.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPostgresMatrixRepository } from './matrixRunRepository.js';

const TENANT = { organizationId: '11111111-1111-1111-1111-111111111111', projectId: '22222222-2222-2222-2222-222222222222' };

class FakeClient {
	constructor() {
		this.calls = [];
		this.released = false;
	}
	async query(text, values) {
		this.calls.push({ text, values });
		if (text.startsWith('SELECT set_config')) return { rows: [] };
		if (text.startsWith('INSERT INTO matrix_runs')) return { rows: [{ id: values[0] }] };
		if (text.startsWith('SELECT * FROM matrix_runs WHERE')) return { rows: [] };
		if (text.startsWith('SELECT * FROM matrix_runs\n')) return { rows: [] };
		if (text.startsWith('UPDATE matrix_runs')) return { rows: [] };
		if (text.startsWith('UPDATE matrix_run_items')) return { rows: [] };
		return { rows: [] };
	}
	release() { this.released = true; }
}

class FakePool {
	constructor() { this.client = new FakeClient(); this.connectCalls = 0; }
	async connect() { this.connectCalls += 1; return this.client; }
}

function sampleRun() {
	return {
		id: 'matrix-muzq0a-1234abcd',
		title: 'Matrix — Login flow',
		targetUrl: 'https://example.com',
		status: 'pending',
		defaultsUsed: true,
		defaultsSnapshot: { rules: [], resolved: [] },
		requestedProfiles: [{ envId: 'ENV-IOS-IP17PRO-26.0-CHR-140' }],
		requestedBrowsers: ['chrome', 'duckduckgo'],
		itemCount: 2,
		ownerUserId: 'user-1',
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		updatedAt: new Date().toISOString(),
		items: [
			{
				id: '33333333-3333-3333-3333-333333333333',
				ordinal: 0,
				testCaseId: 'TC-1',
				environmentId: 'ENV-IOS-IP17PRO-26.0-CHR-140',
				profileId: 'iphone17pro-ios26-chrome140',
				platform: 'ios',
				device: 'iPhone 17 Pro',
				os: 'iOS',
				osVersion: '26.0',
				browser: 'Chrome',
				browserCode: 'chrome',
				browserVersion: '140',
				deviceType: 'mobile',
				status: 'PENDING',
				reason: null,
				sessionId: null,
				verdict: null,
				error: null,
				findings: [],
				startedAt: null,
				finishedAt: null,
				durationMs: null
			},
			{
				id: '44444444-4444-4444-4444-444444444444',
				ordinal: 1,
				testCaseId: 'TC-1',
				environmentId: 'ENV-IOS-IP17PRO-26.0-DDG-1',
				profileId: 'iphone17pro-ios26-duckduckgo1',
				platform: 'ios',
				device: 'iPhone 17 Pro',
				os: 'iOS',
				osVersion: '26.0',
				browser: 'DuckDuckGo',
				browserCode: 'duckduckgo',
				browserVersion: '1',
				deviceType: 'mobile',
				status: 'NOT_SUPPORTED',
				reason: 'mobile-only browser with no Playwright build',
				sessionId: null,
				verdict: null,
				error: null,
				findings: [],
				startedAt: null,
				finishedAt: null,
				durationMs: null
			}
		]
	};
}

test('create inserts the run with the service text-id format and every item', async () => {
	const pool = new FakePool();
	const repository = createPostgresMatrixRepository(pool, { tenantContext: TENANT });
	await repository.create(TENANT, sampleRun());
	const insertRun = pool.client.calls.find((call) => call.text.startsWith('INSERT INTO matrix_runs'));
	assert.ok(insertRun, 'run insert missing');
	assert.equal(insertRun.values[0], 'matrix-muzq0a-1234abcd', 'id must be stored as text');
	assert.ok(insertRun.values.includes('https://example.com'));
	const itemInserts = pool.client.calls.filter((call) => call.text.startsWith('INSERT INTO matrix_run_items'));
	assert.equal(itemInserts.length, 2);
	// Item columns in order: id, org, project, matrix_run_id, ordinal, test_case_id, environment_id, profile_id, platform, device, os, os_version, browser, browser_code, browser_version, device_type, status, reason, ...
	const second = itemInserts[1].values;
	assert.equal(second[4], 1); // ordinal
	assert.equal(second[7], 'iphone17pro-ios26-duckduckgo1'); // profile_id
	assert.equal(second[16], 'NOT_SUPPORTED'); // status
	assert.equal(second[17], 'mobile-only browser with no Playwright build'); // reason
	// Every statement is parameterized — no string interpolation of values.
	for (const call of pool.client.calls) {
		assert.ok(!/'matrix-muzq0a/.test(call.text), 'values must be parameterized, not inlined');
	}
});

test('every query sets tenant scoping (RLS set_config)', async () => {
	const pool = new FakePool();
	const repository = createPostgresMatrixRepository(pool, { tenantContext: TENANT });
	await repository.list(TENANT);
	await repository.get(TENANT, 'matrix-x');
	const tenantSettings = pool.client.calls.filter((call) => call.text.startsWith('SELECT set_config'));
	assert.ok(tenantSettings.length >= 4, 'expected set_config on every connection use');
	assert.ok(tenantSettings.every((call) => call.values[0] === TENANT.organizationId || call.values[0] === TENANT.projectId));
});

test('requireTenant rejects missing tenant context', async () => {
	const pool = new FakePool();
	const repository = createPostgresMatrixRepository(pool, { tenantContext: undefined });
	await assert.rejects(() => repository.list(undefined), TypeError);
});

test('updateItem patches honest status fields and serializes findings', async () => {
	const pool = new FakePool();
	const repository = createPostgresMatrixRepository(pool, { tenantContext: TENANT });
	await repository.updateItem(TENANT, 'matrix-x', '33333333-3333-3333-3333-333333333333', {
		status: 'PASSED',
		sessionId: 'session-1',
		verdict: 'pass',
		durationMs: 4200,
		findings: [{ title: 'Slow login' }]
	});
	const update = pool.client.calls.find((call) => call.text.startsWith('UPDATE matrix_run_items'));
	assert.ok(update, 'update missing');
	const findingsParam = update.values.find((value) => typeof value === 'string' && value.includes('Slow login'));
	assert.ok(findingsParam, 'findings must serialize to JSON text');
});

test('update maps status + timing columns on matrix_runs', async () => {
	const pool = new FakePool();
	const repository = createPostgresMatrixRepository(pool, { tenantContext: TENANT });
	await repository.update(TENANT, 'matrix-x', { status: 'done', finishedAt: '2026-10-02T00:00:00.000Z' });
	const update = pool.client.calls.find((call) => call.text.startsWith('UPDATE matrix_runs'));
	assert.ok(update, 'update missing');
	assert.ok(update.text.includes('status = '));
	assert.ok(update.text.includes('finished_at = '));
});

test('migration 031 declares matrix_runs.id as text (service id format)', async () => {
	const { readFileSync } = await import('node:fs');
	const sql = readFileSync(new URL('./migrations/031_matrix_runs.sql', import.meta.url), 'utf8');
	assert.match(sql, /id text PRIMARY KEY/);
	assert.match(sql, /matrix_run_id text NOT NULL REFERENCES matrix_runs/);
});

// #14649 round 2: the read path must cast to text[] — the id format is
// `matrix-<ts36>-<uuid8>`, and a ::uuid[] cast throws invalid input syntax
// on every list()/get() under the postgres store.
test('item reads cast matrix_run_id to text[], never uuid[]', async () => {
	const { readFileSync } = await import('node:fs');
	const sql = readFileSync(new URL('./matrixRunRepository.js', import.meta.url), 'utf8');
	assert.doesNotMatch(sql, /::uuid\[\]/, 'uuid[] casts break with matrix- text ids');
	assert.match(sql, /ANY\(\$1::text\[\]\)/);
});
