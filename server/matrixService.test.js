/**
 * Matrix run service tests (#14633 NI02 Phase 1).
 *
 * Covers: honest per-item statuses at creation (PASSED never fabricated),
 * default-profile resolution from the live catalog, deselection → NOT_RUN,
 * DuckDuckGo → NOT_SUPPORTED, unknown environments rejected, honest-state
 * guard on updateItem, and local-backend persistence round-trip.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createMatrixService,
	createLocalMatrixBackend,
	expandMatrixItems,
	resolveDefaultProfiles,
	DEFAULT_PROFILE_RULES,
	MatrixValidationError
} from './matrixService.js';
import { generateEnvironments } from './environmentCatalog.js';

// A minimal resolved-environment list with the fields expandMatrixItems needs.
function catalogFixtures() {
	const all = generateEnvironments();
	// Slice keeps the fixture small but must include sibling browser variants
	// for the profiles under test.
	const wanted = [
		'IP17PRO', // iPhone 17 Pro iOS 26
		'PIXEL9', // Pixel 9 Android 16
		'IPADPRO13M4', // iPad Pro 13 (M4) iPadOS 26
		'GALTABS9', // Galaxy Tab S9 (Android tablet)
		'WINLAPTOP', // Windows Laptop
		'MBAIRM3' // MacBook Air (M3)
	];
	return all.filter((env) => wanted.includes(env.deviceId ?? env.deviceModelSlug ?? env.envId.split('-')[0]));
}

function fixtureEnvironments() {
	const wanted = new Set(['iPhone 17 Pro', 'Pixel 9', 'Galaxy Tab S9', 'Windows Laptop']);
	return generateEnvironments().filter((env) => wanted.has(env.device));
}

function testServices() {
	const environments = {
		async list() { return fixtureEnvironments(); }
	};
	const testCases = {
		async resolveForRun(caseNumber) {
			if (caseNumber === 'TC-1') return { caseNumber: 'TC-1', title: 'Login flow', environmentIds: [] };
			throw new Error(`Unknown test case "${caseNumber}".`);
		}
	};
	const runs = {}; // not used at creation time
	return { environments, testCases, runs };
}

function tempBackend() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-matrix-'));
	return { backend: createLocalMatrixBackend({ stateDir: dir }), dir };
}

test('default profile rules resolve all six categories against the live catalog', () => {
	const list = generateEnvironments().map((env) => ({ ...env, envId: env.envId }));
	const resolved = resolveDefaultProfiles(list);
	assert.equal(resolved.length, DEFAULT_PROFILE_RULES.length,
		`expected all ${DEFAULT_PROFILE_RULES.length} defaults, got ${resolved.map((r) => r.ruleId).join(', ')}`);
	const ruleIds = new Set(resolved.map((entry) => entry.ruleId));
	for (const rule of DEFAULT_PROFILE_RULES) {
		assert.ok(ruleIds.has(rule.id), `missing default ${rule.id}`);
	}
});

test('default resolution skips missing rules — never invents an environment', () => {
	const resolved = resolveDefaultProfiles([]);
	assert.deepEqual(resolved, []);
});

test('expandMatrixItems: supported browser → PENDING; duckduckgo → NOT_SUPPORTED with reason', async () => {
	const envs = fixtureEnvironments();
		const iphone = envs.find((env) => env.envId.startsWith('ENV-IOS-IP17PRO-'));
	assert.ok(iphone, 'iPhone 17 Pro fixture missing');
	const items = await expandMatrixItems(envs, [{ envId: iphone.envId }], ['chrome', 'duckduckgo']);
	const chrome = items.find((item) => item.browserCode === 'chrome');
	assert.equal(chrome.status, 'PENDING');
	const ddg = items.find((item) => item.browserCode === 'duckduckgo');
	assert.equal(ddg.status, 'NOT_SUPPORTED');
	assert.ok(ddg.reason, 'duckduckgo reason missing');
});

test('expandMatrixItems: Safari on Windows → NOT_SUPPORTED (inventory-level gap)', async () => {
	const envs = fixtureEnvironments();
	const windows = envs.find((env) => env.envId.startsWith('ENV-WIN-') && env.device === 'Windows Laptop');
	assert.ok(windows, 'Windows laptop fixture missing');
	const items = await expandMatrixItems(envs, [{ envId: windows.envId }], ['safari']);
	const safari = items.find((item) => item.browserCode === 'safari');
	assert.equal(safari.status, 'NOT_SUPPORTED');
	assert.match(safari.reason, /not available on windows/i);
});

test('expandMatrixItems: rejects empty profiles / browsers and unknown environments', async () => {
	const envs = fixtureEnvironments();
	await assert.rejects(() => expandMatrixItems(envs, [], ['chrome']), MatrixValidationError);
	await assert.rejects(() => expandMatrixItems(envs, [{ envId: envs[0].envId }], []), MatrixValidationError);
	await assert.rejects(() => expandMatrixItems(envs, [{ envId: 'NOPE' }], ['chrome']), MatrixValidationError);
});

test('create with defaults: one item per category × browsers, PENDING only where executable', async () => {
	const { backend, dir } = tempBackend();
	try {
		const services = testServices();
		const matrix = createMatrixService(backend, services);
		// The fixture catalog only carries a subset of default devices, so
		// resolveDefaultProfiles over the fixture list yields fewer rules —
		// create must still succeed with what it resolves.
		const run = await matrix.create({ testCaseId: 'TC-1', targetUrl: 'https://example.com', selectedBrowsers: ['chrome'] });
		assert.ok(run.id.startsWith('matrix-'));
		assert.equal(run.status, 'pending');
		assert.ok(run.defaultsUsed, 'defaultsUsed must be true when profiles omitted');
		assert.ok(run.items.length >= 1);
		for (const item of run.items) {
			assert.ok(['PENDING', 'NOT_RUN', 'NOT_SUPPORTED', 'UNAVAILABLE', 'BLOCKED'].includes(item.status),
				`item created with non-initial status ${item.status}`);
			assert.ok(item.profileId, 'every item carries a stable profileId');
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('#14651 default browser fallback: FULL agreed set including duckduckgo, DDG NOT_SUPPORTED with reason', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		// No selectedBrowsers/browsers — the default fallback must engage.
		const run = await matrix.create({ testCaseId: 'TC-1', targetUrl: 'https://example.com' });
		assert.deepEqual(run.requestedBrowsers,
			['chrome', 'edge', 'firefox', 'safari', 'opera', 'brave', 'duckduckgo'],
			'default selection is the FULL agreed 7-browser matrix');
		// Every default profile records DuckDuckGo honestly: NOT_SUPPORTED
		// with the capability reason, never PENDING, never executable.
		const ddg = run.items.filter((item) => item.browserCode === 'duckduckgo');
		assert.ok(ddg.length >= 1, 'duckduckgo items present in the default run');
		for (const item of ddg) {
			assert.equal(item.status, 'NOT_SUPPORTED');
			assert.ok(item.reason, 'NOT_SUPPORTED carries the capability reason');
			assert.ok(/duckduckgo/i.test(item.reason) || /playwright/i.test(item.reason),
				`reason explains why: ${item.reason}`);
		}
		// And at least one supported browser is executable somewhere.
		assert.ok(run.items.some((item) => item.status === 'PENDING'));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('create validates testCaseId and targetUrl', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		// #15043 (B1): targetUrl-only QA runs are now valid; BOTH missing still rejects.
		await assert.rejects(() => matrix.create({}), MatrixValidationError);
		await assert.rejects(() => matrix.create({ testCaseId: 'TC-1', targetUrl: 'ftp://nope' }), MatrixValidationError);
		await assert.rejects(() => matrix.create({ testCaseId: 'TC-X', targetUrl: 'https://example.com' }),
			(error) => error instanceof Error && /Unknown test case/.test(error.message));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('updateItem honest-state guard: PASSED/FAILED require a sessionId', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const run = await matrix.create({
			testCaseId: 'TC-1',
			targetUrl: 'https://example.com',
			selectedBrowsers: ['chrome'],
			profiles: [{ envId: fixtureEnvironments().find((env) => env.envId.startsWith('ENV-IOS-IP17PRO-')).envId }]
		});
		const item = run.items.find((candidate) => candidate.status === 'PENDING');
		assert.ok(item, 'expected at least one PENDING item');
		await assert.rejects(
			() => matrix.updateItem(run.id, item.id, { status: 'PASSED' }),
			(error) => error instanceof MatrixValidationError && /never fabricate/.test(error.message)
		);
		await matrix.updateItem(run.id, item.id, { status: 'RUNNING', startedAt: new Date().toISOString() });
		await matrix.updateItem(run.id, item.id, { status: 'PASSED', sessionId: 'session-x', verdict: 'pass' });
		const reloaded = await matrix.get(run.id);
		assert.equal(reloaded.items.find((candidate) => candidate.id === item.id).status, 'PASSED');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('updateItem rejects invalid statuses and unknown runs/items', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const run = await matrix.create({
			testCaseId: 'TC-1',
			targetUrl: 'https://example.com',
			selectedBrowsers: ['chrome'],
			profiles: [{ envId: fixtureEnvironments()[0].envId }]
		});
		const item = run.items[0];
		await assert.rejects(() => matrix.updateItem(run.id, item.id, { status: 'SUCCEEDED' }), MatrixValidationError);
		await assert.rejects(() => matrix.updateItem('matrix-nope', item.id, { status: 'ERROR' }), MatrixValidationError);
		await assert.rejects(() => matrix.updateItem(run.id, '00000000-0000-0000-0000-000000000000', { status: 'ERROR' }), MatrixValidationError);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('local backend persists across backend instances (page reload survival)', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const created = await matrix.create({
			testCaseId: 'TC-1',
			targetUrl: 'https://example.com',
			selectedBrowsers: ['chrome'],
			profiles: [{ envId: fixtureEnvironments()[0].envId }]
		});
		const reloadedBackend = createLocalMatrixBackend({ stateDir: dir });
		const reloaded = await reloadedBackend.get(null, created.id);
		assert.ok(reloaded, 'run not persisted');
		assert.equal(reloaded.status, 'pending');
		assert.equal(reloaded.items.length, created.items.length);
		assert.equal(reloaded.items[0].status, created.items[0].status);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('_setStatus accepts only the run status vocabulary', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const run = await matrix.create({
			testCaseId: 'TC-1',
			targetUrl: 'https://example.com',
			selectedBrowsers: ['chrome'],
			profiles: [{ envId: fixtureEnvironments()[0].envId }]
		});
		await assert.rejects(() => matrix._setStatus(run.id, 'finished'), MatrixValidationError);
		await matrix._setStatus(run.id, 'running', { startedAt: new Date().toISOString() });
		assert.equal((await matrix.get(run.id)).status, 'running');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/* ── Phase 3 (#14937): launcher configurationEnvIds mode ──────────── */

test('create with configurationEnvIds pins EXACT configurations (no silent newest-version swap)', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const chromeRows = fixtureEnvironments()
			.filter((env) => env.device === 'iPhone 17 Pro' && env.browserCode === 'chrome')
			.sort((a, b) => Number(b.browserVersion) - Number(a.browserVersion));
		// #15909: one version per family — the "pin exact version" contract is
		// exercised with the single available chrome version on the device.
		assert.ok(chromeRows.length >= 1, 'expected chrome versions on iPhone 17 Pro');
		const older = chromeRows[chromeRows.length - 1]; // the advertised version
		const run = await matrix.create({
			targetUrl: 'https://example.com',
			kickoffText: 'https://example.com\nCoverage: core flows',
			configurationEnvIds: [older.envId]
		});
		assert.equal(run.itemCount, 1);
		const item = run.items[0];
		assert.equal(item.environmentId, older.envId, 'exact requested envId pinned');
		assert.equal(item.browserVersion, older.browserVersion, 'exact requested version pinned');
		assert.equal(item.status, 'PENDING');
		assert.equal(item.testCaseId, '');
		assert.equal(run.kickoffText, 'https://example.com\nCoverage: core flows');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('configurationEnvIds: vanished envId → honest BLOCKED item, never dropped', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const run = await matrix.create({
			targetUrl: 'https://example.com',
			configurationEnvIds: ['ENV-GONE-FOREVER-CHR-1']
		});
		assert.equal(run.itemCount, 1);
		assert.equal(run.items[0].status, 'BLOCKED');
		assert.match(run.items[0].reason ?? '', /no longer in the catalog/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('configurationEnvIds: DuckDuckGo row → NOT_SUPPORTED with provider reason, never executes', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const ddg = fixtureEnvironments().find((env) => env.browserCode === 'duckduckgo');
		if (!ddg) return; // catalog without DDG rows: nothing to assert
		const run = await matrix.create({
			targetUrl: 'https://example.com',
			configurationEnvIds: [ddg.envId]
		});
		const item = run.items[0];
		assert.equal(item.status, 'NOT_SUPPORTED');
		assert.ok(item.reason, 'reason expected');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('configurationEnvIds: empty array rejects (422 contract)', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		await assert.rejects(
			() => matrix.create({ targetUrl: 'https://example.com', configurationEnvIds: [] }),
			MatrixValidationError
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/* ── Pipeline Phase 2: parent runs + idempotent batches ──────────── */

test('Phase 2: parent run is a lightweight aggregate (no items), batch pins configs under it', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const envs = fixtureEnvironments().slice(0, 3);
		const parent = await matrix.createParentRun({
			title: 'Big QA run',
			targetUrl: 'https://example.com',
			kickoffText: 'https://example.com\nCoverage: core flows',
			totalPlanned: 3
		});
		assert.equal(parent.kind, 'parent');
		assert.equal(parent.itemCount, 0);
		assert.deepEqual(parent.items, []);
		assert.equal(parent.totalPlanned, 3);
		assert.deepEqual(parent.batchIds, []);

		const { run: batch, created } = await matrix.createBatch({
			parentId: parent.id,
			batchKey: 'k1',
			batchIndex: 0,
			targetUrl: 'https://example.com',
			kickoffText: 'https://example.com\nCoverage: core flows',
			configurationEnvIds: envs.map((env) => env.envId)
		});
		assert.equal(created, true);
		assert.equal(batch.kind, 'batch');
		assert.equal(batch.parentId, parent.id);
		assert.equal(batch.itemCount, envs.length);
		for (const env of envs) {
			assert.ok(batch.items.some((item) => item.environmentId === env.envId), `${env.envId} pinned`);
		}
		// Parent view aggregates the batch on read.
		const view = await matrix.get(parent.id);
		assert.equal(view.itemCount, envs.length);
		assert.equal(view.batchCount, 1);
		assert.equal(view.batches[0].id, batch.id);
		assert.ok(!('items' in view.batches[0]), 'batch summaries in the parent view carry no items');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Phase 2: re-posting the same batchKey is idempotent — zero duplicate items/jobs', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const envIds = fixtureEnvironments().slice(0, 2).map((env) => env.envId);
		const parent = await matrix.createParentRun({ targetUrl: 'https://example.com', totalPlanned: envIds.length });
		const first = await matrix.createBatch({
			parentId: parent.id, batchKey: 'same-key', batchIndex: 0,
			targetUrl: 'https://example.com', configurationEnvIds: envIds
		});
		assert.equal(first.created, true);
		// A network-failure retry posts the SAME key (and even a different
		// batchIndex — the key is the contract, not the index).
		const retry = await matrix.createBatch({
			parentId: parent.id, batchKey: 'same-key', batchIndex: 0,
			targetUrl: 'https://example.com', configurationEnvIds: envIds
		});
		assert.equal(retry.created, false);
		assert.equal(retry.run.id, first.run.id, 'existing batch returned as-is');
		const view = await matrix.get(parent.id);
		assert.equal(view.batchCount, 1, 'no duplicate batch was linked');
		assert.equal(view.itemCount, envIds.length, 'no duplicate items');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Phase 2: batch key collision across DIFFERENT keys under one parent is rejected-or-distinct; unknown parent rejected', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const envIds = fixtureEnvironments().slice(0, 1).map((env) => env.envId);
		await assert.rejects(
			() => matrix.createBatch({ parentId: 'matrix-nope', batchKey: 'k', targetUrl: 'https://example.com', configurationEnvIds: envIds }),
			MatrixValidationError
		);
		const parent = await matrix.createParentRun({ targetUrl: 'https://example.com', totalPlanned: 2 });
		const a = await matrix.createBatch({ parentId: parent.id, batchKey: 'k-a', batchIndex: 0, targetUrl: 'https://example.com', configurationEnvIds: envIds });
		const b = await matrix.createBatch({ parentId: parent.id, batchKey: 'k-b', batchIndex: 1, targetUrl: 'https://example.com', configurationEnvIds: envIds });
		assert.notEqual(a.run.id, b.run.id, 'different keys → distinct batches (disjoint by client construction)');
		const view = await matrix.get(parent.id);
		assert.equal(view.batchCount, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Phase 2: batches listed with different batchIndexes keep their order in the aggregated parent view', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const envs = fixtureEnvironments();
		const parent = await matrix.createParentRun({ targetUrl: 'https://example.com', totalPlanned: envs.length });
		// Create batches in REVERSE index order to prove the read sorts them.
		await matrix.createBatch({ parentId: parent.id, batchKey: 'k-2', batchIndex: 2, targetUrl: 'https://example.com', configurationEnvIds: [envs[4].envId] });
		await matrix.createBatch({ parentId: parent.id, batchKey: 'k-0', batchIndex: 0, targetUrl: 'https://example.com', configurationEnvIds: [envs[0].envId, envs[1].envId] });
		await matrix.createBatch({ parentId: parent.id, batchKey: 'k-1', batchIndex: 1, targetUrl: 'https://example.com', configurationEnvIds: [envs[2].envId, envs[3].envId] });
		const view = await matrix.get(parent.id);
		assert.equal(view.batchCount, 3);
		assert.deepEqual(view.batches.map((batch) => batch.batchIndex), [0, 1, 2], 'batches sorted by index');
		assert.deepEqual(
			view.items.map((item) => item.environmentId),
			[envs[0].envId, envs[1].envId, envs[2].envId, envs[3].envId, envs[4].envId],
			'items aggregated in batch order'
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('Phase 2: parent with zero batches reads as an honest empty aggregate (no items, no error)', async () => {
	const { backend, dir } = tempBackend();
	try {
		const matrix = createMatrixService(backend, testServices());
		const parent = await matrix.createParentRun({ targetUrl: 'https://example.com', totalPlanned: 0 });
		const view = await matrix.get(parent.id);
		assert.equal(view.kind, 'parent');
		assert.equal(view.itemCount, 0);
		assert.deepEqual(view.items, []);
		assert.equal(view.batchCount, 0);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
