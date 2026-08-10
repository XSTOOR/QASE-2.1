import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneRepository } from './repository.js';

const CELL = '1ce430b8-513b-4a30-a01d-b1da61549c18';
const ORG = '8c135239-cc6d-4e29-9f31-d40755137811';
const PROJECT = '63e57ec3-5a83-4491-9706-2ce61763f7d1';
function cellRow(overrides = {}) {
	return {
		id: CELL, name: 'Cell EU 1', region: 'eu-west-1', base_url: 'https://qase-eu.example.com',
		status: 'active', capacity_weight: 100, heartbeat_at: new Date('2026-08-11T00:00:00Z'),
		observed_queue_depth: 2, observed_oldest_queue_age_seconds: 3, lock_version: 1,
		...overrides
	};
}
function fixture(handler) {
	const calls = [];
	const client = {
		async query(text, params = []) {
			const call = { text: text.trim(), params };
			calls.push(call);
			return handler?.(call) ?? { rows: [], rowCount: 0 };
		},
		release() { calls.push({ text: 'RELEASE', params: [] }); }
	};
	let closes = 0;
	return {
		calls,
		get closes() { return closes; },
		repository: createControlPlaneRepository({
			pool: { connect: async () => client, end: async () => { closes++; } }, staleAfterSeconds: 60
		})
	};
}

test('cell registration and heartbeat validate and persist only routing observations', async () => {
	const target = fixture(call => call.text.startsWith('INSERT INTO qase_cells') || call.text.startsWith('UPDATE qase_cells')
		? { rows: [cellRow()], rowCount: 1 } : { rows: [], rowCount: 0 });
	const cell = await target.repository.upsertCell({
		id: CELL, name: 'Cell EU 1', region: 'eu-west-1', baseUrl: 'https://qase-eu.example.com', capacityWeight: 100
	});
	assert.equal(cell.baseUrl, 'https://qase-eu.example.com');
	assert.equal((await target.repository.heartbeat(CELL, { queueDepth: 2, oldestQueuedAgeSeconds: 3 })).id, CELL);
	await assert.rejects(() => target.repository.upsertCell({
		id: CELL, name: 'bad', region: 'eu', baseUrl: 'http://private.example.com'
	}), /HTTPS origin/);
	const registration = target.calls.find(call => call.text.startsWith('INSERT INTO qase_cells'));
	assert.equal(registration.params.includes('https://qase-eu.example.com'), true);
});

test('automatic placement selects a fresh active cell under lock and upserts one project mapping', async () => {
	const target = fixture(call => {
		if (call.text.startsWith('SELECT c.* FROM qase_cells c')) return { rows: [cellRow()], rowCount: 1 };
		return { rows: [], rowCount: 1 };
	});
	const placement = await target.repository.place({ organizationId: ORG, projectId: PROJECT, preferredRegion: 'eu-west-1' });
	assert.equal(placement.cell.id, CELL);
	assert.ok(target.calls.some(call => call.text.includes('FOR UPDATE OF c SKIP LOCKED')));
	const write = target.calls.find(call => call.text.startsWith('INSERT INTO qase_project_placements'));
	assert.deepEqual(write.params, [ORG, PROJECT, CELL]);
});

test('resolution fails closed for absent or stale placements and repository lifecycle is idempotent', async () => {
	const target = fixture(() => ({ rows: [], rowCount: 0 }));
	assert.equal(await target.repository.resolve(ORG, PROJECT), undefined);
	await assert.rejects(() => target.repository.place({ organizationId: ORG, projectId: PROJECT }),
		error => error.code === 'QASE_NO_HEALTHY_CELL');
	const resolve = target.calls.find(call => call.text.includes('JOIN qase_cells'));
	assert.deepEqual(resolve.params, [ORG, PROJECT, 60]);
	await Promise.all([target.repository.close(), target.repository.close()]);
	assert.equal(target.closes, 1);
});
