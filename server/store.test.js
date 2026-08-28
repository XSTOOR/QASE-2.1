import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { createFounderState } from './founderService.js';

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

test('local JSON persistence round-trips Founder Mode independently from QA and SQA', async t => {
	const originalDirectory = process.cwd();
	const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-founder-store-test-'));
	t.after(async () => {
		process.chdir(originalDirectory);
		await fs.rm(isolatedDirectory, { recursive: true, force: true });
	});
	process.chdir(isolatedDirectory);
	const first = await import(`./store.js?founder-write=${Date.now()}`);
	const session = first.createSession('Founder — Example');
	session.mode = 'founder';
	session.founder = createFounderState({
		authorizationConfirmed: true,
		target: { name: 'Example', release: '1.0.0', environment: 'staging' },
		productContext: { stage: 'mvp', primaryGoal: 'Validate demand' }
	}, () => 1_786_896_000_000);
	first.emit(session, 'founder.created');
	first.flushSessions();

	const second = await import(`./store.js?founder-read=${Date.now()}`);
	second.loadSessions();
	const restored = second.getSession(session.id);
	assert.equal(restored.mode, 'founder');
	assert.equal(restored.founder.scope.target.name, 'Example');
	assert.equal(restored.founder.scope.productContext.stage, 'mvp');
	assert.equal(restored.sqa, undefined);
	assert.equal(second.listSessions()[0].mode, 'founder');
	second.flushSessions();
});

test('local run creation binds a Drytis integration without storing submitted source content', async t => {
	const originalDirectory = process.cwd();
	const isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'qase-drytis-store-test-'));
	t.after(async () => {
		process.chdir(originalDirectory);
		await fs.rm(isolatedDirectory, { recursive: true, force: true });
	});
	process.chdir(isolatedDirectory);
	const store = await import(`./store.js?drytis=${Date.now()}`);
	const id = 'fe25868f-45f3-45cc-84a5-69fec3c42de1';
	const session = store.createSession('Drytis project', {
		id,
		targetUrl: 'https://preview.example.test/',
		findings: [{ id: 'a2c92a2f-b571-4f0d-9a6b-58be04c0afca', title: 'Static issue' }],
		drytisIntegration: {
			schemaVersion: '2026-08-1',
			externalReviewId: id,
			snapshotSha256: `sha256:${'a'.repeat(64)}`
		}
	});
	assert.equal(session.id, id);
	assert.equal(session.targetUrl, 'https://preview.example.test/');
	assert.equal(session.findings.length, 1);
	assert.equal(session.drytisIntegration.externalReviewId, id);
	assert.throws(() => store.createSession('Duplicate', { id }), error => error.code === 'QASE_RUN_ID_CONFLICT');
	store.flushSessions();

	const serialized = await fs.readFile(path.join(isolatedDirectory, '.qase', 'sessions.json'), 'utf8');
	assert.doesNotMatch(serialized, /sourceSnapshot|fileContent|submitted source/i);
	const restoredStore = await import(`./store.js?drytis-read=${Date.now()}`);
	restoredStore.loadSessions();
	assert.deepEqual(restoredStore.getSession(id).drytisIntegration, session.drytisIntegration);
	restoredStore.flushSessions();
});
