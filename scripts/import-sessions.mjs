import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLegacySessions } from '../server/legacyImport.js';
import { runPostgresMigrations } from '../server/postgres/migrations.js';
import { createPostgresPool } from '../server/postgres/pool.js';
import { createPostgresRunRepository } from '../server/postgres/runRepository.js';
import { createTenantContext } from '../server/tenancy.js';

function usage() {
	return [
		'Usage: npm run db:import -- [--file <sessions.json>] [--apply]',
		'',
		'Without --apply this performs a read-only validation and dry run.',
		'Take a backup before applying; the source file is never modified.'
	].join('\n');
}

function parseArguments(arguments_) {
	let filePath = path.join(process.cwd(), '.qase', 'sessions.json');
	let apply = false;
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === '--apply') {
			apply = true;
		} else if (argument === '--file') {
			const candidate = arguments_[++index];
			if (!candidate) throw new Error('--file requires a path.');
			filePath = path.resolve(candidate);
		} else if (argument === '--help' || argument === '-h') {
			console.log(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}
	return { filePath, apply };
}

const { filePath, apply } = parseArguments(process.argv.slice(2));
const prepared = readLegacySessions(filePath, {
	maxBytes: Number(process.env.QASE_LEGACY_IMPORT_MAX_BYTES) || undefined
});

console.log(`Validated ${prepared.summary.preparedSessions} legacy run(s).`);
console.log(`Source SHA-256: ${prepared.source.sha256}`);
console.log(`Interrupted stale run(s): ${prepared.summary.interruptedSessions}`);
console.log(`Removed reasoning message(s): ${prepared.summary.removedThinkingMessages}`);
console.log(`Cleared unavailable secret name(s): ${prepared.summary.clearedSecretNameEntries}`);

if (!apply) {
	console.log('\nDry run only. Re-run with --apply after backing up the source file.');
	process.exit(0);
}

const backupPath = `${filePath}.phase2-${prepared.source.sha256.slice(0, 12)}.bak`;
try {
	fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
	console.log(`Backup created: ${backupPath}`);
} catch (error) {
	if (error?.code !== 'EEXIST') throw error;
	console.log(`Using existing backup: ${backupPath}`);
}

const pool = createPostgresPool();
let repository;
try {
	await runPostgresMigrations(pool);
	repository = createPostgresRunRepository({
		pool,
		tenantContext: createTenantContext(process.env)
	});
	await repository.bootstrapTenant();
	const result = await repository.importBatch({
		sourceHash: prepared.source.sha256,
		sourcePath: path.basename(filePath),
		importerVersion: 1,
		runs: prepared.sessions
	});
	console.log(result.alreadyImported
		? '\nThis exact source was already imported; no rows were changed.'
		: `\nImported ${result.imported} run(s) transactionally.`);
} catch (error) {
	console.error(`Legacy import failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
} finally {
	if (repository) await repository.close().catch(() => undefined);
	else await pool.end().catch(() => undefined);
}
