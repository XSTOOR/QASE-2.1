#!/usr/bin/env node
/**
 * Cross-user run isolation against a real QASE server: every API route that
 * takes a run id must refuse another signed-in user, for runs of all three
 * modes (QA, SQA compliance, Founder). Bob uses his own valid session and CSRF
 * token, so a refusal proves ownership checks, not missing credentials.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { request } from 'playwright';

const { createSqaTestServer } = await import('./sqa-test-runtime.mjs');
const { createFounderReviewFixture } = await import('../server/founder/fixtureReview.js');

const dir = path.join('/tmp', `isolation-${Date.now()}`);
const runtime = await createSqaTestServer(dir, { authRequired: true });
await runtime.start();
const signUp = async name => {
	const api = await request.newContext({ baseURL: runtime.base });
	const response = await api.post('/api/auth/register', { data: { email: `${name}-${randomUUID()}@example.test`, displayName: name, password: `Isolation ${name} ${randomUUID()}` } });
	assert.equal(response.status(), 201, `${name} registers`);
	const user = await response.json();
	const csrf = decodeURIComponent((await api.storageState()).cookies.find(cookie => cookie.name === 'qase_csrf')?.value ?? '');
	return { api, user, csrf };
};
const alice = await signUp('alice');

// One run per mode, owned by Alice.
const founder = await createFounderReviewFixture();
founder.ownerUserId = alice.user.id ?? alice.user.user?.id;
const base = { status: 'done', createdAt: Date.now(), updatedAt: Date.now(), messages: [], activities: [], findings: [{ id: randomUUID(), title: 'Alice finding', severity: 'high', status: 'open', ts: Date.now() }], ownerUserId: founder.ownerUserId };
const qa = { ...base, id: randomUUID(), mode: 'qa', title: 'QA — alice', targetUrl: 'https://alice.test/' };
const sqa = { ...base, id: randomUUID(), mode: 'sqa', title: 'Compliance — alice', targetUrl: 'https://alice.test/' };
assert.ok(founder.ownerUserId, 'alice id known');
await runtime.stop();
await fs.writeFile(path.join(dir, '.qase', 'sessions.json'), JSON.stringify([qa, sqa, founder]));
await runtime.start();

const bob = await signUp('bob');
const aliceAgain = await (async () => {
	const api = await request.newContext({ baseURL: runtime.base });
	return api;
})();
const results = [];
try {
	const headers = { Origin: runtime.base, 'X-CSRF-Token': bob.csrf };
	for (const run of [qa, sqa, founder]) {
		const id = run.id;
		const finding = run.findings?.[0]?.id ?? 'x';
		const calls = [
			['GET', `/api/sessions/${id}`], ['GET', `/api/sessions/${id}/qa-evidence`], ['GET', `/api/sessions/${id}/feedback`],
			['GET', `/api/sessions/${id}/artifacts`], ['GET', `/api/sessions/${id}/artifacts/any`], ['GET', `/api/sessions/${id}/report.md`],
			['GET', `/api/sessions/${id}/fix-prompts.md`], ['GET', `/api/sessions/${id}/report.pdf`], ['GET', `/api/sessions/${id}/events`],
			['PATCH', `/api/sessions/${id}/findings/${finding}`, { status: 'fixed' }], ['POST', `/api/sessions/${id}/message`, { text: 'hijack' }],
			['POST', `/api/sessions/${id}/answer`, { answer: 'x' }], ['POST', `/api/sessions/${id}/credentials`, { username: 'u', password: 'p' }],
			['POST', `/api/sessions/${id}/stop`, {}], ['POST', `/api/sessions/${id}/feedback`, { rating: 1 }], ['POST', `/api/sessions/${id}/drytis/push`, {}],
			['DELETE', `/api/sessions/${id}`]
		];
		for (const [method, url, data] of calls) {
			const response = await bob.api.fetch(url, { method, headers, ...(data ? { data } : {}), timeout: 15000 }).catch(error => ({ status: () => `error ${error.message}` }));
			let status = response.status();
			// DELETE is idempotent: a run you cannot see answers 200 { deleted: false } with no side
			// effects, exactly like an id that does not exist (so it discloses nothing).
			if (method === 'DELETE' && status === 200) status = (await response.json()).deleted === false ? '200 nothing deleted' : 200;
			results.push({ mode: run.mode, method, url: url.replace(id, ':id'), status });
		}
	}
	// Device sessions: Alice requests one; Bob cannot list, read or cancel it.
	const aliceHeaders = { Origin: runtime.base, 'X-CSRF-Token': alice.csrf };
	const envs = await (await alice.api.get('/api/environments?limit=50')).json().catch(() => ({}));
	const environment = (envs.environments ?? envs.items ?? envs ?? [])[0];
	const requested = environment ? await alice.api.post('/api/device-runtime/sessions', { headers: aliceHeaders, data: { environmentId: environment.id, allowQueue: true } }) : undefined;
	const deviceSession = requested && requested.status() < 300 ? await requested.json() : undefined;
	const deviceId = deviceSession?.sessionId ?? deviceSession?.session?.sessionId;
	if (deviceId) {
		const listed = await (await bob.api.get('/api/device-runtime/sessions')).json();
		assert.ok(!listed.sessions.some(item => item.sessionId === deviceId), 'Bob does not see Alice\'s device session');
		results.push({ mode: 'device', method: 'GET', url: '/api/device-runtime/sessions/:id', status: (await bob.api.get(`/api/device-runtime/sessions/${deviceId}`)).status() });
		results.push({ mode: 'device', method: 'POST', url: '/api/device-runtime/sessions/:id/cancel', status: (await bob.api.post(`/api/device-runtime/sessions/${deviceId}/cancel`, { headers })).status() });
		const mine = await (await alice.api.get(`/api/device-runtime/sessions/${deviceId}`)).json();
		assert.equal(mine.sessionId, deviceId, 'Alice still sees her device session');
		assert.notEqual(mine.status, 'cancelled', 'Bob could not cancel it');
	} else console.log(`device runtime: no session could be requested here (${requested ? requested.status() : 'no environments'}); device isolation not exercised`);
	results.push({ mode: 'device', method: 'POST', url: '/api/device-runtime/sessions (linked to Alice\'s run)', status: (await bob.api.post('/api/device-runtime/sessions', { headers, data: { environmentId: environment?.id, linkedRunId: qa.id } })).status() });
	const ghost = await (await bob.api.fetch(`/api/sessions/${randomUUID()}`, { method: 'DELETE', headers })).json();
	assert.deepEqual(ghost, { deleted: false }, 'an unknown id answers the same, so ownership is not disclosed');
	// Bob's own lists stay empty; Alice still owns and sees her runs afterwards.
	assert.deepEqual(await (await bob.api.get('/api/sessions')).json(), []);
	const bugs = await (await bob.api.get('/api/findings')).json();
	assert.equal((bugs.findings ?? bugs.items ?? bugs).length ?? 0, 0, 'bug tracker shows Bob none of Alice\'s findings');
	const aliceRuns = await (await alice.api.get('/api/sessions')).json();
	assert.equal(aliceRuns.length, 3, 'Alice still has her three runs (nothing was deleted by Bob)');
	const aliceQa = await (await alice.api.get(`/api/sessions/${qa.id}`)).json();
	assert.equal(aliceQa.findings[0].status, 'open', 'Bob could not change Alice\'s finding');
	assert.ok(!aliceQa.messages.some(message => /hijack/.test(message.text ?? '')), 'Bob could not post into Alice\'s run');
} finally {
	await aliceAgain.dispose();
	await runtime.stop();
}
const allowed = results.filter(item => ![403, 404, '200 nothing deleted'].includes(item.status));
for (const item of results) console.log(`${String(item.status).padEnd(6)} ${item.mode.padEnd(8)} ${item.method.padEnd(6)} ${item.url}`);
assert.equal(allowed.length, 0, `routes that did not refuse another user: ${JSON.stringify(allowed)}`);
console.log(JSON.stringify({ ok: true, checked: results.length, modes: 3 }));
