import 'dotenv/config';
import { runPostgresMigrations } from '../server/postgres/migrations.js';
import { createPostgresPool } from '../server/postgres/pool.js';

const migrationUrl = String(process.env.QASE_MIGRATION_DATABASE_URL ?? '').trim();
const pool = createPostgresPool({
	environment: migrationUrl
		? { ...process.env, QASE_DATABASE_URL: migrationUrl }
		: process.env
});
try {
	await runPostgresMigrations(pool);
	console.log('PostgreSQL migrations are up to date.');
} finally {
	await pool.end();
}
