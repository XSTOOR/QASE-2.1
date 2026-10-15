/**
 * #14942 Phase 4 — evidence payload regression (server route level).
 * Standalone (no node:test) so the long-lived SSE/poll wiring cannot wedge the
 * runner: asserts, prints a summary line, process.exit codes the result.
 */
import assert from 'node:assert/strict';
import { createApplication } from '../server/app.js';
import { createInstanceAccess } from '../server/instanceAccess.js';
import { createConfiguredApplicationServices } from '../server/serviceFactory.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TENANT = Object.freeze({
	organizationId: '11111111-1111-1111-1111-111111111111',
	projectId: '22222222-2222-2222-2222-222222222222',
	actorUserId: '33333333-3333-3333-3333-333333333333',
	actorEmail: 'owner@drytis.example',
	actorName: 'Matrix Test'
});

const t0 = Date.now();
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-matrix-evidence-'));
const composed = await createConfiguredApplicationServices({ stateDirectory: stateDir, tenantContext: TENANT });
const services = composed.services;
const application = createApplication({
	services,
	access: createInstanceAccess({ tenantContext: TENANT }),
	authRequired: false,
	sseHeartbeatMs: 60_000
});
const server = await new Promise((resolve) => {
	const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
});
const origin = `http://127.0.0.1:${server.address().port}`;
const json = async (p, o = {}) => {
	const headers = { ...(o.headers ?? {}) };
	let body = o.body;
	if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
	const response = await fetch(`${origin}${p}`, { ...o, body, headers });
	let parsed = null;
	try { parsed = await response.json(); } catch {}
	return { status: response.status, body: parsed };
};

const log = (step) => console.log(`[evidence] ${step} (+${Date.now() - t0}ms)`);
let failures = 0;
const check = (name, fn) => {
	try { fn(); console.log(`PASS ${name}`); }
	catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`); }
};

try {
	const envIds = ['ENV-IOS-IP15PROMAX-17.0-SAF-17.0'];
	const bug = await services.bugs.create({ title: 'Nav broken on Safari', severity: 'high', environmentId: envIds[0], linkedRunId: null });
	log('bug seeded');
	const tc = await services.testCases.create({ title: 'Evidence payload', environmentIds: [] });
	const created = await json('/api/matrix-runs', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		json: { testCaseId: tc.caseNumber, targetUrl: 'https://example.com', start: false, configurationEnvIds: envIds }
	});
	check('create returns 201', () => assert.equal(created.status, 201));
	const run = created.body.run ?? created.body;
	const target = run.items[0];
	await services.matrix.updateItem(run.id, target.id, {
		status: 'FAILED', verdict: 'fail', sessionId: 'session-ev',
		runtimeFacts: { launchedEngine: 'webkit', userAgent: 'Mozilla/5.0 (iPhone)' },
		artifactRefs: [{ artifactId: 'shot-1', type: 'screenshot' }]
	});
	log('item seeded');
	const fetched = await json(`/api/matrix-runs/${run.id}`);
	check('fetch 200', () => assert.equal(fetched.status, 200));
	const item = fetched.body.run.items.find((c) => c.id === target.id);
	check('sessionId survives', () => assert.equal(item.sessionId, 'session-ev'));
	check('runtimeFacts survive', () => assert.deepEqual(item.runtimeFacts, { launchedEngine: 'webkit', userAgent: 'Mozilla/5.0 (iPhone)' }));
	check('artifactRefs survive', () => assert.equal(item.artifactRefs.length, 1));
	check('verdict survives', () => assert.equal(item.verdict, 'fail'));
	check('defects present', () => assert.ok(Array.isArray(item.defects) && item.defects.some((d) => d.bugNumber === bug.bugNumber), JSON.stringify(item.defects)));
	check('defects not merged across items', () => {
		for (const other of fetched.body.run.items.filter((c) => c.id !== target.id)) {
			assert.equal((other.defects ?? []).length, 0);
		}
	});
	log('asserts complete');
} finally {
	try { await application.whenIdle(); } catch {}
	await new Promise((r) => server.close(r));
	fs.rmSync(stateDir, { recursive: true, force: true });
}
console.log(failures === 0 ? 'RESULT: PASS (7/7 checks)' : `RESULT: FAIL (${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
