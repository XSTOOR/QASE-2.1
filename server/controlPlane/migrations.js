import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPostgresMigrations } from '../postgres/migrations.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTROL_MIGRATIONS_DIRECTORY = path.join(here, 'migrations');
export const CONTROL_MIGRATION_LOCK_KEY = 1_363_235_654;

export function runControlPlaneMigrations(pool) {
	return runPostgresMigrations(pool, {
		directory: CONTROL_MIGRATIONS_DIRECTORY,
		lockKey: CONTROL_MIGRATION_LOCK_KEY
	});
}
