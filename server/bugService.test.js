import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createBugService,
	createLocalBugBackend,
	normalizeBugInput,
	BugValidationError
} from './bugService.js';

function tempState() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-bugs-'));
	return { dir, stateFile: path.join(dir, 'bugs.json') };
}

test('normalizeBugInput validates title, severity, status, steps', () => {
	const ok = normalizeBugInput({ title: 'Login fails on iOS 18', severity: 'HIGH', steps: ['open app', ''] });
	assert.equal(ok.severity, 'high');
	assert.equal(ok.status, 'open');
	assert.deepEqual(ok.steps, ['open app']);
	assert.throws(() => normalizeBugInput({}), BugValidationError);
	assert.throws(() => normalizeBugInput({ title: 'x'.repeat(301) }), BugValidationError);
	assert.throws(() => normalizeBugInput({ title: 'ok', severity: 'blocker' }), BugValidationError);
	assert.throws(() => normalizeBugInput({ title: 'ok', status: 'closed' }), BugValidationError);
});

test('local backend assigns sequential BUG-XXXX numbers', async () => {
	const { dir, stateFile } = tempState();
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }));
	const first = await service.create({ title: 'Crash on rotate' });
	const second = await service.create({ title: 'Mic denied silently' });
	assert.equal(first.bugNumber, 'BUG-0001');
	assert.equal(second.bugNumber, 'BUG-0002');
	assert.equal(first.status, 'open');
	// persists to disk
	const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
	assert.equal(raw.length, 2);
});

test('create freezes an environment snapshot from the environments service', async () => {
	const { dir, stateFile } = tempState();
	const environments = {
		async get(envId) {
			return envId === 'ENV-IP16P-18-SAF-18'
				? { envId, device: 'iPhone 16 Pro', os: 'iOS', osVersion: '18.3', browser: 'Safari', browserVersion: '18.3' }
				: null;
		}
	};
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }), { environments });
	const bug = await service.create({ title: 'Safari rendering bug', environmentId: 'ENV-IP16P-18-SAF-18' });
	assert.equal(bug.environmentSnapshot.device, 'iPhone 16 Pro');
	assert.equal(bug.environmentId, 'ENV-IP16P-18-SAF-18');
});

test('create auto-associates environment + execution level from the linked run', async () => {
	const { dir, stateFile } = tempState();
	const runs = {
		async get(id) {
			return {
				id,
				environmentId: 'ENV-AND-GALS24-14-CHR-138',
				environmentSnapshot: { envId: 'ENV-AND-GALS24-14-CHR-138', device: 'Galaxy S24' },
				executionLevel: 'SIMULATED',
				testCaseId: 'TC-0003'
			};
		}
	};
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }), { runs });
	const bug = await service.create({ title: 'Layout broken', linkedRunId: 'run-abc' });
	assert.equal(bug.environmentId, 'ENV-AND-GALS24-14-CHR-138');
	assert.equal(bug.environmentSnapshot.device, 'Galaxy S24');
	assert.equal(bug.executionLevel, 'SIMULATED');
	assert.equal(bug.linkedTestCaseId, 'TC-0003');
});

test('explicit environment fields are not overwritten by run association', async () => {
	const { dir, stateFile } = tempState();
	const runs = {
		async get() { return { environmentId: 'ENV-OTHER', executionLevel: 'REAL_DEVICE' }; }
	};
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }), { runs });
	const bug = await service.create({
		title: 'Explicit wins',
		environmentId: 'ENV-EXPLICIT',
		environmentSnapshot: { envId: 'ENV-EXPLICIT', device: 'Pixel 9' },
		executionLevel: 'SIMULATED',
		linkedRunId: 'run-xyz'
	});
	assert.equal(bug.environmentId, 'ENV-EXPLICIT');
	assert.equal(bug.environmentSnapshot.device, 'Pixel 9');
	assert.equal(bug.executionLevel, 'SIMULATED');
});

test('list filters by status, severity, environment and search', async () => {
	const { dir, stateFile } = tempState();
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }));
	await service.create({ title: 'Alpha crash', severity: 'critical' });
	await service.create({ title: 'Beta glitch', severity: 'low' });
	await service.create({ title: 'Gamma layout', severity: 'high', environmentId: 'ENV-X' });
	assert.equal((await service.list({ status: 'open' })).length, 3);
	assert.equal((await service.list({ severity: 'critical' })).length, 1);
	assert.equal((await service.list({ environmentId: 'ENV-X' })).length, 1);
	assert.equal((await service.list({ search: 'glitch' })).length, 1);
});

test('update changes status and content; remove deletes', async () => {
	const { dir, stateFile } = tempState();
	const service = createBugService(createLocalBugBackend({ stateDir: dir, stateFile }));
	const bug = await service.create({ title: 'Before' });
	const updated = await service.update(bug.bugNumber, { title: 'After', status: 'resolved' });
	assert.equal(updated.title, 'After');
	assert.equal(updated.status, 'resolved');
	assert.equal((await service.list({})).length, 1);
	const removed = await service.remove(bug.bugNumber);
	assert.equal(removed.bugNumber, bug.bugNumber);
	assert.equal((await service.list({})).length, 0);
	assert.equal(await service.get('BUG-9999'), null);
	assert.equal(await service.update('BUG-9999', {}), null);
});
