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

test('stopping mid-security-check halts cleanly and marks nothing passed', async () => {
	const fixture = securityRunFixture();
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		// The user hits Stop while a security probe is in flight.
		fixture.record.controller.abort();
	};
	await runTurn(fixture.session, { task: 'Run security checks' }, fixture.store);
	assert.equal(calls, 1);
	// Same contract as any stopped run: explicit interruption, user-stop detail, no continuation.
	assert.equal(fixture.session.status, 'interrupted');
	assert.equal(fixture.statuses.at(-1).detail, 'Stopped by user.');
	assert.equal(fixture.record.running, false);
	assert.equal(fixture.record.controller, undefined);
	// And nothing about the security checks was recorded as executed/passed.
	assert.equal(fixture.session.findings.length, 0);
});

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
