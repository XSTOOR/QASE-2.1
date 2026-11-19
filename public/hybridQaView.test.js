import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridAvailabilityMessage, hybridLaunchOptions, hybridScenarioProgress } from './hybridQaView.js';

test('availability describes which models assist the engine', () => {
	assert.match(hybridAvailabilityMessage({ hybridQa: { reasoner: 'opus', classifier: 'jev', reasonerConfigured: true, classifierConfigured: false } }), /opus explores.*no JEV key/);
});

test('progress counts finished engine phases', () => {
	const session = { mode: 'qa', hybrid: { version: 2, phases: [{ status: 'done' }, { status: 'skipped' }, { status: 'running' }, { status: 'pending' }] } };
	assert.deepEqual(hybridScenarioProgress(session), { total: 4, done: 2, percent: 50 });
	assert.equal(hybridScenarioProgress({ mode: 'qa', hybrid: { version: 1 } }), null);
});

test('launch options need exactly one available configuration', () => {
	const configurations = [{ envId: 'e1', availability: 'AVAILABLE', executionEngine: 'chromium', browserCode: 'chrome' }];
	assert.equal(hybridLaunchOptions({ mode: 'legacy' }), null);
	assert.throws(() => hybridLaunchOptions({ mode: 'hybrid', envIds: [], configurations }), /one browser configuration/);
	assert.throws(() => hybridLaunchOptions({ mode: 'hybrid', envIds: ['missing'], configurations }), /no longer available/);
});
