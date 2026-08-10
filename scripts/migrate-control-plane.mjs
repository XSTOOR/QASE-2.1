import 'dotenv/config';
import { runControlPlaneMigrations } from '../server/controlPlane/migrations.js';
import { createPostgresPool } from '../server/postgres/pool.js';

const configuredMigrationUrl = String(process.env.QASE_CONTROL_MIGRATION_DATABASE_URL ?? '').trim();
if (process.env.NODE_ENV === 'production' && !configuredMigrationUrl) {
	throw new Error('Production control-plane migrations require a separate QASE_CONTROL_MIGRATION_DATABASE_URL.');
}
const migrationUrl = configuredMigrationUrl || String(process.env.QASE_CONTROL_DATABASE_URL ?? '').trim();
if (!migrationUrl) throw new Error('Control-plane migrations require QASE_CONTROL_MIGRATION_DATABASE_URL.');
const pool = createPostgresPool({
	environment: {
		...process.env,
		QASE_DATABASE_URL: migrationUrl,
		QASE_DATABASE_SSL: process.env.QASE_CONTROL_DATABASE_SSL ?? process.env.QASE_DATABASE_SSL,
		QASE_DATABASE_POOL_MIN: 0,
		QASE_DATABASE_POOL_MAX: 1
	},
	applicationName: 'qase-control-migrator'
});
try {
	await runControlPlaneMigrations(pool);
	console.log('Control-plane PostgreSQL migrations are up to date.');
} finally {
	await pool.end();
}
