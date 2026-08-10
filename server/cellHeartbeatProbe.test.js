import assert from 'node:assert/strict';
import test from 'node:test';
import { createCellHeartbeatProbe } from './cellHeartbeatProbe.js';

async function listen(app) {
	const server = await new Promise(resolve => {
		const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		close: () => new Promise(resolve => server.close(resolve))
	};
}

test('heartbeat probe exposes minimal liveness and fail-closed readiness', async t => {
	let ready = false;
	const probe = createCellHeartbeatProbe({ controller: { getState: () => ({ ready }) }, port: 0 });
	const server = await listen(probe.app);
	t.after(server.close);
	assert.deepEqual(await (await fetch(`${server.origin}/healthz`)).json(), { status: 'ok' });
	assert.equal((await fetch(`${server.origin}/readyz`)).status, 503);
	ready = true;
	assert.deepEqual(await (await fetch(`${server.origin}/readyz`)).json(), { status: 'ready' });
	assert.throws(() => createCellHeartbeatProbe({ controller: {}, port: 0 }), /controller state/);
});
