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

test('QA progress advances with finished scenarios while the plan runs', () => {
	const phases = ['observe', 'signin', 'discover', 'plan', 'execute', 'triage', 'publish'].map((id, index) => ({ id, status: index < 4 ? 'done' : index === 4 ? 'running' : 'pending' }));
	const session = { mode: 'qa', hybrid: { version: 2, phases, plan: { summary: { total: 20, pending: 10, running: 1 } } } };
	const progress = hybridScenarioProgress(session);
	assert.equal(progress.done, 4);
	assert.deepEqual(progress.scenarios, { done: 9, total: 20 });
	assert.equal(progress.percent, Math.round((4 + 9 / 20) / 7 * 100));
	session.hybrid.plan.summary = { total: 20, pending: 0, running: 0 };
	assert.equal(hybridScenarioProgress(session).percent, Math.round(5 / 7 * 100), 'never more than the work done');
});
