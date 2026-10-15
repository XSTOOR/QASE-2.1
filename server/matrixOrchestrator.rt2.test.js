import test from 'node:test';
import assert from 'node:assert/strict';

import { createMatrixOrchestrator } from './matrixOrchestrator.js';
import { probeLocalBrowsers } from './localBrowserRegistry.js';
await probeLocalBrowsers({ force: true });

function runsFixture() {
	const sessions = new Map();
	let created = 0;
	return {
		async create(title, options = {}) {
			created += 1;
			const session = { id: 'session-' + created, title, status: 'idle', ...options };
			sessions.set(session.id, session);
			return session;
		},
		async get(id) { return sessions.get(id); },
		finish(id, outcome) { const session = sessions.get(id); if (session) Object.assign(session, outcome); },
		sessionCount: () => sessions.size
	};
}

function item(overrides = {}) {
	return {
		id: 'item-0', ordinal: 0, testCaseId: 'TC-1', environmentId: 'ENV-IOS-IP17PRO-26.0-CHR-151',
		profileId: 'p', platform: 'ios', device: 'iPhone 17 Pro', os: 'iOS', osVersion: '26.0',
		browser: 'Chrome', browserCode: 'chrome', browserVersion: '151', deviceType: 'mobile',
		status: 'PENDING', reason: null, browserSupport: null, sessionId: null, verdict: null,
		error: null, findings: [], startedAt: null, finishedAt: null, durationMs: null, ...overrides
	};
}

test('RT2: failed health check → UNAVAILABLE with exact reason, session never launched', async () => {
	const runs = runsFixture();
	const stored = { id: 'matrix-test', status: 'pending', items: [item()] };
	const service = {
		async get() { return structuredClone(stored); },
		async list() { return [structuredClone(stored)]; },
		async _setStatus() {},
		async updateItem(runId, itemId, patch) { Object.assign(stored.items.find((i) => i.id === itemId), patch); }
	};
	let launched = 0;
	const hooks = {
		emit() {},
		checkEnvironmentHealth: async () => ({
			verdict: 'BLOCKED',
			reason: 'engine_launch: chromium engine failed to launch: missing shared library libfoo.so.0',
			checks: []
		}),
		async startSession() { launched += 1; throw new Error('must not launch'); },
		async sendTask() {}
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 150));
	const finalItem = stored.items[0];
	assert.equal(finalItem.status, 'UNAVAILABLE');
	assert.match(finalItem.reason, /engine_launch: chromium engine failed to launch: missing shared library libfoo.so.0/);
	assert.equal(launched, 0, 'a blocked item must never launch a session');
	assert.equal(runs.sessionCount(), 0);
});

test('RT2: healthy gate → item proceeds to execution normally', async () => {
	const runs = runsFixture();
	const stored = { id: 'matrix-test', status: 'pending', items: [item()] };
	const service = {
		async get() { return structuredClone(stored); },
		async list() { return [structuredClone(stored)]; },
		async _setStatus() {},
		async updateItem(runId, itemId, patch) { Object.assign(stored.items.find((i) => i.id === itemId), patch); }
	};
	let gateCalls = 0;
	const hooks = {
		emit() {},
		checkEnvironmentHealth: async () => { gateCalls += 1; return { verdict: 'READY', reason: null, checks: [] }; },
		async startSession(run, item) {
			const session = await runs.create('t', { matrixRunId: run.id });
			runs.finish(session.id, { status: 'done', report: { verdict: 'pass' }, findings: [], runtimeFacts: {} });
			return session;
		},
		async sendTask() {}
	};
	const orchestrator = createMatrixOrchestrator({ runs, matrix: service }, hooks);
	orchestrator.start('matrix-test');
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(gateCalls, 1, 'health gate must run exactly once before launch');
	assert.equal(stored.items[0].status, 'PASSED');
});
