import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createInstanceAccess } from './instanceAccess.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner',
	actorRole: 'viewer'
});

async function fixture() {
	const access = createInstanceAccess({ tenantContext: TENANT });
	const app = express();
	app.use(express.json());
	access.mount(app);
	app.all('/api/probe', (request, response) => response.json(request.auth));
	app.use('/api', (_request, response) => response.status(404).json({ error: 'API route not found.' }));
	const server = await new Promise(resolve => {
		const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	return {
		origin,
		close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
	};
}

test('embedded access attributes every API call to the trusted process owner', async t => {
	const target = await fixture();
	t.after(target.close);
	const response = await fetch(`${target.origin}/api/probe`, {
		headers: {
			'x-qase-actor-user-id': 'request-controlled-user',
			'x-qase-role': 'viewer'
		}
	});
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		organizationId: TENANT.organizationId,
		projectId: TENANT.projectId,
		actorUserId: TENANT.actorUserId,
		email: TENANT.actorEmail,
		displayName: TENANT.actorName,
		role: 'owner'
	});
	assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('embedded access permits same-origin mutations and rejects cross-origin browser requests', async t => {
	const target = await fixture();
	t.after(target.close);
	const accepted = await fetch(`${target.origin}/api/probe`, {
		method: 'POST',
		headers: { origin: target.origin, 'content-type': 'application/json' },
		body: JSON.stringify({ organizationId: 'request-controlled' })
	});
	assert.equal(accepted.status, 200);
	assert.equal((await accepted.json()).organizationId, TENANT.organizationId);

	const foreignOrigin = await fetch(`${target.origin}/api/probe`, {
		method: 'POST', headers: { origin: 'https://attacker.example' }
	});
	assert.equal(foreignOrigin.status, 403);
	assert.deepEqual(await foreignOrigin.json(), { error: 'Cross-origin request rejected.' });

	const crossSiteRead = await fetch(`${target.origin}/api/probe`, {
		headers: { 'sec-fetch-site': 'cross-site' }
	});
	assert.equal(crossSiteRead.status, 403);
});

test('embedded access fails closed without complete trusted tenant identity', () => {
	assert.throws(() => createInstanceAccess(), /trusted tenant context/);
	assert.throws(() => createInstanceAccess({
		tenantContext: { ...TENANT, actorUserId: '' }
	}), /tenantContext\.actorUserId/);
});
