/**
 * Founder review end to end: the real CleanSlate SDK loop, driven by a
 * scripted OpenAI-compatible model server, against the QA Lab's Taskly
 * startup site (planted business gaps) in a real browser. Web search is
 * answered by a stub of the SDK's hosted search provider.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFounderEngine, createFounderRunState } from './engine.js';
import { startQaLab } from '../qa/fixtureSite.js';
import { buildFounderMarkdown, buildFounderHtml } from './report.js';
import { stubWebSearch } from '../sqa/testDoubles.js';
import { COMPETITOR_RESULTS, startFounderModel } from './testDoubles.js';
import { founderActionSource } from '../founderActions.js';
import { buildFounderHandoffPayload } from '../founderHandoff.js';

const ENV = { ...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1', QASE_FOUNDER_MAX_MINUTES: '12', QASE_FOUNDER_KEY_PAGES: '6', QASE_QA_ASK_CREDENTIALS: 'false' };

function harness(targetUrl, brief) {
	const session = { id: `fdr-${Math.random().toString(16).slice(2)}`, mode: 'founder', targetUrl, engine: 'chromium', device: 'desktop', messages: [], activities: [], findings: [], todos: [], founder: createFounderRunState({ targetUrl, brief }) };
	const commits = [];
	const record = {};
	const runStore = {
		async commit(_session, type, payload) { commits.push({ type, payload }); if (type === 'question' && payload.question?.kind === 'founder_brief') setTimeout(() => record.founderReply?.({ text: 'Get small agencies to start the free trial; we compete with Asana.' }), 20); }, publish() {},
		async addMessage(s, message) { s.messages.push(message); },
		async addActivity(s, activity) { const entry = { id: activity.id ?? Math.random().toString(16).slice(2), ...activity }; s.activities.push(entry); return entry; },
		async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); },
		async setStatus(s, status) { s.status = status; }
	};
	return { session, runStore, record, commits, artifactStore: { save: () => ({ artifactId: `ART-${Math.random().toString(16).slice(2, 8)}` }) } };
}

test('Founder review understands the business, researches competitors, walks journeys and advises what to do and avoid', { timeout: 600_000 }, async () => {
	const lab = await startQaLab();
	const model = await startFounderModel();
	const restore = stubWebSearch(COMPETITOR_RESULTS);
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-ws-'));
	try {
		const { session, runStore, record, commits, artifactStore } = harness(`${lab.url}saas/`, { audience: 'Small agencies', journeys: 'Invite a teammate', competitors: 'asana.com' });
		const settings = { reasoner: { enabled: true, model: 'scripted-founder', baseUrl: model.url, apiKey: 'test-key' } };
		await runFounderEngine({ session, runStore, record, env: ENV, settings, artifactStore, rootDir });
		const state = session.founder;
		assert.equal(session.status, 'done');
		assert.equal(state.phases.brief.detail, 'from the launcher', 'a launcher brief means no question');
		assert.equal(state.business.category, 'saas');
		assert.equal(state.journeyPlan[0].name, 'Invite a teammate', "the owner's journey is walked first");
		assert.deepEqual(state.market.competitors.map(item => item.name), ['Asana', 'Trello'], 'the competitor without a found source was rejected');
		const signal = kind => state.signals.find(item => item.kind === kind);
		for (const kind of ['value.cta_above_fold', 'trust.social_proof', 'conversion.pricing', 'onboarding.signup_friction', 'mobile.layout', 'discoverability.meta']) assert.equal(signal(kind).status, 'missing', kind);
		assert.equal(signal('value.headline').status, 'weak');
		assert.equal(signal('conversion.free_start').status, 'good');
		assert.equal(state.journeys.length, 4);
		assert.equal(state.journeys.find(item => /pricing/i.test(item.name)).outcome, 'blocked');
		assert.equal(Object.keys(state.lenses).length, 10, 'every business area is scored by the reviewer');
		const report = state.report;
		assert.ok(report.readiness > 0 && report.readiness < 60, `readiness ${report.readiness}`);
		assert.ok(['not_ready', 'major_gaps'].includes(report.verdict));
		assert.ok(!report.recommendations.some(item => /ad campaign/i.test(item.title)), 'a "now" recommendation without evidence is rejected');
		assert.deepEqual(report.recommendations.slice(0, 4).map(item => item.priority), ['now', 'now', 'now', 'now'], 'do-now items come first');
		assert.deepEqual(report.recommendations.map(item => item.id).slice(0, 3), ['R1', 'R2', 'R3']);
		assert.ok(report.recommendations.some(item => item.kind === 'avoid'), 'the review says what not to do');
		assert.equal(report.keep.length, 1);
		assert.match(report.positioning, /small agencies/);
		assert.ok(state.finalizedAt);
		assert.ok(commits.some(item => item.type === 'founder.finalized'), 'the finalized event publishes the recommendations for Studio');
		assert.equal(session.findings.length, 4);
		assert.ok(session.findings.every(item => item.category === 'business' && item.fix));
		assert.ok(session.messages.some(item => item.kind === 'founder-report'));
		assert.ok(session.messages.filter(item => item.kind === 'founder-rec').length >= 3);
		// The Studio handoff reads the same recommendations.
		const source = founderActionSource(session);
		const { payload } = buildFounderHandoffPayload(source, ['R1', 'R3']);
		assert.equal(payload.implementationRequirements.length, 2);
		assert.match(payload.implementationRequirements[0].title, /headline/i);
		assert.ok(payload.implementationRequirements[0].actions.length);
		const markdown = buildFounderMarkdown(session);
		for (const expected of [/## Scorecard/, /## Recommendations/, /Avoid — Don't ask for a phone number/, /## Journeys walked/, /Asana/, /## Measured signals/]) assert.match(markdown, expected);
		assert.match(buildFounderHtml(session), /Founder review — Taskly/);
		assert.ok(model.log.length >= 8);
	} finally {
		restore();
		await model.close();
		await lab.close();
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});

test('without a brief the agent asks once in the conversation and uses the answer', { timeout: 600_000 }, async () => {
	const lab = await startQaLab();
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'founder-ws-'));
	try {
		const { session, runStore, record, commits, artifactStore } = harness(`${lab.url}saas/`, {});
		// No reasoning model: the brief is still asked, and the review falls back to measured advice.
		await runFounderEngine({ session, runStore, record, env: { ...ENV, QASE_FOUNDER_ASK_BRIEF: 'true' }, settings: { reasoner: { enabled: false } }, artifactStore, rootDir });
		const state = session.founder;
		assert.ok(commits.some(item => item.type === 'question' && item.payload.question?.kind === 'founder_brief'));
		assert.equal(state.phases.brief.detail, 'answered in the conversation');
		assert.match(state.brief.goals, /free trial/);
		assert.equal(session.status, 'done');
		assert.ok(state.business.heuristic);
		assert.ok(state.report.recommendations.length >= 5, 'advice is written from the measured signals');
		assert.ok(state.report.recommendations.every(item => item.source === 'measured'));
		assert.equal(state.report.lenses.find(item => item.id === 'conversion').scoredBy, 'measured');
		assert.ok(state.report.readiness !== null);
		assert.match(state.limitations.map(item => item.message).join(' '), /No reasoning-model key/);
	} finally {
		await lab.close();
		fs.rmSync(rootDir, { recursive: true, force: true });
	}
});
