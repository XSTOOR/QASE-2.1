import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeApplicationServices } from './localServices.js';

const RUN_ID = '6bf078e0-20df-48c3-a6f8-eb74ca14b9e1';

test('artifact purge uses only non-creating live lookup and always drops the record', async () => {
	const calls = [];
	let record = {
		controller: { abort: () => calls.push('abort') },
		dispose: () => calls.push('dispose')
	};
	const runStore = {
		peekLive: () => record,
		dropLive: () => {
			calls.push('drop');
			record = undefined;
		},
		liveFor: () => {
			throw new Error('purge must not create a live record');
		}
	};
	const services = createRuntimeApplicationServices(runStore, {
		purgeRunWorkspace: async runId => calls.push(`workspace:${runId}`)
	});

	await services.agent.purgeArtifacts(RUN_ID);
	await services.agent.purgeArtifacts(RUN_ID);
	assert.deepEqual(calls, [
		'abort', 'dispose', 'drop', `workspace:${RUN_ID}`,
		'drop', `workspace:${RUN_ID}`
	]);
});

test('artifact purge still removes workspace and live entry when runtime disposal fails', async () => {
	const calls = [];
	const failure = new Error('runtime dispose failed');
	const runStore = {
		peekLive: () => ({ dispose: () => { throw failure; } }),
		dropLive: () => calls.push('drop'),
		liveFor: () => { throw new Error('must not be called'); }
	};
	const services = createRuntimeApplicationServices(runStore, {
		purgeRunWorkspace: async () => calls.push('workspace')
	});

	await assert.rejects(services.agent.purgeArtifacts(RUN_ID), failure);
	assert.deepEqual(calls, ['drop', 'workspace']);
});
