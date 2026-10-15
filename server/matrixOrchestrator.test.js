/**
 * Matrix orchestrator tests (#14633 NI02 Phase 1).
 *
 * Covers: honest outcome mapping (pass/fail/blocked/error), DuckDuckGo items
 * never launch, sessions carry the matrixRunId link, awaiting_input → BLOCKED
 * (never PASSED), runtime-unavailable → BLOCKED, sequential execution, done
 * status with counts, and the resume scan (dangling RUNNING → ERROR).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMatrixOrchestrator, statusCounts } from './matrixOrchestrator.js';
import { generateEnvironments } from './environmentCatalog.js';
import { availableParallelism, cpus, totalmem } from 'node:os';
// RT1 (#14680): browser support resolution probes real binaries on a cold
// cache (~0.5s). Prime the version-only registry once so item tests — which
// assert within 100–200ms — measure orchestration, not probe latency.
import { probeLocalBrowsers } from './localBrowserRegistry.js';
await probeLocalBrowsers({ force: true });

function item(overrides = {}) {
	return {
		id: `item-${overrides.browserCode ?? 'chrome'}`,
		ordinal: 0,
		testCaseId: 'TC-1',
		environmentId: 'ENV-IOS-IP17PRO-26.0-CHR-151',
		profileId: 'iphone17pro-ios26-chrome151',
		platform: 'ios',
		device: 'iPhone 17 Pro',
		os: 'iOS',
		osVersion: '26.0',
		browser: 'Chrome',
		browserCode: 'chrome',
		browserVersion: '151',
		deviceType: 'mobile',
		status: 'PENDING',
		reason: null,
		browserSupport: null,
		sessionId: null,
		verdict: null,
		error: null,
		findings: [],
		startedAt: null,
		finishedAt: null,
		durationMs: null,
		...overrides
	};
}

function matrixFixture({ items }) {
	const stored = {
		id: 'matrix-test',
		title: 'Matrix — Login flow',
		targetUrl: 'https://example.com',
		status: 'pending',
		items: items.map((entry, index) => item({
			// Ensure unique ids — updateItem patches by id and would otherwise
			// collide when several default items share "item-chrome".
			id: entry.id ?? `item-${index}-${entry.browserCode ?? 'chrome'}`,
			...entry,
			ordinal: index
		}))
	};
	const patches = [];
	const service = {
		async get() { return structuredClone({ ...stored, items: stored.items.map((it) => ({ ...it })) }); },
		async list() { return [structuredClone(stored)]; },
		async _setStatus(id, status, timing) {
			stored.status = status;
			stored.finishedAt = timing?.finishedAt ?? stored.finishedAt;
			patches.push({ kind: 'status', id, status });
		},
		async updateItem(runId, itemId, patch) {
			assert.equal(runId, stored.id);
			const target = stored.items.find((candidate) => candidate.id === itemId);
			assert.ok(target, `unknown item ${itemId}`);
			Object.assign(target, patch);
			patches.push({ kind: 'item', itemId, patch: { ...patch } });
		}
	};
	return { service, patches, stored };
}

/** Session store fixture: sessions complete with the given outcome. */
function runsFixture(outcomes) {
	const sessions = new Map();
	let created = 0;
	return {
		async create(title, options = {}) {
			created += 1;
			const session = { id: `session-${created}`, title, status: 'idle', ...options };
			sessions.set(session.id, session);
			return session;
		},
		async get(id) { return sessions.get(id); },
		// #16225: owner-scoped get — returns undefined when the ambient actor
		// differs from the session owner (this is the PRODUCTION bug shape:
		// boot-resumed orchestrator reads sessions created under a run owner).
		async getScoped(id, ownerId) {
			const session = sessions.get(id);
			return session && session.ownerUserId === ownerId ? session : undefined;
		},
		/** Test helper: finish a session with an outcome. */
		finish(id, outcome) {
			const session = sessions.get(id);
			if (session) Object.assign(session, outcome);
		},
		sessionCount: () => sessions.size,
		sessionsRef: sessions
	};
}

function hooksFor(runs, stored, launchBehavior = {}) {
	const launched = [];
	return {
		launched,
		startSession: launchBehavior.startSession ?? (async (matrixRun, item) => {
			const session = await runs.create(`${matrixRun.title} — ${item.device}`, {
				matrixRunId: matrixRun.id,
				environmentId: item.environmentId
			});
			launched.push({ itemId: item.id, sessionId: session.id, options: { matrixRunId: matrixRun.id } });
			if (launchBehavior.launchError) throw launchBehavior.launchError;
			return session;
		}),
		sendTask: async () => {
			if (launchBehavior.taskError) throw launchBehavior.taskError;
		},
		emit: () => {}
	};
}

test('PENDING item executes; verdict pass → PASSED with findings + duration', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null);
	// #14650: fixture verification hooks — the engine probes known-defect
	// fixtures per profile and records the actual verdict with expectation.
	hooks.resolveEnvironment = async (item) => ({ envId: item.environmentId, deviceType: 'mobile' });
	hooks.verifyFixtures = [{ id: 'login-button-overlaps-keyboard', affects: (env) => env?.deviceType === 'mobile' || env?.deviceType === 'tablet' }];
	hooks.runFixtureVerification = async ({ fixture, environment }) => ({
		reproduced: environment.deviceType === 'mobile' ? 'TRUE' : 'FALSE',
		evidence: { probe: 'ok' },
		error: null
	});
	// Finish the session the moment it is started.
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, {
			status: 'done',
			report: { verdict: 'pass' },
			runtimeFacts: { userAgent: 'Mozilla/5.0 (iPhone)', viewport: { width: 402, height: 874 }, executionLevel: 'SIMULATED', provider: 'local' },
			findings: [{ title: 'Slow login', severity: 'medium', category: 'performance' }]
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	assert.equal(orchestrator.start('matrix-test').ok, true);
	await new Promise((resolve) => setTimeout(resolve, 50));
	const finalItem = service.get && (await service.get()).items[0];
	assert.equal(finalItem.status, 'PASSED');
	assert.equal(finalItem.sessionId, 'session-1');
	assert.ok(finalItem.durationMs !== null);
	assert.equal(finalItem.findings.length, 1);
	assert.equal(finalItem.findings[0].title, 'Slow login');
	// #14650: fixture verdicts recorded from actual execution, with the
	// expectation stated alongside; runtime facts persisted per profile.
	assert.equal(finalItem.fixtureVerdicts.length, 1);
	assert.equal(finalItem.fixtureVerdicts[0].fixtureId, 'login-button-overlaps-keyboard');
	assert.equal(finalItem.fixtureVerdicts[0].reproduced, 'TRUE');
	assert.equal(finalItem.fixtureVerdicts[0].expected, 'EXPECTED');
	assert.ok(finalItem.fixtureVerdicts[0].evidence);
	assert.equal(finalItem.runtimeFacts.viewport.width, 402);
	assert.equal(finalItem.runtimeFacts.executionLevel, 'SIMULATED');
	assert.equal(finalItem.executionLevel, 'SIMULATED');
	// Session link persisted through the runs.create options.
	assert.equal(runs.sessionsRef.get('session-1').matrixRunId, 'matrix-test');
});

test('verdict fail → FAILED; verdict blocked → BLOCKED; session error → ERROR', async () => {
	const outcomes = [
		{ report: { verdict: 'fail' }, status: 'done' },
		{ report: { verdict: 'blocked' }, status: 'done' },
		{ status: 'error', detail: 'browser crashed' }
	];
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}, {}, {}] });
	let index = 0;
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, outcomes[index++]);
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	const items = (await service.get()).items;
	assert.equal(items[0].status, 'FAILED');
	assert.equal(items[1].status, 'BLOCKED');
	assert.equal(items[2].status, 'ERROR');
	assert.match(items[2].error, /browser crashed/);
});

test('awaiting_input → BLOCKED — never PASSED', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, { status: 'awaiting_input', pendingQuestion: { text: 'Proceed?' } });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 50));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'BLOCKED');
	assert.match(finalItem.error, /awaiting user input/);
});

test('RUNTIME_UNAVAILABLE at launch → BLOCKED, not ERROR', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null, {
		startSession: async () => {
			throw Object.assign(new Error('No runtime configured for REAL_DEVICE execution.'), { code: 'RUNTIME_UNAVAILABLE' });
		}
	});
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 50));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'BLOCKED');
	assert.match(finalItem.error, /Blocked:/);
});

test('NOT_SUPPORTED item (duckduckgo) never launches a session', async () => {
	const runs = runsFixture();
	const ddg = { id: 'item-duckduckgo', browserCode: 'duckduckgo', browser: 'DuckDuckGo', browserSupport: { status: 'not_supported', reason: 'mobile-only browser with no Playwright build' } };
	const { service } = matrixFixture({ items: [ddg, {}] });
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 60));
	const items = (await service.get()).items;
	assert.equal(items[0].status, 'NOT_SUPPORTED');
	assert.equal(items[0].sessionId, null);
	assert.equal(runs.sessionCount(), 1, 'duckduckgo must not have launched a session');
	assert.equal(items[1].status, 'PASSED');
});

test('NOT_RUN / non-PENDING items keep their honest state and never launch', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({
		items: [
			{ id: 'item-skipped', status: 'NOT_RUN', reason: 'Deselected by user.' },
			{ id: 'item-unsupported', status: 'NOT_SUPPORTED', reason: 'nope' }
		]
	});
	const hooks = hooksFor(runs, null);
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(runs.sessionCount(), 0);
	const items = (await service.get()).items;
	assert.equal(items[0].status, 'NOT_RUN');
	assert.equal(items[1].status, 'NOT_SUPPORTED');
});

test('double start is refused; run reaches done with counts', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		await new Promise((resolve) => setTimeout(resolve, 60));
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	const first = orchestrator.start('matrix-test');
	assert.equal(first.ok, true);
	// While running, a second start is refused.
	const second = orchestrator.start('matrix-test');
	assert.equal(second.ok, false);
	await new Promise((resolve) => setTimeout(resolve, 200));
	assert.equal(orchestrator.isActive('matrix-test'), false);
	assert.equal((await service.get()).status, 'done');
});

test('resume recovery: dangling running run + RUNNING items become ERROR interrupted', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({
		items: [
			{ id: 'item-running', status: 'RUNNING', sessionId: 'session-gone' },
			{ id: 'item-done', status: 'PASSED', sessionId: 'session-old', verdict: 'pass' }
		]
	});
	stored.status = 'running';
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooksFor(runs, null));
	await orchestrator.resumeRecovery();
	const run = await service.get();
	assert.equal(run.status, 'error');
	const running = run.items.find((candidate) => candidate.id === 'item-running');
	assert.equal(running.status, 'ERROR');
	assert.match(running.error, /Interrupted/);
	const passed = run.items.find((candidate) => candidate.id === 'item-done');
	assert.equal(passed.status, 'PASSED', 'finished items must be untouched');
});

// #16159: a restart used to strand every QUEUED item forever — POST /start
// only accepts PENDING, and the per-run worker pool only exists while this
// process orchestrates. Recovery now re-schedules them and the run resumes.
test('resume recovery (#16159): stranded QUEUED items are re-scheduled and the run resumes to completion', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({
		items: [
			{ id: 'item-queued-a', status: 'QUEUED' },
			{ id: 'item-queued-b', status: 'QUEUED' },
			{ id: 'item-passed', status: 'PASSED', verdict: 'pass', sessionId: 'session-old' }
		]
	});
	// A restart killed the orchestrator mid-drain: status stayed running (or
	// error after the classic sweep) with two items stranded QUEUED.
	stored.status = 'error';
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	await orchestrator.resumeRecovery();
	// Give the fire-and-forget resume drain time to execute both items.
	await new Promise((resolve) => setTimeout(resolve, 300));
	const run = await service.get();
	assert.equal(run.status, 'done');
	for (const id of ['item-queued-a', 'item-queued-b']) {
		const finalItem = run.items.find((candidate) => candidate.id === id);
		assert.equal(finalItem.status, 'PASSED', `${id} must be re-executed, not stranded QUEUED`);
		assert.ok(finalItem.sessionId, `${id} must carry its new session`);
	}
	const passed = run.items.find((candidate) => candidate.id === 'item-passed');
	assert.equal(passed.status, 'PASSED', 'already-finished items must be untouched');
});

test('#16225: boot-resumed run polls sessions ACROSS owners — owner-scoped get() must not read them as "disappeared"', async () => {
	// Production shape: sessions created under the run owner (621a…), polled
	// by a boot-resumed orchestrator with NO request actor. A runs.get that
	// owner-filters (default tenant actor) returned undefined → every item
	// ERROR "Session … disappeared" while the orphaned session kept running.
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{ id: 'item-a' }] });
	const OWNER = '621a-owner';
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		session.ownerUserId = OWNER; // session belongs to the run owner
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	// Owner-scoped get(): what an ambient/tenant actor would see.
	const scopedRuns = { ...runs, async get(id) { return runs.getScoped?.(id, 'default-tenant-actor'); } };
	scopedRuns.create = runs.create.bind(runs);
	scopedRuns.getAny = (id) => runs.get(id); // unscoped path the orchestrator must use
	// Start with the REAL orchestrator path (simulating a boot resume of a
	// stranded run): mark the item QUEUED in the store, then resume.
	await service.updateItem('matrix-test', 'item-a', { status: 'QUEUED' });
	stored.status = 'error';
	const orchestrator = createMatrixOrchestrator({ runs: scopedRuns, matrix: service }, hooks);
	await orchestrator.resumeRecovery();
	await new Promise((resolve) => setTimeout(resolve, 300));
	const run = await service.get();
	const item = run.items.find((candidate) => candidate.id === 'item-a');
	assert.equal(item.status, 'PASSED', 'item must complete — scoped get() must not produce "disappeared"');
	assert.doesNotMatch(item.error ?? '', /disappeared/);
});

test('#16225 negative control: with the OLD scoped get() only, the same scenario stamps "disappeared" — proves the test detects the bug', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{ id: 'item-a' }] });
	const OWNER = '621a-owner';
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		session.ownerUserId = OWNER;
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	// ONLY the scoped get() — no peek/getAny (the pre-fix orchestrator shape).
	const scopedRuns = { ...runs, async get(id) { return runs.getScoped?.(id, 'default-tenant-actor'); } };
	scopedRuns.create = runs.create.bind(runs);
	await service.updateItem('matrix-test', 'item-a', { status: 'QUEUED' });
	stored.status = 'error';
	const orchestrator = createMatrixOrchestrator({ runs: scopedRuns, matrix: service }, hooks);
	await orchestrator.resumeRecovery();
	await new Promise((resolve) => setTimeout(resolve, 300));
	const run = await service.get();
	const item = run.items.find((candidate) => candidate.id === 'item-a');
	assert.equal(item.status, 'ERROR');
	assert.match(item.error ?? '', /disappeared/, 'pre-fix behavior reproduced: scoped get() read the session as gone');
});

// #16159: the pre-RUNNING phase (support resolution / health gate / session
// creation) holds a global slot; a hang there blocked the entire queue. It is
// now bounded — a blow-through surfaces as an honest ERROR. (Explicit env
// override shortens the timeout to 1s for the test.)
test('pre-launch hang (#16159): a health gate that never resolves errors the item instead of stalling the queue forever', async () => {
	process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S = '1';
	try {
		const runs = runsFixture();
		const { service } = matrixFixture({ items: [{}, { id: 'item-after' }] });
		const hooks = hooksFor(runs, null);
		const realStart = hooks.startSession;
		let healthCalls = 0;
		hooks.checkEnvironmentHealth = () => {
			healthCalls += 1;
			// Only the FIRST item's health check hangs forever; the sibling
			// must sail through and prove the queue is not starved.
			return healthCalls === 1 ? new Promise(() => {}) : Promise.resolve({ verdict: 'PASS', checks: [] });
		};
		hooks.startSession = async (run, item) => {
			const session = await realStart(run, item);
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
			return session;
		};
		const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
		orchestrator.start('matrix-test');
		// The hung item times out (~1s) and its sibling still executes.
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const items = (await service.get()).items;
		assert.equal(items[0].status, 'ERROR');
		assert.match(items[0].error, /Pre-launch checks did not complete/);
		assert.equal(items[1].status, 'PASSED', 'sibling items must not be starved');
	} finally {
		delete process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S;
	}
});

test('pre-launch hang (#16159 review WARN-1): a startSession resolving AFTER the timeout disposes its late session instead of leaking it', async () => {
	process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S = '1';
	try {
		const runs = runsFixture();
		const { service } = matrixFixture({ items: [{}] });
		const hooks = hooksFor(runs, null);
		const realStart = hooks.startSession;
		let startSessionCalls = 0;
		hooks.startSession = async (run, item) => {
			startSessionCalls += 1;
			// Session creation outlives the 1s timeout, then resolves.
			await new Promise((resolve) => setTimeout(resolve, 1800));
			const session = await realStart(run, item);
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
			return session;
		};
		const closed = [];
		hooks.closeSessionBrowser = async (session) => { closed.push(session.id); };
		const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
		orchestrator.start('matrix-test');
		// The item times out (~1s) and errors; the late session resolves at
		// ~1.8s and must be closed exactly once (not leaked, not doubled).
		await new Promise((resolve) => setTimeout(resolve, 4000));
		const item = (await service.get()).items[0];
		assert.equal(item.status, 'ERROR');
		assert.match(item.error, /Session creation did not complete/);
		assert.equal(startSessionCalls, 1);
		assert.equal(closed.length, 1, 'late session is disposed exactly once');
	} finally {
		delete process.env.QASE_MATRIX_PRELAUNCH_TIMEOUT_S;
	}
});

test('statusCounts tallies the full honest vocabulary', () => {
	const counts = statusCounts([
		{ status: 'PASSED' }, { status: 'PASSED' }, { status: 'FAILED' },
		{ status: 'NOT_RUN' }, { status: 'NOT_SUPPORTED' }, { status: 'BLOCKED' },
		{ status: 'QUEUED' }, { status: 'CANCELLED' }
	]);
	assert.equal(counts.PASSED, 2);
	assert.equal(counts.FAILED, 1);
	assert.equal(counts.NOT_RUN, 1);
	assert.equal(counts.NOT_SUPPORTED, 1);
	assert.equal(counts.BLOCKED, 1);
	assert.equal(counts.QUEUED, 1);
	assert.equal(counts.CANCELLED, 1);
	assert.equal(counts.PENDING, 0);
	assert.deepEqual(Object.keys(counts).sort(), [
		'BLOCKED', 'CANCELLED', 'ERROR', 'FAILED', 'NOT_RUN', 'NOT_SUPPORTED', 'PASSED', 'PENDING', 'QUEUED', 'RUNNING', 'UNAVAILABLE'
	]);
});

// The catalog the items reference must exist so a smoke expansion is coherent.
test('referenced environments exist in the generated catalog (smoke)', () => {
	const all = generateEnvironments();
	const envIds = new Set(all.map((env) => env.envId));
	assert.ok(envIds.has('ENV-IOS-IP17PRO-26.0-CHR-151'), 'iPhone 17 Pro Chrome env missing');
});

/* ── Phase 3 (#14937): cancel + retry at the ORCHESTRATOR level ──── */

test('cancel(): QUEUED items → CANCELLED, worker stops claiming, run cancelled', async () => {
	const runs = runsFixture();
	const items = [{}].concat(Array.from({ length: 3 }, (_, i) => ({ id: `item-q${i}` })));
	const { service, stored } = matrixFixture({ items });
	// matrix.cancel support for the fixture service: flip QUEUED/PENDING → CANCELLED.
	service.cancel = async (runId) => {
		assert.equal(runId, stored.id);
		let cancelled = 0;
		for (const it of stored.items) {
			if (it.status === 'QUEUED' || it.status === 'PENDING') {
				it.status = 'CANCELLED';
				it.finishedAt = new Date().toISOString();
				cancelled += 1;
			}
		}
		stored.status = 'cancelled';
		return { run: stored, cancelled };
	};
	// First item hangs mid-run (never finishes) so the pool stays busy.
	const hooks = hooksFor(runs, null);
	hooks.startSession = async (matrixRun, item) => {
		const session = await runs.create(`${matrixRun.title} — ${item.device}`, {
			matrixRunId: matrixRun.id,
			environmentId: item.environmentId,
			status: 'running'
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, { ...hooks, emit: () => {} });
	assert.equal(orchestrator.start('matrix-test').ok, true);
	// Let item 1 go RUNNING.
	await new Promise((resolve) => setTimeout(resolve, 80));
	await orchestrator.cancel('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 150));
	const finalRun = await service.get();
	assert.equal(finalRun.status, 'cancelled');
	const queued = finalRun.items.filter((i) => i.status === 'CANCELLED');
	assert.ok(queued.length >= 1, `expected CANCELLED items, got ${finalRun.items.map((i) => i.status).join(',')}`);
	// No further sessions beyond the one in-flight item.
	assert.ok(runs.sessionCount() <= 2, `workers kept claiming after cancel: ${runs.sessionCount()} sessions`);
	// Settle the deliberately-hanging in-flight session so no promise stays
	// open (waitForSession would otherwise poll until MAX_ITEM_MS).
	for (const [id, session] of runs.sessionsRef) {
		if (session.status === 'running') runs.finish(id, { status: 'interrupted', detail: 'cancelled mid-run' });
	}
	await new Promise((resolve) => setTimeout(resolve, 250));
});

test('retryItem(): re-queues a FAILED item, enforces MAX 2, refuses terminal-success', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null);
	hooks.startSession = async (matrixRun, item) => {
		const session = await runs.create(`${matrixRun.title} — ${item.device}`, { matrixRunId: matrixRun.id });
		runs.finish(session.id, { status: 'done', report: { verdict: 'fail' }, findings: [] });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, { ...hooks, emit: () => {} });
	assert.equal(orchestrator.start('matrix-test').ok, true);
	await new Promise((resolve) => setTimeout(resolve, 80));
	let run = await service.get();
	const theItem = run.items[0];
	assert.equal(theItem.status, 'FAILED');
	// Retry 1 + 2 allowed.
	assert.equal((await orchestrator.retryItem('matrix-test', theItem.id)).ok, true);
	await new Promise((resolve) => setTimeout(resolve, 80));
	run = await service.get();
	assert.equal(run.items[0].retryCount, 1);
	assert.equal((await orchestrator.retryItem('matrix-test', theItem.id)).ok, true);
	await new Promise((resolve) => setTimeout(resolve, 80));
	// Retry 3 refused — bound reached.
	const refused = await orchestrator.retryItem('matrix-test', theItem.id);
	assert.equal(refused.ok, false);
	assert.match(refused.error ?? '', /retry/i);
	// PASSED items can never be retried (never fabricate a rerun).
	const runNow = await service.get();
	const passedItem = { ...runNow.items[0], status: 'PASSED', sessionId: 'session-x' };
	stored.items[0] = passedItem;
	const refusePassed = await orchestrator.retryItem('matrix-test', passedItem.id);
	assert.equal(refusePassed.ok, false);
});

/* ── Pipeline Phase 3 (#15493): unattended authorization + cleanup ── */

test('Phase 3: policy-covered question auto-answers and the item completes (PASSED, evidence recorded)', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{}] });
	stored.securityAuthorization = { confirmed: true };
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	const resumed = [];
	hooks.resumeSession = async (session, answer) => {
		resumed.push({ sessionId: session.id, answer });
		// After the auto-answer the session finishes the turn.
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return true;
	};
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, {
			status: 'awaiting_input',
			pendingQuestion: { question: 'Do I have permission to run the security scan against this target?' }
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'PASSED', 'auto-answered run completes, not BLOCKED');
	assert.equal(finalItem.autoAnswers, 1);
	assert.ok(Array.isArray(finalItem.autoAnswerEvidence) && finalItem.autoAnswerEvidence.length === 1);
	assert.match(finalItem.autoAnswerEvidence[0].question, /security scan/);
	assert.equal(resumed.length, 1, 'session resumed exactly once, same session');
});

test('Phase 3: credential question stays BLOCKED with the question carried on the item', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{}] });
	stored.securityAuthorization = { confirmed: true }; // authorization does NOT cover credentials
	const hooks = hooksFor(runs, null);
	hooks.resumeSession = async () => {
		throw new Error('resumeSession must never be called for credentials');
	};
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, {
			status: 'awaiting_input',
			pendingQuestion: { question: 'Please provide the sign-in credentials for this account.', credentialLike: true }
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'BLOCKED');
	assert.match(finalItem.error, /needs sign-in credentials/);
	assert.equal(finalItem.question, 'Please provide the sign-in credentials for this account.');
});

test('Phase 3: destructive confirmation stays BLOCKED even with authorization confirmed', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{}] });
	stored.securityAuthorization = { confirmed: true };
	const hooks = hooksFor(runs, null);
	hooks.resumeSession = async () => {
		throw new Error('resumeSession must never be called for destructive asks');
	};
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, {
			status: 'awaiting_input',
			pendingQuestion: { question: 'Confirm: delete the test account permanently?' }
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'BLOCKED');
	assert.match(finalItem.error, /destructive/);
});

test('Phase 3: unauthorized run gets NO auto-answer — plain question blocks', async () => {
	const runs = runsFixture();
	const { service, stored } = matrixFixture({ items: [{}] });
	stored.securityAuthorization = undefined;
	const hooks = hooksFor(runs, null);
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, {
			status: 'awaiting_input',
			pendingQuestion: { question: 'Do I have permission to run the security scan?' }
		});
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	const finalItem = (await service.get()).items[0];
	assert.equal(finalItem.status, 'BLOCKED');
	assert.match(finalItem.error, /does not cover/);
});

test('Phase 3: browser cleanup runs after every terminal item — exactly once per session', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}, {}] });
	const hooks = hooksFor(runs, null);
	const closed = [];
	hooks.closeSessionBrowser = async (session) => { closed.push(session.id); };
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(closed.length, 2, 'one cleanup per executed item');
	const items = (await service.get()).items;
	assert.ok(items.every((entry) => entry.status === 'PASSED'));
});

test('Phase 3: browser cleanup runs even when the item errors', async () => {
	const runs = runsFixture();
	const { service } = matrixFixture({ items: [{}] });
	const hooks = hooksFor(runs, null);
	const closed = [];
	hooks.closeSessionBrowser = async (session) => { closed.push(session.id); };
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		const session = await realStart(run, item);
		runs.finish(session.id, { status: 'error', detail: 'engine crash' });
		return session;
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(closed.length, 1, 'errored item still closes its browser');
	assert.equal((await service.get()).items[0].status, 'ERROR');
});

/* ── Pipeline Phase 4 (#15496): global admission gate & bounded concurrency ── */

function configuredParallelismForTest() {
	// Mirrors matrixOrchestrator.configuredParallelism — the env clamp makes
	// the effective budget machine-dependent (this dev container: cores=3 →
	// coreBudget=1), so tests compute what the orchestrator WILL use.
	const raw = Number(process.env.QASE_MATRIX_PARALLEL ?? 2);
	const configured = Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : 2;
	const cores = availableParallelism?.() ?? cpus()?.length ?? 4;
	const coreBudget = Math.max(1, cores - 2);
	const totalMb = Math.round(totalmem() / (1024 ** 2));
	const memBudget = Math.max(1, Math.min(8, Math.floor((totalMb - 1536) / 600)));
	return Math.min(configured, coreBudget, memBudget, 8);
}

test('Phase 4: with QASE_MATRIX_PARALLEL=3 a 9-item run never exceeds the environment-clamped budget', async () => {
	process.env.QASE_MATRIX_PARALLEL = '3';
	const budget = configuredParallelismForTest();
	const runs = runsFixture();
	const items = Array.from({ length: 9 }, (_, index) => ({ id: `p-item-${index}` }));
	const { service } = matrixFixture({ items });
	const hooks = hooksFor(runs, null);
	let concurrent = 0;
	let peak = 0;
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		concurrent += 1;
		peak = Math.max(peak, concurrent);
		const session = await realStart(run, item);
		// Each item takes a moment, so overlap is real when budget allows.
		setTimeout(() => {
			concurrent -= 1;
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		}, 60);
		return session;
	};
	const { createMatrixOrchestrator: fresh } = await import('./matrixOrchestrator.js');
	const orchestrator = fresh({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	// waitForSession polls at POLL_INTERVAL_MS=2000 — a 9-item sequential run
	// needs several poll cycles; wait generously and poll for completion.
	let finalItems = [];
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		finalItems = (await service.get()).items;
		if (finalItems.filter((item) => item.status === 'PASSED').length === 9) break;
	}
	delete process.env.QASE_MATRIX_PARALLEL;
	assert.ok(peak <= budget, `peak concurrency ${peak} exceeded the clamped budget ${budget}`);
	assert.equal(peak, budget, `expected full use of the budget (peak ${peak} vs budget ${budget})`);
	assert.equal(finalItems.filter((item) => item.status === 'PASSED').length, 9);
});

test('Phase 4: two simultaneous runs share ONE budget (global gate across runs)', async () => {
	process.env.QASE_MATRIX_PARALLEL = '2';
	const budget = configuredParallelismForTest();
	const runs = runsFixture();
	const fixtures = [matrixFixture({ items: [{}] }), matrixFixture({ items: [{}] })];
	fixtures.forEach((fixture, index) => {
		fixture.stored.id = `matrix-${index}`;
		// The fixture's updateItem asserts runId — relax it to accept either.
		const service = fixture.service;
		const originalUpdate = service.updateItem;
		service.updateItem = async (runId, itemId, patch) => (runId === fixture.stored.id ? originalUpdate(runId, itemId, patch) : undefined);
	});
	const hooks = hooksFor(runs, null);
	let concurrent = 0;
	let peak = 0;
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		concurrent += 1;
		peak = Math.max(peak, concurrent);
		const session = await realStart(run, item);
		setTimeout(() => {
			concurrent -= 1;
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		}, 80);
		return session;
	};
	const { createMatrixOrchestrator: fresh } = await import('./matrixOrchestrator.js');
	const services0 = { runs, matrix: { ...fixtures[0].service, ...Object.fromEntries(Object.entries(fixtures[1].service).map(([key, value]) => [key, typeof value === 'function' ? value.bind(fixtures[1].service) : value])) } };
	const orchestrator = fresh({ runs, matrix: fixtures[0].service }, hooks);
	// Two services on ONE orchestrator — the gate must span both runs. Point
	// the orchestrator's matrix service at a dispatcher that routes by run id.
	const routedMatrix = new Proxy({}, {
		get(_target, prop) {
			return (...args) => {
				const runId = String(args[0] ?? '');
				const target = fixtures.some((fixture) => fixture.stored.id === runId)
					? fixtures.find((fixture) => fixture.stored.id === runId).service
					: fixtures[0].service;
				const value = target[prop];
				return typeof value === 'function' ? value.apply(target, args) : value;
			};
		}
	});
	const routed = fresh({ runs, matrix: routedMatrix }, hooks);
	routed.start(fixtures[0].stored.id);
	routed.start(fixtures[1].stored.id);
	await new Promise((resolve) => setTimeout(resolve, 600));
	delete process.env.QASE_MATRIX_PARALLEL;
	assert.ok(peak <= budget, `cross-run peak ${peak} exceeded the global budget ${budget}`);
});

test('Phase 4: timeout path is wired to kill the session (static contract)', async () => {
	// The runtime floor for QASE_MATRIX_ITEM_TIMEOUT_S is 60s — a live wait
	// would wedge the suite (see matrixapi-node-test-wedge.md). Assert the
	// contract statically: waitForSession invokes agent.stop BEFORE throwing
	// MATRIX_ITEM_TIMEOUT.
	const source = (await import('node:fs')).readFileSync(new URL('./matrixOrchestrator.js', import.meta.url), 'utf8');
	const timeoutIndex = source.indexOf('MATRIX_ITEM_TIMEOUT');
	assert.ok(timeoutIndex > 0, 'timeout code exists');
	const watchdog = source.slice(Math.max(0, timeoutIndex - 600), timeoutIndex);
	assert.match(watchdog, /services\.agent\?\.stop\?\.\(sessionId\)/, 'timeout path invokes agent.stop before throwing');
});

/* ── Phase 4 round 2: slot-accounting regression (reviewer-reproduced leak) ── */

test('Phase 4 R2: cross-run handoff does NOT leak slots — repeated contention drains cleanly', async () => {
	process.env.QASE_MATRIX_PARALLEL = '1';
	const budget = configuredParallelismForTest(); // 1 on this container
	const runs = runsFixture();
	const makeFixture = (id) => {
		const fixture = matrixFixture({ items: [{}, {}] });
		fixture.stored.id = id;
		return fixture;
	};
	const fixtures = [makeFixture('matrix-a'), makeFixture('matrix-b'), makeFixture('matrix-c'), makeFixture('matrix-d')];
	// Route matrix calls by run id so ONE orchestrator spans all runs.
	const routedMatrix = new Proxy({}, {
		get(_target, prop) {
			return (...args) => {
				const runId = String(args[0] ?? '');
				const target = fixtures.find((fixture) => fixture.stored.id === runId) ?? fixtures[0];
				const value = target.service[prop];
				return typeof value === 'function' ? value.apply(target, args) : value;
			};
		}
	});
	const hooks = hooksFor(runs, null);
	let concurrent = 0;
	let peak = 0;
	const realStart = hooks.startSession;
	hooks.startSession = async (run, item) => {
		concurrent += 1;
		peak = Math.max(peak, concurrent);
		const session = await realStart(run, item);
		setTimeout(() => {
			concurrent -= 1;
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' } });
		}, 40);
		return session;
	};
	const { createMatrixOrchestrator: fresh } = await import('./matrixOrchestrator.js');
	const orchestrator = fresh({ runs, matrix: routedMatrix }, hooks);
	// Round 1: two runs contend for the single slot (waiters guaranteed).
	orchestrator.start('matrix-a');
	orchestrator.start('matrix-b');
	// Round 2: two MORE runs contend — with the leaked-counter bug these
	// deadlock (waiters never resolve); with correct accounting they drain.
	setTimeout(() => orchestrator.start('matrix-c'), 150);
	setTimeout(() => orchestrator.start('matrix-d'), 150);
	let done = false;
	for (let attempt = 0; attempt < 60; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const statuses = [];
		for (const fixture of fixtures) {
			const run = await fixture.service.get();
			statuses.push(run.status);
		}
		if (statuses.every((status) => status === 'done')) { done = true; break; }
	}
	delete process.env.QASE_MATRIX_PARALLEL;
	assert.ok(done, `all four runs must drain (statuses were: ${JSON.stringify(await Promise.all(fixtures.map(async (fixture) => (await fixture.service.get()).status)))}) — slot accounting leaked or deadlocked`);
	assert.ok(peak <= budget, `peak ${peak} exceeded budget ${budget}`);
});
