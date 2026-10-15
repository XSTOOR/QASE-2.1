import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createTestCaseService,
	createLocalTestCaseBackend,
	normalizeTestCaseInput,
	TestCaseValidationError
} from './testCaseService.js';

function freshBackend() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-testcases-'));
	return createLocalTestCaseBackend({ stateDir: dir, stateFile: path.join(dir, 'test-cases.json') });
}

const environmentsStub = {
	async get(envId) {
		if (envId === 'ENV-GOOD') return { envId, active: true };
		if (envId === 'ENV-OFF') return { envId, active: false };
		return null;
	}
};

function service(backend = freshBackend()) {
	return { service: createTestCaseService(backend, { environments: environmentsStub }), backend };
}

test('normalizeTestCaseInput trims, dedupes tags/envIds and enforces caps', () => {
	const normalized = normalizeTestCaseInput({
		title: '  Checkout flow  ',
		steps: [' Open cart ', '', 'Pay'],
		tags: ['smoke', 'Smoke', ' '],
		environmentIds: ['ENV-A', 'ENV-A', 'ENV-B']
	});
	assert.equal(normalized.title, 'Checkout flow');
	assert.deepEqual(normalized.steps, ['Open cart', 'Pay']);
	assert.deepEqual(normalized.tags, ['smoke']);
	assert.deepEqual(normalized.environmentIds, ['ENV-A', 'ENV-B']);
	assert.throws(() => normalizeTestCaseInput({ title: '' }), TestCaseValidationError);
	assert.throws(() => normalizeTestCaseInput({ title: 'x'.repeat(301) }), TestCaseValidationError);
	assert.throws(() => normalizeTestCaseInput({ title: 'ok', steps: Array.from({ length: 51 }, () => 's') }), TestCaseValidationError);
});

test('create issues sequential TC-XXXX numbers and persists to disk', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-testcases-'));
	const backend = createLocalTestCaseBackend({ stateDir: dir, stateFile: path.join(dir, 'test-cases.json') });
	const { service: svc } = service(backend);
	const first = await svc.create({ title: 'First', environmentIds: ['ENV-GOOD'] });
	const second = await svc.create({ title: 'Second' });
	assert.equal(first.caseNumber, 'TC-0001');
	assert.equal(second.caseNumber, 'TC-0002');
	// Restart: a fresh backend over the same file continues numbering.
	const reopened = createLocalTestCaseBackend({ stateDir: dir, stateFile: path.join(dir, 'test-cases.json') });
	const svc2 = createTestCaseService(reopened, { environments: environmentsStub });
	const third = await svc2.create({ title: 'Third' });
	assert.equal(third.caseNumber, 'TC-0003');
	assert.deepEqual((await svc2.list()).map((c) => c.caseNumber), ['TC-0001', 'TC-0002', 'TC-0003']);
});

test('create rejects unknown and inactive environment assignments', async () => {
	const { service: svc } = service();
	await assert.rejects(
		() => svc.create({ title: 'Bad env', environmentIds: ['ENV-NOPE'] }),
		(error) => { assert.match(error.message, /Unknown environment/); return true; }
	);
	await assert.rejects(
		() => svc.create({ title: 'Inactive env', environmentIds: ['ENV-OFF'] }),
		(error) => { assert.match(error.message, /Inactive environment/); return true; }
	);
});

test('update adds and removes environment assignments with validation', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-testcases-'));
	const backend = createLocalTestCaseBackend({ stateDir: dir, stateFile: path.join(dir, 'test-cases.json') });
	const stubWithB = {
		async get(envId) {
			if (envId === 'ENV-GOOD' || envId === 'ENV-B') return { envId, active: true };
			if (envId === 'ENV-OFF') return { envId, active: false };
			return null;
		}
	};
	const svc = createTestCaseService(backend, { environments: stubWithB });
	const record = await svc.create({ title: 'Case', environmentIds: ['ENV-GOOD'] });
	await assert.rejects(
		() => svc.update(record.caseNumber, { addEnvironmentIds: ['ENV-NOPE'] }),
		TestCaseValidationError
	);
	const added = await svc.update(record.caseNumber, { addEnvironmentIds: ['ENV-B'] });
	assert.deepEqual(added.environmentIds, ['ENV-GOOD', 'ENV-B']);
	const removed = await svc.update(record.caseNumber, { removeEnvironmentIds: ['ENV-GOOD'] });
	assert.deepEqual(removed.environmentIds, ['ENV-B']);
});

test('remove soft-deletes; get/list no longer see the case but files keep it', async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-testcases-'));
	const stateFile = path.join(dir, 'test-cases.json');
	const backend = createLocalTestCaseBackend({ stateDir: dir, stateFile });
	const svc = createTestCaseService(backend, { environments: environmentsStub });
	const record = await svc.create({ title: 'Doomed' });
	await svc.remove(record.caseNumber);
	assert.equal(await svc.get(record.caseNumber), null);
	assert.deepEqual(await svc.list(), []);
	const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	assert.equal(raw.length, 1, 'soft-deleted record stays on disk for run history');
	assert.equal(raw[0].deleted, true);
});

test('list filters by search text, tag and environment', async () => {
	const { service: svc } = service();
	await svc.create({ title: 'Login smoke', tags: ['smoke'], environmentIds: ['ENV-GOOD'] });
	await svc.create({ title: 'Checkout regression', tags: ['regression'] });
	assert.equal((await svc.list({ search: 'smoke' })).length, 1);
	assert.equal((await svc.list({ tag: 'regression' })).length, 1);
	assert.equal((await svc.list({ environmentId: 'ENV-GOOD' })).length, 1);
});

test('resolveForRun enforces case existence and environment membership', async () => {
	const { service: svc } = service();
	const record = await svc.create({ title: 'Case', environmentIds: ['ENV-GOOD'] });
	const resolved = await svc.resolveForRun(record.caseNumber, 'ENV-GOOD');
	assert.equal(resolved.caseNumber, 'TC-0001');
	await assert.rejects(() => svc.resolveForRun('TC-9999', 'ENV-GOOD'), /Unknown test case/);
	await assert.rejects(
		() => svc.resolveForRun(record.caseNumber, 'ENV-UNASSIGNED'),
		/is not assigned to TC-0001/
	);
});

test('runs without environments: resolveForRun allows a case with no environment', async () => {
	const { service: svc } = service();
	const record = await svc.create({ title: 'Envless' });
	const resolved = await svc.resolveForRun(record.caseNumber, undefined);
	assert.equal(resolved.caseNumber, 'TC-0001');
});
