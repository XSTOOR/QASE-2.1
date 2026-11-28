import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { firefox, webkit } from 'playwright';
import { runQaEngine } from './engine.js';
import { qaModelSettings } from './models.js';
import { createRuntimeDiagnostics } from './runtimeDiagnostics.js';

test('run publishes the API contract defect, its sanitized evidence, and the browser monitoring status', { timeout: 60000 }, async t => {
	const server = http.createServer((req, res) => {
		if (req.url === '/api/list') {
			res.setHeader('Content-Type', 'application/json');
			return res.end('{"wrongField":"private-data"}');
		}
		res.setHeader('Content-Type', 'text/html');
		res.end('<title>Fixture</title><h1>List</h1><script>fetch("/api/list").then(r=>r.json())</script>');
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const origin = 'http://127.0.0.1:' + server.address().port;
	const session = { id: 'phase9-fixture', mode: 'qa', engine: 'chromium', device: 'desktop', targetUrl: origin, activities: [], messages: [], todos: [], findings: [] };
	const controller = new AbortController();
	let published;
	const runStore = {
		async commit(_, kind, body) {
			if (kind === 'report') published = body.report;
			// Only authorize the entry page assessment in this fixture.
			if (kind === 'hybrid.state' && body.hybrid.phase === 'discover') controller.abort();
		},
		async addActivity(_, item) { session.activities.push(item); return item; },
		async updateActivity(_, id, change) { Object.assign(session.activities.find(a => a.id === id) ?? {}, change); },
		async addMessage(_, msg) { session.messages.push(msg); },
		async setStatus(_, status) { session.status = status; }
	};
	const env = { ...process.env, NODE_ENV: 'test', QASE_AGENT_CURSOR: 'false', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
		QASE_QA_RUNTIME_DIAGNOSTICS: JSON.stringify({ contracts: [{ id: 'list-shape', origin, page: '/', endpoint: '/api/list', method: 'GET', fields: { items: 'array' } }] }) };
	await runQaEngine({ session, env, runStore, signal: controller.signal, record: {}, settings: qaModelSettings({}, {}), artifactStore: { save: () => ({ artifactId: 'fixture-image' }) } });
	assert.equal(session.status, 'done');
	const diagnostic = published.qaEngine.runtimeDiagnostics;
	const findings = session.findings.filter(f => f.detector === 'runtime.api_response_defect');
	assert.equal(findings.length, 1, JSON.stringify(diagnostic.events.filter(e => e.contract)));
	const event = diagnostic.events.find(e => e.contract === 'list-shape' && findings[0].evidence.includes(e.id));
	assert.equal(event.method, 'GET');
	assert.equal(event.status, 200);
	assert.equal(event.classification, 'API Response Defect');
	assert.ok(published.qaEngine.sections.find(s => s.id === 'evidence').items.some(i => i.includes(event.id)));
	assert.ok(!JSON.stringify(published).includes('private-data'));
});

for (const engine of [firefox, webkit]) {
	test(engine.name() + ' captures console, runtime and response evidence without a CDP session', async t => {
		const server = http.createServer((_, res) => { res.setHeader('Content-Type','text/html'); res.end('<title>Runtime</title>'); });
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		t.after(() => { server.closeAllConnections(); server.close(); });
		const origin = 'http://127.0.0.1:' + server.address().port;
		const browser = await engine.launch();
		t.after(() => browser.close());
		const page = await browser.newPage();
		const monitor = createRuntimeDiagnostics({ session: { targetUrl: origin, id: 'portable' } });
		const log = { pageErrors: [], console: [], responses: [], failedRequests: [] };
		monitor.attach(page, log, new Map());
		await page.goto(origin);
		const exception = page.waitForEvent('pageerror');
		await page.evaluate(() => { console.warn('portable'); setTimeout(() => { throw new Error('portable'); }); });
		await exception;
		await monitor.flush();
		assert.equal(log.pageErrors.length, 1);
		assert.ok(log.console.some(entry => entry.type === 'warning'));
		assert.ok(log.responses.some(entry => entry.status === 200));
		await page.close();
		assert.equal(monitor.snapshot().status, 'Completed');
	});
}

test('concurrent pages, retention, invalid configuration, skipped monitoring and listener teardown', () => {
	const session = { targetUrl: 'https://example.org', id: 'r' };
	const log = () => ({ console: [], pageErrors: [], responses: [], failedRequests: [] });
	const page = () => Object.assign(new EventEmitter(), { url: () => session.targetUrl });
	const monitor = createRuntimeDiagnostics({ session, rawConfig: '{"maxEvents":2}' });
	const a = page(), b = page();
	monitor.attach(a, log(), new Map());
	monitor.attach(b, log(), new Map());
	const warn = (p, n) => p.emit('console', { type: () => 'warning', text: () => n, location: () => ({}) });
	warn(a, 'a'); warn(a, 'b'); warn(b, 'c');
	const history = monitor.snapshot();
	assert.equal(history.status, 'Partially Completed');
	assert.equal(history.dropped, 1);
	assert.equal(history.events.length, 2);
	assert.notEqual(history.events[0].browserSessionId, history.events[1].browserSessionId);
	a.emit('close'); b.emit('close');
	assert.equal(a.eventNames().length + b.eventNames().length, 0);
	assert.equal(createRuntimeDiagnostics({ session }).snapshot().status, 'Failed');
	const skipped = createRuntimeDiagnostics({ session, rawConfig: '{"enabled":false}' });
	skipped.attach(a, log(), new Map()); warn(a, 'a'); a.emit('close');
	assert.equal(skipped.snapshot().status, 'Skipped');
	assert.equal(skipped.snapshot().events.length, 0);
	const bad = createRuntimeDiagnostics({ session, rawConfig: '{' });
	bad.attach(b, log(), new Map()); b.emit('close');
	assert.equal(bad.snapshot().status, 'Partially Completed');
	assert.match(bad.snapshot().issues[0], /configuration/);
});
