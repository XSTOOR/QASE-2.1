import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'prune-local.mjs');

/**
 * Tests for scripts/prune-local.mjs (Phase 12 · launch and maintain): the
 * local-store retention sweep. Runs the real script as a subprocess against a
 * temp .qase fixture — never the live store.
 */
describe('prune-local retention sweep', () => {
	let dir;
	const NOW = Date.now();
	const OLD = NOW - 40 * 24 * 60 * 60 * 1000; // 40 days ago — past 30d cutoff

	const run = args => execFileSync(process.execPath, [SCRIPT, ...args], {
		cwd: dir,
		env: { ...process.env, QASE_RUN_RETENTION_DAYS: '' },
		encoding: 'utf8'
	});

	before(() => {
		dir = mkdtempSync(join(tmpdir(), 'qase-prune-'));
		mkdirSync(join(dir, '.qase'), { recursive: true });
		mkdirSync(join(dir, '.qase', 'runsnapshots'), { recursive: true });
		mkdirSync(join(dir, '.qase', 'workspaces'), { recursive: true });
		const sessions = [
			{ id: '11111111-1111-4111-8111-111111111111', title: 'Old done run', status: 'done', updatedAt: OLD, ownerUserId: 'u1' },
			{ id: '22222222-2222-4222-8222-222222222222', title: 'Old but interrupted', status: 'interrupted', updatedAt: OLD, ownerUserId: 'u1' },
			{ id: '33333333-3333-4333-8333-333333333333', title: 'Fresh run', status: 'done', updatedAt: NOW, ownerUserId: 'u1' },
			{ id: '44444444-4444-4444-8444-444444444444', title: 'Old running run', status: 'running', updatedAt: OLD, ownerUserId: 'u1' }
		];
		writeFileSync(join(dir, '.qase', 'sessions.json'), JSON.stringify(sessions, null, 2));
		writeFileSync(join(dir, '.qase', 'runsnapshots', '11111111-1111-4111-8111-111111111111.json'), '{}');
		mkdirSync(join(dir, '.qase', 'workspaces', '11111111-1111-4111-8111-111111111111'));
		writeFileSync(join(dir, '.qase', 'workspaces', '11111111-1111-4111-8111-111111111111', 'scratch.txt'), 'x');
		// Must-never-touch files.
		writeFileSync(join(dir, '.qase', 'auth.json'), '{"users":[]}');
		writeFileSync(join(dir, '.qase', 'invites.json'), '{"invites":[]}');
	});

	after(() => rmSync(dir, { recursive: true, force: true }));

	it('dry run reports the aged session without mutating anything', () => {
		const out = run([]);
		assert.match(out, /DRY RUN/);
		assert.match(out, /11111111-1111-4111-8111-111111111111/);
		const stored = JSON.parse(readFileSync(join(dir, '.qase', 'sessions.json'), 'utf8'));
		assert.equal(stored.length, 4, 'dry run must not modify sessions.json');
		assert.ok(existsSync(join(dir, '.qase', 'runsnapshots', '11111111-1111-4111-8111-111111111111.json')), 'dry run must not delete the snapshot');
	});

	it('apply removes only the aged, finished session; keeps live states, fresh runs, auth and invites', () => {
		const out = run(['--apply']);
		assert.match(out, /Applied — removed 1 session/);
		const stored = JSON.parse(readFileSync(join(dir, '.qase', 'sessions.json'), 'utf8'));
		assert.equal(stored.length, 3);
		const ids = stored.map(s => s.status);
		assert.ok(ids.includes('interrupted'), 'interrupted runs are never swept');
		assert.ok(ids.includes('running'), 'running runs are never swept');
		assert.ok(ids.includes('done'), 'fresh runs are kept');
		assert.ok(!existsSync(join(dir, '.qase', 'runsnapshots', '11111111-1111-4111-8111-111111111111.json')), 'aged snapshot removed');
		assert.ok(!existsSync(join(dir, '.qase', 'workspaces', '11111111-1111-4111-8111-111111111111')), 'aged workspace removed');
		assert.ok(existsSync(join(dir, '.qase', 'auth.json')), 'auth store untouched');
		assert.ok(existsSync(join(dir, '.qase', 'invites.json')), 'invite store untouched');
	});

	it('--days widens the window; nothing is removed when nothing qualifies', () => {
		const out = run(['--days', '90']);
		assert.match(out, /0 of 3 sessions past cutoff/);
	});

	it('refuses to build paths from non-UUID session ids (path traversal guard)', () => {
		const hostile = { id: '../../victim', title: 'hostile', status: 'done', updatedAt: OLD };
		const stored = JSON.parse(readFileSync(join(dir, '.qase', 'sessions.json'), 'utf8'));
		stored.push(hostile);
		writeFileSync(join(dir, '.qase', 'sessions.json'), JSON.stringify(stored, null, 2));
		const out = run(['--apply']);
		// The hostile record is silently ignored — reported count covers only
		// the legitimate aged session (0 remaining here) and nothing outside
		// the fixture dir is ever touched (the test would fail loudly if the
		// tmpdir itself were deleted by "../../").
		assert.doesNotMatch(out, /victim/);
		assert.ok(existsSync(dir), 'fixture root still exists — no traversal');
		// Still a valid sessions.json afterwards.
		JSON.parse(readFileSync(join(dir, '.qase', 'sessions.json'), 'utf8'));
	});
});
