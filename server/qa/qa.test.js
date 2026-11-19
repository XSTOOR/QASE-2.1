import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaModels, parseModelJson, qaModelSettings } from './models.js';
import { candidate, mergeCandidates } from './findings.js';
import { triage } from './triage.js';
import { buildReport, verdictFor } from './report.js';
import { createFrontier } from './crawl.js';
import { buildFindingFixPrompt } from '../../public/fixPromptBuilder.js';

const settings = (overrides = {}) => {
	const base = qaModelSettings({ QASE_API_KEY: 'test-key' }, {});
	return { reasoner: { ...base.reasoner, ...overrides.reasoner }, jev: { ...base.jev, ...overrides.jev } };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('parseModelJson reads fenced, bare and embedded JSON', () => {
	assert.deepEqual(parseModelJson('```json\n{"a":1}\n```'), { a: 1 });
	assert.deepEqual(parseModelJson('Sure! {"issues":[]} hope that helps'), { issues: [] });
	assert.equal(parseModelJson('no json here'), undefined);
});

test('model settings: no key means both models are disabled, never an error', () => {
	const resolved = qaModelSettings({}, {});
	assert.equal(resolved.reasoner.enabled, false);
	assert.equal(resolved.jev.enabled, false);
	const models = createQaModels({ settings: resolved, state: {} });
	assert.equal(models.reasonerAvailable(), false);
	assert.equal(models.jevAvailable(), false);
});

test('reasoner retries transient failures, then opens a circuit instead of throwing', async () => {
	let calls = 0;
	const models = createQaModels({ settings: settings(), state: {}, fetchImpl: async () => { calls++; return json({ error: 'busy' }, 503); } });
	const first = await models.chat([{ role: 'user', content: 'hi' }]);
	assert.equal(first, undefined);
	assert.equal(calls, 3);
	assert.equal(models.reasonerAvailable(), false, 'three consecutive failures open the circuit');
	assert.equal(await models.chat([{ role: 'user', content: 'again' }]), undefined);
	assert.equal(calls, 3, 'an open circuit makes no further requests');
});

test('reasoner records usage and returns text and tool calls', async () => {
	const state = {};
	const usage = [];
	const models = createQaModels({ settings: settings(), state, onUsage: entry => usage.push(entry), fetchImpl: async () => json({
		choices: [{ message: { content: 'ok', tool_calls: [{ id: 't1', function: { name: 'finish', arguments: '{}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 }
	}) });
	const reply = await models.chat([{ role: 'user', content: 'x' }]);
	assert.equal(reply.text, 'ok');
	assert.equal(reply.toolCalls[0].function.name, 'finish');
	assert.equal(state.reasoner.inputTokens, 10);
	assert.equal(usage[0].totalTokens, 15);
});

test('JEV keeps valid answers when the usage receipt is missing or one answer is malformed', async () => {
	const models = createQaModels({ settings: settings(), state: {}, fetchImpl: async () => json({ model: 'jev-1.13', answers: { a: { type: 'noul', noul: 0.8 }, b: { type: 'noul', noul: 7 } } }) });
	const answers = await models.decide({}, { a: { type: 'noul', instructions: 'x' }, b: { type: 'noul', instructions: 'y' } });
	assert.deepEqual(answers, { a: { type: 'noul', noul: 0.8 } });
});

test('JEV rejection (4xx) is not retried and does not throw', async () => {
	let calls = 0;
	const models = createQaModels({ settings: settings(), state: {}, fetchImpl: async () => { calls++; return json({}, 401); } });
	assert.equal(await models.decide({}, { a: { type: 'noul', instructions: 'x' } }), undefined);
	assert.equal(calls, 1);
});

test('candidates from several viewports merge into one finding', () => {
	const base = { detector: 'page.text_overlap', category: 'layout', title: 'Text overlaps', url: 'https://x.test/a', selector: 'h1', actual: 'x', data: { key: 'h1|p' } };
	const merged = mergeCandidates([candidate({ ...base, viewport: 'desktop', severity: 'medium' }), candidate({ ...base, viewport: 'mobile', severity: 'high' })]);
	assert.equal(merged.length, 1);
	assert.deepEqual(merged[0].viewports, ['desktop', 'mobile']);
	assert.equal(merged[0].severity, 'high');
});

test('triage: JEV verdicts promote or dismiss; detector severity moves at most one step', async () => {
	const strong = candidate({ detector: 'page.control_obscured', category: 'layout', severity: 'high', confidence: 0.85, title: 'Button covered', actual: 'covered', url: 'https://x.test/' });
	const weak = candidate({ source: 'visual', detector: 'visual.review', category: 'visual', severity: 'medium', confidence: 0.6, title: 'Maybe misaligned', actual: 'hmm', url: 'https://x.test/' });
	const fetchImpl = async (_url, init) => {
		const body = JSON.parse(init.body);
		const answers = {};
		for (const id of Object.keys(body.questions)) answers[id] = id.startsWith('g') ? { type: 'noul', noul: id === 'g0' ? 0.9 : 0.2 } : { type: 'score', score: 0 };
		return json({ model: 'jev-1.13', answers, usage: { input_tokens: 5, output_tokens: 5 } });
	};
	const models = createQaModels({ settings: settings({ reasoner: { enabled: false } }), state: {}, fetchImpl });
	const result = await triage({ candidates: [strong, weak], models, context: { target: 'https://x.test/' } });
	assert.deepEqual(result.findings.map(item => item.title), ['Button covered']);
	assert.equal(result.findings[0].severity, 'medium', 'graded info → detector severity drops one step only');
	assert.deepEqual(result.dismissed.map(item => item.title), ['Maybe misaligned']);
	assert.deepEqual(result.stats.verifiedBy, ['jev']);
});

test('triage without any model falls back to detector confidence', async () => {
	const models = createQaModels({ settings: qaModelSettings({}, {}), state: {} });
	const result = await triage({ candidates: [
		candidate({ detector: 'page.broken_image', category: 'content', severity: 'medium', confidence: 0.9, title: 'Broken', actual: 'x', url: 'https://x.test/' }),
		candidate({ detector: 'page.missing_h1', category: 'seo', severity: 'info', confidence: 0.4, title: 'No h1', actual: 'x', url: 'https://x.test/' })
	], models, context: { target: 'https://x.test/' } });
	assert.deepEqual(result.findings.map(item => item.title), ['Broken']);
	assert.equal(result.stats.unverified, 2);
});

test('verdicts are deterministic', () => {
	assert.equal(verdictFor({ findings: [], loaded: false }), 'blocked');
	assert.equal(verdictFor({ findings: [{ severity: 'high' }], loaded: true }), 'fail');
	assert.equal(verdictFor({ findings: [{ severity: 'low' }], loaded: true }), 'pass_with_issues');
	assert.equal(verdictFor({ findings: [], loaded: true, coverageGaps: true }), 'partial');
	assert.equal(verdictFor({ findings: [], loaded: true }), 'pass');
});

test('report lists coverage, limitations and model usage', () => {
	const models = createQaModels({ settings: qaModelSettings({}, {}), state: {} });
	const report = buildReport({ session: { targetUrl: 'https://x.test/' }, findings: [{ title: 'A', severity: 'low' }], dismissed: [], loaded: true, models, triageStats: {},
		coverage: { pages: 3, viewports: ['desktop', 'mobile'], interactions: 4, forms: 1, securityChecks: 30, injectionUrls: 2 },
		limitations: [{ message: 'Exploration skipped', affectsCoverage: false }] });
	assert.equal(report.verdict, 'pass_with_issues');
	assert.deepEqual(report.notCovered, ['Exploration skipped']);
	assert.ok(report.covered.some(line => line.includes('3 pages')));
	assert.equal(report.qaEngine.models.reasoner.used, false);
});

test('fix prompts include element, viewports and the suggested fix', () => {
	const prompt = buildFindingFixPrompt({ title: 'Menu behind content', severity: 'high', category: 'layout', url: 'https://x.test/', expected: 'On top', actual: 'Behind', selector: '#menu', viewports: ['desktop'], fix: 'Raise the z-index.' });
	assert.match(prompt, /Element: #menu/);
	assert.match(prompt, /Viewports: desktop/);
	assert.match(prompt, /## Suggested fix\nRaise the z-index\./);
});

test('crawl frontier stays in scope, skips destructive and binary URLs, and caps URL patterns', () => {
	const frontier = createFrontier({ start: 'https://x.test/', inScope: url => url.startsWith('https://x.test/'), maxPages: 10 });
	assert.equal(frontier.add('https://other.test/'), false);
	assert.equal(frontier.add('/logout'), false);
	assert.equal(frontier.add('/file.pdf'), false);
	assert.equal(frontier.add('/item/1'), true);
	assert.equal(frontier.add('/item/2'), true);
	assert.equal(frontier.add('/item/3'), false, 'at most two URLs per pattern');
});
