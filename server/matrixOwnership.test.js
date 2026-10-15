import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createMatrixRoutes } from './matrixApi.js';

test('matrix HTTP status, control and events are owner scoped without restricting the scheduler', async t => {
	const records = [
		{ id: 'matrix-own', ownerUserId: 'owner', items: [] },
		{ id: 'matrix-other', ownerUserId: 'other', items: [] }
	];
	let controlled = 0;
	const matrix = { list: async () => records, get: async id => records.find(r => r.id === id) };
	const app = express();
	app.use((req, _res, next) => { req.auth = { userId: 'owner' }; next(); });
	createMatrixRoutes({ matrix, orchestrator: { isActive: () => false, cancel: () => { controlled++; } }, onError: (_err, res) => res.sendStatus(500) })(app);
	const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
	t.after(() => new Promise(resolve => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}/api/matrix-runs`;
	assert.deepEqual((await (await fetch(base)).json()).runs.map(r => r.id), ['matrix-own']);
	assert.equal((await fetch(`${base}/matrix-own`)).status, 200);
	for (const [suffix, method] of [['', 'GET'], ['/events', 'GET'], ['/start', 'POST'], ['/cancel', 'POST'], ['/items/x/retry', 'POST']]) {
		assert.equal((await fetch(`${base}/matrix-other${suffix}`, { method })).status, 404);
	}
	assert.equal(controlled, 0);
	assert.equal((await matrix.list()).length, 2, 'internal scheduler retains its system-level view');
});
