import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { purgeRunWorkspace, resolveRunWorkspace } from './workspaceLifecycle.js';

const RUN_ID = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';

test('workspace cleanup accepts only one canonical run directory', () => {
	const root = path.resolve('private-test-workspaces');
	assert.deepEqual(resolveRunWorkspace(RUN_ID, { root }), {
		root,
		target: path.join(root, RUN_ID)
	});
	for (const unsafe of ['../outside', '.', '', '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1/..']) {
		assert.throws(() => resolveRunWorkspace(unsafe, { root }), /canonical run UUID/);
	}
});

test('workspace cleanup removes only the selected run and is idempotent', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-governance-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const selected = path.join(root, RUN_ID);
	const kept = path.join(root, 'fb13e42d-9f18-4ca1-9da4-60a3be3f0863');
	await fs.mkdir(path.join(selected, '.state'), { recursive: true });
	await fs.mkdir(kept, { recursive: true });
	await fs.writeFile(path.join(selected, '.state', 'session.json'), 'sensitive browser state');
	await fs.writeFile(path.join(kept, 'keep.txt'), 'keep');

	assert.equal(await purgeRunWorkspace(RUN_ID, { root }), selected);
	assert.equal(await fs.stat(selected).then(() => true, () => false), false);
	assert.equal(await fs.readFile(path.join(kept, 'keep.txt'), 'utf8'), 'keep');
	await purgeRunWorkspace(RUN_ID, { root });
});
