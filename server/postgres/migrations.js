import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_NAME = /^(\d{3})_([a-z0-9_]+)\.sql$/;

export const MIGRATIONS_DIRECTORY = path.join(here, 'migrations');
export const MIGRATION_ADVISORY_LOCK_KEY = 1_363_235_653;

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS qase_schema_migrations (
	version integer PRIMARY KEY,
	name text NOT NULL UNIQUE,
	checksum text NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
	CONSTRAINT qase_schema_migrations_version_positive CHECK (version > 0),
	CONSTRAINT qase_schema_migrations_checksum_valid CHECK (checksum ~ '^[0-9a-f]{64}$')
)`;

function checksum(sql) {
	return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Loads and checks the ordered, forward-only SQL migration set. */
export async function loadMigrations(directory = MIGRATIONS_DIRECTORY) {
	const entries = await fs.readdir(directory, { withFileTypes: true });
	const migrations = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;
		const match = entry.name.match(MIGRATION_NAME);
		if (!match) {
			throw new Error(`Invalid PostgreSQL migration filename: ${entry.name}`);
		}
		const sql = await fs.readFile(path.join(directory, entry.name), 'utf8');
		if (!sql.trim()) {
			throw new Error(`PostgreSQL migration is empty: ${entry.name}`);
		}
		migrations.push({
			version: Number(match[1]),
			name: match[2],
			filename: entry.name,
			checksum: checksum(sql),
			sql
		});
	}

	migrations.sort((left, right) => left.version - right.version);
	if (migrations.length === 0) {
		throw new Error(`No PostgreSQL migrations found in ${directory}`);
	}
	for (let index = 0; index < migrations.length; index++) {
		const migration = migrations[index];
		if (index > 0 && migrations[index - 1].version === migration.version) {
			throw new Error(`Duplicate PostgreSQL migration version: ${migration.version}`);
		}
		if (index > 0 && migration.version <= migrations[index - 1].version) {
			throw new Error('PostgreSQL migrations are not strictly ordered.');
		}
	}
	return migrations;
}

function validateAppliedMigrations(migrations, rows) {
	const applied = [...rows]
		.map(row => ({
			version: Number(row.version),
			name: String(row.name),
			checksum: String(row.checksum)
		}))
		.sort((left, right) => left.version - right.version);

	for (let index = 0; index < applied.length; index++) {
		const recorded = applied[index];
		const local = migrations[index];
		if (!local || local.version !== recorded.version) {
			throw new Error(
				`Database migration history is not a known contiguous prefix at version ${recorded.version}.`
			);
		}
		if (local.name !== recorded.name) {
			throw new Error(
				`PostgreSQL migration ${recorded.version} name mismatch: database=${recorded.name}, source=${local.name}.`
			);
		}
		if (local.checksum !== recorded.checksum) {
			throw new Error(
				`PostgreSQL migration ${recorded.version} checksum mismatch; applied migrations are immutable.`
			);
		}
	}

	return applied;
}

async function rollback(client, migrationError) {
	try {
		await client.query('ROLLBACK');
	} catch (rollbackError) {
		if (migrationError && typeof migrationError === 'object') {
			migrationError.rollbackError = rollbackError;
		}
	}
}

/**
 * Applies pending migrations while holding a session advisory lock.
 *
 * `pool` must expose `connect()` returning a dedicated client with `query()` and
 * `release()`. A dedicated connection is required because advisory locks are
 * session-scoped and must be released on the same connection that acquired them.
 */
export async function runPostgresMigrations(pool, options = {}) {
	if (!pool || typeof pool.connect !== 'function') {
		throw new TypeError('A PostgreSQL pool with connect() is required.');
	}

	const migrations = await loadMigrations(options.directory ?? MIGRATIONS_DIRECTORY);
	const lockKey = options.lockKey ?? MIGRATION_ADVISORY_LOCK_KEY;
	const client = await pool.connect();
	if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
		throw new TypeError('The PostgreSQL pool returned an invalid client.');
	}

	let locked = false;
	let failure;
	let outcome;

	try {
		await client.query('SELECT pg_advisory_lock($1::bigint)', [lockKey]);
		locked = true;
		await client.query(BOOTSTRAP_SQL);
		const history = await client.query(
			'SELECT version, name, checksum FROM qase_schema_migrations ORDER BY version'
		);
		const applied = validateAppliedMigrations(migrations, history.rows ?? []);
		const pending = migrations.slice(applied.length);
		const newlyApplied = [];

		for (const migration of pending) {
			await client.query('BEGIN');
			try {
				await client.query(migration.sql);
				await client.query(
					'INSERT INTO qase_schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
					[migration.version, migration.name, migration.checksum]
				);
				await client.query('COMMIT');
				newlyApplied.push({
					version: migration.version,
					name: migration.name,
					checksum: migration.checksum
				});
			} catch (error) {
				await rollback(client, error);
				throw error;
			}
		}

		outcome = {
			applied: newlyApplied,
			currentVersion: migrations.at(-1).version
		};
	} catch (error) {
		failure = error;
	} finally {
		if (locked) {
			try {
				await client.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey]);
			} catch (unlockError) {
				if (!failure) failure = unlockError;
				else if (failure && typeof failure === 'object') failure.unlockError = unlockError;
			}
		}
		try {
			await client.release();
		} catch (releaseError) {
			if (!failure) failure = releaseError;
			else if (failure && typeof failure === 'object') failure.releaseError = releaseError;
		}
	}

	if (failure) throw failure;
	return outcome;
}

// Short alias retained for focused tooling and tests.
export const runMigrations = runPostgresMigrations;
