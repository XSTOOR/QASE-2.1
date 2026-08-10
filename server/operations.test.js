import assert from 'node:assert/strict';
import express from 'express';
import test from 'node:test';
import { createOperationalControls } from './operations.js';

const TOKEN = 'phase-five-metrics-token-at-least-32-bytes';

async function listen(app) {
	const server = await new Promise(resolve => {
		const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	return { origin, close: () => new Promise(resolve => server.close(resolve)) };
}

test('request telemetry uses generated IDs and normalized routes', async t => {
	const controls = createOperationalControls({ environment: {}, now: (() => {
		let value = 0n;
		return () => (value += 10_000_000n);
	})() });
	const app = express();
	app.use(controls.middleware);
	app.get('/api/sessions/:id', (_request, response) => response.json({ ok: true }));
	const server = await listen(app);
	t.after(server.close);
	const response = await fetch(`${server.origin}/api/sessions/secret-run-id`);
	assert.equal(response.status, 200);
	assert.match(response.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
	const metrics = await controls.render();
	assert.match(metrics, /route="\/api\/sessions\/:id"/);
	assert.doesNotMatch(metrics, /secret-run-id/);
});

test('mutation concurrency rejects excess work without limiting reads', async t => {
	let release;
	const held = new Promise(resolve => { release = resolve; });
	let enter;
	const entered = new Promise(resolve => { enter = resolve; });
	const controls = createOperationalControls({ environment: {}, mutationLimit: 1 });
	const app = express();
	app.use(controls.middleware);
	app.post('/api/work', async (_request, response) => { enter(); await held; response.json({ ok: true }); });
	app.get('/api/work', (_request, response) => response.json({ ok: true }));
	const server = await listen(app);
	t.after(server.close);
	const first = fetch(`${server.origin}/api/work`, { method: 'POST' });
	await entered;
	const read = await fetch(`${server.origin}/api/work`);
	assert.equal(read.status, 200);
	const rejected = await fetch(`${server.origin}/api/work`, { method: 'POST' });
	assert.equal(rejected.status, 503);
	assert.equal(rejected.headers.get('retry-after'), '1');
	release();
	assert.equal((await first).status, 200);
	assert.match(await controls.render(), /qase_http_overload_rejections_total 1/);
});

test('metrics endpoint is disabled without a token and protected when enabled', async t => {
	assert.throws(() => createOperationalControls({ metricsToken: 'short' }), /at least 32 bytes/);
	const controls = createOperationalControls({ metricsToken: TOKEN });
	const app = express();
	app.use(controls.middleware);
	controls.mount(app, { queue: { stats: async () => ({ queued: 7, leased: 2, oldestQueuedAgeSeconds: 11, expiredLeases: 1 }) } });
	const server = await listen(app);
	t.after(server.close);
	assert.equal((await fetch(`${server.origin}/metrics`)).status, 401);
	const response = await fetch(`${server.origin}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
	assert.equal(response.status, 200);
	const body = await response.text();
	assert.match(body, /qase_execution_jobs\{status="queued"\} 7/);
	assert.match(body, /qase_execution_oldest_queued_age_seconds 11/);
});
