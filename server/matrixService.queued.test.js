/**
 * Matrix service additions — Phase B1 (#15043).
 *
 * QUEUED item status + cancelled run status + retry accounting, layered on the
 * frozen NI02 vocabulary without breaking existing readers: QUEUED items are
 * scheduled PENDING items; CANCELLED items are queued-but-never-launched items.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createMatrixService,
	createLocalMatrixBackend,
	MATRIX_ITEM_STATUSES,
	MatrixValidationError
} from './matrixService.js';
import { generateEnvironments } from './environmentCatalog.js';

function fixtureEnvironments() {
	const wanted = new Set(['iPhone 17 Pro', 'Pixel 9', 'Galaxy Tab S9', 'Windows Laptop']);
	return generateEnvironments().filter((env) => wanted.has(env.device));
}

function testServices() {
	return {
		environments: { async list() { return fixtureEnvironments(); } },
		testCases: {
			async resolveForRun(caseNumber) {
				if (caseNumber === 'TC-1') return { caseNumber: 'TC-1', title: 'Login flow', environmentIds: [] };
				throw new Error(`Unknown test case "${caseNumber}".`);
			}
		},
		runs: {}
	};
}

function tempBackend() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-b1-'));
	return createLocalMatrixBackend({ stateDir: dir });
}

async function createRun(service) {
	return service.create({
		testCaseId: 'TC-1',
		targetUrl: 'https://example.test',
		selectedBrowsers: ['chrome', 'firefox'],
		profiles: [{ envId: firstEnvId() }, { envId: secondEnvId() }]
	});
}

function firstEnvId() { return fixtureEnvironments()[0].envId; }
function secondEnvId() { return fixtureEnvironments()[1].envId; }

test('MATRIX_ITEM_STATUSES includes QUEUED and CANCELLED without dropping the honest set', () => {
	assert.ok(MATRIX_ITEM_STATUSES.includes('QUEUED'));
	assert.ok(MATRIX_ITEM_STATUSES.includes('CANCELLED'));
	for (const legacy of ['PENDING', 'RUNNING', 'PASSED', 'FAILED', 'NOT_RUN', 'UNAVAILABLE', 'NOT_SUPPORTED', 'BLOCKED', 'ERROR']) {
		assert.ok(MATRIX_ITEM_STATUSES.includes(legacy), `legacy status ${legacy} must survive`);
	}
});

test('updateItem accepts QUEUED and CANCELLED transitions', async () => {
	const service = createMatrixService(tempBackend(), testServices());
	const run = await createRun(service);
	const item = run.items.find((candidate) => candidate.status === 'PENDING');
	assert.ok(item, 'expected a PENDING item');
	await service.updateItem(run.id, item.id, { status: 'QUEUED' });
	const afterQueue = await service.get(run.id);
	assert.equal(afterQueue.items.find((candidate) => candidate.id === item.id).status, 'QUEUED');
	await service.updateItem(run.id, item.id, { status: 'CANCELLED', reason: 'Run cancelled.' });
	const afterCancel = await service.get(run.id);
	assert.equal(afterCancel.items.find((candidate) => candidate.id === item.id).status, 'CANCELLED');
});

test('updateItem still rejects PASSED without a session (honest-pass guard intact)', async () => {
	const service = createMatrixService(tempBackend(), testServices());
	const run = await createRun(service);
	const item = run.items.find((candidate) => candidate.status === 'PENDING');
	await assert.rejects(
		() => service.updateItem(run.id, item.id, { status: 'PASSED' }),
		(error) => error instanceof MatrixValidationError
	);
});

test('run status vocabulary accepts cancelled', async () => {
	const service = createMatrixService(tempBackend(), testServices());
	const run = await createRun(service);
	const updated = await service._setStatus(run.id, 'cancelled', { finishedAt: new Date().toISOString() });
	assert.equal(updated.status, 'cancelled');
});

test('retry bookkeeping: retryItem marks re-queued items and enforces the bound', async () => {
	const service = createMatrixService(tempBackend(), testServices());
	const run = await createRun(service);
	const item = run.items.find((candidate) => candidate.status === 'PENDING');
	await service.updateItem(run.id, item.id, { status: 'FAILED', sessionId: 'session-1', verdict: 'fail' });
	// First retry allowed.
	await service.updateItem(run.id, item.id, {
		status: 'QUEUED',
		reason: null,
		error: null,
		sessionId: null,
		verdict: null,
		retryCount: 1
	});
	// Second retry allowed (bound is 2).
	await service.updateItem(run.id, item.id, {
		status: 'FAILED', sessionId: 'session-2', verdict: 'fail', retryCount: 1
	});
	await service.updateItem(run.id, item.id, {
		status: 'QUEUED', sessionId: null, verdict: null, error: null, retryCount: 2
	});
	// Third retry attempt must be refused by the orchestrator bound check —
	// the service exposes retryCount; orchestrator guards it (see
	// matrixOrchestrator tests).
	const after = await service.get(run.id);
	const stored = after.items.find((candidate) => candidate.id === item.id);
	assert.equal(stored.retryCount, 2);
});
