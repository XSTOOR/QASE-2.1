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

test('runtime session identifiers and attestation are captured before release', async () => {
	const { session, bridge } = fixture();
	await captureRuntimeFacts(session, bridge, { deviceSessionId: 'runtime-123', deviceSession: { attestation: { device_id: 'device-123' } } });
	assert.equal(session.runtimeFacts.runtimeSessionId, 'runtime-123'); assert.equal(session.runtimeFacts.attestation.device_id, 'device-123');
	await captureRuntimeFacts(session, { readRuntimeFacts: async () => null });
	assert.equal(session.runtimeFacts.runtimeSessionId, 'runtime-123');
});
test('agent capture is wired into the QA finalizer and precedes device-session release', () => {
	const agent = readFileSync(new URL('./agent.js', import.meta.url), 'utf8');
	assert.match(agent, /captureRuntimeFacts: \(\) => captureRuntimeFacts\(session, record\.bridge, record\)/);
	const capture = agent.indexOf('await captureRuntimeFacts(session, bridge, record);');
	assert.ok(capture > 0 && capture < agent.indexOf('record.deviceSessionId = null;', capture));
});
