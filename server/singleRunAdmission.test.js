import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleRunAdmission } from './singleRunAdmission.js';

test('busy server refuses before creating any run and does not expose another user’s work', async () => {
	const admit = createSingleRunAdmission({ matrix: { list: async () => [{ id: 'private', ownerUserId: 'other', status: 'running', items: [{ status: 'RUNNING' }] }] }, orchestrator: { canStartImmediately: () => false } });
	const result = await admit('me', () => assert.fail('must not create'));
	assert.equal(result.status, 503); assert.equal(result.body.code, 'QA_CAPACITY_BUSY');
	assert.doesNotMatch(JSON.stringify(result), /private|other/);
});
test('repeated launch returns the owner’s active run without starting or queuing another', async () => {
	const run = { id: 'mine', ownerUserId: 'me', status: 'running', items: [{ status: 'QUEUED' }] };
	const admit = createSingleRunAdmission({ matrix: { list: async () => [run], get: async () => run }, orchestrator: { canStartImmediately: () => false } });
	const result = await admit('me', () => assert.fail('duplicate'));
	assert.equal(result.body.id, 'mine'); assert.equal(result.body.reused, true);
});
test('concurrent submissions cannot pass admission during a create await', async () => {
	let release;
	const barrier = new Promise(resolve => { release = resolve; });
	let created = 0;
	const admit = createSingleRunAdmission({ matrix: { list: async () => [] }, orchestrator: { canStartImmediately: () => true } });
	const first = admit('me', async () => { created++; await barrier; return { status: 201 }; });
	const second = await admit('me', () => assert.fail('duplicate'));
	assert.equal(second.status, 409); release(); assert.equal((await first).status, 201); assert.equal(created, 1);
});
test('failed admission releases its lock so retry works and completed runs do not block', async () => {
	const admit = createSingleRunAdmission({ matrix: { list: async () => [{ ownerUserId: 'me', status: 'done', items: [{ status: 'PASSED' }] }] }, orchestrator: { canStartImmediately: () => true } });
	await assert.rejects(admit('me', async () => { throw new Error('offline'); }));
	assert.equal((await admit('me', async () => ({ status: 201 }))).status, 201);
});
