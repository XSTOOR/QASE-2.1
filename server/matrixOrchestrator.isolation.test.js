/**
 * RT5 (#14757) · Bulk isolation audit.
 *
 * One environment failing MID-BULK must not affect any other item's result:
 * every item gets its own session, its own evidence set, and its own
 * honest terminal state. Also verifies the coverage-state mapping of the
 * run's outcomes end-to-end (orchestrator status → coverageStateOf).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMatrixOrchestrator } from './matrixOrchestrator.js';
import { coverageStateOf } from './matrixCoverage.js';
import { probeLocalBrowsers } from './localBrowserRegistry.js';
await probeLocalBrowsers({ force: true });

function item(overrides = {}) {
	return {
		id: `item-${overrides.browserCode ?? 'chrome'}-${overrides.os ?? 'win'}`,
		ordinal: 0,
		testCaseId: 'TC-1',
		environmentId: 'ENV-X',
		profileId: `profile-${overrides.browserCode ?? 'chrome'}`,
		platform: 'windows',
		device: 'Desktop',
		os: 'Windows',
		osVersion: '11',
		browser: overrides.browser ?? 'Chrome',
		browserCode: overrides.browserCode ?? 'chrome',
		browserVersion: '151',
		deviceType: 'desktop',
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

test('mid-bulk failure of one environment leaves every other item intact', async () => {
	const items = [
		item({ id: 'a', browserCode: 'chrome', browser: 'Chrome', profileId: 'win11-chrome' }),
		item({ id: 'b', browserCode: 'edge', browser: 'Edge', profileId: 'win11-edge' }),
		item({ id: 'c', browserCode: 'firefox', browser: 'Firefox', profileId: 'win11-firefox' })
	];
	const stored = { id: 'bulk-1', title: 'Bulk isolation', targetUrl: 'https://example.com', status: 'pending', items };
	const sessions = new Map();
	let created = 0;
	const sessionStore = {
		async create(title, options = {}) {
			created += 1;
			const session = { id: `session-${created}`, title, status: 'running', ...options };
			sessions.set(session.id, session);
			return session;
		},
		async get(id) { return sessions.get(id); }
	};
	const service = {
		async get() { return stored; },
		async list() { return [stored]; },
		async _setStatus() {},
		async updateItem(_runId, itemId, patch) {
			const target = stored.items.find((candidate) => candidate.id === itemId);
			assert.ok(target, `unknown item ${itemId}`);
			Object.assign(target, patch);
		}
	};
	const hooks = {
		emit: () => {},
		startSession: async (run, itm) => {
			const session = await sessionStore.create(`${run.title} — ${itm.device}`, { matrixRunId: run.id, environmentId: itm.environmentId });
			// Environment B dies MID-SESSION (a crash after launch); A and C
			// complete normally with their own verdicts.
			if (itm.id === 'b') {
				session.status = 'error';
				session.detail = 'Chromium crashed mid-run (simulated engine death)';
			} else {
				session.status = 'done';
				session.report = { verdict: itm.id === 'a' ? 'pass' : 'fail' };
			}
			return session;
		},
		sendTask: async () => {}
	};

	const orchestrator = createMatrixOrchestrator({ runs: sessionStore, matrix: service }, hooks);
	const started = orchestrator.start('bulk-1');
	assert.equal(started.ok, true);
	// Fire-and-forget: wait for completion.
	await new Promise((resolve) => setTimeout(resolve, 300));
	assert.equal(orchestrator.isActive('bulk-1'), false);

	const byId = Object.fromEntries(stored.items.map((itm) => [itm.id, itm]));
	// Every item reached its own terminal state — B's crash did not leak.
	assert.equal(byId.a.status, 'PASSED');
	assert.equal(byId.b.status, 'ERROR');
	assert.equal(byId.b.error, 'Chromium crashed mid-run (simulated engine death)');
	assert.equal(byId.c.status, 'FAILED');
	// Independent sessions per item — never shared.
	assert.notEqual(byId.a.sessionId, byId.b.sessionId);
	assert.notEqual(byId.b.sessionId, byId.c.sessionId);
	assert.equal(new Set([byId.a.sessionId, byId.b.sessionId, byId.c.sessionId]).size, 3);
	// The crashed item's coverage state is Execution Failed — the healthy
	// ones keep Tested-Passed / Tested-Failed.
	assert.equal(coverageStateOf(byId.a).id, 'PASSED');
	assert.equal(coverageStateOf(byId.b).id, 'EXECUTION_FAILED');
	assert.equal(coverageStateOf(byId.c).id, 'FAILED');
	// Findings carry the exact environment when recorded.
	if (byId.c.findings?.length) {
		const finding = byId.c.findings[0];
		assert.ok(finding.environment, 'finding carries its environment block');
		assert.equal(finding.environment.profileId, 'win11-firefox');
		assert.equal(finding.environment.sessionId, byId.c.sessionId);
		assert.equal(finding.environment.matrixRunId, 'bulk-1');
	}
});
