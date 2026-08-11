import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

test('local deletion aborts and disposes the existing live record without recreating it', async t => {
	const originalDirectory = process.cwd();
	const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-store-test-'));
	t.after(async () => {
		process.chdir(originalDirectory);
		await fs.rm(isolatedDirectory, { recursive: true, force: true });
	});
	process.chdir(isolatedDirectory);
	const store = await import(`./store.js?isolated=${Date.now()}`);
	const session = store.createSession('Deletion cleanup');
	const calls = [];
	const record = store.liveFor(session.id);
	record.controller = { abort: () => calls.push('abort') };
	record.dispose = () => calls.push('dispose');

	assert.equal(store.deleteSession(session.id), true);
	assert.deepEqual(calls, ['abort', 'dispose']);
	assert.equal(store.peekLive(session.id), undefined);
	assert.equal(store.deleteSession(session.id), false);
	store.flushSessions();
});
