import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { closeApplicationBrowsers, drainHttpServer, installShutdownHandlers } from './processLifecycle.js';

function fixture() {
	const processLike = new EventEmitter();
	const exits = [];
	processLike.exit = code => exits.push(code);
	return { processLike, exits };
}

test('shutdown attempts remaining cleanup after a stage fails and sanitizes logs', async () => {
	const { processLike, exits } = fixture();
	const calls = [];
	const logs = [];
	const shutdown = installShutdownHandlers({
		processLike, logger: { error: (...args) => logs.push(args) },
		onDraining: signal => calls.push(signal),
		steps: [() => { throw new Error('secret connection URL'); }, () => calls.push('closed')]
	});
	await shutdown('SIGTERM');
	assert.deepEqual(calls, ['SIGTERM', 'closed']);
	assert.deepEqual(exits, [1]);
	assert.doesNotMatch(JSON.stringify(logs), /secret connection/);
});

test('shutdown exits successfully once and bounds a stuck cleanup stage', async () => {
	const healthy = fixture();
	await installShutdownHandlers({ ...healthy, steps: [async () => {}] })('SIGTERM');
	assert.deepEqual(healthy.exits, [0]);
	const stuck = fixture();
	const expired = new Promise(resolve => { stuck.processLike.exit = code => { stuck.exits.push(code); resolve(); }; });
	void installShutdownHandlers({ ...stuck, steps: [() => new Promise(() => {})], timeoutMs: 20 })('SIGTERM');
	await expired;
	assert.deepEqual(stuck.exits, [1]);
});

test('a second shutdown signal forces exit without running cleanup twice', async () => {
	const { processLike, exits } = fixture();
	let calls = 0;
	const shutdown = installShutdownHandlers({ processLike, steps: [() => { calls++; return new Promise(() => {}); }] });
	void shutdown('SIGTERM');
	await new Promise(resolve => setImmediate(resolve));
	await shutdown('SIGINT');
	assert.equal(calls, 1);
	assert.deepEqual(exits, [1]);
});

test('HTTP draining forcibly closes an unfinished response after its deadline', async () => {
	let received;
	const incoming = new Promise(resolve => { received = resolve; });
	const server = createServer((_request, response) => { response.writeHead(200); response.write('stream'); received(); });
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const request = fetch(`http://127.0.0.1:${server.address().port}`).then(response => response.text()).catch(() => 'closed');
	await incoming;
	await drainHttpServer(server, 20);
	assert.equal(await request, 'closed');
	assert.equal(server.listening, false);
	await drainHttpServer(server, 20);
});

test('browser shutdown uses local handles and closes every browser despite one failure', async () => {
	const closed = [];
	const services = {
		runs: { listLive: () => [{ id: 'a' }, { id: 'b' }], list: () => { throw new Error('database unavailable'); } },
		agent: {
			stop: id => { if (id === 'a') throw new Error('abort failed'); },
			closeBrowser: async id => { closed.push(id); }
		}
	};
	await assert.rejects(closeApplicationBrowsers(services), AggregateError);
	assert.deepEqual(closed.sort(), ['a', 'b']);
	services.agent.isRemote = true;
	await closeApplicationBrowsers(services);
	assert.equal(closed.length, 2);
});
