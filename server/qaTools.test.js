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

test('partial results require gaps, keep runtime integrity and never hide high severity', async () => {
	const partial = { ...report, verdict: 'partial', not_covered: ['Authentication not executed.'] };
	const valid = fixture();
	assert.equal((await valid.finish.run(partial)).success, true);
	assert.equal(valid.session.report.verdict, 'partial');
	assert.match(buildReportMarkdown(valid.session), /Completed with gaps/);
	assert.equal((await fixture().finish.run({ ...partial, not_covered: [] })).success, false);
	const missingIdentity = fixture({ runtimeFacts: {} });
	await missingIdentity.finish.run(partial);
	assert.equal(missingIdentity.session.report.verdict, 'blocked');
	const high = fixture({ findings: [{ ...finding }] });
	await high.finish.run(partial);
	assert.equal(high.session.report.verdict, 'fail');
});

test('QA finding to Markdown workflow preserves evidence, redacts vaulted data, and fails high-impact defects', async t => {
	const target = fixture();
	storeSecrets(target.session.id, { password: 'qa-test-private-password' });
	t.after(() => clearSecrets(target.session.id));
	assert.equal((await target.finding.run({ ...finding, evidence: `${finding.evidence} qa-test-private-password` })).success, true);
	const published = await target.finish.run(report);
	assert.equal(published.success, true);
	assert.equal(published.verdict, 'fail');
	assert.equal(target.session.report.bySeverity.high, 1);
	assert.deepEqual(target.commits.map(item => item.type), ['finding', 'report']);
	const markdown = buildReportMarkdown(target.session);
	assert.match(markdown, /Meeting microphone fails to start/);
	assert.match(markdown, /microphone audio track is live/);
	assert.match(markdown, /\*\*Verdict:\*\* Fail/);
	assert.equal(JSON.stringify(target.session).includes('qa-test-private-password'), false);
	assert.equal(markdown.includes('qa-test-private-password'), false);
});

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

test('QA rejects malformed model findings and reports without mutating durable state', async () => {
	const target = fixture();
	for (const value of [undefined, null, [], {}, { ...finding, title: {} }, { ...finding, actual: ' ' }, { ...finding, severity: 'urgent' }]) {
		assert.equal((await target.finding.run(value)).success, false);
	}
	for (const value of [undefined, null, [], {}, { ...report, verdict: 'approved' }, { ...report, summary: ' ' }, { ...report, covered: [{}] }]) {
		assert.equal((await target.finish.run(value)).success, false);
	}
	assert.equal(target.session.findings.length, 0);
	assert.equal(target.session.report, undefined);
	assert.equal(target.commits.length, 0);
});

test('QA finish requires completed work and model force cannot bypass it', async () => {
	const target = fixture({ todos: [{ text: 'Verify microphone permission rejection', status: 'pending' }] });
	assert.equal('force' in target.finish.parametersSchema.properties, false);
	const result = await target.finish.run({ ...report, force: true });
	assert.equal(result.success, false);
	assert.equal(result.remaining_count, 1);
	assert.equal(target.session.report, undefined);
	assert.equal(target.commits.length, 0);
});

test('QA cannot publish success without a plan, successful browser evidence, or declared coverage', async () => {
	for (const overrides of [{ todos: [] }, { activities: [] }, { activities: [{ toolName: 'browser_open', status: 'failed' }] }]) {
		const target = fixture(overrides);
		assert.equal((await target.finish.run(report)).success, false);
		assert.equal(target.session.report, undefined);
	}
	const target = fixture();
	assert.equal((await target.finish.run({ ...report, covered: [] })).success, false);
	// Phase D3: unverified runtime downgrades to BLOCKED instead of PASS.
	const unverified = fixture({ runtimeFacts: undefined });
	delete unverified.session.runtimeFacts;
	const blocked = await unverified.finish.run(report);
	assert.equal(blocked.success, true);
	assert.equal(unverified.session.report.verdict, 'blocked');
	assert.ok(unverified.session.report.notCovered.some(line => line.includes('Device runtime could not be verified')));
});

test('QA waits for ongoing tools and cannot finalize SQA or Founder runs', async () => {
	const target = fixture({ activities: [{ id: 'running-mic', toolName: 'browser_media_probe', status: 'running', ts: Date.now() }] });
	const result = await target.finish.run(report);
	assert.equal(result.success, false);
	assert.deepEqual(result.active_activity_ids, ['running-mic']);
	for (const mode of ['sqa', 'founder']) {
		assert.equal((await fixture({ mode }).finish.run(report)).success, false);
	}
});

test('a running activity left behind by a dead process no longer blocks publishing', async () => {
	// Production incident: browser_click stayed "running" for hours after a
	// restart, rejecting finish_qa_report 24 times in a row.
	const stale = fixture({ activities: [
		{ id: 'stuck-click', toolName: 'browser_click', status: 'running', ts: Date.now() - 130_000 },
		{ id: 'done-wait', toolName: 'browser_wait', status: 'done', ts: Date.now() - 200_000 }
	] });
	const result = await stale.finish.run(report);
	assert.equal(result.success, true);
	assert.equal(stale.session.report.verdict, 'pass');
	assert.equal(stale.commits.length, 1);

	const timeless = fixture({ activities: [
		{ id: 'ancient-click', toolName: 'browser_click', status: 'running' },
		{ id: 'done-snapshot', toolName: 'browser_snapshot', status: 'done', ts: Date.now() - 200_000 }
	] });
	assert.equal((await timeless.finish.run(report)).success, true);
});

test('a blocked QA report records unavailable checks without inventing browser evidence', async () => {
	const target = fixture({ todos: [], activities: [] });
	assert.equal((await target.finish.run({ verdict: 'blocked', summary: 'The meeting needs an authorized test account.' })).success, false);
	const result = await target.finish.run({
		verdict: 'blocked', summary: 'The meeting needs an authorized test account.',
		not_covered: ['Meeting prejoin and microphone: an authorized meeting URL and test account were unavailable.']
	});
	assert.equal(result.success, true);
	assert.equal(result.verdict, 'blocked');
	assert.deepEqual(target.session.report.covered, []);
	assert.equal(target.session.report.notCovered.length, 1);
});

test('QA storage failure cannot leave a phantom finding or completed report', async () => {
	const target = fixture();
	const previous = structuredClone(target.session);
	const tools = createQaTools(target.session, { async commit() { throw new Error('persistence unavailable'); } });
	await assert.rejects(tools[0].run(finding), /persistence unavailable/);
	assert.deepEqual(target.session, previous);
	await assert.rejects(tools[1].run(report), /persistence unavailable/);
	assert.deepEqual(target.session, previous);
	assert.equal((await target.finish.run(report)).success, true);
});

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

test('R2: runtime identity matching the selection does not block a passing run', async () => {
	const target = fixture({
		environmentSnapshot: { envId: 'ENV-WIN-CHROME-141', platform: 'windows', browser: 'Chrome', browserCode: 'chrome', browserVersion: '141', os: 'Windows', osVersion: '11' },
		runtimeFacts: { executionLevel: 'SIMULATED', userAgent: CHROME_UA, capturedAt: new Date().toISOString() }
	});
	const published = await target.finish.run({ ...report, verdict: 'pass' });
	assert.equal(published.success, true);
	assert.equal(target.session.report.runtimeIdentity?.browserCode, 'chrome');
	assert.equal(target.session.report.runtimeIdentity?.browserVersionAuthoritative, true);
});

test('R2: Chrome executing when Firefox was selected downgrades the verdict to BLOCKED', async () => {
	const target = fixture({
		environmentSnapshot: { envId: 'ENV-WIN-FIREFOX-141', platform: 'windows', browser: 'Firefox', browserCode: 'firefox', browserVersion: '141', os: 'Windows', osVersion: '11' },
		runtimeFacts: { executionLevel: 'SIMULATED', userAgent: CHROME_UA, capturedAt: new Date().toISOString() }
	});
	const published = await target.finish.run({ ...report, verdict: 'pass' });
	assert.equal(published.success, true);
	assert.equal(published.verdict, 'blocked');
	assert.ok(
		(target.session.report.notCovered ?? []).some((line) => /Runtime identity mismatch/.test(String(line))),
		'block reason names the mismatch'
	);
});

test('R2: browser version drift (selected 140, runtime reports 141) blocks', async () => {
	const target = fixture({
		environmentSnapshot: { envId: 'ENV-WIN-CHROME-140', platform: 'windows', browser: 'Chrome', browserCode: 'chrome', browserVersion: '151', os: 'Windows', osVersion: '11' },
		runtimeFacts: { executionLevel: 'SIMULATED', userAgent: CHROME_UA, capturedAt: new Date().toISOString() }
	});
	const published = await target.finish.run({ ...report, verdict: 'pass' });
	assert.equal(published.verdict, 'blocked');
	assert.ok((target.session.report.notCovered ?? []).some((line) => /version mismatch/.test(String(line))));
});

test('R2: runs without an environment or observable facts keep the legacy behavior', async () => {
	const noEnv = fixture({ runtimeFacts: { executionLevel: 'SIMULATED', userAgent: CHROME_UA } });
	assert.equal((await noEnv.finish.run({ ...report, verdict: 'pass' })).success, true);
	const noFacts = fixture({ environmentSnapshot: { envId: 'ENV-X', platform: 'windows', browserCode: 'chrome', browserVersion: '141' }, runtimeFacts: undefined });
	delete noFacts.session.runtimeFacts;
	const published = await noFacts.finish.run({ ...report, verdict: 'pass' });
	// No observable identity → runtimeConnected check fails → blocked (pre-R2 behavior).
	assert.equal(published.verdict, 'blocked');
});

test('R2: report markdown carries the runtime-observed browser identity', async () => {
	const observed = fixture({
		environmentSnapshot: { envId: 'ENV-MAC-FIREFOX-141', platform: 'macos', browser: 'Firefox', browserCode: 'firefox', browserVersion: '141', os: 'macOS', osVersion: '15' },
		runtimeFacts: { executionLevel: 'SIMULATED', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:141.0) Gecko/20100101 Firefox/141.0', capturedAt: new Date().toISOString() }
	});
	await observed.finish.run({ ...report, verdict: 'pass' });
	const markdown = buildReportMarkdown(observed.session);
	assert.match(markdown, /Runtime browser \(observed\):\*\* firefox 141\.0, Gecko engine/);
});
