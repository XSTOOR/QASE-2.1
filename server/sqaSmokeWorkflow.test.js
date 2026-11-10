import './testWorkingDirectory.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createSqaSmokeWorkflow } from './sqaSmokeWorkflow.js';
import { AGENT_EVIDENCE_TYPES, createSqaState, createSqaTodoPlan } from './sqaService.js';
import { countSqaBrowserActivities, guardSqaBrowserTool, SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD } from './sqaBrowserBudget.js';
import { ensureRuntime, runTurn } from './agent.js';
import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from './sqaCatalog.js';
import { inspectSqaEvidence } from './sqaEvidence.js';

const presentation = ['SQA-WEB-001', 'SQA-WEB-004', 'SQA-WEB-005', 'SQA-WEB-006'];
function fixture(execute = async () => ({ success: true })) {
	const session = { id: 'workflow-fixture', mode: 'sqa', activities: [], sqa: createSqaState({ authorizationConfirmed: true,
		target: { name: 'Controlled fixture', release: 'test', environment: 'local' } }) };
	let calls = 0;
	const composition = createSqaSmokeWorkflow(session, { invoke: async (name, input, signal) => {
		const activity = { id: `child-${++calls}`, toolName: name, input, status: 'running', ts: Date.now() };
		session.activities.push(activity);
		const tool = guardSqaBrowserTool({ name, run: () => execute(input, session, signal) }, session);
		const result = await tool.run(input, { signal });
		activity.status = result.success === false ? 'failed' : 'done';
		return { activityId: activity.id, result };
	} });
	return { session, composition, run: (input, context) => composition.tool.run(input, context), calls: () => calls };
}

test('one presentation call retains three separately charged child checks and requires an explicit result batch', async () => {
	const f = fixture();
	const result = await f.run({ workflow: 'presentation' });
	assert.equal(result.success, true);
	assert.equal(result.checks.length, 3);
	assert.equal(countSqaBrowserActivities(f.session), 3);
	assert.deepEqual(result.checks.map(c => c.tool === 'browser_diagnostics' ? 'diagnostics' : c.action), ['diagnostics', 'accessibility', 'responsive']);
	assert.deepEqual(result.control_ids, presentation);
	assert.equal(f.session.sqa.observations.length, 0, 'composition cannot infer a verdict');
	assert.equal((await f.run({ workflow: 'presentation' })).code, 'SQA_WORKFLOW_ALREADY_ATTEMPTED');
	assert.equal(f.calls(), 3, 'a repeated composition does not replay any children');
});

test('a child failure preserves earlier results and prevents later dispatch', async () => {
	const f = fixture(async input => input.action === 'accessibility' ? { success: false, code: 'DRIVER_FAILURE', error: 'Keyboard unavailable.' } : { success: true });
	const result = await f.run({ workflow: 'presentation' });
	assert.equal(result.code, 'DRIVER_FAILURE');
	assert.equal(result.checks.length, 2);
	assert.equal(f.calls(), 2);
	assert.equal(result.checks[0].activity_id, 'child-1');
	assert.equal(result.checks[1].result.error, 'Keyboard unavailable.');
	assert.equal(f.session.sqa.observations.length, 0);
});

test('each child rechecks the input budget and forwards the reserved closeout instruction', async () => {
	const f = fixture(async (_input, session) => { session.tokenUsage = { inputTokens: SQA_INPUT_TOKEN_CLOSEOUT_THRESHOLD }; return { success: true }; });
	const result = await f.run({ workflow: 'presentation' });
	assert.equal(result.code, 'SQA_INPUT_TOKEN_CLOSEOUT_REQUIRED');
	assert.equal(result.checks.length, 2);
	assert.equal(f.calls(), 2);
	assert.equal(f.session.activities[0].status, 'done');
	assert.equal(f.session.activities[1].status, 'failed');
});

test('cancellation after a saved child prevents all later checks', async () => {
	const controller = new AbortController();
	const f = fixture(async () => { controller.abort(); return { success: true }; });
	const result = await f.run({ workflow: 'presentation' }, { signal: controller.signal });
	assert.equal(result.code, 'SQA_WORKFLOW_CANCELLED');
	assert.equal(f.calls(), 1);
	assert.equal(result.checks.length, 1);
	assert.equal(f.composition.dispatchAllowed(), true, 'ownership is released after cancellation');
	assert.equal((await f.run({ workflow: 'presentation' }, { signal: controller.signal })).code, 'SQA_WORKFLOW_CANCELLED');
});

test('composition owns dispatch across awaits, allowing only its internal child context', async () => {
	let release, entered;
	const waiting = new Promise(resolve => { entered = resolve; });
	const f = fixture(async () => {
		assert.equal(f.composition.dispatchAllowed(), true, 'owned SDK child may dispatch');
		entered(); await new Promise(resolve => { release = resolve; });
		return { success: false, error: 'Fixture stops after the held step.' };
	});
	const running = f.run({ workflow: 'presentation' });
	await waiting;
	assert.equal(f.composition.dispatchAllowed(), false, 'another async caller cannot interleave tool dispatch');
	assert.equal((await f.run({ workflow: 'presentation' })).code, 'SQA_WORKFLOW_BUSY');
	release(); await running;
	assert.equal(f.composition.dispatchAllowed(), true);
});

test('invalid inputs, closed/reviewed scopes and native mode never dispatch a child', async () => {
	const f = fixture();
	for (const input of [null, [], { workflow: 'other' }, { workflow: 'presentation', links: ['Privacy'] }, { workflow: 'interaction' },
		{ workflow: 'interaction', links: [''] }, { workflow: 'presentation', controls: [{ status: 'pass' }] }]) {
		assert.equal((await f.run(input)).code, 'SQA_WORKFLOW_INPUT_INVALID');
	}
	assert.equal((await f.run({ workflow: 'interaction', links: ['Privacy'] })).code, 'SQA_CONTROL_RESULT_REQUIRED');
	for (const patch of [{ finalizedAt: 'saved' }, { budgetCloseout: {} }, { review: { status: 'in_review' } }, { execution: { strategy: 'qualified-opus-jev-v1' } }]) {
		const previous = f.session.sqa; f.session.sqa = { ...previous, ...patch };
		assert.equal((await f.run({ workflow: 'presentation' })).success, false);
		f.session.sqa = previous;
	}
	f.session.mode = 'founder';
	assert.equal((await f.run({ workflow: 'presentation' })).code, 'SQA_WORKFLOW_UNAVAILABLE');
	assert.equal(f.calls(), 0);
});

test('unknown scope and a prior in-flight action cannot start a composed workflow', async () => {
	const f = fixture();
	f.session.sqa.scope.applicableControlIds = [];
	assert.equal((await f.run({ workflow: 'presentation' })).code, 'SQA_WORKFLOW_OUT_OF_SCOPE');
	f.session.activities.push({ toolName: 'browser_diagnostics', status: 'running' });
	assert.equal((await f.run({ workflow: 'presentation' })).code, 'SQA_WORKFLOW_INTERRUPTED');
	assert.equal(f.calls(), 0);
});

test('missing durable receipts and persistence failures stop composition without replay', async () => {
	for (const invoke of [async () => ({ result: { success: true } }), async () => { throw new Error('Fixture persistence failed'); }]) {
		const session = fixture().session;
		let calls = 0;
		const workflow = createSqaSmokeWorkflow(session, { invoke: async (...args) => { calls++; return invoke(...args); } });
		assert.equal((await workflow.tool.run({ workflow: 'presentation' })).success, false);
		assert.equal(calls, 1);
		assert.equal(session.sqa.observations.length, 0);
		assert.equal(workflow.dispatchAllowed(), true);
	}
});

test('interaction retains unavailable form blockers and refuses already attempted or recorded groups', async () => {
	const f = fixture(async input => input.action === 'form_validation'
		? { success: true, eligible: false, blockerReason: 'No safe empty email form.' } : { success: true });
	f.session.sqa.observations = presentation.map(controlId => ({ controlId, status: 'blocked', evidence: [] }));
	const result = await f.run({ workflow: 'interaction', links: ['Privacy'] });
	assert.equal(result.success, true);
	assert.equal(result.checks.length, 2);
	assert.equal(result.checks[1].result.eligible, false);
	assert.equal(result.checks[1].result.blockerReason, 'No safe empty email form.');
	assert.equal((await f.run({ workflow: 'interaction', links: ['Privacy'] })).code, 'SQA_WORKFLOW_ALREADY_ATTEMPTED');
	f.session.sqa.observations.push({ controlId: 'SQA-WEB-002', status: 'blocked' });
	assert.equal((await f.run({ workflow: 'interaction', links: ['Privacy'] })).code, 'SQA_WORKFLOW_ALREADY_RECORDED');
	assert.equal(f.calls(), 2);
});

for (const engine of ['chromium', 'firefox', 'webkit']) test(`native SDK ${engine} compositions save matching evidence and publish without discounted child actions`, { timeout: 60_000 }, async t => {
	console.log(`[SQA workflow fixture] ${engine}: initialize`);
	const keys = ['QASE_API_KEY', 'QASE_HEADLESS', 'QASE_ALLOW_PRIVATE_NETWORK', 'QASE_BROWSER_ALLOWED_PRIVATE_HOSTS'];
	const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
	process.env.QASE_API_KEY = 'isolated-workflow-placeholder';
	process.env.QASE_HEADLESS = 'true';
	process.env.QASE_ALLOW_PRIVATE_NETWORK = 'true';
	process.env.QASE_BROWSER_ALLOWED_PRIVATE_HOSTS = '127.0.0.1';
	t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
	const fixture = createServer((req, res) => {
		if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
		res.setHeader('Content-Type', 'text/html');
		res.end(req.url === '/privacy' ? '<h1>Privacy</h1><p>Local fixture only.</p>' : '<!doctype html><html lang="en"><title>Local workflow</title><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Local workflow</h1><nav><a href="/privacy">Privacy</a></nav><form><label>Work email<input type="email" required></label><button>Validate</button><output></output></form><script>const f=document.querySelector("form"),o=f.querySelector("output");f.oninput=()=>o.textContent="";f.onsubmit=e=>{e.preventDefault();o.textContent="Email accepted locally"}</script>');
	});
	await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
	// Only this fixture owns these sockets. Do not let a browser keep-alive
	// delay server cleanup before the later browser-disposal hook can run.
	t.after(() => new Promise(resolve => { fixture.closeAllConnections(); fixture.close(resolve); }));
	const target = `http://127.0.0.1:${fixture.address().port}/`;
	const session = { id: randomUUID(), mode: 'sqa', engine, targetUrl: target, messages: [], activities: [], findings: [], secretNames: [],
		environmentSnapshot: { envId: `composition-${engine}`, platform: 'desktop', browserCode: engine === 'webkit' ? 'safari' : engine === 'chromium' ? 'chrome' : 'firefox', browser: engine, os: 'Windows', deviceType: 'desktop', executionProvider: 'local' },
		sqa: createSqaState({ authorizationConfirmed: true, scopeNotes: 'Public-only controlled loopback fixture. No accounts or reviewer documents.', target: { name: 'Composition fixture', release: 'test', environment: 'local' } }) };
	session.todos = createSqaTodoPlan(session.sqa);
	const scopeBefore = [...session.sqa.scope.applicableControlIds];
	const live = {};
	const commits = [];
	const store = { liveFor: () => live, listLive: () => [], publish() {}, subscribe() { return () => {}; },
		async commit(_session, type, payload) { commits.push({ type, payload }); },
		async setStatus(run, status, detail) { run.status = status; run.statusDetail = detail; },
		async addActivity(run, item) { const activity = { ts: Date.now(), ...item }; run.activities.push(activity); return activity; },
		async updateActivity(run, id, patch) { Object.assign(run.activities.find(item => item.id === id), patch); },
		async addMessage(run, item) { run.messages.push(item); return item; }
	};
	const record = await ensureRuntime(session, store);
	console.log(`[SQA workflow fixture] ${engine}: SDK ready`);
	t.after(async () => { await record.runtime.headlessRuntime.getToolContext().browserAutomationService.browser?.close(); record.dispose?.(); });
	const batch = ids => ({ controls: ids.map(control_id => ({ control_id, status: 'pass', evidence: [{ type: 'test_result', summary: `Controlled local technical smoke for ${control_id}; bounded sample only.` }] })) });
	const remaining = scopeBefore.filter(id => !SQA_TECHNICAL_CONTROL_IDS.includes(id) && getSqaControl(id).evidenceRequirements.some(r => AGENT_EVIDENCE_TYPES.has(r.type)));
	const steps = [
		['browser_open', { url: target }], ['browser_snapshot', {}],
		['run_sqa_smoke_workflow', { workflow: 'presentation' }], ['record_sqa_control', batch(presentation)],
		['run_sqa_smoke_workflow', { workflow: 'interaction', links: ['Privacy'] }], ['record_sqa_control', batch(['SQA-WEB-002', 'SQA-WEB-003'])],
		['record_sqa_control', { controls: remaining.map(control_id => ({ control_id, status: 'blocked', rationale: 'This fixture exercises technical smoke only; release-specific assurance evidence was not supplied.' })) }],
		['update_todo', { items: session.todos.map(item => ({ content: item.text, status: 'completed' })) }], ['finish_sqa_assessment', {}]
	];
	let outerCalls = 0;
	record.runtime.run = async function* () {
		while (steps.length) {
			const [name, input] = steps.shift(); outerCalls++;
			console.log(`[SQA workflow fixture] ${engine}: ${name}`);
			for await (const part of record.runtime.headlessRuntime.executeTool(name, input, randomUUID(), record.controller.signal)) {
				if (part.type === 'tool_result') assert.notEqual(part.result.success, false, `${name}: ${part.result.error}`);
				yield part;
			}
		}
	};
	record.runtime.getPendingQuestion = () => undefined;
	await runTurn(session, { task: 'Execute the controlled SQA workflow fixture without model calls.' }, store);
	assert.equal(session.status, 'done', JSON.stringify(session.messages));
	assert.equal(outerCalls, 9);
	assert.equal(countSqaBrowserActivities(session), 7, 'the two outer workflows do not discount their five actual browser children');
	assert.deepEqual(session.sqa.scope.applicableControlIds, scopeBefore);
	assert.equal(session.sqa.assessment.technicalSummary.pass, 6);
	assert.equal(session.sqa.assessment.summary.not_assessed, 0);
	assert.equal(session.sqa.assessment.verdict, 'blocked', 'absent broader and reviewer evidence cannot become a pass');
	assert.equal(session.sqa.smokeEvidence.length, 2);
	for (const id of ['SQA-WEB-002', 'SQA-WEB-003']) assert.equal(inspectSqaEvidence(session, id, 1).integrity, 'verified');
	assert.ok(commits.some(item => item.type === 'sqa' && item.payload?.final));
	assert.equal(session.activities.filter(a => a.toolName === 'browser_sqa_smoke').length, 4);
	assert.equal(session.activities.some(a => a.status === 'running'), false);
});
