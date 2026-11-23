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
	...process.env, NODE_ENV: 'test', QASE_QA_VISION_PROBE: '7:red', QASE_BROWSER_ALLOWED_PRIVATE_HOSTS: '127.0.0.1',
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
		const firstContent = body.messages?.[0]?.content;
		if (Array.isArray(firstContent) && JSON.stringify(firstContent).includes('Vision check')) {
			// Answer only if a real JPEG arrived (base64 JPEG starts with /9j/ and is not tiny).
			const image = firstContent.find(part => part.type === 'image_url')?.image_url?.url ?? '';
			const real = /^data:image\/jpeg;base64,\/9j\//.test(image) && image.length > 4000;
			return json({ choices: [{ message: { content: real ? '{"digit":"7","background":"red"}' : '{"digit":"?","background":"?"}' } }], usage: { prompt_tokens: 900, completion_tokens: 10 } });
		}
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
		// Vision was proven with a real image before screenshots were relied on, and images reached the model.
		assert.equal(state.vision?.ok, true, JSON.stringify(state.vision));
		assert.ok(qa.routing.decisions.some(item => item.modality === 'image+text'), 'image calls are logged with their modality');

		// Coverage, gate and report.
		assert.equal(qa.capabilityMatrix.length, 140);
		assert.ok(!qa.capabilityMatrix.some(row => row.state === 'passed' && row.support === 'unsupported'));
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'authorization').state, 'failed');
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'pagination').state, 'failed');
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'payments').state, 'not_applicable', 'no checkout was observed');
		assert.equal(qa.capabilityMatrix.find(row => row.id === 'create_records').state, 'unsupported', 'forms exist but writes are not authorized');
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

test('a single-page app that keeps its session in sessionStorage is signed into and tested beyond the login page', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}workspace/spa/login`);
		storeSecrets(session.id, { QA_USERNAME: WORKSPACE_ACCOUNTS.user.email, QA_PASSWORD: WORKSPACE_ACCOUNTS.user.password });
		session.qaAuth = { authorized: true };
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_MINUTES: '3', QASE_QA_MAX_PAGES: '6' }, settings: qaModelSettings({}, {}), artifactStore });
		assert.equal(session.hybrid.signedIn, true, session.hybrid.graph.auth.blockedReason);
		const signedInPages = Object.entries(session.hybrid.graph.pages).filter(([, page]) => page.discoveredBy === 'signed-in').map(([url]) => new URL(url).pathname);
		for (const path of ['/workspace/spa/app/settings', '/workspace/spa/app/billing']) assert.ok(signedInPages.includes(path), `tested ${path} (got ${signedInPages.join(', ')})`);
		assert.ok(!JSON.stringify(session).includes(WORKSPACE_ACCOUNTS.user.password));
	} finally { await lab.close(); }
});

test('a button-navigated app behind a welcome tour is walked screen by screen, tabs and dialogs included', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}workspace/rail/`);
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_MINUTES: '8', QASE_QA_MAX_PAGES: '6' }, settings: qaModelSettings({}, {}), artifactStore });
		const graph = session.hybrid.graph;
		const paths = Object.keys(graph.pages).map(url => new URL(url).pathname);
		for (const path of ['/workspace/rail/projects', '/workspace/rail/meeting', '/workspace/rail/about', '/workspace/rail/projects/42']) assert.ok(paths.includes(path), `reached ${path} by clicking (got ${paths.join(', ')})`);
		assert.equal(paths.filter(path => path.startsWith('/workspace/rail/chat/')).length, 1, 'one chat screen, not one per visit');
		const views = graph.views.map(view => view.label);
		assert.ok(views.includes('Archived'), `tab found (views: ${views.join(', ')})`);
		assert.ok(views.includes('Preferences'), 'dialog found');
		assert.ok(views.includes('Inbox'), 'a side panel opened from the rail');
		assert.ok(views.includes('Inbox › Board') && views.includes('Inbox › Threads'), `controls inside the panel were explored (views: ${views.join(', ')})`);
		assert.ok(!graph.views.some(view => /Welcome to Rail/.test(view.heading)), 'a returning tour is not mistaken for a feature');
		assert.ok(session.hybrid.overlaysDismissed?.some(item => /Welcome to Rail/.test(item) && /Skip/.test(item)), 'the tour was closed with Skip');
		assert.ok(session.hybrid.graph.transitions.some(item => /click "Projects"/.test(item.via)));
		assert.ok(session.hybrid.candidates.some(item => item.detector === 'page.failed_request' && item.url.includes('/workspace/rail/meeting')), 'the failing API on a click-only screen was found');
		// In place: Back restores the screen; page loads are rare.
		assert.ok(session.hybrid.uiWalk.backs >= 3, `went back with history (${JSON.stringify(session.hybrid.uiWalk)})`);
		assert.ok(session.hybrid.uiWalk.reloads <= 2, `reloads stay rare (${JSON.stringify(session.hybrid.uiWalk)})`);
		assert.ok(graph.views.find(view => view.label === 'Archived').appeared.some(text => /Archived projects/.test(text)), 'a panel records what appeared');
	} finally { await lab.close(); }
});

test('explorer: sees what each action changed, recovers from stale refs, and gets the untested checklist', { timeout: 180_000 }, async () => {
	const lab = await startQaLab();
	const { createQaBrowser } = await import('./browser.js');
	const { explore } = await import('./explorer.js');
	const browser = await createQaBrowser({ session: { id: 'x', targetUrl: `${lab.url}workspace/rail/`, engine: 'chromium', device: 'desktop' }, env: ENV });
	const prompts = [];
	const toolResults = [];
	let step = 0;
	const models = {
		reasonerAvailable: () => true, visionAvailable: () => false, jevAvailable: () => false, state: { reasoner: {}, jev: {} },
		async chat(messages) {
			prompts.push(messages[1].content);
			const last = messages.at(-1);
			if (last.role === 'tool') toolResults.push(last.content);
			const observation = [...messages].reverse().find(item => item.role === 'tool' || (item.role === 'user' && typeof item.content === 'string' && item.content.includes('Interactive elements')))?.content ?? messages[1].content;
			const ref = label => new RegExp(`(e\\d+) [^\\n]*"${label}"`).exec(observation)?.[1];
			step++;
			const call = (name, args) => ({ text: '', toolCalls: [{ id: `c${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
			if (step === 1) return call('click', { ref: ref('Projects') ?? 'e0' });
			if (step === 2) return call('click', { ref: ref('Archived') ?? 'e0' });
			if (step === 3) return call('click', { ref: 'e999' });
			if (step === 4) return call('click', { ref: ref('Active') ?? 'e0' });
			return call('finish', { summary: 'Opened Projects and both tabs.' });
		}
	};
	try {
		const result = await explore({ browser, profile: { name: 'desktop', label: 'Desktop', viewport: { width: 1280, height: 800 } }, startUrl: `${lab.url}workspace/rail/about`, models, maxSteps: 8, deadline: Date.now() + 120_000, blockedWrites: () => 0, save: async () => undefined, goal: 'Open Projects and check its tabs', untested: ['panel "Archived" on /workspace/rail/projects'] });
		assert.match(prompts[0], /not yet exercised[\s\S]*Archived/, 'the checklist is in the prompt');
		assert.match(prompts[0], /Journey to test now/);
		assert.match(toolResults[0], /RESULT: URL changed to .*\/workspace\/rail\/projects/, toolResults[0].slice(0, 300));
		assert.match(toolResults[1], /RESULT: URL unchanged\. .*Appeared: .*Archived projects/, toolResults[1].slice(0, 300));
		assert.match(toolResults[2], /no longer exists/);
		assert.ok(!toolResults.some(text => /\(covered\)/.test(text.split('Visible text:')[0] ?? '')), 'the tour never covers the elements the agent acts on');
		assert.ok(result.summary.finished);
		assert.ok(result.summary.trail.length >= 5 && result.summary.trail.some(line => /RESULT: URL changed/.test(line)), result.summary.trail.join('\n'));
	} finally { await browser.close(); await lab.close(); }
});

test('vision self-check: a model that cannot read images gets no screenshots, and the report says so', { timeout: 240_000 }, async () => {
	const lab = await startQaLab();
	let imagesAfterCheck = 0;
	let checked = false;
	const blind = async (url, init) => {
		const body = JSON.parse(init.body);
		const usage = { prompt_tokens: 100, completion_tokens: 10 };
		if (String(url).includes('/decisions')) return json({ model: 'jev-1.13', answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: 'score', score: 2 }])), usage: { input_tokens: 10, output_tokens: 2 } });
		const hasImage = JSON.stringify(body.messages).includes('image_url');
		if (JSON.stringify(body.messages[0]?.content ?? '').includes('Vision check')) { checked = true; return json({ choices: [{ message: { content: '{"digit":"4","background":"purple"}' } }], usage }); }
		if (hasImage && checked) imagesAfterCheck++;
		if (body.tools?.length) return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'finish', arguments: '{"summary":"done"}' } }] } }], usage });
		return json({ choices: [{ message: { content: '{}' } }], usage });
	};
	try {
		const { session, runStore, artifactStore } = harness(`${lab.url}workspace/rail/`);
		await runQaEngine({ session, runStore, record: {}, env: { ...ENV, QASE_QA_MAX_MINUTES: '3', QASE_QA_MAX_PAGES: '3' }, settings: qaModelSettings({ QASE_API_KEY: 'test-key' }, {}), modelFetch: blind, artifactStore });
		assert.equal(session.hybrid.vision.ok, false);
		assert.equal(imagesAfterCheck, 0, 'no screenshot was sent to a model that failed the check');
		assert.ok(session.report.notCovered.some(line => /vision self-check/i.test(line)));
	} finally { await lab.close(); }
});

test('generalization: different apps get different plans, and nothing unobserved is planned', { timeout: 300_000 }, async () => {
	const lab = await startQaLab();
	const planFor = async path => {
		const { session, runStore, artifactStore } = harness(`${lab.url}${path}`);
		const controller = new AbortController();
		const timer = setInterval(() => { if (session.hybrid?.phases?.plan?.status === 'done') controller.abort(); }, 100);
		await runQaEngine({ session, runStore, record: {}, signal: controller.signal, env: { ...ENV, QASE_QA_MAX_MINUTES: '4', QASE_QA_MAX_PAGES: '6' }, settings: qaModelSettings({}, {}), artifactStore });
		clearInterval(timer);
		const units = new Set(session.hybrid.plan.scenarios.map(item => item.unit));
		const matrix = Object.fromEntries(session.report.qaEngine.capabilityMatrix.map(row => [row.id, row.state]));
		return { units, matrix, scenarios: session.hybrid.plan.scenarios, graph: session.hybrid.graph };
	};
	try {
		const statics = await planFor('workspace/static');
		const shop = await planFor('workspace/shop');
		const rail = await planFor('workspace/rail/');
		// Negative control: a static page has no search, forms, media, sign-in or roles, so none are planned.
		for (const unit of ['search', 'forms', 'media', 'authz', 'roles', 'websocket', 'pwa', 'explore']) assert.ok(!statics.units.has(unit), `static page: no ${unit} scenario`);
		for (const id of ['search', 'form_validation', 'media_captions', 'payments', 'login']) assert.equal(statics.matrix[id], 'not_applicable', `static page: ${id} not applicable`);
		// The shop's filter/sort/checkout were observed, so they are planned (payments stay unsupported, never run).
		assert.ok(shop.units.has('search') && shop.units.has('forms'), [...shop.units].join(','));
		assert.equal(shop.matrix.payments, 'unsupported');
		assert.ok(Object.keys(shop.graph.pages).some(url => url.endsWith('/workspace/shop/checkout')));
		// The rail app is mapped by clicking; its plan targets the screens found that way.
		assert.ok(rail.graph.views.length >= 3 && rail.scenarios.some(item => item.targets.some(url => url.includes('/workspace/rail/projects'))));
		// Materially different plans.
		const signature = plan => [...plan.units].sort().join(',');
		assert.notEqual(signature(statics), signature(shop));
		assert.ok(statics.scenarios.length < shop.scenarios.length);
		// Every scenario states its contract.
		for (const item of shop.scenarios) for (const field of ['feature', 'objective', 'expected', 'evidenceRequired', 'completion']) assert.ok(item[field], `${item.id} has ${field}`);
	} finally { await lab.close(); }
});

test('explorer: a toast covering a control is cleared, and newly revealed controls are listed first even on busy pages', { timeout: 120_000 }, async () => {
	const lab = await startQaLab();
	const { createQaBrowser } = await import('./browser.js');
	const { explore } = await import('./explorer.js');
	const browser = await createQaBrowser({ session: { id: 'x', targetUrl: `${lab.url}workspace/busy`, engine: 'chromium', device: 'desktop' }, env: ENV });
	const results = [];
	let step = 0;
	const models = {
		reasonerAvailable: () => true, visionAvailable: () => false, jevAvailable: () => false, state: { reasoner: {}, jev: {} },
		async chat(messages) {
			const last = messages.at(-1);
			if (last.role === 'tool') results.push(last.content);
			const observation = last.role === 'tool' ? last.content : messages[1].content;
			step++;
			const call = (name, args) => ({ text: '', toolCalls: [{ id: `c${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
			if (step === 1) return call('click', { ref: /(e\d+) button "Workspace"/.exec(observation)?.[1] ?? 'e0' });
			return call('finish', { summary: 'done' });
		}
	};
	try {
		await explore({ browser, profile: { name: 'desktop', label: 'Desktop', viewport: { width: 1280, height: 800 } }, startUrl: `${lab.url}workspace/busy`, models, maxSteps: 4, deadline: Date.now() + 60_000, blockedWrites: () => 0, save: async () => undefined });
		assert.match(results[0], /RESULT: URL unchanged\. Appeared: .*Alpha tab/, results[0].slice(0, 400));
		const listed = results[0].split('Interactive elements:')[1].split('Visible text:')[0];
		assert.match(listed.split('\n').slice(0, 6).join('\n'), /NEW e\d+ button\(tab\) "Alpha tab"/, 'revealed tabs are listed first');
		assert.match(listed, /more controls further down/);
	} finally { await browser.close(); await lab.close(); }
});

test('explorer: revealed answer text and expanded state count as a change (no false "dead control")', { timeout: 120_000 }, async () => {
	const lab = await startQaLab();
	const { createQaBrowser } = await import('./browser.js');
	const { explore } = await import('./explorer.js');
	const browser = await createQaBrowser({ session: { id: 'x', targetUrl: `${lab.url}workspace/faq`, engine: 'chromium', device: 'desktop' }, env: ENV });
	const results = [];
	let step = 0;
	const models = {
		reasonerAvailable: () => true, visionAvailable: () => false, jevAvailable: () => false, state: { reasoner: {}, jev: {} },
		async chat(messages) {
			const last = messages.at(-1);
			if (last.role === 'tool') results.push(last.content);
			const observation = last.role === 'tool' ? last.content : messages[1].content;
			const ref = label => new RegExp(`(e\\d+) button "${label}`).exec(observation)?.[1] ?? 'e0';
			step++;
			const call = (name, args) => ({ text: '', toolCalls: [{ id: `c${step}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
			if (step === 1) return call('click', { ref: ref('Can I cancel anytime') });
			if (step === 2) return call('click', { ref: ref('Do you offer refunds') });
			if (step === 3) return call('click', { ref: ref('Live chat') });
			return call('finish', { summary: 'done' });
		}
	};
	try {
		await explore({ browser, profile: { name: 'desktop', label: 'Desktop', viewport: { width: 1280, height: 800 } }, startUrl: `${lab.url}workspace/faq`, models, maxSteps: 5, deadline: Date.now() + 60_000, blockedWrites: () => 0, save: async () => undefined });
		assert.match(results[0], /RESULT: URL unchanged\. .*(Expanded: Can I cancel anytime|Appeared: .*Cancel from Settings)/, results[0].slice(0, 300));
		assert.match(results[1], /Appeared: .*Refunds are available within 14 days/, results[1].slice(0, 300));
		assert.match(results[2], /RESULT: nothing visible changed/, 'a control that really does nothing is still reported as such');
	} finally { await browser.close(); await lab.close(); }
});
