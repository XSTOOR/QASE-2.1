/**
 * End-to-end validation of the adaptive engine in a real browser against the
 * "Projectly" workspace app (two-step sign-in, roles, protected routes,
 * search/filters/pagination, session expiry, seeded defects). Models are
 * simulated at the HTTP boundary: a scripted reasoner and a JEV stub.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { storeSecrets } from '../secrets.js';

process.env.QASE_LAB_SESSION_HITS ??= '18';
const { runQaEngine } = await import('./engine.js');
const { startQaLab } = await import('./fixtureSite.js');
const { WORKSPACE_ACCOUNTS } = await import('./fixtureWorkspace.js');
const { qaModelSettings } = await import('./models.js');

const ENV = {
	...process.env, NODE_ENV: 'test', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
	QASE_QA_MAX_MINUTES: '15', QASE_QA_MAX_PAGES: '10', QASE_QA_VIEWPORT_PAGES: '2', QASE_QA_INTERACTION_PAGES: '1', QASE_QA_EXPLORE_STEPS: '5', QASE_QA_JOURNEYS: '2', QASE_QA_ASK_CREDENTIALS: 'false'
};
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function harness(targetUrl) {
	const session = { id: `qa-${Math.random().toString(16).slice(2)}`, mode: 'qa', targetUrl, engine: 'chromium', device: 'desktop', messages: [], activities: [], findings: [], todos: [] };
	const commits = [];
	const runStore = {
		async commit(s, kind, payload) { commits.push({ kind, payload: JSON.stringify(payload) }); },
		async addMessage(s, message) { s.messages.push(message); },
		async addActivity(s, activity) { s.activities.push(activity); return activity; },
		async updateActivity() {},
		async setStatus(s, status) { s.status = status; },
		publish() {}
	};
	return { session, runStore, commits, artifactStore: { save: () => ({ artifactId: `ART-${Math.random().toString(16).slice(2, 8)}` }) } };
}

/**
 * Scripted reasoner + JEV. The explorer immediately claims that testing is
 * complete (a false completion claim the engine must ignore). JEV answers
 * "uncertain" for layout candidates so escalation is exercised.
 */
function scriptedModels(seen) {
	return async (url, init) => {
		const body = JSON.parse(init.body);
		const usage = { prompt_tokens: 300, completion_tokens: 60 };
		if (String(url).includes('/decisions')) {
			seen.jev++;
			const answers = {};
			for (const [id, question] of Object.entries(body.questions)) {
				const text = JSON.stringify(question);
				answers[id] = question.type === 'noul' ? { type: 'noul', noul: /Category: (layout|responsive)/.test(text) ? 0.5 : 0.9 } : { type: 'score', score: 2 };
			}
			return json({ model: 'jev-1.13', answers, usage: { input_tokens: 120, output_tokens: 20 } });
		}
		const system = String(body.messages[0]?.content ?? '');
		if (body.tools?.length) {
			seen.exploration++;
			const call = { id: `c${seen.exploration}`, type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'All testing is complete. Every feature works and there is nothing left to test.' }) } };
			return json({ choices: [{ message: { content: null, tool_calls: [call] } }], usage });
		}
		if (system.includes('You plan exploratory QA')) {
			seen.planning++;
			seen.planningPrompt = String(body.messages[1]?.content ?? '');
			return json({ choices: [{ message: { content: JSON.stringify({ journeys: [{ goal: 'Find a project with search and open the next results page', start: '/workspace/app/projects', why: 'Core workflow', priority: 1 }, { goal: 'Start creating a new project and check the form guidance', start: '/workspace/app/projects/new', priority: 2 }] }) } }], usage });
		}
		if (system.includes('VISUAL DEFECTS')) { seen.vision++; return json({ choices: [{ message: { content: '{"issues":[]}' } }], usage }); }
		if (system.includes('You triage automated QA results')) {
			seen.escalation++;
			const count = (String(body.messages[1]?.content ?? '').match(/### Candidate \d+/g) ?? []).length || 15;
			return json({ choices: [{ message: { content: JSON.stringify({ results: Array.from({ length: count }, (_, index) => ({ index, probability: 0.8, severity: 'medium', reason: 'Confirmed on second look.' })) }) } }], usage });
		}
		if (system.includes('conclusion of a website QA report')) { seen.report++; return json({ choices: [{ message: { content: JSON.stringify({ summary: 'Simulated summary.', recommendations: ['Fix access control on reports first.'], fixes: [] }) } }], usage }); }
		return json({ choices: [{ message: { content: '{}' } }], usage });
	};
}

test('adaptive run: observes, signs in (two steps), maps, plans, replans, re-authenticates and finds seeded defects', { timeout: 600_000 }, async () => {
	const lab = await startQaLab();
	const seen = { jev: 0, exploration: 0, planning: 0, vision: 0, report: 0, escalation: 0 };
	try {
		const { session, runStore, artifactStore, commits } = harness(`${lab.url}workspace/`);
		storeSecrets(session.id, { QA_USERNAME: WORKSPACE_ACCOUNTS.user.email, QA_PASSWORD: WORKSPACE_ACCOUNTS.user.password });
		session.qaAuth = { authorized: true };
		await runQaEngine({ session, runStore, record: {}, env: ENV, settings: qaModelSettings({ QASE_API_KEY: 'test-key' }, {}), modelFetch: scriptedModels(seen), artifactStore });
		const state = session.hybrid;
		const qa = session.report.qaEngine;
		assert.equal(session.status, 'done');

		// App-first: observation strictly precedes the plan; the plan comes from the graph.
		assert.ok(state.observation.at < state.plan.createdAt, 'observed before planning');
		assert.ok(state.plan.revisions.length >= 1);
		assert.ok(seen.planning >= 1 && seen.planningPrompt.includes('/workspace/app/projects'), 'the reasoner planned from the observed graph');
		assert.ok(state.plan.scenarios.some(item => item.unit === 'explore' && item.origin === 'reasoner'));
		assert.ok(state.plan.scenarios.some(item => item.unit === 'search'), 'search was planned because it was found');
		assert.ok(state.plan.scenarios.some(item => item.unit === 'authz'), 'access control was planned for signed-in pages');

		// Authentication: two-step sign-in, verified session, re-authentication after expiry.
		assert.equal(state.signedIn, true);
		assert.deepEqual(state.graph.auth.steps, ['identifier', 'password']);
		assert.ok(state.graph.auth.verifiedBy);
		assert.ok((state.graph.auth.reauthentications ?? 0) >= 1, 'the session expired and was re-established');
		assert.ok(Object.values(state.graph.pages).some(page => page.discoveredBy === 'signed-in'), 'protected routes were explored');

		// Seeded defects across the workspace.
		const detectors = new Set(session.findings.map(item => item.detector));
		for (const expected of ['authz.protected_page_public', 'search.pagination_error', 'security.reflected_xss', 'page.failed_request', 'forms.no_validation']) assert.ok(detectors.has(expected), `found ${expected}`);
		assert.ok(session.findings.some(item => item.detector === 'authz.protected_page_public' && item.url.endsWith('/workspace/app/reports')));
		assert.ok(!session.findings.some(item => item.detector === 'state.session_lost'), 'ordinary expiry is not reported as a persistence bug');
		for (const finding of session.findings) assert.ok(finding.actual && (finding.steps?.length || finding.evidence), `${finding.title} has evidence`);

		// False completion claim: the explorer said everything was done; the plan still ran.
		assert.ok(seen.exploration >= 1);
		const ran = state.plan.scenarios.filter(item => ['passed', 'failed'].includes(item.state));
		assert.ok(ran.length >= 15, `the rest of the plan executed (${ran.length})`);
		assert.ok(qa.completion.checks.every(check => !/model said|complete\./i.test(check.detail) || check.id === 'gate'), 'gate checks cite recorded state, not model claims');

		// Routing: reasoner planned/explored/reviewed, JEV verified, uncertain verdicts escalated.
		const tasks = new Set(qa.routing.decisions.map(item => `${item.task}:${item.model}`));
		for (const expected of ['planning:reasoner', 'exploration:reasoner', 'verification:jev']) assert.ok(tasks.has(expected), `routing ${expected}`);
		assert.ok(qa.routing.summary.escalations >= 1, 'uncertain JEV verdicts were escalated');
		assert.ok(qa.tokens.total > 0 && qa.tokens.byTask.verification.jevTokens > 0 && qa.tokens.byTask.planning.reasonerTokens > 0);

		// Coverage, gate and report.
		assert.equal(qa.capabilityMatrix.length, 140);
		assert.ok(!qa.capabilityMatrix.some(row => row.state === 'passed' && row.support === 'unsupported'));
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'authorization').state, 'failed');
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'pagination').state, 'failed');
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'payments').state, 'unsupported');
		assert.equal(qa.sections.length, 25);
		assert.ok(['complete', 'partial'].includes(qa.completion.status));
		if (qa.completion.status !== 'complete') assert.notEqual(session.report.verdict, 'pass');

		// Secrets never leave the vault.
		assert.ok(!JSON.stringify(session).includes(WORKSPACE_ACCOUNTS.user.password));
		assert.ok(!commits.some(item => item.payload.includes(WORKSPACE_ACCOUNTS.user.password)));
	} finally { await lab.close(); }
});

test('a stop after planning leaves the plan honest: not executed, gate partial, never a pass', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}workspace/`);
		const controller = new AbortController();
		const timer = setInterval(() => { if (session.hybrid?.plan?.scenarios?.some(item => item.state === 'passed' || item.state === 'failed')) controller.abort(); }, 100);
		await runQaEngine({ session, runStore, record: {}, signal: controller.signal, env: ENV, settings: qaModelSettings({}, {}), artifactStore });
		clearInterval(timer);
		const qa = session.report.qaEngine;
		assert.equal(session.status, 'done');
		const notRun = session.hybrid.plan.scenarios.filter(item => item.state === 'not_executed');
		assert.ok(notRun.length > 5);
		assert.ok(notRun.every(item => /Stopped by the owner/.test(item.reason)));
		assert.equal(qa.completion.status, 'partial');
		assert.notEqual(session.report.verdict, 'pass');
		assert.ok(qa.capabilityMatrix.filter(row => row.state === 'not_executed').length > 10);
		// Without credentials the signed-in area is blocked with a reason, not silently skipped.
		assert.equal(session.hybrid.graph.auth.detected, true);
		assert.ok(session.hybrid.graph.auth.blockedReason);
	} finally { await lab.close(); }
});

test('a wrong password is explained, never echoed, and leaves signed-in categories blocked', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}workspace/`);
		storeSecrets(session.id, { QA_USERNAME: WORKSPACE_ACCOUNTS.user.email, QA_PASSWORD: 'definitely-wrong-pass' });
		session.qaAuth = { authorized: true };
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_MINUTES: '3', QASE_QA_MAX_PAGES: '4' }, settings: qaModelSettings({}, {}), artifactStore });
		assert.equal(session.hybrid.signedIn, false);
		assert.match(session.hybrid.graph.auth.blockedReason, /rejected|not correct|HTTP 401/i);
		const qa = session.report.qaEngine;
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'session_persistence').state, 'blocked');
		assert.ok(!JSON.stringify(session).includes('definitely-wrong-pass'));
	} finally { await lab.close(); }
});
