import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	loadMigrations,
	MIGRATION_ADVISORY_LOCK_KEY,
	runPostgresMigrations
} from './migrations.js';

class FakeClient {
	constructor({ applied = [], failOnMigration } = {}) {
		this.applied = applied.map(row => ({ ...row }));
		this.failOnMigration = failOnMigration;
		this.calls = [];
		this.released = false;
	}

	async query(text, values) {
		this.calls.push({ text, values });
		if (text.startsWith('SELECT version, name, checksum')) {
			return { rows: this.applied.map(row => ({ ...row })) };
		}

		const migrationMatch = text.match(/Qase PostgreSQL migration (\d{3})/);
		if (migrationMatch && Number(migrationMatch[1]) === this.failOnMigration) {
			throw new Error(`simulated migration ${this.failOnMigration} failure`);
		}

		if (text.startsWith('INSERT INTO qase_schema_migrations')) {
			this.applied.push({ version: values[0], name: values[1], checksum: values[2] });
		}
		return { rows: [] };
	}

	async release() {
		this.released = true;
	}
}

class FakePool {
	constructor(options) {
		this.client = new FakeClient(options);
		this.connectCalls = 0;
	}

	async connect() {
		this.connectCalls++;
		return this.client;
	}
}

function statements(client) {
	return client.calls.map(call => call.text);
}

test('loads the checked migration set in numeric order', async () => {
	const migrations = await loadMigrations();
	assert.deepEqual(migrations.map(migration => migration.version), [1, 2, 3, 4, 5]);
	assert.deepEqual(migrations.map(migration => migration.name), [
		'identity_tenancy',
		'run_domain',
		'events_import_rls',
		'drytis_identity_sessions',
		'distributed_execution'
	]);
	for (const migration of migrations) {
		assert.match(migration.checksum, /^[0-9a-f]{64}$/);
	}
	assert.match(migrations[1].sql, /next_event_sequence bigint NOT NULL DEFAULT 0/);
	assert.match(migrations[1].sql, /secret_names text\[\] NOT NULL/);
	assert.match(migrations[2].sql, /FORCE ROW LEVEL SECURITY/);
	assert.match(migrations[2].sql, /current_setting\('qase\.organization_id', true\)/);
	assert.match(migrations[2].sql, /current_setting\('qase\.project_id', true\)/);
	assert.match(migrations[3].sql, /CREATE TABLE qase_auth_sessions/);
	assert.match(migrations[4].sql, /FOR UPDATE SKIP LOCKED|CREATE TABLE qa_execution_jobs/);
});

test('applies pending migrations in order and records them with parameters', async () => {
	const pool = new FakePool();
	const result = await runPostgresMigrations(pool);
	const sql = statements(pool.client);
	const migrationOrder = sql
		.map(statement => statement.match(/Qase PostgreSQL migration (\d{3})/)?.[1])
		.filter(Boolean);

	assert.equal(pool.connectCalls, 1);
	assert.deepEqual(migrationOrder, ['001', '002', '003', '004', '005']);
	assert.deepEqual(result.applied.map(migration => migration.version), [1, 2, 3, 4, 5]);
	assert.equal(result.currentVersion, 5);
	assert.equal(sql.filter(statement => statement === 'BEGIN').length, 5);
	assert.equal(sql.filter(statement => statement === 'COMMIT').length, 5);
	assert.equal(sql.filter(statement => statement === 'ROLLBACK').length, 0);

	const records = pool.client.calls.filter(call => call.text.startsWith('INSERT INTO qase_schema_migrations'));
	assert.equal(records.length, 5);
	assert.match(records[0].text, /VALUES \(\$1, \$2, \$3\)/);
	assert.deepEqual(records.map(record => record.values.slice(0, 2)), [
		[1, 'identity_tenancy'],
		[2, 'run_domain'],
		[3, 'events_import_rls'],
		[4, 'drytis_identity_sessions'],
		[5, 'distributed_execution']
	]);
	assert.deepEqual(pool.client.calls[0].values, [MIGRATION_ADVISORY_LOCK_KEY]);
	assert.match(sql[0], /pg_advisory_lock/);
	assert.match(sql.at(-1), /pg_advisory_unlock/);
	assert.equal(pool.client.released, true);
});

test('does no transactional work when every migration is already applied', async () => {
	const migrations = await loadMigrations();
	const pool = new FakePool({
		applied: migrations.map(({ version, name, checksum }) => ({ version, name, checksum }))
	});
	const result = await runPostgresMigrations(pool);
	const sql = statements(pool.client);

	assert.deepEqual(result, { applied: [], currentVersion: 5 });
	assert.equal(sql.includes('BEGIN'), false);
	assert.equal(sql.some(statement => statement.startsWith('INSERT INTO qase_schema_migrations')), false);
	assert.match(sql.at(-1), /pg_advisory_unlock/);
	assert.equal(pool.client.released, true);
});

test('rejects a changed checksum before beginning a migration', async () => {
	const migrations = await loadMigrations();
	const pool = new FakePool({
		applied: [{
			version: migrations[0].version,
			name: migrations[0].name,
			checksum: '0'.repeat(64)
		}]
	});

	await assert.rejects(runPostgresMigrations(pool), /checksum mismatch/);
	const sql = statements(pool.client);
	assert.equal(sql.includes('BEGIN'), false);
	assert.match(sql.at(-1), /pg_advisory_unlock/);
	assert.equal(pool.client.released, true);
});

test('rolls back a failed migration, unlocks, and releases the client', async () => {
	const pool = new FakePool({ failOnMigration: 2 });

	await assert.rejects(runPostgresMigrations(pool), /simulated migration 2 failure/);
	const sql = statements(pool.client);
	assert.equal(sql.filter(statement => statement === 'BEGIN').length, 2);
	assert.equal(sql.filter(statement => statement === 'COMMIT').length, 1);
	assert.equal(sql.filter(statement => statement === 'ROLLBACK').length, 1);
	assert.deepEqual(pool.client.applied.map(row => row.version), [1]);
	assert.match(sql.at(-1), /pg_advisory_unlock/);
	assert.equal(pool.client.released, true);
});
