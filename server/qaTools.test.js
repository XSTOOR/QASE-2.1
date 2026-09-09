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
		activities: [{ id: 'media-observation', toolName: 'browser_snapshot', status: 'done' }], ...overrides
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
});

test('QA waits for ongoing tools and cannot finalize SQA or Founder runs', async () => {
	const target = fixture({ activities: [{ id: 'running-mic', toolName: 'browser_media_probe', status: 'running', ts: 0 }] });
	const result = await target.finish.run(report);
	assert.equal(result.success, false);
	assert.deepEqual(result.active_activity_ids, ['running-mic']);
	for (const mode of ['sqa', 'founder']) {
		assert.equal((await fixture({ mode }).finish.run(report)).success, false);
	}
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
