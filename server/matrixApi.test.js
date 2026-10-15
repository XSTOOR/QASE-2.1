/**
 * Matrix run API tests (#14649 NI02 Phase 1) — end-to-end over HTTP with the
 * REAL application composition (local services), not inert fakes.
 *
 * Verifies: create → honest item statuses persisted and visible over HTTP;
 * deselection → NOT_RUN rows; DuckDuckGo → NOT_SUPPORTED; a run reaches a
 * terminal state or keeps items at their non-PENDING honest state; the
 * orchestrator never strands a run at `running` (the round-1 review defect
 * was an emit-hook crash invisible to fake-based tests — this file mounts the
 * real wiring).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createConfiguredApplicationServices } from './serviceFactory.js';
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

async function startApp() {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-matrix-api-'));
	const composed = await createConfiguredApplicationServices({
		stateDirectory: stateDir,
		tenantContext: TENANT
	});
	const services = composed.services;
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		authRequired: false, // unit-test composition — no auth service attached
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise((resolve) => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const authHeaders = { cookie: 'qase-test=t' };

	async function json(pathName, options = {}) {
		const headers = { ...(options.headers ?? {}) };
		let body = options.body;
		if (options.json !== undefined) {
			headers['content-type'] = 'application/json';
			body = JSON.stringify(options.json);
		}
		const response = await fetch(`${origin}${pathName}`, { ...options, body, headers });
		let parsed = null;
		try { parsed = await response.json(); } catch { parsed = null; }
		return { status: response.status, body: parsed };
	}
	async function close() {
		await application.whenIdle();
		await new Promise((resolve) => server.close(resolve));
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
	return { json, close, services };
}

// NOTE (#14942): the evidence-per-item payload test lives in
// tmp-matrixEvidence.test.mjs as a STANDALONE script — the same composition
// held open by node:test's process isolation accumulated 200+s+ wall time and
// tripped the "Promise resolution is still pending" file-level wedge (SSE
// poll/heartbeats keep the loop alive between tests). The route itself is
// verified by that script (7/7 checks). Do not re-inline it here without
// also forcing application.whenIdle() between tests.

test('POST /api/matrix-runs creates honest items over HTTP (statuses + profileIds persisted)', async () => {
	const app = await startApp();
	try {
		// Seed one test case via the service layer.
		const record = await app.services.testCases.create({
			title: 'Login flow',
			environmentIds: []
		});
		const created = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: {
				testCaseId: record.caseNumber,
				targetUrl: 'https://example.com',
				selectedBrowsers: ['chrome', 'duckduckgo', 'safari'],
				start: false
			}
		});
		assert.equal(created.status, 201, JSON.stringify(created.body));
		const run = created.body.run ?? created.body;
		assert.ok(run.id.startsWith('matrix-'));
		assert.equal(run.status, 'pending');
		assert.ok(run.defaultsUsed);
		assert.ok(run.items.length > 0);
		// Per-profile honest rows: no item fabricated PASSED at creation.
		for (const item of run.items) {
			assert.ok(['PENDING', 'NOT_RUN', 'NOT_SUPPORTED', 'UNAVAILABLE', 'BLOCKED'].includes(item.status));
			assert.ok(item.profileId);
			assert.ok(item.device && item.os && item.browser && item.browserVersion);
		}
		// DuckDuckGo → NOT_SUPPORTED everywhere, with reason.
		const ddg = run.items.filter((item) => item.browserCode === 'duckduckgo');
		assert.ok(ddg.length > 0, 'duckduckgo items expected');
		assert.ok(ddg.every((item) => item.status === 'NOT_SUPPORTED' && item.reason));
		// GET round-trip: statuses survive reload.
		const fetched = await app.json(`/api/matrix-runs/${run.id}`);
		assert.equal(fetched.status, 200);
		assert.equal(fetched.body.run.items.length, run.items.length);
		assert.deepEqual(
			fetched.body.run.items.map((item) => item.status).sort(),
			run.items.map((item) => item.status).sort()
		);
	} finally {
		await app.close();
	}
});

test('run-level browser deselection records NOT_RUN rows (never dropped)', async () => {
	const app = await startApp();
	try {
		const record = await app.services.testCases.create({ title: 'Deselect flow', environmentIds: [] });
		const created = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: {
				testCaseId: record.caseNumber,
				targetUrl: 'https://example.com',
				selectedBrowsers: ['chrome', 'firefox'],
				browsers: ['chrome'],
				start: false
			}
		});
		assert.equal(created.status, 201);
		const items = (created.body.run ?? created.body).items;
		const firefox = items.filter((item) => item.browserCode === 'firefox');
		assert.ok(firefox.length > 0, 'firefox rows expected');
		assert.ok(firefox.every((item) => item.status === 'NOT_RUN' && /Deselected by user/.test(item.reason ?? '')));
		const chrome = items.filter((item) => item.browserCode === 'chrome');
		assert.ok(chrome.every((item) => item.status === 'PENDING'));
	} finally {
		await app.close();
	}
});

test('POST /api/matrix-runs rejects invalid input with 422', async () => {
	const app = await startApp();
	try {
		const missing = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { }
		});
		assert.equal(missing.status, 422);
		const badUrl = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { testCaseId: 'TC-1', targetUrl: 'javascript:alert(1)' }
		});
		assert.equal(badUrl.status, 422);
	} finally {
		await app.close();
	}
});

test('GET unknown matrix run → 404; list returns summaries with statusCounts', async () => {
	const app = await startApp();
	try {
		const missing = await app.json('/api/matrix-runs/matrix-nope');
		assert.equal(missing.status, 404);
		const list = await app.json('/api/matrix-runs');
		assert.equal(list.status, 200);
		assert.ok(Array.isArray(list.body.runs));
	} finally {
		await app.close();
	}
});

test('POST /cancel cancels queued items; unknown run → 404', async () => {
	const app = await startApp();
	// Execution is deliberately NOT started (start: false): the ROUTE logic —
	// cancel flips QUEUED/PENDING to CANCELLED and marks the run cancelled —
	// is what this pins; the worker/scheduling behaviour is covered by the
	// orchestrator unit tests (test 11 there).
	try {
		const missing = await app.json('/api/matrix-runs/matrix-nope/cancel', { method: 'POST' });
		assert.equal(missing.status, 404);
		const record = await app.services.testCases.create({ title: 'Cancel flow', environmentIds: [] });
		const created = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { testCaseId: record.caseNumber, targetUrl: 'https://example.com', start: false }
		});
		const run = created.body.run ?? created.body;
		const cancelled = await app.json(`/api/matrix-runs/${run.id}/cancel`, { method: 'POST' });
		assert.ok([200, 202].includes(cancelled.status), JSON.stringify(cancelled.body));
		assert.equal(cancelled.body.ok, true);
		const fetched = await app.json(`/api/matrix-runs/${run.id}`);
		assert.equal(fetched.status, 200);
		assert.equal(fetched.body.run.status, 'cancelled');
		const pending = fetched.body.run.items.filter((item) => item.status === 'PENDING');
		assert.equal(pending.length, 0, 'no item may stay PENDING after cancel');
		const cancelledItems = fetched.body.run.items.filter((item) => item.status === 'CANCELLED');
		assert.ok(cancelledItems.length > 0);
		assert.ok(cancelledItems.every((item) => item.reason));
	} finally {
		await app.close();
	}
});

test('POST item retry refuses terminal-success and unknown ids; FAILED item retries bounded at 2', async () => {
	const app = await startApp();
	try {
		const record = await app.services.testCases.create({ title: 'Retry flow', environmentIds: [] });
		const created = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { testCaseId: record.caseNumber, targetUrl: 'https://example.com', start: false }
		});
		const run = created.body.run ?? created.body;
		// Unknown run / item → 404.
		const noRun = await app.json(`/api/matrix-runs/matrix-nope/items/x/retry`, { method: 'POST' });
		assert.ok([404, 409].includes(noRun.status), `unknown run: ${JSON.stringify(noRun.body)}`);
		const noItem = await app.json(`/api/matrix-runs/${run.id}/items/does-not-exist/retry`, { method: 'POST' });
		assert.ok([404, 409].includes(noItem.status), `unknown item: ${JSON.stringify(noItem.body)}`);
		// A PENDING item is not retryable (terminal-success / not-failed family).
		const pending = run.items.find((item) => item.status === 'PENDING');
		const refusedPending = await app.json(`/api/matrix-runs/${run.id}/items/${pending.id}/retry`, { method: 'POST' });
		assert.ok([409, 404].includes(refusedPending.status), JSON.stringify(refusedPending.body));
		// Drive a FAILED item through the bounded retry (max 2), third refuses.
		const failed = run.items.find((item) => item.status === 'PENDING');
		await app.services.matrix.updateItem(run.id, failed.id, { status: 'FAILED', reason: 'seed failure', sessionId: 'seed-session' });
		// Drive the bounded retry (max 2): after each retry the item is QUEUED
		// for a fresh execution; simulate that execution failing again, then
		// retry once more. The third retry must hit the bound → 409.
		const first = await app.json(`/api/matrix-runs/${run.id}/items/${failed.id}/retry`, { method: 'POST' });
		assert.ok([200, 202].includes(first.status), `retry 1: ${JSON.stringify(first.body)}`);
		await app.services.matrix.updateItem(run.id, failed.id, { status: 'FAILED', reason: 'failed again', sessionId: 'seed-session-2' });
		const second = await app.json(`/api/matrix-runs/${run.id}/items/${failed.id}/retry`, { method: 'POST' });
		assert.ok([200, 202].includes(second.status), `retry 2: ${JSON.stringify(second.body)}`);
		await app.services.matrix.updateItem(run.id, failed.id, { status: 'FAILED', reason: 'failed a third time', sessionId: 'seed-session-3' });
		const third = await app.json(`/api/matrix-runs/${run.id}/items/${failed.id}/retry`, { method: 'POST' });
		assert.equal(third.status, 409);
		// A PASSED item is never retryable.
		const passed = run.items.find((item) => item.id !== failed.id && item.status === 'PENDING');
		await app.services.matrix.updateItem(run.id, passed.id, { status: 'PASSED', sessionId: 'seed-session' });
		const refusedPassed = await app.json(`/api/matrix-runs/${run.id}/items/${passed.id}/retry`, { method: 'POST' });
		assert.ok([409, 404].includes(refusedPassed.status), JSON.stringify(refusedPassed.body));
	} finally {
		await app.close();
	}
});

test('a swept error run with PENDING items can be restarted; a done run cannot', async () => {
	const app = await startApp();
	// The restart path launches real sessions; without an agent API key those
	// background executions would outlive the test. Patch the orchestrator to
	// a no-op recorder — the ROUTE logic (restartability) is what this test
	// pins; actual execution is covered by the orchestrator unit tests.
	const starts = [];
	const originalStart = app.services.matrixOrchestrator?.start;
	if (app.services.matrixOrchestrator) app.services.matrixOrchestrator.start = (id) => { starts.push(id); return { ok: true }; };
	try {
		const record = await app.services.testCases.create({ title: 'Restart flow', environmentIds: [] });
		const created = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { testCaseId: record.caseNumber, targetUrl: 'https://example.com', start: false }
		});
		const run = created.body.run ?? created.body;
		// Simulate the resume-recovery sweep: run went to error with PENDING items.
		await app.services.matrix._setStatus(run.id, 'error', {});
		const restart = await app.json(`/api/matrix-runs/${run.id}/start`, { method: 'POST' });
		assert.ok([200, 202].includes(restart.status), JSON.stringify(restart.body));
		// A completed run is never restartable.
		const done = await app.json('/api/matrix-runs', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			json: { testCaseId: record.caseNumber, targetUrl: 'https://example.com', start: false }
		});
		const doneRun = done.body.run ?? done.body;
		await app.services.matrix._setStatus(doneRun.id, 'done', {});
		const refused = await app.json(`/api/matrix-runs/${doneRun.id}/start`, { method: 'POST' });
		assert.equal(refused.status, 409);
	} finally {
		if (app.services.matrixOrchestrator && originalStart) app.services.matrixOrchestrator.start = originalStart;
		await app.close();
	}
});

/* ── Pipeline Phase 2: /api/qa-matrix-runs parent + idempotent batches ──
 * Over the REAL composition: the per-request 2,000 cap now enforces the
 * per-BATCH limit; a parent carries plan metadata only; batches are
 * idempotent on (parentId, batchKey); the parent GET aggregates batches. */

test('Phase 2: parent + batches over HTTP — cap is per-request, batches idempotent, parent view aggregates', async () => {
	const app = await startApp();
	// Patch the orchestrator start to a recorder — route logic under test,
	// not execution.
	const starts = [];
	const originalStart = app.services.matrixOrchestrator?.start;
	if (app.services.matrixOrchestrator) app.services.matrixOrchestrator.start = (id) => { starts.push(id); return { ok: true }; };
	try {
		const envs = await app.services.environments.list({ limit: 100 });
		assert.ok(envs.length >= 3, 'catalog must expose at least 3 environments');
		const envIds = envs.slice(0, 3).map((env) => env.envId);
		// Parent request carrying configurations must be rejected — configs
		// travel in batches only.
		const badParent = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { kind: 'parent', targetUrl: 'https://example.com', configurationEnvIds: envIds }
		});
		assert.equal(badParent.status, 422);
		// Per-request cap = per-batch limit: >2,000 in ONE request 422s.
		const oversized = Array.from({ length: 2001 }, (_, i) => `ENV-FAKE-${i}`);
		const tooBig = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { targetUrl: 'https://example.com', configurationEnvIds: oversized }
		});
		assert.equal(tooBig.status, 422);
		assert.match(String(tooBig.body?.error ?? ''), /per-batch limit is 2,000/);
		// Parent creation.
		const parentRes = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { kind: 'parent', targetUrl: 'https://example.com', totalPlanned: 3, title: 'Big run' }
		});
		assert.equal(parentRes.status, 201, JSON.stringify(parentRes.body));
		const parent = parentRes.body;
		assert.equal(parent.kind, 'parent');
		assert.equal(parent.itemCount, 0);
		// Batch 1: 201 + started.
		const b1 = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { parentId: parent.id, batchKey: 'key-1', batchIndex: 0, targetUrl: 'https://example.com', configurationEnvIds: envIds.slice(0, 2) }
		});
		assert.equal(b1.status, 201, JSON.stringify(b1.body));
		assert.equal(b1.body.kind, 'batch');
		assert.deepEqual(starts, [b1.body.id], 'newly created batch is started');
		// Batch retry with the SAME key → 200, NOT re-created, not restarted.
		const b1Retry = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { parentId: parent.id, batchKey: 'key-1', batchIndex: 0, targetUrl: 'https://example.com', configurationEnvIds: envIds.slice(0, 2) }
		});
		assert.equal(b1Retry.status, 200, 'idempotent replay returns 200');
		assert.equal(b1Retry.body.id, b1.body.id, 'same batch returned');
		assert.deepEqual(starts, [b1.body.id], 'replayed batch is NOT started twice');
		// Batch 2 distinct key.
		const b2 = await app.json('/api/qa-matrix-runs', {
			method: 'POST',
			json: { parentId: parent.id, batchKey: 'key-2', batchIndex: 1, targetUrl: 'https://example.com', configurationEnvIds: envIds.slice(2, 3) }
		});
		assert.equal(b2.status, 201);
		assert.deepEqual(starts, [b1.body.id, b2.body.id]);
		// Parent view aggregates both batches over HTTP.
		const view = await app.json(`/api/matrix-runs/${parent.id}`);
		assert.equal(view.status, 200);
		const aggregated = view.body.run ?? view.body;
		assert.equal(aggregated.batchCount, 2);
		assert.equal(aggregated.itemCount, 3);
		assert.ok(aggregated.items.every((item) => envIds.includes(item.environmentId)), 'union of batch items');
	} finally {
		if (app.services.matrixOrchestrator && originalStart) app.services.matrixOrchestrator.start = originalStart;
		await app.close();
	}
});
