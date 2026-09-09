import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneApplication } from './app.js';

const READ = 'control-plane-read-token-more-than-32-bytes';
const WRITE = 'control-plane-write-token-more-than-32-bytes';
const CELL = '1ce430b8-513b-4a30-a01d-b1da61549c18';
const ORG = '8c135239-cc6d-4e29-9f31-d40755137811';
const PROJECT = '63e57ec3-5a83-4491-9706-2ce61763f7d1';
function repository() {
	const cell = { id: CELL, name: 'EU', region: 'eu-west-1', baseUrl: 'https://qase-eu.example.com', heartbeatAt: 1 };
	return {
		check: async () => true,
		resolve: async () => cell,
		place: async input => ({ organizationId: input.organizationId, projectId: input.projectId, cell }),
		upsertCell: async input => ({ ...cell, ...input }),
		heartbeat: async () => cell,
		disablePlacement: async () => true
	};
}
async function fixture(overrides = {}) {
	const created = createControlPlaneApplication({ repository: overrides.repository ?? repository(), readToken: READ, writeToken: WRITE, environment: {}, isDraining: overrides.isDraining });
	const server = await new Promise(resolve => {
		const candidate = created.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

test('control API keeps probes public and routing metadata bearer protected', async t => {
	const target = await fixture();
	t.after(target.close);
	assert.equal((await fetch(`${target.origin}/healthz`)).status, 200);
	assert.equal((await fetch(`${target.origin}/readyz`)).status, 200);
	const path = `/internal/v1/placements/${ORG}/${PROJECT}`;
	assert.equal((await fetch(`${target.origin}${path}`)).status, 401);
	const resolved = await fetch(`${target.origin}${path}`, { headers: { authorization: `Bearer ${READ}` } });
	assert.deepEqual(await resolved.json(), { cellId: CELL, baseUrl: 'https://qase-eu.example.com', region: 'eu-west-1' });
});

test('control API fails readiness while draining without requiring a database call', async t => {
	const database = repository();
	database.check = () => { throw new Error('draining must not query the database'); };
	const target = await fixture({ repository: database, isDraining: () => true });
	t.after(target.close);
	assert.equal((await fetch(`${target.origin}/healthz`)).status, 200);
	const readiness = await fetch(`${target.origin}/readyz`);
	assert.equal(readiness.status, 503);
	assert.deepEqual(await readiness.json(), { status: 'not_ready' });
});

test('read credential cannot mutate while write credential can register and place', async t => {
	const target = await fixture();
	t.after(target.close);
	const cellPath = `/internal/v1/cells/${CELL}`;
	const body = JSON.stringify({ id: ORG, name: 'EU', region: 'eu-west-1', baseUrl: 'https://qase-eu.example.com' });
	assert.equal((await fetch(`${target.origin}${cellPath}`, {
		method: 'PUT', headers: { authorization: `Bearer ${READ}`, 'content-type': 'application/json' }, body
	})).status, 401);
	const registered = await fetch(`${target.origin}${cellPath}`, {
		method: 'PUT', headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' }, body
	});
	assert.equal(registered.status, 200);
	assert.equal((await registered.json()).id, CELL, 'path cell ID must override an untrusted body ID');
	const placement = await fetch(`${target.origin}/internal/v1/placements/${ORG}/${PROJECT}`, {
		method: 'PUT', headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' }, body: '{}'
	});
	assert.equal(placement.status, 200);
});

test('control API validates separate long credentials and maps no-capacity to 503', async t => {
	assert.throws(() => createControlPlaneApplication({ repository: repository(), readToken: 'short', writeToken: WRITE }), /32 bytes/);
	assert.throws(() => createControlPlaneApplication({ repository: repository(), readToken: READ, writeToken: READ }), /different/);
	const unavailable = repository();
	unavailable.place = async () => { throw Object.assign(new Error('No healthy Qase cell is available for this placement.'), { code: 'QASE_NO_HEALTHY_CELL' }); };
	const target = await fixture({ repository: unavailable });
	t.after(target.close);
	const response = await fetch(`${target.origin}/internal/v1/placements/${ORG}/${PROJECT}`, {
		method: 'PUT', headers: { authorization: `Bearer ${WRITE}`, 'content-type': 'application/json' }, body: '{}'
	});
	assert.equal(response.status, 503);
});
