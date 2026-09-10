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
	assert.deepEqual(migrations.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	assert.deepEqual(migrations.map(migration => migration.name), [
		'identity_tenancy',
		'run_domain',
		'events_import_rls',
		'drytis_identity_sessions',
		'distributed_execution',
		'operational_correlation',
		'data_lifecycle',
		'sqa_assessment',
		'founder_review',
		'drytis_product_integration',
		'first_party_auth_profiles',
		'account_settings'
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
	assert.match(migrations[5].sql, /ADD COLUMN correlation_id uuid/);
	assert.match(migrations[6].sql, /CREATE TABLE qase_lifecycle_requests/);
	assert.match(migrations[6].sql, /CREATE TABLE qa_run_legal_holds/);
	assert.match(migrations[6].sql, /CREATE TABLE qa_run_legal_holds \([\s\S]*?id uuid PRIMARY KEY/);
	assert.match(migrations[6].sql, /qa_run_legal_holds_reference_unique[\s\S]*organization_id, project_id, run_id, reference_id/);
	assert.match(migrations[6].sql, /CREATE TABLE qase_run_cleanup/);
	assert.match(migrations[6].sql, /request_reference_id text NOT NULL/);
	assert.match(migrations[6].sql, /attestation_reference_id text/);
	assert.match(migrations[6].sql, /cleanup attestation reference may only be set on completion/);
	assert.match(migrations[6].sql, /CREATE TABLE qase_lifecycle_events/);
	assert.match(migrations[6].sql, /CREATE TABLE qase_erasure_tombstones/);
	assert.match(migrations[6].sql, /qase_lifecycle_events_append_only/);
	assert.match(migrations[6].sql, /CREATE TRIGGER qa_runs_restore_suppression/);
	assert.match(migrations[6].sql, /FOREIGN KEY \(organization_id, project_id, run_id\)[\s\S]*ON DELETE RESTRICT/);
	assert.match(migrations[6].sql, /FORCE ROW LEVEL SECURITY/);
	assert.match(migrations[6].sql, /qa_runs_purge_candidates/);
	assert.match(migrations[7].sql, /ADD COLUMN run_mode text NOT NULL DEFAULT 'qa'/);
	assert.match(migrations[7].sql, /ADD COLUMN sqa_assessment jsonb/);
	assert.match(migrations[7].sql, /qa_runs_sqa_shape/);
	assert.match(migrations[8].sql, /ADD COLUMN founder_assessment jsonb/);
	assert.match(migrations[8].sql, /run_mode IN \('qa', 'sqa', 'founder'\)/);
	assert.match(migrations[8].sql, /qa_runs_mode_shape/);
	assert.match(migrations[9].sql, /ADD COLUMN drytis_integration jsonb/);
	assert.match(migrations[9].sql, /CREATE TABLE qase_drytis_request_nonces/);
	assert.match(migrations[9].sql, /requested_by_actor_type text NOT NULL DEFAULT 'user'/);
	assert.match(migrations[9].sql, /requested_by_actor_type IN \('system', 'service'\)/);
	assert.match(migrations[9].sql, /FORCE ROW LEVEL SECURITY/);
	assert.doesNotMatch(migrations[9].sql, /source_content|file_content|access_token|private_key/i);
	assert.match(migrations[10].sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash/);
	assert.match(migrations[10].sql, /CREATE TABLE qase_user_profiles/);
	assert.match(migrations[10].sql, /CREATE TABLE qase_memory_entries/);
	assert.match(migrations[10].sql, /FORCE ROW LEVEL SECURITY/);
});

test('applies pending migrations in order and records them with parameters', async () => {
	const pool = new FakePool();
	const result = await runPostgresMigrations(pool);
	const sql = statements(pool.client);
	const migrationOrder = sql
		.map(statement => statement.match(/Qase PostgreSQL migration (\d{3})/)?.[1])
		.filter(Boolean);

	assert.equal(pool.connectCalls, 1);
	assert.deepEqual(migrationOrder, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012']);
	assert.deepEqual(result.applied.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
	assert.equal(result.currentVersion, 12);
	assert.equal(sql.filter(statement => statement === 'BEGIN').length, 12);
	assert.equal(sql.filter(statement => statement === 'COMMIT').length, 12);
	assert.equal(sql.filter(statement => statement === 'ROLLBACK').length, 0);

	const records = pool.client.calls.filter(call => call.text.startsWith('INSERT INTO qase_schema_migrations'));
	assert.equal(records.length, 12);
	assert.match(records[0].text, /VALUES \(\$1, \$2, \$3\)/);
	assert.deepEqual(records.map(record => record.values.slice(0, 2)), [
		[1, 'identity_tenancy'],
		[2, 'run_domain'],
		[3, 'events_import_rls'],
		[4, 'drytis_identity_sessions'],
		[5, 'distributed_execution'],
		[6, 'operational_correlation'],
		[7, 'data_lifecycle'],
		[8, 'sqa_assessment'],
		[9, 'founder_review'],
		[10, 'drytis_product_integration'],
		[11, 'first_party_auth_profiles'],
		[12, 'account_settings']
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

	assert.deepEqual(result, { applied: [], currentVersion: 12 });
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
