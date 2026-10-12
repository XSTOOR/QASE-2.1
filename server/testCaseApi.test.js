import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApplication } from './app.js';
import { createInstanceAccess } from './instanceAccess.js';
import { createTestCaseService, createLocalTestCaseBackend } from './testCaseService.js';
import { createLocalEnvironmentBackend } from './environmentService.js';
import { createLocalDeviceCatalogBackend } from './localDeviceCatalog.js';

const TENANT = Object.freeze({
	organizationId: '55c15025-8ef4-4ce8-8ad5-4562f33f1852',
	projectId: 'f2964599-fb3a-4c4e-acec-ee84d74fab55',
	actorUserId: '9e2fb678-423e-41a0-ae19-e9cae143c606',
	actorEmail: 'owner@drytis.example',
	actorName: 'Drytis Owner'
});

const SAMPLE_ENV = {
	envId: 'ENV-IOS-IP16PRO-18.3-CHR-151',
	platform: 'ios',
	platformLabel: 'iOS',
	device: 'iPhone 16 Pro',
	os: 'iOS',
	osVersion: '18.3',
	browser: 'Chrome',
	browserCode: 'chrome',
	browserVersion: '151',
	deviceType: 'mobile',
	screenSize: '1179x2556',
	executionProvider: 'environment',
	isRealDevice: true,
	active: true,
	catalogVersion: 'test',
	runtimeCapabilities: {}
};

async function startFixture(overrides = {}) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-testcase-api-'));
	const deviceCatalog = createLocalDeviceCatalogBackend({ stateDir: dir, stateFile: path.join(dir, 'catalog.json') });
	await deviceCatalog.seed();
	const environments = createLocalEnvironmentBackend({
		stateDir: dir,
		stateFile: path.join(dir, 'environments.json'),
		catalogBackend: deviceCatalog
	});
	const envService = await (async () => {
		const { createEnvironmentService } = await import('./environmentService.js');
		return createEnvironmentService(environments, { tenantContext: TENANT });
	})();
	await envService.seed();
	const testCases = createTestCaseService(createLocalTestCaseBackend({
		stateDir: dir, stateFile: path.join(dir, 'test-cases.json')
	}), { environments: envService });

	const services = {
		runs: overrides.runs || {
			load: async () => undefined,
			list: async () => [],
			create: async (title, options) => ({ id: 'dbg-session', title, ...options }),
			get: async () => null,
			delete: async () => true,
			recordCleanup: async () => ({ recorded: true }),
			commit: async s => s,
			addMessage: async (s, m) => m,
			addActivity: async (s, a) => a,
			updateActivity: async (s, _i, a) => a,
			setStatus: async (s, _st) => s,
			markExecutionStarted: async s => s,
			markReportPhase: async s => s,
			publish: async () => undefined,
			subscribe: () => ({ dispose() {} }),
			dropLive: () => undefined
		},
		events: { publish: async () => undefined, subscribe: () => ({ dispose() {} }) },
		configuration: { getPublic: async () => ({}), save: async () => ({}), testConnection: async () => ({}) },
		secrets: { clear: async () => undefined, names: () => [], store: async () => undefined },
feedback: {
		create: async () => ({}),
		get: async () => null,
		list: async () => [],
		update: async () => ({}),
		remove: async () => true,
		stats: async () => ({}),
		forRun: async () => null
		},
		reports: { buildMarkdown: async () => '' },
		agent: { ensureRuntime: async () => ({}), runTurn: async () => ({}), closeBrowser: async () => undefined, getLiveState: () => ({}), stop: async () => undefined, invalidateIdleRuntimes: () => undefined },
		readiness: { check: async () => ({ ready: true }) },
		feedback: { create: async () => ({}), get: async () => undefined, list: async () => [], update: async () => ({}), remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		lifecycle: { close: async () => undefined },
		feedback: { create: async () => undefined, get: async () => undefined, list: async () => [], update: async () => undefined, remove: async () => undefined, stats: async () => ({}), forRun: async () => undefined },
		deviceCatalog,
		environments: envService,
		testCases,
		...(overrides.autogen ? { testCaseAutogen: overrides.autogen } : {})
	};
	const application = createApplication({
		services,
		access: createInstanceAccess({ tenantContext: TENANT }),
		sseHeartbeatMs: 1_000
	});
	const server = await new Promise(resolve => {
		const candidate = application.app.listen(0, '127.0.0.1', () => resolve(candidate));
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	async function json(pathName, requestOptions = {}) {
		const headers = new Headers(requestOptions.headers);
		let body = requestOptions.body;
		if (requestOptions.json !== undefined) {
			headers.set('content-type', 'application/json');
			body = JSON.stringify(requestOptions.json);
		}
		const response = await fetch(`${origin}${pathName}`, { ...requestOptions, headers, body });
		let parsed = null;
		try { parsed = await response.json(); } catch { parsed = null; }
		return { status: response.status, body: parsed };
	}
	async function close() {
		await application.whenIdle();
		await new Promise(resolve => server.close(resolve));
	}
	return { json, close, services };
}

test('POST /api/test-cases creates with TC-0001 and validates environment assignment', async () => {
	const fx = await startFixture();
	try {
		const bad = await fx.json('/api/test-cases', {
			method: 'POST',
			json: { title: 'Case', environmentIds: ['ENV-DOES-NOT-EXIST'] }
		});
		assert.equal(bad.status, 422);
		assert.match(bad.body.error, /Unknown environment/);

		const created = await fx.json('/api/test-cases', {
			method: 'POST',
			json: { title: 'Checkout on iPhone', steps: ['open', 'pay'], tags: ['smoke'], environmentIds: ['ENV-IOS-IP16PRO-18.3-CHR-151'] }
		});
		assert.equal(created.status, 201);
		assert.equal(created.body.caseNumber, 'TC-0001');
		assert.deepEqual(created.body.environmentIds, ['ENV-IOS-IP16PRO-18.3-CHR-151']);
	} finally {
		await fx.close();
	}
});

test('CRUD: get, patch (title + env add/remove), list filter, delete', async () => {
	const fx = await startFixture();
	try {
		const created = await fx.json('/api/test-cases', { method: 'POST', json: { title: 'Original' } });
		const { caseNumber } = created.body;

		const patched = await fx.json(`/api/test-cases/${caseNumber}`, {
			method: 'PATCH',
			json: { title: 'Renamed', addEnvironmentIds: ['ENV-IOS-IP16PRO-18.3-CHR-151'] }
		});
		assert.equal(patched.status, 200);
		assert.equal(patched.body.title, 'Renamed');
		assert.deepEqual(patched.body.environmentIds, ['ENV-IOS-IP16PRO-18.3-CHR-151']);

		const removed = await fx.json(`/api/test-cases/${caseNumber}`, {
			method: 'PATCH',
			json: { removeEnvironmentIds: ['ENV-IOS-IP16PRO-18.3-CHR-151'] }
		});
		assert.deepEqual(removed.body.environmentIds, []);

		const listed = await fx.json('/api/test-cases?search=Renamed');
		assert.equal(listed.body.total, 1);

		const gone = await fx.json(`/api/test-cases/${caseNumber}`, { method: 'DELETE' });
		assert.equal(gone.status, 204);
		const after = await fx.json(`/api/test-cases/${caseNumber}`);
		assert.equal(after.status, 404);
	} finally {
		await fx.close();
	}
});

test('POST /api/sessions with testCaseId links the run; unassigned env → 422; no case → unchanged', async () => {
	const fx = await startFixture();
	try {
		// Backward compatibility: session without testCaseId still 201.
		const plain = await fx.json('/api/sessions', { method: 'POST', json: {} });
		assert.equal(plain.status, 201);

		// Case with an assigned environment.
		const created = await fx.json('/api/test-cases', {
			method: 'POST',
			json: { title: 'Linked', environmentIds: ['ENV-IOS-IP16PRO-18.3-CHR-151'] }
		});
		const caseNumber = created.body.caseNumber;

		// Wrong environment (exists in catalog but not assigned to the case) → 422.
		const wrongEnv = await fx.json('/api/sessions', {
			method: 'POST',
			json: { testCaseId: caseNumber, environmentId: 'ENV-IOS-IP16PRO-18.3-FF-153' }
		});
		assert.equal(wrongEnv.status, 422);
		assert.match(wrongEnv.body.error, /is not assigned to/);

		// Unknown case → 422.
		const unknownCase = await fx.json('/api/sessions', { method: 'POST', json: { testCaseId: 'TC-9999' } });
		assert.equal(unknownCase.status, 422);

		// Correct pair → 201 with the case snapshot on the session.
		const linked = await fx.json('/api/sessions', {
			method: 'POST',
			json: { testCaseId: caseNumber, environmentId: 'ENV-IOS-IP16PRO-18.3-CHR-151' }
		});
		assert.equal(linked.status, 201, `body: ${JSON.stringify(linked.body)}`);
		assert.ok(linked.body, 'response body must parse as JSON');
		assert.equal(linked.body.testCaseId, caseNumber);
		assert.equal(linked.body.testCaseSnapshot.title, 'Linked');
	} finally {
		await fx.close();
	}
});

test('list forwards source and sourceRunId filters; manual POST defaults to source manual', async () => {
	const fx = await startFixture();
	try {
		const manual = await fx.json('/api/test-cases', { method: 'POST', json: { title: 'Manual case' } });
		assert.equal(manual.status, 201);
		assert.equal(manual.body.source, 'manual');

		// Insert an auto-sourced case directly through the service to avoid depending on the LLM.
		await fx.services.testCases.create({ title: 'Auto case', source: 'auto', sourceRunId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });

		const manualOnly = await fx.json('/api/test-cases?source=manual');
		assert.equal(manualOnly.body.total, 1);
		assert.equal(manualOnly.body.testCases[0].source, 'manual');

		const autoOnly = await fx.json('/api/test-cases?source=auto');
		assert.equal(autoOnly.body.total, 1);
		assert.equal(autoOnly.body.testCases[0].source, 'auto');
		assert.equal(autoOnly.body.testCases[0].sourceRunId, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');

		const byRun = await fx.json('/api/test-cases?sourceRunId=aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
		assert.equal(byRun.body.total, 1);
		assert.equal(byRun.body.testCases[0].title, 'Auto case');

		const byMiss = await fx.json('/api/test-cases?sourceRunId=00000000-0000-4000-8000-000000000000');
		assert.equal(byMiss.body.total, 0);
	} finally {
		await fx.close();
	}
});

test('POST /api/test-cases/generate generates from a completed run and reports created cases', async () => {
	let calls = 0;
	let callArgs = null;
	const autogen = {
		generateForRun: async (run) => {
			calls += 1;
			callArgs = run;
			return { created: ['TC-0001', 'TC-0002', 'TC-0003'], skipped: 0 };
		}
	};
	const fx = await startFixture({ autogen });
	try {
		const missing = await fx.json('/api/test-cases/generate', { method: 'POST', json: { runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' } });
		assert.equal(missing.status, 404);

		const session = await fx.services.runs.create({ url: 'https://example.com', targetUrl: 'https://example.com', instruction: 'Smoke the checkout' });
		const sessionId = session.id;
		const stored = { id: sessionId, report: { verdict: 'PASS', summary: 'ok' } };
		fx.services.runs.get = async (id) => (id === sessionId ? stored : null);
		await fx.services.runs.commit(sessionId, 'report', {
			verdict: 'PASS',
			summary: 'Checkout smoke passed on production.',
			todos: [
				{ text: 'Add item to cart', done: true },
				{ text: 'Complete payment with test card', done: true }
			]
		});
		await fx.services.runs.setStatus(sessionId, 'done');

		const gen = await fx.json('/api/test-cases/generate', { method: 'POST', json: { runId: sessionId } });
		assert.equal(gen.status, 200);
		assert.equal(gen.body.count, 3);
		assert.deepEqual(gen.body.created, ['TC-0001', 'TC-0002', 'TC-0003']);
		assert.equal(callArgs.id, sessionId);
		assert.equal(calls, 1);
		assert.ok(callArgs.report);

		const noBody = await fx.json('/api/test-cases/generate', { method: 'POST', json: {} });
		assert.equal(noBody.status, 422);
	} finally {
		await fx.close();
	}
});
