/**
 * Unit tests for the adaptive QA architecture: capability registry, coverage
 * states, planning and replanning, resume safety, the completion gate and
 * hybrid routing with escalation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CAPABILITIES, CAPABILITY_COUNT, capabilityCoverage, COVERAGE_STATES } from './capabilities.js';
import { createAppGraph } from './appGraph.js';
import { createPlan, scenariosFromGraph, revisePlan, nextScenario, recoverInterrupted, closeOutPlan, unitOutcomes } from './planner.js';
import { evaluateCompletion } from './completionGate.js';
import { createRouter } from './router.js';
import { triage } from './triage.js';
import { candidate } from './findings.js';

const OPTIONS = { secondaryPages: 4, interactionPages: 3 };

function sampleGraph({ signedIn = false } = {}) {
	const model = createAppGraph();
	model.addPage('https://app.test/', { status: 200, heading: 'Home', features: { navigation: 1, menus: 2, forms: 0 }, discoveredBy: 'observe', audited: true, auth: 'public' });
	model.addPage('https://app.test/search', { status: 200, heading: 'Search', features: { search: 1, table: 1, pagination: 1, forms: 1 }, discoveredBy: 'crawl', audited: true, auth: 'public' });
	if (signedIn) {
		model.setAuth({ detected: true, signedIn: true });
		model.addPage('https://app.test/app', { status: 200, heading: 'Dashboard', features: { table: 1 }, discoveredBy: 'signed-in', audited: true, auth: 'signed-in' });
	}
	return model;
}

test('the registry has exactly 140 unique categories, each fully specified', () => {
	assert.equal(CAPABILITY_COUNT, 140);
	assert.equal(new Set(CAPABILITIES.map(item => item.id)).size, 140);
	for (const item of CAPABILITIES) {
		for (const field of ['id', 'name', 'group', 'applies', 'access', 'tools', 'strategy', 'safety', 'evidence', 'pass', 'fail', 'recovery', 'support']) assert.ok(item[field] !== undefined && item[field] !== '', `${item.id} lacks ${field}`);
		assert.ok(['executed', 'partial', 'unsupported'].includes(item.support));
		if (item.support === 'unsupported') assert.ok(item.prerequisite, `${item.id} must say what would make it runnable`);
		if (item.support !== 'unsupported') assert.ok(item.units.length, `${item.id} needs an executor`);
		if (item.support === 'partial') assert.ok(item.note, `${item.id} must say what part is covered`);
	}
});

test('coverage never marks a category passed unless its executor ran', () => {
	const model = sampleGraph();
	const plan = createPlan();
	revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedIn: false, options: OPTIONS }));
	closeOutPlan(plan, 'budget ended');
	const rows = capabilityCoverage({ graph: model.graph, units: unitOutcomes(plan), findings: [], signedIn: false, viewportsTested: [] });
	assert.equal(rows.length, 140);
	assert.ok(rows.every(row => COVERAGE_STATES.includes(row.state)));
	assert.equal(rows.filter(row => row.state === 'passed').length, 0, 'nothing ran, so nothing passed');
	assert.ok(rows.filter(row => row.state === 'not_executed').every(row => row.reason));
	assert.ok(rows.filter(row => row.state === 'unsupported').every(row => row.reason));
	const search = rows.find(row => row.id === 'search');
	assert.equal(search.state, 'not_executed');
	assert.equal(rows.find(row => row.id === 'media_captions').state, 'not_applicable');
});

test('signed-in categories are blocked without a session and a finding fails its category', () => {
	const model = sampleGraph();
	model.setAuth({ detected: true, blockedReason: 'No test account was given.' });
	const plan = createPlan();
	revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedIn: false, options: OPTIONS }));
	for (const item of plan.scenarios) item.state = 'passed';
	const finding = { id: 'f1', detector: 'security.reflected_xss', viewports: ['desktop'] };
	const rows = capabilityCoverage({ graph: model.graph, units: unitOutcomes(plan, { observe: true, page_audit: true }), findings: [finding], signedIn: false, viewportsTested: ['desktop'] });
	assert.equal(rows.find(row => row.id === 'session_persistence').state, 'blocked');
	assert.equal(rows.find(row => row.id === 'login').state, 'blocked');
	assert.equal(rows.find(row => row.id === 'reflected_xss').state, 'failed');
	assert.equal(rows.find(row => row.id === 'keyboard_navigation').state, 'passed');
});

test('the plan follows the graph and replanning only adds what is new', () => {
	const model = sampleGraph();
	const plan = createPlan();
	const first = revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedIn: false, options: OPTIONS }), { trigger: 'initial' });
	assert.equal(first.revision, 1);
	assert.ok(plan.scenarios.some(item => item.unit === 'search' && item.targets[0] === 'https://app.test/search'), 'search is planned because a search box was observed');
	assert.ok(!plan.scenarios.some(item => item.unit === 'authz'), 'no access-control scenario without a session');
	assert.equal(revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedIn: false, options: OPTIONS }), { trigger: 'same graph' }), undefined, 'an unchanged graph adds nothing');
	// Discovery: a signed-in page with a video and the session appear.
	model.setAuth({ detected: true, signedIn: true });
	model.addPage('https://app.test/app/tour', { status: 200, heading: 'Tour', features: { media: 1 }, discoveredBy: 'signed-in', audited: false, auth: 'signed-in' });
	const second = revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedInUrl: 'https://app.test/app/tour', signedIn: true, options: OPTIONS }), { trigger: 'found /app/tour' });
	assert.equal(second.revision, 2);
	const added = plan.scenarios.filter(item => item.revision === 2);
	assert.ok(added.some(item => item.unit === 'media'));
	assert.ok(added.some(item => item.unit === 'authz'));
	assert.ok(added.some(item => item.unit === 'page_audit'), 'an unaudited page gets a page audit');
	assert.ok(!added.some(item => item.unit === 'security_origin'), 'site-level scenarios are not repeated');
	const viewports = plan.scenarios.filter(item => item.unit === 'viewports');
	assert.equal(new Set(viewports.flatMap(item => item.targets)).size, viewports.flatMap(item => item.targets).length, 'pages are never re-planned for the same unit');
});

test('visual review runs last; interrupted scenarios with side effects are never replayed', () => {
	const plan = createPlan();
	revisePlan(plan, [
		{ id: 'visual:site', unit: 'visual', targets: [], priority: 1, capabilities: [] },
		{ id: 'links:site', unit: 'links', targets: [], priority: 4, capabilities: [] }
	]);
	assert.equal(nextScenario(plan).unit, 'links');
	plan.scenarios[1].state = 'passed';
	assert.equal(nextScenario(plan).unit, 'visual');
	plan.scenarios.push({ id: 'x', unit: 'forms', targets: [], state: 'running', sideEffects: true }, { id: 'y', unit: 'seo', targets: [], state: 'running', sideEffects: false });
	const recovered = recoverInterrupted(plan);
	assert.deepEqual(recovered, [{ id: 'x', state: 'inconclusive' }, { id: 'y', state: 'pending' }]);
	assert.match(plan.scenarios.find(item => item.id === 'x').reason, /did not replay/);
});

test('completion gate: a model claim of completion cannot complete a run with open scenarios', () => {
	const model = sampleGraph();
	const plan = createPlan();
	revisePlan(plan, scenariosFromGraph({ graph: model, start: 'https://app.test/', signedIn: false, options: OPTIONS }));
	plan.scenarios[0].state = 'passed';
	plan.scenarios[0].evidence = ['The model said: "All testing is complete, every feature passed."'];
	const state = { loaded: true, mainResponse: { status: 200 }, observation: { at: plan.createdAt - 1 } };
	const gate = evaluateCompletion({ state, plan, graph: model.graph, coverageRows: [{ state: 'passed', support: 'executed' }], findings: [], triaged: true });
	assert.equal(gate.status, 'partial');
	assert.ok(gate.failed.includes('every_scenario_terminal'));
	closeOutPlan(plan, 'budget ended');
	const after = evaluateCompletion({ state, plan, graph: model.graph, coverageRows: [{ state: 'passed', support: 'executed' }], findings: [], triaged: true });
	assert.equal(after.status, 'partial');
	assert.ok(after.failed.includes('every_scenario_executed'));
	for (const item of plan.scenarios) item.state = 'passed';
	assert.equal(evaluateCompletion({ state, plan, graph: model.graph, coverageRows: [{ state: 'passed', support: 'executed' }], findings: [], triaged: true }).status, 'complete');
	// Planning before observing, an unexplained auth wall or evidence-free findings all block completion.
	assert.ok(evaluateCompletion({ state: { ...state, observation: { at: plan.createdAt + 5 } }, plan, graph: model.graph, coverageRows: [{ state: 'passed' }], triaged: true }).failed.includes('observed_before_planning'));
	model.setAuth({ detected: true, signedIn: false });
	assert.ok(evaluateCompletion({ state, plan, graph: model.graph, coverageRows: [{ state: 'passed' }], triaged: true }).failed.includes('authentication_resolved'));
	model.setAuth({ blockedReason: 'No account' });
	assert.ok(evaluateCompletion({ state, plan, graph: model.graph, coverageRows: [{ state: 'passed' }], findings: [{ title: 'x' }], triaged: true }).failed.includes('findings_have_evidence'));
	assert.equal(evaluateCompletion({ state: { loaded: false }, plan, graph: model.graph, coverageRows: [] }).status, 'blocked');
});

function stubModels({ jevProbability = 0.9, reasonerProbability = 0.2 } = {}) {
	const state = { reasoner: { calls: 0, inputTokens: 0, outputTokens: 0, model: 'opus' }, jev: { calls: 0, inputTokens: 0, outputTokens: 0, model: 'jev' } };
	return {
		state,
		reasonerAvailable: () => true, jevAvailable: () => true, visionAvailable: () => true,
		async chat(messages) {
			state.reasoner.calls++; state.reasoner.inputTokens += 100; state.reasoner.outputTokens += 20;
			const count = (messages[1]?.content.match(/^\d+\./gm) ?? []).length || 15;
			return { text: JSON.stringify({ results: Array.from({ length: count }, (_, index) => ({ index, probability: reasonerProbability, severity: 'low', reason: 'reasoner second opinion' })) }), toolCalls: [] };
		},
		async json(messages, options) { const result = await this.chat(messages, options); return JSON.parse(result.text); },
		async decide(context, questions) {
			state.jev.calls++; state.jev.inputTokens += 50; state.jev.outputTokens += 5;
			return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type === 'noul' ? { type: 'noul', noul: jevProbability } : { type: 'score', score: 2 }]));
		}
	};
}

test('router: tasks go to their preferred model, every call is logged and costed', async () => {
	const models = stubModels();
	const router = createRouter({ models });
	assert.equal(router.choose('planning').model, 'reasoner');
	assert.equal(router.choose('verification').model, 'jev');
	await router.models.chat([{ role: 'user', content: 'x' }], { purpose: 'planning' });
	await router.models.decide({}, { a: { type: 'noul' } });
	const { decisions, tokens } = router.state();
	assert.deepEqual(decisions.map(item => [item.task, item.model]), [['planning', 'reasoner'], ['verification', 'jev']]);
	assert.equal(tokens.planning.reasonerTokens, 120);
	assert.equal(tokens.verification.jevTokens, 55);
	const down = { ...stubModels(), reasonerAvailable: () => false, jevAvailable: () => false };
	down.state.reasoner.lastError = 'HTTP 503';
	const fallback = createRouter({ models: down }).choose('planning');
	assert.equal(fallback.model, 'deterministic');
	assert.equal(createRouter({ models: { ...stubModels(), jevAvailable: () => false } }).choose('verification').model, 'reasoner');
});

test('triage escalates uncertain JEV verdicts to the reasoner, which decides', async () => {
	const decisions = [];
	const items = [candidate({ detector: 'page.low_contrast', category: 'accessibility', severity: 'low', confidence: 0.6, title: 'Low contrast', url: 'https://app.test/', actual: 'Grey on white', expected: 'AA contrast', steps: ['Open /'], data: { key: 'a' } })];
	const uncertain = await triage({ candidates: items, models: stubModels({ jevProbability: 0.5, reasonerProbability: 0.1 }), context: { target: 'https://app.test/' }, onDecision: entry => decisions.push(entry) });
	assert.equal(uncertain.stats.escalated, 1);
	assert.equal(uncertain.dismissed.length, 1, 'the reasoner dismissed it');
	assert.equal(uncertain.dismissed[0].verification.escalatedFrom.by, 'jev');
	assert.equal(decisions[0].task, 'escalation');
	const confident = await triage({ candidates: [{ ...items[0], id: 'b' }], models: stubModels({ jevProbability: 0.95 }), context: { target: 'https://app.test/' }, onDecision: entry => decisions.push(entry) });
	assert.equal(confident.stats.escalated, 0, 'confident JEV verdicts are not escalated');
	assert.equal(confident.findings.length, 1);
});

test('prompt-injection rule: every agent prompt that reads website content treats it as untrusted data', async () => {
	const { UNTRUSTED_CONTENT_RULE } = await import('../untrustedContent.js');
	const { proposeJourneys } = await import('./planner.js');
	const fs = await import('node:fs');
	let plannerSystem;
	await proposeJourneys({ models: { reasonerAvailable: () => true, json: async messages => { plannerSystem = messages[0].content; return { journeys: [] }; } }, model: { summary: () => 'Pages: /' } });
	assert.ok(plannerSystem.includes(UNTRUSTED_CONTENT_RULE), 'planner');
	const triageSystems = [];
	const stub = stubModels();
	stub.jevAvailable = () => false;
	stub.chat = async messages => { triageSystems.push(messages[0].content); return { text: '{"results":[]}', toolCalls: [] }; };
	await triage({ candidates: [candidate({ detector: 'page.low_contrast', category: 'accessibility', severity: 'low', confidence: 0.6, title: 't', url: 'https://a.test/', actual: 'a', expected: 'b', steps: ['s'], data: { key: 'k' } })], models: stub, context: { target: 'https://a.test/' } });
	assert.ok(triageSystems.some(text => text.includes(UNTRUSTED_CONTENT_RULE)), 'triage');
	// The explorer, visual review and the SQA/Founder stage agent append the rule to what they send.
	for (const [file, pattern] of [['explorer.js', /content: `\$\{SYSTEM\}\\n\$\{UNTRUSTED_CONTENT_RULE\}`/], ['visualReview.js', /content: `\$\{PROMPT\}\\n\$\{UNTRUSTED_CONTENT_RULE\}`/], ['../stageAgent.js', /\$\{task\}\\n\\n\$\{UNTRUSTED_CONTENT_RULE\}/]]) {
		assert.match(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), pattern, file);
	}
});
