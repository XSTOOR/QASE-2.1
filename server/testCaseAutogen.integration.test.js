/**
 * Integration: a 'report' commit on the run bus triggers auto-generation of
 * test cases through the wiring in serviceFactory.attachTestCaseAutogen.
 * Uses the real local application services (temp state dirs) so the store,
 * bus and test-case service are the production ones.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createConfiguredApplicationServices } from './serviceFactory.js';

function makeTempHome() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-autogen-int-'));
	process.chdir(dir);
	return dir;
}

const AUTOGON_ENV = {
	QASE_DATA_DIR: undefined,
	QASE_AUTOGEN_TESTCASES: 'on',
	QASE_AUTOGEN_MAX_CASES: '3'
};

async function buildServices(overrides = {}) {
	const home = makeTempHome();
	const environment = {
		...AUTOGON_ENV,
		QASE_STATE_DIR: path.join(home, '.qase'),
		...overrides
	};
	const result = await createConfiguredApplicationServices({
		environment,
		// Never touch the real model settings in tests.
		getConfig: () => ({ provider: 'custom', apiKey: '', baseUrl: '', model: '' })
	});
	const services = result.services;
	await services.runs.load();
	return { services, home };
}

const FIXED_RUN_IDS = new Map();

function fixedRunId(key) {
	if (!FIXED_RUN_IDS.has(key)) {
		// store.js requires canonical v4 UUIDs and its session map is
		// module-global for the process, so every run gets a fresh UUID.
		FIXED_RUN_IDS.set(key, crypto.randomUUID());
	}
	return FIXED_RUN_IDS.get(key);
}

async function createStoredRun(services, id) {
	const uuid = fixedRunId(id);
	const session = await services.runs.create('integration run', { id: uuid });
	Object.assign(session, completedSession(uuid));
	return session;
}

function completedSession(id) {
	return {
		id,
		status: 'running', // report commits before the terminal transition
		targetUrl: 'https://shop.example.com/checkout',
		report: { verdict: 'pass', summary: 'All good.' },
		todos: [
			{ text: 'Add an item to the cart', status: 'done' },
			{ text: 'Complete checkout', status: 'done' },
			{ text: 'Verify order confirmation email', status: 'done' }
		],
		findings: [],
		environmentSnapshot: null
	};
}

describe('serviceFactory autogen wiring', () => {
	test('a report commit on the run bus creates auto test cases', async () => {
		const { services } = await buildServices();
		try {
			const target = await createStoredRun(services, 'integration-run-1');
			await services.runs.publish(target, 'report', { report: target.report });
			// Bus listeners are synchronous; generation is async — wait it out.
			await new Promise((resolve) => setTimeout(resolve, 80));
			const cases = await services.testCases.list({ source: 'auto' });
			assert.ok(cases.length >= 1, 'expected auto-generated cases');
			assert.ok(cases.every((record) => record.source === 'auto'));
			assert.ok(cases.every((record) => record.sourceRunId === target.id));
		} finally {
			await services.lifecycle.close();
		}
	});

	test('non-report events trigger nothing', async () => {
		const { services } = await buildServices();
		try {
			const target = await createStoredRun(services, 'integration-run-2');
			await services.runs.publish(target, 'message', { message: { id: 'm1' } });
			await new Promise((resolve) => setTimeout(resolve, 50));
			const cases = await services.testCases.list({ source: 'auto' });
			assert.equal(cases.length, 0);
		} finally {
			await services.lifecycle.close();
		}
	});

	test('generation failure never breaks the bus', async () => {
		const { services } = await buildServices();
		try {
			const target = await createStoredRun(services, 'integration-run-3');
			// Break the test-case service so generation throws.
			const original = services.testCases.list;
			services.testCases.list = async () => { throw new Error('boom'); };
			// Must not throw.
			await services.runs.publish(target, 'report', { report: target.report });
			await new Promise((resolve) => setTimeout(resolve, 50));
			services.testCases.list = original;
		} finally {
			await services.lifecycle.close();
		}
	});

	test('disabled flag produces nothing even when events flow', async () => {
		const { services } = await buildServices({ QASE_AUTOGEN_TESTCASES: 'off' });
		try {
			const target = await createStoredRun(services, 'integration-run-4');
			await services.runs.publish(target, 'report', { report: target.report });
			await new Promise((resolve) => setTimeout(resolve, 50));
			const cases = await services.testCases.list({ source: 'auto' });
			assert.equal(cases.length, 0);
		} finally {
			await services.lifecycle.close();
		}
	});
});
