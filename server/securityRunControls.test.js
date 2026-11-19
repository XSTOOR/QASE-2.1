import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { runTurn } from './agent.js';
import { guardSecurityPayloadTool } from './securityPayloadBudget.js';

function securityRunFixture() {
	const session = {
		id: randomUUID(),
		mode: 'qa',
		targetUrl: 'https://fixture.test',
		selectedTests: ['security_authentication', 'security_input_validation'],
		securityAuthorization: { confirmed: true, notes: 'isolated fixture' },
		messages: [], activities: [], todos: [], findings: [], secretNames: []
	};
	const record = {
		runtime: { async *run() {}, getPendingQuestion: () => undefined },
		bridge: { hasPage: () => false, captureFrame: async () => {}, stopFrames() {} }
	};
	const statuses = [];
	const store = {
		liveFor: () => record, listLive: () => [], publish() {}, commit: async () => {},
		setStatus: async (s, status, detail) => { s.status = status; statuses.push({ status, detail }); },
		addActivity: async (s, item) => { const activity = { ts: Date.now(), ...item }; s.activities.push(activity); return activity; },
		updateActivity: async (s, id, patch) => Object.assign(s.activities.find(item => item.id === id), patch),
		addMessage: async (s, item) => { s.messages.push(item); return s.messages.at(-1); }
	};
	return { session, record, store, statuses };
}


test('the payload guard stops the flood without blocking the finalizer', async () => {
	const { session } = securityRunFixture();
	session.activities = [
		{ toolName: 'browser_fill', status: 'done' },
		{ toolName: 'browser_type', status: 'done' }
	];
	let payloadCalls = 0;
	const guarded = guardSecurityPayloadTool({
		name: 'browser_fill',
		run: async () => { payloadCalls++; return { success: true }; }
	}, session, 2);
	const blocked = await guarded.run({});
	assert.equal(blocked.success, false);
	assert.equal(blocked.code, 'SECURITY_PAYLOAD_LIMIT_REACHED');
	assert.equal(payloadCalls, 0);
	// The instruction tells the agent to report honestly instead of hammering.
	assert.match(blocked.error, /not tested with this reason/);

	// Non-payload tools (e.g. the finalizer, snapshots) are untouched.
	let finalizerCalls = 0;
	const finalizer = guardSecurityPayloadTool({
		name: 'finish_qa_report',
		run: async () => { finalizerCalls++; return { success: true }; }
	}, session, 2);
	assert.equal((await finalizer.run({}, {})).success, true);
	assert.equal(finalizerCalls, 1);
});
