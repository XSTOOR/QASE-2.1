/**
 * End-to-end engine runs against the seeded-defect QA Lab in a real browser.
 * Models are simulated at the HTTP boundary, so these tests cost nothing and
 * still exercise the real exploration, triage and report code paths.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runQaEngine } from './engine.js';
import { startQaLab } from './fixtureSite.js';
import { qaModelSettings } from './models.js';
import { storeSecrets, clearSecrets } from '../secrets.js';

const ENV = {
	...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
	QASE_QA_MAX_MINUTES: '15', QASE_QA_MAX_PAGES: '5', QASE_QA_VIEWPORT_PAGES: '1', QASE_QA_INTERACTION_PAGES: '1', QASE_QA_EXPLORE_STEPS: '6'
};

function harness(targetUrl) {
	const session = { id: `qa-${Math.random().toString(16).slice(2)}`, mode: 'qa', targetUrl, engine: 'chromium', device: 'desktop', messages: [], activities: [], findings: [], todos: [] };
	const statuses = [];
	const runStore = {
		async commit() {},
		async addMessage(s, message) { s.messages.push(message); },
		async addActivity(s, activity) { s.activities.push(activity); return activity; },
		async updateActivity(s, id, patch) { Object.assign(s.activities.find(item => item.id === id) ?? {}, patch); },
		async setStatus(s, status, detail) { s.status = status; statuses.push({ status, detail }); },
		publish() {}
	};
	return { session, runStore, statuses, artifactStore: { save: () => ({ artifactId: `ART-${Math.random().toString(16).slice(2, 8)}` }) } };
}

const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A scripted reasoner + JEV at the HTTP boundary. */
function simulatedModels() {
	const seen = { exploration: 0, vision: 0, report: 0, jev: 0 };
	const fetchImpl = async (url, init) => {
		const body = JSON.parse(init.body);
		if (String(url).includes('/decisions')) {
			seen.jev++;
			const answers = {};
			for (const [id, question] of Object.entries(body.questions)) answers[id] = question.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'score', score: 2 };
			return json({ model: 'jev-1.13', answers, usage: { input_tokens: 100, output_tokens: 20 } });
		}
		const usage = { prompt_tokens: 200, completion_tokens: 50 };
		if (body.tools?.length) {
			seen.exploration++;
			const call = seen.exploration === 1
				? { id: 'c1', type: 'function', function: { name: 'report_issue', arguments: JSON.stringify({ title: 'Price shows $undefined after loading', severity: 'high', category: 'functional', steps: ['Open the home page', 'Look at the price'], expected: 'A real price', actual: 'The price reads $undefined per month' }) } }
				: { id: `c${seen.exploration}`, type: 'function', function: { name: 'finish', arguments: '{"summary":"Checked the home page journey."}' } };
			return json({ choices: [{ message: { content: null, tool_calls: [call] } }], usage });
		}
		const system = body.messages[0]?.content ?? '';
		if (system.includes('VISUAL DEFECTS')) { seen.vision++; return json({ choices: [{ message: { content: '{"issues":[]}' } }], usage }); }
		if (system.includes('conclusion of a website QA report')) {
			seen.report++;
			return json({ choices: [{ message: { content: JSON.stringify({ summary: 'Simulated executive summary.', recommendations: ['Fix the exposed .env file first.'], fixes: [{ index: 0, fix: 'Simulated precise fix.' }] }) } }], usage });
		}
		return json({ choices: [{ message: { content: '{}' } }], usage });
	};
	return { fetchImpl, seen };
}

test('engine completes a full run with reasoner and JEV, finding seeded defects across categories', { timeout: 420_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, statuses, artifactStore } = harness(lab.url);
		const models = simulatedModels();
		await runQaEngine({ session, runStore, record: {}, env: ENV, settings: qaModelSettings({ QASE_API_KEY: 'test-key' }, {}), modelFetch: models.fetchImpl, artifactStore });
		assert.equal(session.status, 'done');
		assert.ok(session.report, 'a report is always published');
		assert.equal(session.report.summary, 'Simulated executive summary.');
		const detectors = new Set(session.findings.map(item => item.detector));
		for (const expected of ['page.text_overlap', 'page.control_obscured', 'motion.opens_behind', 'motion.dead_control', 'forms.no_validation', 'security.reflected_xss', 'security.exposed_file', 'security.sql_error', 'security.open_redirect', 'agent.exploration']) {
			assert.ok(detectors.has(expected), `expected a finding from ${expected}`);
		}
		assert.ok(models.seen.jev > 0, 'JEV verified candidates');
		assert.ok(models.seen.exploration >= 2, 'the reasoner explored');
		assert.ok(session.findings.every(item => item.fix), 'every finding carries fix guidance for its prompt');
		assert.ok(session.findings.every(item => item.evidence?.includes('Verified by')));
		assert.equal(session.hybrid.version, 2);
		assert.deepEqual(statuses.at(-1), { status: 'done', detail: undefined });
	} finally { await lab.close(); }
});

test('engine still completes with a report when both models fail', { timeout: 420_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(lab.url);
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_PAGES: '2' }, settings: qaModelSettings({ QASE_API_KEY: 'test-key' }, {}),
			modelFetch: async () => new Response('{"error":"down"}', { status: 503, headers: { 'content-type': 'application/json' } }), artifactStore });
		assert.equal(session.status, 'done');
		assert.ok(session.report);
		assert.ok(session.findings.length > 5, 'deterministic detectors still report');
		assert.ok(session.report.notCovered.some(line => /exploratory testing was unavailable/i.test(line)));
		assert.ok(session.report.notCovered.some(line => /Neither JEV nor the reasoning model/i.test(line)));
	} finally { await lab.close(); }
});

test('a user stop still publishes a partial report', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(lab.url);
		const controller = new AbortController();
		const originalSetStatus = runStore.setStatus;
		let stopTimer;
		runStore.setStatus = async (s, status, detail) => {
			if (status === 'running') stopTimer = setTimeout(() => controller.abort(), 12_000);
			return originalSetStatus(s, status, detail);
		};
		await runQaEngine({ session, runStore, record: {}, signal: controller.signal, env: ENV, settings: qaModelSettings({}, {}), artifactStore });
		clearTimeout(stopTimer);
		assert.equal(session.status, 'done');
		assert.equal(session.report.verdict === 'pass' ? 'pass' : 'ok', 'ok');
		assert.ok(session.report.notCovered.some(line => /Stopped by the user/.test(line)));
		assert.ok(Object.values(session.hybrid.phases).some(phase => phase.status === 'skipped'));
	} finally { await lab.close(); }
});

test('an unreachable target ends as a blocked report, not an error', { timeout: 120_000 }, async () => {
	const lab = await startQaLab();
	const url = lab.url;
	await lab.close();
	const { session, runStore, artifactStore } = harness(url);
	await runQaEngine({ session, runStore, record: {}, env: ENV, settings: qaModelSettings({}, {}), artifactStore });
	assert.equal(session.status, 'done');
	assert.equal(session.report.verdict, 'blocked');
	assert.ok(session.report.notCovered.some(line => /could not be loaded/i.test(line)));
});

test('a provided test account signs in once and signed-in pages are tested', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}account`);
		storeSecrets(session.id, { QA_USERNAME: 'qa@lab.test', QA_PASSWORD: 'lab-pass' });
		session.qaAuth = { authorized: true, loginUrl: `${lab.url}login` };
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_PAGES: '2' }, settings: qaModelSettings({}, {}), artifactStore });
		assert.equal(session.status, 'done');
		assert.equal(session.hybrid.signedIn, true);
		assert.ok(session.findings.some(item => item.detector === 'page.broken_text' && item.url.endsWith('/account')), 'the signed-in page was audited');
		assert.ok(!JSON.stringify(session).includes('lab-pass'), 'the password never appears in run state');
	} finally { await lab.close(); }
});
