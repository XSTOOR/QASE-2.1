import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureRuntimeFacts } from './runtimeCapture.js';
import { createQaTools } from './qaTools.js';

const facts = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36', platform: 'Win32', viewport: { width: 1440, height: 900 } };
function fixture() {
	const session = { id: 'capture-race', mode: 'qa', status: 'running', findings: [{ severity: 'medium' }], todos: [{ text: 'Test navigation', status: 'completed' }], activities: [{ toolName: 'browser_snapshot', status: 'done' }], environmentSnapshot: { platform: 'macos', browserCode: 'chrome', browserVersion: '151', os: 'macOS' } };
	const bridge = { readRuntimeFacts: async () => facts, execution: { level: 'SIMULATED', provider: 'local' } };
	return { session, bridge };
}
const input = { verdict: 'pass_with_issues', summary: 'Navigation tested; authentication not in scope.', covered: ['Navigation'], not_covered: ['No sign-in credentials provided.'] };

test('lazy browser facts are captured before finalization, preventing a false blocked report', async () => {
	const { session, bridge } = fixture();
	let published;
	const tools = createQaTools(session, { async commit(_, type, payload) { if (type === 'report') { assert.ok(session.runtimeFacts?.userAgent); published = payload.report; } } }, { captureRuntimeFacts: () => captureRuntimeFacts(session, bridge) });
	const result = await tools[1].run(input);
	assert.equal(result.verdict, 'pass_with_issues'); assert.equal(published.runtimeIdentity.browserCode, 'chrome');
	assert.deepEqual(published.notCovered, input.not_covered); assert.equal(published.bySeverity.medium, 1);
});
test('missing browser evidence still blocks rather than pretending the run passed', async () => {
	const { session } = fixture();
	const tools = createQaTools(session, { async commit() {} }, { captureRuntimeFacts: async () => { throw Error('Browser closed'); } });
	assert.equal((await tools[1].run(input)).verdict, 'blocked');
});
test('fresh evidence of a different browser still blocks the report', async () => {
	const { session, bridge } = fixture(); session.environmentSnapshot.browserCode = 'firefox';
	const tools = createQaTools(session, { async commit() {} }, { captureRuntimeFacts: () => captureRuntimeFacts(session, bridge) });
	assert.equal((await tools[1].run(input)).verdict, 'blocked');
});
test('runtime session identifiers and attestation are captured before release', async () => {
	const { session, bridge } = fixture();
	await captureRuntimeFacts(session, bridge, { deviceSessionId: 'runtime-123', deviceSession: { attestation: { device_id: 'device-123' } } });
	assert.equal(session.runtimeFacts.runtimeSessionId, 'runtime-123'); assert.equal(session.runtimeFacts.attestation.device_id, 'device-123');
	await captureRuntimeFacts(session, { readRuntimeFacts: async () => null });
	assert.equal(session.runtimeFacts.runtimeSessionId, 'runtime-123');
});
test('cancelled executions cannot publish a late success report after timeout', async () => {
	const { session, bridge } = fixture(); let cancelled = false; let commits = 0;
	const tools = createQaTools(session, { async commit() { commits++; } }, { captureRuntimeFacts: async () => { await captureRuntimeFacts(session, bridge); cancelled = true; }, isCancelled: () => cancelled });
	assert.equal((await tools[1].run(input)).success, false); assert.equal(commits, 0); assert.equal(session.report, undefined);
});
test('agent capture is wired into the QA finalizer and precedes device-session release', () => {
	const agent = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
	assert.match(agent, /captureRuntimeFacts: \(\) => captureRuntimeFacts\(session, record\.bridge, record\)/);
	const capture = agent.indexOf('await captureRuntimeFacts(session, bridge, record);');
	assert.ok(capture > 0 && capture < agent.indexOf('record.deviceSessionId = null;', capture));
});
