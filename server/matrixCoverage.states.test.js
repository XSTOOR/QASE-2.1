/**
 * RT5 (#14757) · Coverage-state vocabulary + evidence isolation tests.
 *
 * 1. coverageStateOf: every distinct user-facing state resolves from its
 *    item record; states are never collapsed (esp. UNAVAILABLE splits into
 *    Environment/Browser/Device-Offline by recorded reason; NOT_RUN splits
 *    deselected vs pending).
 * 2. computeMatrixCoverage exposes per-state counts; unrun never Passed.
 * 3. Artifact isolation: two sessions on different environments produce
 *    disjoint artifact sets, each stamped with its own runtime identity.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageStateOf, COVERAGE_STATES, computeMatrixCoverage } from './matrixCoverage.js';
import { createArtifactStore } from './artifactStore.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('coverageStateOf resolves every distinct state without collapsing', () => {
	assert.equal(coverageStateOf({ status: 'PASSED' }).id, 'PASSED');
	assert.equal(coverageStateOf({ status: 'FAILED' }).id, 'FAILED');
	assert.equal(coverageStateOf({ status: 'NOT_SUPPORTED' }).id, 'NOT_SUPPORTED');
	assert.equal(coverageStateOf({ status: 'RUNNING' }).id, 'RUNNING');

	// NOT_RUN splits: deselected by user vs created-but-never-run.
	assert.equal(coverageStateOf({ status: 'NOT_RUN', reason: 'Deselected by user.' }).id, 'NOT_SELECTED');
	assert.equal(coverageStateOf({ status: 'NOT_RUN', reason: null }).id, 'NOT_RUN');

	// UNAVAILABLE splits by recorded reason — data-driven, never guessed.
	assert.equal(coverageStateOf({ status: 'UNAVAILABLE', reason: 'Health check blocked execution: engine launch failed' }).id, 'ENVIRONMENT_UNAVAILABLE');
	assert.equal(coverageStateOf({ status: 'UNAVAILABLE', reason: 'Health check blocked execution: emulation could not apply' }).id, 'ENVIRONMENT_UNAVAILABLE');
	assert.equal(coverageStateOf({ status: 'UNAVAILABLE', reason: 'Chromium executable missing; browser binary not launchable' }).id, 'BROWSER_UNAVAILABLE');
	assert.equal(coverageStateOf({ status: 'UNAVAILABLE', reason: 'browser runtime could not start' }).id, 'BROWSER_UNAVAILABLE');
	assert.equal(coverageStateOf({ status: 'UNAVAILABLE', reason: 'Device offline — connection lost mid-run' }).id, 'DEVICE_OFFLINE');

	// ERROR / BLOCKED → Execution Failed (except device-offline variants).
	assert.equal(coverageStateOf({ status: 'ERROR', error: 'Session crashed' }).id, 'EXECUTION_FAILED');
	assert.equal(coverageStateOf({ status: 'BLOCKED', error: 'Session paused awaiting user input' }).id, 'EXECUTION_FAILED');
	assert.equal(coverageStateOf({ status: 'ERROR', error: 'device disappeared during matrix run' }).id, 'DEVICE_OFFLINE');
	assert.equal(coverageStateOf({ status: 'PENDING' }).id, 'NOT_RUN');
	// Unknown statuses never resolve to Passed.
	assert.equal(coverageStateOf({ status: 'SOMETHING_ELSE' }).id, 'EXECUTION_FAILED');
});

test('distinct labels exist for every required user-facing state', () => {
	const labels = Object.values(COVERAGE_STATES).map((state) => state.label);
	const required = ['Tested — Passed', 'Tested — Failed', 'Environment Unavailable', 'Browser Unavailable', 'Execution Failed', 'Device Offline', 'Not Selected', 'Not Supported'];
	for (const label of required) assert.ok(labels.includes(label), `missing label ${label}`);
	assert.equal(new Set(labels).size, labels.length, 'all labels distinct');
});

test('computeMatrixCoverage reports per-state counts and never marks unrun as passed', () => {
	const run = {
		id: 'r1', title: 't', status: 'done',
		items: [
			{ status: 'PASSED', platform: 'windows', deviceType: 'desktop', browserCode: 'chrome', browser: 'Chrome' },
			{ status: 'FAILED', platform: 'windows', deviceType: 'desktop', browserCode: 'edge', browser: 'Edge' },
			{ status: 'NOT_RUN', reason: 'Deselected by user.', platform: 'macos', deviceType: 'desktop', browserCode: 'firefox', browser: 'Firefox' },
			{ status: 'UNAVAILABLE', reason: 'Health check blocked execution: network unreachable', platform: 'ios', deviceType: 'phone', browserCode: 'safari', browser: 'Safari' },
			{ status: 'NOT_SUPPORTED', reason: 'DuckDuckGo is not runnable', platform: 'android', deviceType: 'phone', browserCode: 'duckduckgo', browser: 'DuckDuckGo' }
		]
	};
	const coverage = computeMatrixCoverage([run]);
	const states = coverage.execution.states;
	assert.equal(states.PASSED, 1);
	assert.equal(states.FAILED, 1);
	assert.equal(states.NOT_SELECTED, 1);
	assert.equal(states.ENVIRONMENT_UNAVAILABLE, 1);
	assert.equal(states.NOT_SUPPORTED, 1);
	assert.equal(states.NOT_RUN, 0, 'deselected is NOT_SELECTED, plain not-run is separate');
	// Gap rows carry their resolved distinct state + label.
	const gap = coverage.runs[0].gaps.find((g) => g.browser === 'Firefox');
	assert.equal(gap.coverageState, 'NOT_SELECTED');
	assert.equal(gap.coverageStateLabel, 'Not Selected');
	const envGap = coverage.runs[0].gaps.find((g) => g.browser === 'Safari');
	assert.equal(envGap.coverageState, 'ENVIRONMENT_UNAVAILABLE');
});

test('two environments produce isolated, differently-stamped artifact sets', () => {
	const dir = mkdtempSync(join(tmpdir(), 'qase-rt5-artifacts-'));
	try {
		const store = createArtifactStore({ root: dir });
		const sessionA = { id: 'sess-env-a', environmentSnapshot: { device: 'iPhone 15', os: 'iOS', osVersion: '17', browser: 'Safari', browserVersion: '17' } };
		const sessionB = {
			id: 'sess-env-b',
			environmentSnapshot: { device: 'Pixel 8', os: 'Android', osVersion: '14', browser: 'Brave', browserVersion: '136' },
			// Runtime-detected truth: the REAL Brave 154 binary launched — the
			// catalog label said 136; the stamp must prefer the runtime fact.
			runtimeFacts: {
				launchedEngineId: 'chromium',
				brandedBinary: { brand: 'brave', detectedVersion: '154.1.96.61' },
				userAgent: 'Brave-ua'
			}
		};

		const metaA = store.save(sessionA, {
			type: 'screenshot', fileName: 'final-a.jpg',
			bytes: Buffer.from('fake-jpeg-a'),
			label: 'Final frame A',
			bridgeExecution: { level: 'SIMULATED', provider: 'local', executionEngine: 'webkit', runtimeFacts: { userAgent: 'iPhone-ua' } }
		});
		store.save(sessionB, {
			type: 'screenshot', fileName: 'final-b.jpg',
			bytes: Buffer.from('fake-jpeg-b'),
			label: 'Final frame B',
			bridgeExecution: { level: 'SIMULATED', provider: 'local', executionEngine: 'chromium', runtimeFacts: { userAgent: 'Pixel-ua' } }
		});

		const listA = store.list('sess-env-a');
		const listB = store.list('sess-env-b');
		// Disjoint: each session sees only its own artifacts.
		assert.equal(listA.length, 1);
		assert.equal(listB.length, 1);
		assert.notEqual(listA[0].artifactId, listB[0].artifactId);
		// Stamped with the correct runtime identity (flat sidecar fields).
		assert.equal(listA[0].browser, 'Safari');
		assert.equal(listA[0].device, 'iPhone 15');
		// RT5: runtime-detected identity beats the catalog label — Brave 154
		// (the binary that actually launched), not the catalog's 136.
		assert.equal(listB[0].browserVersion, '154.1.96.61', 'runtime-detected binary version wins over the snapshot label');
		assert.equal(listB[0].launchedEngine, 'chromium');
		assert.equal(listB[0].observedUserAgent, 'Brave-ua');
		assert.equal(listB[0].device, 'Pixel 8');
		// The artifact id resolves only within its own session.
		assert.ok(store.get('sess-env-b', metaA.artifactId) === null || store.get('sess-env-b', metaA.artifactId).meta.browser === 'Brave');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
