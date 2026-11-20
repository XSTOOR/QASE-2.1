import './testWorkingDirectory.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createQaTools } from './qaTools.js';
import { buildReportMarkdown } from './report.js';
import { clearSecrets, storeSecrets } from './secrets.js';

function fixture(overrides = {}) {
	const session = {
		id: randomUUID(), mode: 'qa', createdAt: Date.now(), targetUrl: 'https://example.test/meeting',
		findings: [], messages: [], todos: [{ text: 'Verify meeting prejoin microphone flow', status: 'completed' }],
		activities: [{ id: 'media-observation', toolName: 'browser_snapshot', status: 'done' }],
		// Phase D3: verified runtime facts so integrity checks pass by default.
		runtimeFacts: { executionLevel: 'SIMULATED', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/153', os: 'Linux', capturedAt: new Date().toISOString() },
		...overrides
	};
	const commits = [];
	const tools = createQaTools(session, { async commit(_session, type, payload) { commits.push({ type, payload }); } });
	return { session, commits, finding: tools[0], finish: tools[1] };
}

const report = { verdict: 'pass', summary: 'Meeting prejoin and microphone selection were exercised.', covered: ['Meeting prejoin microphone selection'] };
const finding = {
	title: 'Meeting microphone fails to start', severity: 'high', category: 'media',
	expected: 'The microphone audio track is live.', actual: 'The track ends immediately.',
	steps: ['Open the meeting link', 'Allow microphone access', 'Start the microphone'],
	evidence: 'The microphone track state is ended.'
};


test('report markdown includes token usage when counted and omits the line otherwise', () => {
	const counted = fixture({ tokenUsage: {
		inputTokens: 15_000, outputTokens: 3_500, totalTokens: 18_500, cachedInputTokens: 900, estimated: false
	} });
	const markdown = buildReportMarkdown(counted.session);
	assert.match(markdown, /\*\*Tokens:\*\* 15,000 prompt \/ 3,500 completion \/ 18,500 total/);

	const estimated = fixture({ tokenUsage: {
		inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200, estimated: true
	} });
	assert.match(buildReportMarkdown(estimated.session), /\*\*Tokens:\*\* 1,000 prompt \/ 200 completion \/ 1,200 total \(estimated\)/);

	// Uncounted runs render unchanged — never a zero line.
	assert.doesNotMatch(buildReportMarkdown(fixture().session), /Tokens/);
});

test('report markdown includes the linked test case and omits it for unlinked runs', () => {
	const linked = fixture({ testCaseId: 'TC-0007', testCaseSnapshot: { caseNumber: 'TC-0007', title: 'Checkout completes' } });
	assert.match(buildReportMarkdown(linked.session), /\*\*Test case:\*\* Checkout completes \(TC-0007\)/);

	const idOnly = fixture({ testCaseId: 'TC-0007' });
	assert.match(buildReportMarkdown(idOnly.session), /\*\*Test case:\*\* TC-0007/);

	assert.doesNotMatch(buildReportMarkdown(fixture().session), /Test case/);
});

test('report markdown carries the environment snapshot when the run selected one', () => {
	const withEnvironment = fixture({ environmentSnapshot: {
		envId: 'ENV-MAC-SONOMA-CHR-151',
		platform: 'macos',
		device: 'MacBook Pro',
		osVersion: 'Sonoma',
		browser: 'Chrome',
		browserVersion: '151',
		executionProvider: 'environment'
	} });
	delete withEnvironment.session.runtimeFacts;
	const markdown = buildReportMarkdown(withEnvironment.session);
	// Phase 22: a catalog capability hint alone never claims "real device" —
	// without RECORDED execution facts the report says NOT AVAILABLE FOR REAL
	// EXECUTION instead of inventing a level.
	assert.match(markdown, /\*\*Environment:\*\* MacBook Pro · Sonoma · Chrome 151/);
	assert.doesNotMatch(markdown, /real device/i);
	assert.match(markdown, /\*\*Execution:\*\* NOT AVAILABLE FOR REAL EXECUTION/);

	// Runs without an environment keep the legacy device line, never an undefined.
	assert.doesNotMatch(buildReportMarkdown(fixture().session), /undefined/);
});



// #17997: validation failures must name the actual cause. E2E hybrid run
// a3418492 showed the generic message sending the agent into a 6-call retry
// loop during budget closeout.






test('report markdown states the execution level from recorded facts, never the request', () => {
	const recorded = fixture({
		environmentSnapshot: { envId: 'ENV-X', device: 'iPhone 16 Pro', osVersion: '18.3', browser: 'Safari' },
		executionLevelRequested: 'REAL_DEVICE',
		executionLevel: 'SIMULATED',
		executionProviderActual: 'local-simulation',
		runtimeFacts: { executionLevel: 'SIMULATED', provider: 'local-simulation' }
	});
	const markdown = buildReportMarkdown(recorded.session);
	assert.match(markdown, /\*\*Execution:\*\* SIMULATED \(local-simulation\)/);

	const real = fixture({
		environmentSnapshot: { envId: 'ENV-Y', device: 'Pixel 9', osVersion: '15', browser: 'Chrome' },
		runtimeFacts: { executionLevel: 'REAL_DEVICE', provider: 'browserstack' }
	});
	assert.match(buildReportMarkdown(real.session), /\*\*Execution:\*\* REAL DEVICE \(remote environment runtime\)/);
});

test('report markdown marks environment runs without a level NOT AVAILABLE FOR REAL EXECUTION; old runs unaffected', () => {
	const envNoLevel = fixture({
		environmentSnapshot: { envId: 'ENV-Z', device: 'iPad Pro 13', osVersion: '18.1', browser: 'Safari' },
		runtimeFacts: undefined
	});
	delete envNoLevel.session.runtimeFacts;
	assert.match(buildReportMarkdown(envNoLevel.session), /\*\*Execution:\*\* NOT AVAILABLE FOR REAL EXECUTION/);

	// Backward compatibility: legacy run without an environment renders no Execution line.
	const legacy = fixture();
	delete legacy.session.runtimeFacts;
	assert.doesNotMatch(buildReportMarkdown(legacy.session), /Execution/);
});

// ---------------------------------------------------------------------------
// R2 #14491 · Runtime identity verification in the integrity gate
// ---------------------------------------------------------------------------

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.65 Safari/537.36';
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0';





