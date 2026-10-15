/**
 * listSessions bounding tests (#14651 NI03).
 *
 * The capped list() stays request-scoped (max 100, owner-filtered). The
 * unbounded mode exists for coverage aggregation (localServices.listAll) —
 * it must return EVERY full record with no cap, so NI04's coverage numbers
 * come from actual execution data with no runs silently dropped past 100.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

async function withFreshStore(run) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-listsessions-'));
	const previous = process.cwd();
	process.chdir(directory);
	try {
		const store = await import(`./store.js?case=${Date.now()}-${Math.random().toString(36).slice(2)}`);
		return await run(store);
	} finally {
		process.chdir(previous);
		await fs.rm(directory, { recursive: true, force: true });
	}
}

test('capped listSessions clamps to 100 (request scope unchanged)', () => withFreshStore((store) => {
	for (let i = 0; i < 120; i += 1) {
		store.createSession(`run-${i}`);
	}
	const capped = store.listSessions();
	assert.equal(capped.length, 100, 'default list stays capped at 100');
	assert.equal(store.listSessions({ limit: 500 }).length, 100, 'limit clamps to the 100 ceiling');
}));

test('unbounded listSessions returns every full record for coverage aggregation', () => withFreshStore((store) => {
	for (let i = 0; i < 120; i += 1) {
		store.createSession(`run-${i}`);
	}
	const unbounded = store.listSessions({ unbounded: true });
	assert.equal(unbounded.length, 120, 'unbounded mode must not drop sessions past 100');
	// Full records, not summaries.
	assert.ok(unbounded.every((session) => typeof session === 'object' && session.id && Array.isArray(session.messages)));
}));

test('unbounded ignores the owner filter (aggregation is cross-owner)', () => withFreshStore((store) => {
	store.createSession('owned', { ownerUserId: 'user-a' });
	store.createSession('other', { ownerUserId: 'user-b' });
	const scoped = store.listSessions({ ownerUserId: 'user-a' });
	assert.equal(scoped.length, 1, 'owner filter still applies on the capped path');
	const unbounded = store.listSessions({ unbounded: true, ownerUserId: 'user-a' });
	assert.equal(unbounded.length, 2, 'unbounded returns all owners');
}));
