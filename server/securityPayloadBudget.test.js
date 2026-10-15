import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	guardSecurityPayloadTool,
	countSecurityPayloadActivities,
	runHasSecurityChecks
} from './securityPayloadBudget.js';
import { clampSecurityPayloadLimit } from './config.js';

function fakeTool(name) {
	return {
		name,
		async run() { return { success: true, name }; }
	};
}

test('the payload limit is a bounded safety ceiling', () => {
	assert.equal(clampSecurityPayloadLimit(40), 40);
	assert.equal(clampSecurityPayloadLimit(undefined), 40);
	assert.equal(clampSecurityPayloadLimit('not-a-number'), 40);
	assert.equal(clampSecurityPayloadLimit(0), 40);
	assert.equal(clampSecurityPayloadLimit(-5), 40);
	assert.equal(clampSecurityPayloadLimit(100000), 200);
});

test('only security-check runs get the payload guard', () => {
	const standardRun = { selectedTests: ['navigation', 'forms'], activities: [] };
	assert.equal(runHasSecurityChecks(standardRun), false);
	const tool = guardSecurityPayloadTool(fakeTool('browser_fill'), standardRun, 2);
	// Untouched: same object identity, no wrapper.
	assert.equal(tool.name, 'browser_fill');
	assert.equal(tool.run.constructor.name, 'AsyncFunction');

	const securityRun = { selectedTests: ['security_sql_injection'], activities: [] };
	assert.equal(runHasSecurityChecks(securityRun), true);
	const guarded = guardSecurityPayloadTool(fakeTool('browser_fill'), securityRun, 2);
	assert.notEqual(guarded, fakeTool('browser_fill').run);
});

test('the guard blocks payload tools at the cap with a terminal instruction', async () => {
	const session = {
		selectedTests: ['security_input_validation'],
		activities: [
			{ toolName: 'browser_fill', status: 'completed' },
			{ toolName: 'browser_type', status: 'completed' },
			{ toolName: 'browser_type', status: 'running' }
		]
	};
	assert.equal(countSecurityPayloadActivities(session), 2);
	const guarded = guardSecurityPayloadTool(fakeTool('browser_fill'), session, 2);
	const blocked = await guarded.run({});
	assert.equal(blocked.success, false);
	assert.equal(blocked.code, 'SECURITY_PAYLOAD_LIMIT_REACHED');
	assert.equal(blocked.used, 2);
	assert.equal(blocked.limit, 2);
	assert.match(blocked.error, /not tested with this reason/);

	// Below the cap, the tool runs normally.
	const underGuarded = guardSecurityPayloadTool(fakeTool('browser_type'), session, 3);
	assert.deepEqual(await underGuarded.run({}), { success: true, name: 'browser_type' });
});

test('non-payload browser tools pass through even on security runs', () => {
	const session = { selectedTests: ['security_authentication'], activities: [] };
	const snapshot = fakeTool('browser_snapshot');
	const guarded = guardSecurityPayloadTool(snapshot, session, 1);
	assert.equal(guarded, snapshot);
});
