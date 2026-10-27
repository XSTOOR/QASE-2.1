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
	assert.deepEqual(migrations.map(migration => migration.version),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,  37, 38, 39, 40, 41, 42]);
	// #14631: migration 030 must stay DDL-only. The profile alias algorithm
	// (buildProfileId) cannot be replicated in SQL without collisions — a
	// data-mutating backfill here would abort the migration chain on any
	// populated environments table.
	const profileAlias = migrations.find((migration) => migration.version === 30);
	assert.ok(profileAlias, 'migration 30 missing');
	assert.ok(!/\bUPDATE\b/.test(profileAlias.sql), 'migration 030 must not contain UPDATE statements');
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
		'account_settings',
		'run_timing',
		'token_usage',
		'finding_status',
		'run_pause',
		'run_feedback',
		'run_engine_device',
		'run_cohort',
		'run_feedback_column',
		'qa_test_selection',
		'security_authorization',
		'environments',
		'device_catalog',
		'test_cases',
		'cross_platform_catalog',
		'device_runtime',
		'bugs',
		'test_case_provenance',
		'environment_profile_id',
		'matrix_runs',
		'qa_runs_matrix_link',
		'matrix_item_evidence',
		'matrix_item_fixtures',
		'run_scope_selection',
		'matrix_item_retry_count',
		'password_resets',
		'password_reset_otp',
		'recovery_codes',
		'founder_project_state',
		'partial_qa_verdict',
		'hybrid_qa_state'
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
	assert.match(migrations[12].sql, /run_timing|started_at/);
	assert.match(migrations[13].sql, /ALTER TABLE qa_runs ADD COLUMN IF NOT EXISTS token_usage jsonb/);
	assert.match(migrations[13].sql, /qa_runs_token_usage_object/);
	assert.match(migrations[14].sql, /ALTER TABLE qa_findings ADD COLUMN IF NOT EXISTS status text/);
	assert.match(migrations[14].sql, /qa_findings_status_enum/);
	assert.match(migrations[14].sql, /CHECK \(status IN \('open', 'in_progress', 'fixed', 'wont_fix'\)\)/);
	assert.match(migrations[14].sql, /qa_findings_status_note_size/);
	assert.match(migrations[14].sql, /qa_findings_status_at_positive/);
	assert.match(migrations[14].sql, /UPDATE qa_findings SET status = 'open' WHERE status IS NULL/);
	assert.match(migrations[20].sql, /ADD COLUMN selected_tests text\[\]/);
	assert.match(migrations[20].sql, /qa_runs_selected_tests_valid/);
	assert.match(migrations[24].sql, /CREATE TABLE IF NOT EXISTS test_cases/);
	assert.match(migrations[24].sql, /test_cases_number_unique UNIQUE \(organization_id, project_id, case_number\)/);
	assert.match(migrations[24].sql, /ALTER TABLE qa_runs\s+ADD COLUMN IF NOT EXISTS test_case_id text/);
	assert.match(migrations[24].sql, /CREATE POLICY test_cases_tenant_isolation ON test_cases/);
	assert.match(migrations[34].sql, /ADD COLUMN IF NOT EXISTS scope_selection jsonb/);
	assert.match(migrations[34].sql, /qa_runs_scope_selection_values/);
	assert.match(migrations[36].sql, /CREATE TABLE qase_auth_password_resets/);
	assert.match(migrations[37].sql, /ADD COLUMN IF NOT EXISTS kind/);
	assert.match(migrations[36].sql, /token_hash char\(64\) NOT NULL/);
	assert.match(migrations[36].sql, /FORCE ROW LEVEL SECURITY/);
	assert.doesNotMatch(migrations[36].sql, /token text|reset_token text/i);
	assert.match(migrations[38].sql, /CREATE TABLE qase_auth_recovery_codes/);
	assert.match(migrations[38].sql, /code_hash char\(64\) NOT NULL/);
	assert.match(migrations[38].sql, /FORCE ROW LEVEL SECURITY/);
	assert.doesNotMatch(migrations[38].sql, /code text(?!.*hash)/i);
	assert.match(migrations[39].sql, /founder_project_state/);
});

test('applies pending migrations in order and records them with parameters', async () => {
	const pool = new FakePool();
	const result = await runPostgresMigrations(pool);
	const sql = statements(pool.client);
	const migrationOrder = sql
		.map(statement => statement.match(/Qase PostgreSQL migration (\d{3})/)?.[1])
		.filter(Boolean);

	assert.equal(pool.connectCalls, 1);
	assert.deepEqual(migrationOrder, ['001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011', '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023', '024', '025', '026', '027', '028', '029', '030', '031', '032', '033', '034', '035', '036', '037', '038', '039', '040', '041', '042']);
	assert.deepEqual(result.applied.map(migration => migration.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42]);
	assert.equal(result.currentVersion, 42);
	assert.equal(result.applied.length, 42);
	assert.equal(sql.filter(statement => statement === 'BEGIN').length, 42);
	assert.equal(sql.filter(statement => statement === 'COMMIT').length, 42);
	assert.equal(sql.filter(statement => statement === 'ROLLBACK').length, 0);

	const records = pool.client.calls.filter(call => call.text.startsWith('INSERT INTO qase_schema_migrations'));
	assert.equal(records.length, 42);
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
		[12, 'account_settings'],
		[13, 'run_timing'],
		[14, 'token_usage'],
		[15, 'finding_status'],
		[16, 'run_pause'],
		[17, 'run_feedback'],
		[18, 'run_engine_device'],
		[19, 'run_cohort'],
		[20, 'run_feedback_column'],
		[21, 'qa_test_selection'],
		[22, 'security_authorization'],
		[23, 'environments'],
		[24, 'device_catalog'],
		[25, 'test_cases'],
		[26, 'cross_platform_catalog'],
		[27, 'device_runtime'],
		[28, 'bugs'],
		[29, 'test_case_provenance'],
		[30, 'environment_profile_id'],
		[31, 'matrix_runs'],
		[32, 'qa_runs_matrix_link'],
		[33, 'matrix_item_evidence'],
		[34, 'matrix_item_fixtures'],
		[35, 'run_scope_selection'],
		[36, 'matrix_item_retry_count'],
		[37, 'password_resets'],
		[38, 'password_reset_otp'],
		[39, 'recovery_codes'],
		[40, 'founder_project_state'],
		[41, 'partial_qa_verdict'],
		[42, 'hybrid_qa_state']
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

	assert.deepEqual(result, { applied: [], currentVersion: 42 });
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
