/**
 * Compliance SQA end to end: the real CleanSlate SDK loop, driven by a
 * scripted OpenAI-compatible model server, against the QA Lab's BrightPath
 * education site (planted compliance gaps) in a real browser. Web search is
 * answered by a stub of the SDK's hosted search provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSqaEngine, createSqaRunState } from './engine.js';
import { startQaLab } from '../qa/fixtureSite.js';
import { buildSqaMarkdown } from './report.js';
import { startScriptedModel, stubWebSearch } from './testDoubles.js';

const ENV = { ...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', QASE_SQA_MAX_MINUTES: '12', QASE_SQA_KEY_PAGES: '6', QASE_QA_ASK_CREDENTIALS: 'false' };

function harness(targetUrl) {
	const session = { id: `sqa-${Math.random().toString(16).slice(2)}`, mode: 'sqa', targetUrl, engine: 'chromium', device: 'desktop', messages: [], activities: [], findings: [], todos: [], sqa: createSqaRunState({}) };
	const runStore = {
		async commit() {}, publish() {},
		async addMessage(s, message) { s.messages.push(message); },
		async addActivity(s, activity) { const entry = { id: activity.id ?? Math.random().toString(16).slice(2), ...activity }; s.activities.push(entry); return entry; },
		async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); },
		async setStatus(s, status) { s.status = status; }
	};
	return { session, runStore, artifactStore: { save: () => ({ artifactId: `ART-${Math.random().toString(16).slice(2, 8)}` }) } };
}

test('compliance SQA identifies an education product, researches standards, tests them and reports per framework', { timeout: 600_000 }, async () => {
	const lab = await startQaLab();
	const model = await startScriptedModel();
	const restore = stubWebSearch();
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqa-ws-'));
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}edu/`);
		const settings = { reasoner: { enabled: true, model: 'scripted-analyst', baseUrl: model.url, apiKey: 'test-key' } };
		await runSqaEngine({ session, runStore, record: {}, env: ENV, settings, artifactStore, rootDir });
		const state = session.sqa;
		assert.equal(session.status, 'done');
		assert.equal(state.product.category, 'education');
		assert.equal(state.product.audience.children, true);
		assert.deepEqual(state.frameworks.map(item => item.name), ['WCAG 2.2 Level AA', 'COPPA', 'India DPDP Act 2023'], 'the unsourced framework was rejected');
		assert.ok(state.sources.some(item => item.url.includes('ftc.gov')), 'search results are recorded as sources');
		assert.ok(state.requirements.length >= 9);
		const byTitle = title => state.requirements.find(item => item.title === title);
		assert.equal(byTitle('Consent before tracking').status, 'fail', 'the _ga cookie before consent is measured');
		assert.equal(byTitle('Consent before tracking').decidedBy, 'measured');
		assert.equal(byTitle('Images have text alternatives').status, 'fail');
		assert.equal(byTitle('Notice where data is collected').status, 'fail', 'the child sign-up form has no privacy notice');
		assert.equal(byTitle('Notice to data principals').status, 'pass', 'a privacy policy is linked');
		assert.equal(byTitle('Privacy notice covers children').status, 'fail');
		assert.equal(byTitle('Privacy notice covers children').decidedBy, 'agent');
		assert.equal(byTitle('Verifiable parental consent').status, 'needs_documents');
		assert.ok(!state.requirements.some(item => item.status === 'untested'), 'every requirement has an outcome');
		assert.equal(session.report.verdict, 'non_compliant');
		assert.match(session.report.summary, /BrightPath/);
		assert.ok(session.findings.length >= 4 && session.findings.every(item => item.category === 'compliance'));
		assert.ok(session.messages.some(item => item.kind === 'sqa-report'));
		assert.ok(session.messages.some(item => /This looks like \*\*Online live classes/.test(item.text)));
		const evidence = kind => state.evidence.find(item => item.kind === kind);
		assert.equal(evidence('privacy.cookie_reject').status, 'issue');
		assert.equal(evidence('privacy.children_notice').status, 'issue');
		assert.equal(evidence('privacy.accessibility_statement').status, 'issue');
		const markdown = buildSqaMarkdown(session);
		assert.match(markdown, /## Frameworks assessed/);
		assert.match(markdown, /COPPA/);
		assert.match(markdown, /not legal advice/);
		assert.ok(model.log.length >= 6, 'the SDK made model calls in every stage');
		assert.ok(model.log.every(entry => entry.tools.length <= 7), 'each stage advertises only its own tools');
	} finally {
		restore();
		await model.close();
		await lab.close();
	}
});

test('without a reasoning model the assessment still completes from a labelled baseline and measured evidence', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}edu/`);
		await runSqaEngine({ session, runStore, record: {}, env: ENV, settings: { reasoner: { enabled: false } }, artifactStore });
		const state = session.sqa;
		assert.equal(session.status, 'done');
		assert.equal(state.product.category, 'education');
		assert.ok(state.product.heuristic);
		assert.ok(state.frameworks.length >= 3 && state.frameworks.every(item => item.baseline));
		assert.ok(state.frameworks.some(item => /COPPA/.test(item.name)), 'a children\'s product gets COPPA in the baseline');
		assert.ok(state.requirements.some(item => item.status === 'fail' && item.decidedBy === 'measured'));
		assert.ok(session.report.notCovered.some(line => /No reasoning-model key/.test(line)));
	} finally { await lab.close(); }
});
