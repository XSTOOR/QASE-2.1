#!/usr/bin/env node
/**
 * Local-store retention sweep (Phase 12 · Launch and maintain).
 *
 * Removes sessions (and their runsnapshots + workspaces) older than
 * QASE_RUN_RETENTION_DAYS (default 30). Dry-run by default; pass --apply to
 * execute. Never touches auth.json, invites.json, analytics, or run-secrets.
 *
 * Usage:
 *   npm run prune:local [-- --apply] [-- --days N] [-- --help]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const argv = process.argv.slice(2);
const help = argv.includes('--help') || argv.includes('-h');
const apply = argv.includes('--apply');
const daysIndex = argv.indexOf('--days');
const days = daysIndex !== -1 && Number.isFinite(Number(argv[daysIndex + 1])) && Number(argv[daysIndex + 1]) > 0
	? Math.floor(Number(argv[daysIndex + 1]))
	: (() => {
		const raw = Number(process.env.QASE_RUN_RETENTION_DAYS ?? '30');
		return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 30;
	})();

const qaseRoot = path.join(process.cwd(), '.qase');

if (help) {
	console.log(`Usage: npm run prune:local [-- --apply] [-- --days N]

Sweeps the local .qase store for sessions whose last update is older than
--days (default: QASE_RUN_RETENTION_DAYS or 30) and removes:
  - the session record from .qase/sessions.json
  - .qase/runsnapshots/<id>.json
  - .qase/workspaces/<id>/
Never touches auth.json, invites.json, analytics, or run-secrets*.

Default mode is a DRY RUN: prints what would be removed, changes nothing.
Pass --apply to execute.`);
	process.exit(0);
}

const sessionsPath = path.join(qaseRoot, 'sessions.json');
if (!fs.existsSync(sessionsPath)) {
	console.log(`No local store found at ${sessionsPath} — nothing to prune.`);
	process.exit(0);
}

const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
// Session IDs are canonical UUIDs; anything else in sessions.json is corrupt
// or hostile — refuse to build filesystem paths from it (a ".." id would
// escape .qase on --apply).
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeId = id => typeof id === 'string' && UUID_PATTERN.test(id);
const snapshotPath = id => path.join(qaseRoot, 'runsnapshots', `${String(id).toLowerCase()}.json`);
const workspacePath = id => path.join(qaseRoot, 'workspaces', String(id).toLowerCase());
let sessions;
try {
	sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
} catch (error) {
	console.error(`Could not parse ${sessionsPath}: ${error.message}`);
	process.exit(1);
}
if (!Array.isArray(sessions)) {
	console.error(`${sessionsPath} does not contain a session array — refusing to prune.`);
	process.exit(1);
}

// Live/interrupted runs are never swept regardless of age.
const isSweepable = session => {
	const status = session?.status;
	if (status === 'running' || status === 'awaiting_input' || status === 'interrupted') return false;
	if (!safeId(session?.id)) return false; // corrupt/hostile record — never build paths from it
	return typeof session.updatedAt === 'number' && session.updatedAt < cutoff;
};

const toRemove = sessions.filter(isSweepable);
const toKeep = sessions.filter(session => !isSweepable(session));



if (toRemove.length === 0) {
	console.log(`Local retention sweep (${days}d): 0 of ${sessions.length} sessions past cutoff. Nothing to do.`);
	process.exit(0);
}

console.log(`Local retention sweep (cutoff: sessions not updated since ${new Date(cutoff).toISOString()}):`);
for (const session of toRemove) {
	const snapshot = fs.existsSync(snapshotPath(session.id));
	const workspace = fs.existsSync(workspacePath(session.id));
	console.log(`  ${session.id}  "${(session.title ?? '').slice(0, 50)}"  updated ${new Date(session.updatedAt).toISOString()}${snapshot ? ' +snapshot' : ''}${workspace ? ' +workspace' : ''}`);
}

if (!apply) {
	console.log(`\nDRY RUN — ${toRemove.length} session(s) would be removed. Re-run with --apply to execute.`);
	process.exit(0);
}

let snapshotCount = 0;
let workspaceCount = 0;
for (const session of toRemove) {
	for (const target of [snapshotPath(session.id), workspacePath(session.id)]) {
		try {
			fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
			if (target.endsWith('.json')) snapshotCount += 1; else workspaceCount += 1;
		} catch { /* best-effort */ }
	}
}
// Atomic-ish write of the pruned session list (tmp + rename, same pattern as the store).
const tmp = `${sessionsPath}.tmp-prune-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(toKeep, null, 2));
fs.renameSync(tmp, sessionsPath);
console.log(`\nApplied — removed ${toRemove.length} session(s), ${snapshotCount} snapshot file(s), ${workspaceCount} workspace dir(s); kept ${toKeep.length}.`);
