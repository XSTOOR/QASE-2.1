import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createQaBrowser, VIEWPORTS } from './browser.js';
import { createRuntimeDiagnostics } from './runtimeDiagnostics.js';
import { checkResponse, diagnosticPolicy, readDiagnosticConfig } from './runtimePolicy.js';

test('privacy policy retains only configured public strings and removes credentials, path identifiers, query and fragment', () => {
	const policy = diagnosticPolicy({ targetUrl: 'https://example.org' }, { publicPaths: ['/api/save'], publicMessages: ['Loading failed'] });
	assert.equal(policy.url('https://name:password@example.org/api/save?token=secret#private'), 'https://example.org/api/save');
	assert.equal(policy.message('Loading failed'), 'Loading failed');
	for (const text of ['password', 'joe@example.org', 'private', '123456789']) {
		assert.ok(!policy.url('https://example.org/' + text).includes(text));
		assert.ok(!policy.message(text).includes(text));
	}
	assert.throws(() => readDiagnosticConfig('{"thresholdsMs":{"fetch":-1}}'));
});

test('contract validation inspects only bounded approved JSON and discloses no values', async () => {
	const payload = '{"ok":false,"email":"private@example.org"}';
	const response = {
		status: () => 200, headers: () => ({ 'content-length': String(payload.length), 'content-type': 'application/json' }),
		request: () => ({ sizes: async () => ({ responseBodySize: payload.length }) }), body: async () => Buffer.from(payload)
	};
	assert.deepEqual(await checkResponse(response, { fields: { ok: 'boolean' } }), {});
	assert.match((await checkResponse(response, { values: { ok: true } })).violation, /value/);
	assert.match((await checkResponse(response, { fields: { missing: 'string' } })).violation, /missing/);
	assert.match((await checkResponse(response, { contentType: 'text/html' })).violation, /content type/);
	assert.match((await checkResponse({ ...response, body: async () => Buffer.from('{') }, { fields: {} })).violation, /Malformed/);
	assert.match((await checkResponse({ ...response, headers: () => ({ 'content-encoding': 'gzip' }), body: () => assert.fail() }, { fields: {} })).gap, /bounded/);
});

test('real browser correlates authorized form actions, failed resources, exceptions, redirects and partial monitoring', { timeout: 80000 }, async t => {
	const html = '<button id="save">Save</button><form id="f"><button id="submit">Submit</button></form><button id="broken">Show</button><button id="bad">Load</button><button id="negative">Validate</button><button id="move">Next</button><button id="poll">Poll</button><p hidden id="receipt">Saved</p><script src="/app.js"></script>';
	const js = [
		"fetch('/api/poll');poll.onclick=()=>fetch('/api/poll');save.onclick=()=>fetch('/api/save?access_token=private-value',{method:'POST',headers:{Authorization:'Bearer private-value'},body:'private-value'});",
		"f.onsubmit=e=>{e.preventDefault();throw new TypeError('submit failure')};",
		"broken.onclick=()=>{throw new ReferenceError('handler failure')};",
		"bad.onclick=()=>fetch('/api/error').then(r=>r.text());negative.onclick=()=>fetch('/api/invalid').then(r=>r.text());move.onclick=()=>location.hash='/wrong';"
	].join('\n');
	const external = http.createServer((_, res) => { res.writeHead(503, { 'Access-Control-Allow-Origin': '*' }); res.end('optional service'); });
	await new Promise(r => external.listen(0, '127.0.0.1', r));
	t.after(() => { external.closeAllConnections(); external.close(); });
	const server = http.createServer((req, res) => {
		const path = req.url.split('?')[0];
		if (path === '/') { res.setHeader('Content-Type', 'text/html'); return res.end(html); }
		if (path === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(js); }
		if (path === '/api/save') return setTimeout(() => { res.setHeader('Content-Type','application/json'); res.end('{"ok":true}'); }, 50);
		if (path === '/api/error') { res.writeHead(503, {'Content-Type':'text/plain'}); return res.end('unavailable'); }
		if (path === '/api/invalid') { res.writeHead(422, {'Content-Type':'text/plain'}); return res.end('invalid'); }
		if (path === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
		if (path === '/redirect') { res.writeHead(302, { Location: '/' }); return res.end(); }
		if (path === '/hang') return;
		if (path === '/drop') { req.socket.destroy(); return; }
		res.writeHead(404); res.end();
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const origin = 'http://127.0.0.1:' + server.address().port;
	const session = { id: 'test-run', projectId: 'test-project', testCaseId: 'test-case', targetUrl: origin, engine: 'chromium' };
	const base = { origin, page: '/', endpoint: '/api/save', method: 'GET', visible: '#receipt', timeoutMs: 250 };
	const contracts = [
		{ ...base, id: 'save', control: '#save', method: 'POST', fields: { ok: 'boolean' }, slowMs: 1 },
		{ ...base, id: 'bad', control: '#bad', endpoint: '/api/error' },
		{ ...base, id: 'negative', control: '#negative', endpoint: '/api/invalid', statuses: [422] },
		{ ...base, id: 'click-error', control: '#broken', script: '/app.js', errorMessage: 'handler failure' },
		{ ...base, id: 'submit-error', control: '#submit', script: '/app.js', errorMessage: 'submit failure' },
		{ ...base, id: 'nav', control: '#move', visible: undefined, destination: '/#/right' }
	];
	const found = [];
	contracts.push({ ...base, id: 'background', control: '#poll', endpoint: '/api/poll' });
	const diagnostics = createRuntimeDiagnostics({ session, projectId: 'test-project', rawConfig: JSON.stringify({ contracts, publicPaths: ['/redirect','/drop','/hang'], publicMessages: ['approved warning'] }),
		context: () => ({ scenarioId: 'journey-1' }), onCandidate: f => found.push(f) });
	const browser = await createQaBrowser({ session, diagnostics, allowWrites: true, env: { ...process.env, QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', QASE_AGENT_CURSOR: 'false' } });
	t.after(() => browser.close());
	const { page, log } = await browser.openPage(VIEWPORTS.desktop);
	const other = await browser.openPage(VIEWPORTS.desktop);
	await page.goto(origin + '/redirect');
	assert.equal(log.runtime, diagnostics.attach(page, log, new Map()), 'one monitor per page');
	await other.page.goto(origin);
	await other.page.evaluate(() => console.error('private-value'));
	await page.evaluate(() => {
		for (let i = 0; i < 2; i++) console.warn('approved warning');
		console.log('private-value');
		Promise.reject(new Error('private-value'));
	});
	for (const rule of contracts) {
		const element = await page.$(rule.control);
		await log.runtime.action({ stepId: rule.id, name: 'click', ref: 'e2', element, run: () => element.click(), executed: () => true });
		await element.dispose();
	}
	await page.evaluate(async url => {
		await fetch(url).then(r => r.text());
		await fetch('/loop').catch(() => {});
	}, 'http://127.0.0.1:' + external.address().port + '/optional');
	const abortObserved = page.waitForEvent('requestfailed', r => r.url().endsWith('/hang'));
	await page.evaluate(async () => {
		const load = (tag, url, attr) => new Promise(r => { const e = document.createElement(tag); if (tag === 'link') e.rel = 'stylesheet'; e.onload = e.onerror = r; e[attr] = url; document.head.append(e); });
		await Promise.all([load('img','/absent.png','src'),load('script','/absent.js','src'),load('link','/absent.css','href'), new FontFace('test','url(/absent.woff)').load().catch(() => {})]);
		await fetch('/drop').catch(() => {});
		const abort = new AbortController(); fetch('/hang', { signal: abort.signal }).catch(() => {}); setTimeout(() => abort.abort(), 40);
	});
	const failed = abortObserved;
	await failed;
	const hanging = page.waitForEvent('request', r => r.url().endsWith('/hang'));
	await page.evaluate(() => { void fetch('/hang'); });
	await hanging;
	await diagnostics.flush();
	await page.close();
	await other.page.close();
	const snapshot = diagnostics.snapshot();
	const { events } = snapshot;
	const matches = cls => events.filter(e => e.classification === cls);
	assert.ok(!JSON.stringify({ snapshot, found, log: { errors: log.pageErrors, console: log.console } }).includes('private-value'));
	assert.equal(snapshot.runId, 'test-run');
	assert.equal(snapshot.projectId, 'test-project');
	assert.equal(snapshot.testCaseId, 'test-case');
	assert.equal(new Set(events.map(e => e.browserSessionId)).size, 2);
	assert.ok(events.some(e => e.type === 'console' && e.level === 'error'));
	assert.ok(events.some(e => e.text === 'approved warning' && e.count === 2));
	assert.ok(events.some(e => e.type === 'runtime' && !e.stepId), 'unhandled rejection outside the action');
	assert.ok(events.some(e => e.redirectedFrom && events.find(p => p.id === e.redirectedFrom)?.status === 302));
	assert.ok(events.some(e => e.type === 'navigation' && e.previousUrl !== e.pageUrl));
	for (const resource of ['image','script','stylesheet','font']) assert.ok(events.some(e => e.resourceType === resource && e.status === 404), resource);
	assert.ok(events.some(e => e.party === 'external' && e.status === 503 && e.classification === 'Inconclusive'));
	assert.ok(events.some(e => e.redirectedFrom && e.error === 'ERR_TOO_MANY_REDIRECTS' || e.reason?.includes('redirect limit')), 'redirect exhaustion is observable');
	assert.ok(events.some(e => e.url?.endsWith('/drop') && e.error));
	assert.ok(events.some(e => e.url?.endsWith('/hang') && (e.state === 'pending' || e.error)));
	assert.ok(events.some(e => e.contract === 'save' && e.performance?.durationMs > 1));
	assert.equal(matches('Expected Behavior').length, 1, JSON.stringify({ issues: snapshot.issues, events: events.filter(e => e.contract).map(e => [e.type,e.contract,e.state,e.status,e.classification,e.reason,e.related?.length]) }));
	assert.equal(matches('Verified Network Defect').length, 1);
	assert.equal(matches('UI and Network Mismatch').length, 1);
	assert.equal(matches('Verified Runtime Defect').length, 2);
	assert.equal(matches('Navigation Defect').length, 1);
	assert.ok(events.some(e => e.contract === 'background' && e.type === 'interaction' && e.classification === 'Inconclusive'));
	assert.equal(found.length, 5);
	for (const f of found) assert.ok(events.some(e => e.id === f.data.eventId && e.stepId && e.executed && e.expectationMet === false));
	assert.equal(page.listenerCount('pageerror'), 0);
});
