/**
 * Run dispatcher. Every mode runs on its own host-orchestrated engine:
 *
 *   QA       server/qa/       automated testing (JEV verification + reasoning model)
 *   SQA      server/sqa/      compliance testing (reasoning model, CleanSlate SDK stage agent)
 *   Founder  server/founder/  business review (reasoning model, CleanSlate SDK stage agent)
 *
 * Engines own their browser and models. The live record (runStore.liveFor)
 * carries running / controller / bridge / question waiters between the HTTP
 * layer and the running engine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runQaTurn } from './qa/index.js';
import { runSqaTurn } from './sqa/index.js';
import { runFounderTurn } from './founder/index.js';

const SNAPSHOT_DIR = path.join(process.cwd(), '.qase', 'runsnapshots');
const snapshotPathFor = sessionId => path.join(SNAPSHOT_DIR, `${sessionId}.json`);

/** Snapshot written by earlier versions for boot-time recovery; read-only now. */
export function loadRunSnapshot(sessionId) {
	try {
		return JSON.parse(fs.readFileSync(snapshotPathFor(sessionId), 'utf8'))?.snapshot ?? null;
	} catch {
		return null;
	}
}

/** Index of persisted snapshots: [{ sessionId, ownerUserId, savedAt }]. */
export function listRunSnapshots() {
	try {
		return fs.readdirSync(SNAPSHOT_DIR)
			.filter(name => name.endsWith('.json'))
			.map(name => {
				try {
					const record = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, name), 'utf8'));
					return { sessionId: record.sessionId ?? name.replace(/\.json$/, ''), ownerUserId: typeof record.ownerUserId === 'string' ? record.ownerUserId : undefined, savedAt: Number(record.savedAt) || 0 };
				} catch {
					return null;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

export function deleteRunSnapshot(sessionId) {
	try { fs.rmSync(snapshotPathFor(sessionId), { force: true }); } catch { /* already gone */ }
}

/** Stops an idle run's live browser frames; engines close their browser when a run ends. */
export async function closeBrowser(sessionId, runStore) {
	const record = runStore.liveFor(sessionId);
	clearTimeout(record.idleTimer);
	record.idleTimer = undefined;
	try { record.bridge?.stopFrames?.(); } catch { /* best effort */ }
}

/** Engines need no SDK runtime constructed ahead of the turn. */
export async function ensureRuntime(session, runStore) {
	return runStore.liveFor(session.id);
}

/** Runs one turn of a session on its mode's engine. */
export async function runTurn(session, input, runStore) {
	if (session.mode === 'sqa') return runSqaTurn(session, input, runStore);
	if (session.mode === 'founder') return runFounderTurn(session, input, runStore);
	return runQaTurn(session, input, runStore);
}
