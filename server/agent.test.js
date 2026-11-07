import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { activityLabel, allowedToolNames, ensureRuntime, guardSqaBrowserTool, isFounderSynthesisReady, modelActivityTimeoutMs, prepareFounderSynthesis, prepareSqaContextContinuation, prepareSqaSynthesis, restoreWaitingSnapshot, runTurn, sqaAutomaticBudgetCloseoutInput, summariseResult, withModelActivityDeadline } from './agent.js';
import { attachUsageCapture, createUsageLogger } from './usageCapture.js';
import { createBrowserTools } from './browserTools.js';
import { createFounderReviewTodos, FOUNDER_CATEGORY_IDS } from './founderService.js';
import { clearSecrets, resolveSecrets, storeSecrets } from './secrets.js';
import { withUserConfiguration } from './config.js';
import { getSqaControl, SQA_TECHNICAL_CONTROL_IDS } from './sqaCatalog.js';
import { AGENT_EVIDENCE_TYPES, createSqaState, createSqaTodoPlan } from './sqaService.js';
import { createSqaTools } from './sqaTools.js';

function runtimeFixture(overrides = {}) {
	const session = { id: randomUUID(), mode: 'qa', targetUrl: 'https://example.test', messages: [], activities: [], todos: [], findings: [], secretNames: [], ...overrides };
	const record = {
		runtime: { async *run() {}, getPendingQuestion: () => undefined },
		bridge: { hasPage: () => false, captureFrame: async () => {}, stopFrames() {} }
	};
	const statuses = [];
	const store = {
		liveFor: () => record, listLive: () => [], publish() {}, commit: async () => {},
		setStatus: async (s, status, detail) => { s.status = status; statuses.push({ status, detail }); },
		addActivity: async (s, item) => { const activity = { ts: Date.now(), ...item }; s.activities.push(activity); return activity; },
		updateActivity: async (s, id, patch) => Object.assign(s.activities.find(item => item.id === id), patch),
		addMessage: async (s, item) => { s.messages.push(item); return item; }
	};
	return { session, record, store, statuses };
}

for(const mode of ['sqa','founder']) test(`${mode} host publication remains authoritative if SDK prefetch throws before yielding the tool result`,async()=>{
 const f=runtimeFixture({mode,[mode]:{}});
 f.record.runtime.run=async function*(){f.session[mode].finalizedAt='2026-11-03T00:00:00.000Z';f.record.onModePublished();throw new Error('SDK prefetched after durable publication');};
 await runTurn(f.session,{task:'Finalize existing evidence'},f.store);
 assert.equal(f.session.status,'done');assert.equal(f.statuses.some(s=>s.status==='error'||s.status==='interrupted'),false);
});

test('SQA closeout uses supported session clearing only after control evidence is accounted for and never completes todos itself',()=>{
 const f=runtimeFixture({mode:'sqa',sqa:{scope:{applicableControlIds:['SQA-WEB-001']},observations:[],execution:{routes:[{url:'https://example.test',reviewed:true}],actions:[{tool:'browser_click',status:'done',interaction:true},{tool:'browser_diagnostics',status:'done'}]}},todos:[{text:'Record complete work',status:'pending'}]});
 let clears=0;const tools=['browser_snapshot','update_todo','finish_sqa_assessment'].map(name=>({name}));
 f.record.modeReasoning={state:f.session.sqa.execution};f.record.runtime.agentSession={clear(){clears++;}};f.record.runtime.headlessRuntime={options:{tools},getTools(){return this.options.tools;},toolsByName:new Map(tools.map(t=>[t.name,t]))};
 assert.equal(prepareSqaSynthesis(f.session,f.record),false);
 f.session.sqa.observations=[{controlId:'SQA-WEB-001',status:'blocked',rationale:'Required reviewed artifact unavailable',evidence:[]}];
 f.session.findings=[{id:'confirmed-fixture',controlIds:['SQA-WEB-001']}];
 assert.equal(prepareSqaSynthesis(f.session,f.record),false,'Synthesis must retain control-recording tools until confirmed findings are reconciled.');
 assert.equal(clears,0);
 f.session.findings=[];
 assert.equal(prepareSqaSynthesis(f.session,f.record),true);assert.equal(clears,1);
 assert.deepEqual(f.record.runtime.headlessRuntime.getTools().map(t=>t.name),['update_todo','finish_sqa_assessment']);
 assert.equal(f.session.todos[0].status,'pending');assert.equal(f.session.sqa.finalizedAt,undefined);
 assert.equal(f.record.modeReasoning.state.phase,'synthesis');
 assert.equal(prepareSqaSynthesis(f.session,f.record),false);assert.equal(clears,1);
});

test('legacy SQA context compaction cannot reset the qualified mode runtime', () => {
 const f=runtimeFixture({mode:'sqa',sqa:{},tokenUsage:{inputTokens:200000}});
 let cleared=false;
 f.record.modeReasoning={state:{phase:'exploration'}};
 f.record.runtime.agentSession={clear(){cleared=true;}};
 assert.equal(prepareSqaContextContinuation(f.session,f.record),false);
 assert.equal(cleared,false);
});

test('fixed browser activities name their real action and atomic summaries use recorded assertion counts', () => {
	assert.match(activityLabel('browser_qa_check', { action: 'navigation' }), /Clicked link/);
	assert.match(activityLabel('browser_qa_scenario', { action: 'disclosure' }), /accordion/);
	assert.equal(activityLabel('browser_open', {}), 'Opened page');
	assert.match(summariseResult('browser_qa_scenario', { action: 'responsive', assertionCounts: { passed: 5, failed: 1 }, url: 'https://fixture.test/docs' }), /responsive: 6 assertions, 1 failed · https:\/\/fixture.test\/docs/);
});

function founderSynthesisFixture() {
	const activities = ['browser_open', 'browser_snapshot', 'browser_diagnostics'].map((toolName, index) => ({ id: `evidence-${index}`, toolName, status: 'done', ts: Date.now() }));
	const fixture = runtimeFixture({
		mode: 'founder', activities,
		todos: createFounderReviewTodos().map(todo => ({ ...todo, status: 'completed' })),
		founder: {
			scope: { productContext: { stage: 'beta', targetCustomer: 'Product teams', businessModel: 'B2B SaaS', primaryGoal: 'Activation' } },
			observations: FOUNDER_CATEGORY_IDS.map(category => ({ category, title: `Observed ${category}`, summary: 'Controlled fixture evidence.', evidence: activities.map(activity => ({ activityId: activity.id })) }))
		}
	});
	const finalizer = { name: 'finish_founder_review', description: 'Publish the report.', parametersSchema: { type: 'object' } };
	const browser = { name: 'browser_snapshot', description: 'Read the page.', parametersSchema: { type: 'object' } };
	const headless = {
		options: { tools: [browser, finalizer] },
		toolsByName: new Map([[browser.name, browser], [finalizer.name, finalizer]]),
		getTools() { return this.options.tools; }
	};
	let clears = 0;
	fixture.record.runtime.agentSession = { clear() { clears++; } };
	fixture.record.runtime.headlessRuntime = headless;
	return { ...fixture, headless, clearCount: () => clears };
}

test('a turn harvests provider token usage into the run and persists it once', async () => {
	const { session, record, store, statuses } = runtimeFixture();
	const commits = [];
	store.commit = async (s, type, payload) => { commits.push({ type, payload }); };
	// Real usage arrives through the wrapped logProviderReportedUsage hook...
	record.runtime.cleanSlateService = {
		logProviderReportedUsage(diagnostics, usage) { /* SDK original */ }
	};
	// ...and an estimate through the injectable logger's debug line.
	record.runtime.run = async function* () {
		this.logger?.debug?.('[CleanSlateService] provider=Custom API model=m stage=complete elapsedMs=1 inputChars=4000 estimatedInputTokens=1000 outputChars=800 estimatedOutputTokens=200');
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};
	// The wrapper is attached in ensureRuntime, which the fixture bypasses, so
	// attach here exactly as ensureRuntime does.
	record.turnUsage = { reports: [], estimates: [] };
	const release = attachUsageCapture(record.runtime.cleanSlateService, {
		onUsage: usage => record.turnUsage.reports.push(usage)
	});
	record.releaseUsageCapture = release;
	record.runtime.logger = createUsageLogger({
		onEstimate: usage => record.turnUsage.estimates.push(usage)
	});
	session.findings = [{ severity: 'high', title: 'Broken form', actual: 'HTTP 500' }];
	session.report = { ts: 456, verdict: 'fail', summary: 'Tested.' };

	await runTurn(session, { task: 'Count my tokens' }, store);

	assert.equal(session.status, 'done');
	assert.ok(session.tokenUsage, 'token usage recorded');
	assert.equal(session.tokenUsage.inputTokens, 1000);
	assert.equal(session.tokenUsage.outputTokens, 200);
	assert.equal(session.tokenUsage.totalTokens, 1200);
	assert.equal(session.tokenUsage.estimated, true, 'estimate marked when no real report');
	const usageCommits = commits.filter(commit => commit.type === 'usage');
	assert.ok(usageCommits.length >= 1, 'usage committed at least once');
	assert.deepEqual(usageCommits.at(-1).payload.usage, session.tokenUsage, 'last usage commit carries the final totals');

	// A real provider report on a later turn supersedes estimates.
	record.turnUsage.reports.push({ inputTokens: 500, outputTokens: 50, totalTokens: 550, cachedInputTokens: 5 });
	record.turnUsage.estimates.length = 0;
	record.runtime.run = async function* () {
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};
	await runTurn(session, { task: 'More tokens' }, store);
	assert.equal(session.tokenUsage.inputTokens, 1500, 'totals accumulate across turns');
	assert.equal(session.tokenUsage.estimated, false, 'real report supersedes estimate');
	release();
});

test('real usage commits live during the stream, before turn end', async () => {
	const { session, record, store } = runtimeFixture();
	const commits = [];
	store.commit = async (s, type, payload) => { commits.push({ type, payload }); };
	record.turnUsage = { reports: [], estimates: [] };

	// Two model calls stream; the second finishes late in the stream, well
	// before the turn (and the loop) ends. The finalizer publishes so the turn
	// ends like a real completed run (no auto-continuation).
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 10000, outputTokens: 2000, totalTokens: 12000, callId: 'call-a', estimated: false });
		yield { type: 'chat_text', content: 'working…' };
		record.onUsageHarvested({ inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, callId: 'call-b', estimated: false });
		yield { type: 'chat_text', content: 'still working…' };
		session.report = { ts: 789, verdict: 'fail', summary: 'Tested.' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};

	await runTurn(session, { task: 'Long run' }, store);

	assert.equal(session.status, 'done');
	assert.equal(session.tokenUsage.inputTokens, 15000, 'inputs accumulate');
	assert.equal(session.tokenUsage.outputTokens, 3000, 'outputs accumulate');
	assert.equal(session.tokenUsage.totalTokens, 18000, 'total is in + out');
	assert.ok(commits.some(commit => commit.type === 'usage' && commit.payload.usage.inputTokens === 10000),
		'first call committed live before the turn ended');
	assert.ok(commits.some(commit => commit.type === 'usage' && commit.payload.usage.inputTokens === 15000),
		'second call committed live before the turn ended');
});

test('duplicate usage reports are idempotent — a repeated call id is never counted twice', async () => {
	const { session, record, store } = runtimeFixture();
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, callId: 'call-abc', estimated: false });
		// The same report surfacing twice (SDK retry / event replay):
		record.onUsageHarvested({ inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, callId: 'call-abc', estimated: false });
		// A report with no call id of its own, surfaced twice — the minted id
		// must survive re-entry so this also counts exactly once.
		const unIded = { inputTokens: 2000, outputTokens: 500, totalTokens: 2500, estimated: false };
		record.onUsageHarvested(unIded);
		record.onUsageHarvested(unIded);
		// A published finalizer with a published artifact ends the run like a
		// real completed turn.
		session.report = { ts: 789, verdict: 'fail', summary: 'Tested.' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};

	await runTurn(session, { task: 'Dupes' }, store);

	assert.equal(session.tokenUsage.inputTokens, 7000, 'input counted once per call');
	assert.equal(session.tokenUsage.outputTokens, 1500, 'output counted once per call');
	assert.equal(session.tokenUsage.totalTokens, 8500, 'total counted once per call');
});

test('usage is preserved when a run is stopped mid-stream', async () => {
	const { session, record, store } = runtimeFixture();
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 4000, outputTokens: 800, totalTokens: 4800, callId: 'call-stop', estimated: false });
		yield { type: 'chat_text', content: 'working…' };
		// Stop goes through the run's own controller (record.controller is the
		// AbortController runTurn installed).
		record.controller.abort();
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		throw abortError;
	};

	await runTurn(session, { task: 'Stop me' }, store);

	assert.equal(session.status, 'interrupted', 'run reported as stopped');
	assert.equal(session.tokenUsage.inputTokens, 4000, 'usage accumulated before the stop is kept');
	assert.equal(session.tokenUsage.outputTokens, 800);
});

test('usage is preserved when a model call fails mid-stream', async () => {
	const { session, record, store } = runtimeFixture();
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 2500, outputTokens: 400, totalTokens: 2900, callId: 'call-fail', estimated: false });
		yield { type: 'chat_text', content: 'working…' };
		throw new Error('provider exploded');
	};

	await runTurn(session, { task: 'Fail me' }, store);

	assert.equal(session.status, 'error', 'run reported as failed');
	assert.equal(session.tokenUsage.inputTokens, 2500, 'usage from calls before the failure is kept');
	assert.equal(session.tokenUsage.outputTokens, 400);
});

test('usage ledger survives auto-continuation turns — replayed reports are not re-counted', async () => {
	const { session, record, store } = runtimeFixture();
	let attempt = 0;
	// A prose-only stream triggers the automatic continuation path, which
	// re-enters runTurn for the SAME run. The replayed call-b report must be
	// dropped by the run-scoped ledger, not counted a second time.
	record.runtime.run = async function* () {
		attempt += 1;
		if (attempt === 1) {
			record.onUsageHarvested({ inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, callId: 'call-b', estimated: false });
			yield { type: 'chat_text', content: 'still working…' };
			return;
		}
		// Same report surfacing again in the continuation turn.
		record.onUsageHarvested({ inputTokens: 5000, outputTokens: 1000, totalTokens: 6000, callId: 'call-b', estimated: false });
		record.onUsageHarvested({ inputTokens: 700, outputTokens: 300, totalTokens: 1000, callId: 'call-c', estimated: false });
		session.report = { ts: 791, verdict: 'fail', summary: 'Continuation finished.' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};

	await runTurn(session, { task: 'Run with continuation' }, store);

	assert.equal(session.status, 'done');
	assert.equal(attempt, 2, 'run went through one automatic continuation');
	assert.equal(session.tokenUsage.inputTokens, 5700, 'replayed call-b not re-counted across continuation turns');
	assert.equal(session.tokenUsage.outputTokens, 1300);
	assert.equal(session.tokenUsage.totalTokens, 7000);
});
test('an estimate commits live and is rolled back when a real report supersedes it', async () => {
	const { session, record, store } = runtimeFixture();
	// Only estimates this turn: the chars/4 fallback used by providers that
	// send no in-stream usage. They commit live, exactly like real reports.
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 1000, outputTokens: 200, estimated: true });
		session.report = { ts: 789, verdict: 'fail', summary: 'Tested.' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};
	await runTurn(session, { task: 'Estimate only' }, store);
	assert.equal(session.status, 'done');
	assert.equal(session.tokenUsage.inputTokens, 1000, 'estimate applied when no real report');
	assert.equal(session.tokenUsage.estimated, true);

	// A real report for the same call supersedes the committed estimate: the
	// estimate is rolled back before the real value is applied.
	record.runtime.run = async function* () {
		record.onUsageHarvested({ inputTokens: 1000, outputTokens: 200, estimated: true });
		record.onUsageHarvested({ inputTokens: 700, outputTokens: 300, callId: 'call-real', estimated: false });
		session.report = { ts: 790, verdict: 'fail', summary: 'Tested again.' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
	};
	await runTurn(session, { task: 'Real follows' }, store);
	assert.equal(session.status, 'done');
	assert.equal(session.tokenUsage.inputTokens, 1700, 'estimate rolled back, real report added once');
	assert.equal(session.tokenUsage.outputTokens, 500);
	assert.equal(session.tokenUsage.estimated, false);
});

test('each mode exposes only its own finalizer and browser capabilities', () => {
	for (const [mode, finalizer] of [['qa', 'finish_qa_report'], ['sqa', 'finish_sqa_assessment'], ['founder', 'finish_founder_review']]) {
		const names = allowedToolNames(mode);
		assert.equal(names.has('browser_media'), true);
		assert.equal(names.has('browser_test_meeting_link'), true);
		assert.equal(names.has('browser_sqa_smoke'), mode === 'sqa');
		assert.equal(names.has('run_command'), false);
		assert.deepEqual([...names].filter(name => name.startsWith('finish_')), [finalizer]);
		assert.equal(names.has('report_finding'), mode !== 'founder');
	}
});

test('a stale saved model falls back to the provider default with a warning and heals the preference', async () => {
	const saved = { ...process.env };
	const live = { messages: [] };
	const addMessageCalls = [];
	const store = {
		liveFor: () => live,
		publish() {},
		commit: async () => {},
		addMessage: async (s, item) => { addMessageCalls.push(item); s.messages.push(item); return item; }
	};
	const session = { id: randomUUID(), mode: 'founder', messages: [], activities: [], todos: [], findings: [], secretNames: [] };
	try {
		process.env.QASE_PROVIDER = 'custom';
		process.env.QASE_BASE_URL = 'https://llm.drytis.ai';
		process.env.QASE_API_KEY ||= 'test-key-placeholder';
		await withUserConfiguration({ model: 'drytis/jev-1.13' }, () => {}, async () => {
			const record = await ensureRuntime(session, store);
			try {
				// Config layer swapped the stale model for the default; the user
				// was told once and the stored preference healed.
				assert.equal(addMessageCalls.length, 1);
				assert.equal(addMessageCalls[0].kind, 'warning');
				assert.match(addMessageCalls[0].text, /drytis\/jev-1\.13/);
				assert.match(addMessageCalls[0].text, /z-ai\/glm-5\.2/);
			} finally { record.dispose?.(); }
		});
	} finally {
		for (const key of ['QASE_PROVIDER', 'QASE_BASE_URL']) {
			if (key in saved) process.env[key] = saved[key]; else delete process.env[key];
		}
		if (!('QASE_API_KEY' in saved)) {
			// we set it with ||=; restore by checking the original snapshot
			if (saved.QASE_API_KEY === undefined) delete process.env.QASE_API_KEY; else process.env.QASE_API_KEY = saved.QASE_API_KEY;
		}
	}
});

test('the real SDK registry and advertised descriptions enforce each mode boundary', async () => {
	const saved = process.env.QASE_API_KEY;
	process.env.QASE_API_KEY ||= 'qualification-placeholder';
	try {
		for (const mode of ['qa','sqa','founder']) {
			const live = {};
			const session = {id:randomUUID(),mode,secretNames:[],activities:[],findings:[],todos:[],messages:[]};
			const record = await ensureRuntime(session, {liveFor:()=>live,publish(){},commit:async()=>{}});
			try {
				const names=record.runtime.headlessRuntime.getTools().map(tool=>tool.name);
				assert.deepEqual(new Set(names),allowedToolNames(mode));
				const descriptions=record.runtime.getToolDescriptions();
				if (mode === 'founder') {
					const todo = record.runtime.headlessRuntime.getTools().find(tool => tool.name === 'update_todo');
					const items = createFounderReviewTodos().map(item => ({ content: item.text, status: 'completed' }));
					for (const invalid of [items.slice(1), [...items].reverse(), items.map((item,index) => index === 2 ? {...item,content:'Test microphone workflow'} : item)]) {
						const result = await todo.run({ items: invalid }, {});
						assert.equal(result.success, false);
						assert.equal(result.code, 'FOUNDER_CANONICAL_PLAN_REQUIRED');
						assert.deepEqual(result.canonical_plan, createFounderReviewTodos());
					}
					assert.equal((await todo.run({ items }, {})).success, true);
				}
				for (const denied of ['run_command','read_file','write_file',...(mode==='sqa'?['finish_qa_report']:[])]) {
					assert.ok(!descriptions.includes(`- ${denied}:`));
					const parts=[];
					for await (const part of record.runtime.headlessRuntime.executeTool(denied,{},'blocked-test')) parts.push(part);
					assert.equal(parts[0].result.success,false);
				}
			} finally {record.dispose();}
		}
	} finally {if(saved===undefined)delete process.env.QASE_API_KEY;else process.env.QASE_API_KEY=saved;}
});

test('the real configured-provider SDK persists the new Founder report protocol before registering its staged finalizer',async()=>{
 const saved={...process.env};const keys=['QASE_PROVIDER','QASE_BASE_URL','QASE_API_KEY','QASE_FOUNDER_REASONING_ENABLED'];
 Object.assign(process.env,{QASE_PROVIDER:'custom',QASE_BASE_URL:'https://llm.drytis.ai',QASE_API_KEY:'qualification-placeholder',QASE_FOUNDER_REASONING_ENABLED:'false'});
 const session={id:randomUUID(),mode:'founder',founder:{observations:[]},secretNames:[],activities:[],findings:[],todos:[],messages:[]};
 const live={},commits=[];const store={liveFor:()=>live,publish(){},async commit(s,type){commits.push({type,generation:structuredClone(s.founder.reportGeneration)});}};
 try{
  const record=await ensureRuntime(session,store);
  try{
   assert.equal(commits[0].type,'founder.report_protocol');assert.equal(commits[0].generation.protocol,'section-draft-v1');
   const tools=record.runtime.headlessRuntime.getTools();assert.ok(tools.some(t=>t.name==='draft_founder_report_section'));
   assert.deepEqual(tools.find(t=>t.name==='finish_founder_review').parametersSchema.required,['draft_revision']);
   assert.doesNotMatch(record.runtime.getToolDescriptions(),/- finish_founder_review:/,'The unbounded native report schema must not be copied into exploration context.');
   assert.ok(record.runtime.getToolDescriptions().length<1000,'Native tool schemas must not be duplicated in the system context.');
  }finally{record.dispose?.();}
 }finally{for(const key of keys){if(key in saved)process.env[key]=saved[key];else delete process.env[key];}}
 const failed={...session,id:randomUUID(),founder:{observations:[]}};const record={};
 Object.assign(process.env,{QASE_PROVIDER:'custom',QASE_BASE_URL:'https://llm.drytis.ai',QASE_API_KEY:'qualification-placeholder',QASE_FOUNDER_REASONING_ENABLED:'false'});
 try{
  await assert.rejects(ensureRuntime(failed,{liveFor:()=>record,async commit(){throw new Error('Storage unavailable');}}),/Storage unavailable/);
  assert.equal(failed.founder.reportGeneration,undefined);assert.equal(record.runtime,undefined);
 }finally{for(const key of keys){if(key in saved)process.env[key]=saved[key];else delete process.env[key];}}
});

test('new browser capabilities validate model arguments before invoking the bridge', async () => {
	const calls = [];
	const tools = createBrowserTools(() => ({
		media: async input => { calls.push(input); return { success: true, synthetic: true }; },
		testMeetingLink: async input => { calls.push(input); return { success: true }; },
		sqaSmoke: async input => { calls.push(input); return { success: true, action: input.action }; },
		runSecurityChecks: async input => ({ success: true, results: [] })
	}));
	const media = tools.find(tool => tool.name === 'browser_media');
	const meeting = tools.find(tool => tool.name === 'browser_test_meeting_link');
	const smoke = tools.find(tool => tool.name === 'browser_sqa_smoke');
	for (const input of [null, {}, { action: 'record' }, { action: 'set_permission' }, { action: 'probe', durationMs: Infinity }]) {
		assert.equal((await media.run(input)).success, false);
	}
	assert.equal((await meeting.run({})).success, false);
	assert.equal((await meeting.run({ url: 10 })).success, false);
	assert.equal((await smoke.run({})).success, false);
	assert.equal((await smoke.run({ action: 'accessibility', viewports: [{ width: 390, height: 844 }] })).success, false);
	assert.equal((await smoke.run({ action: 'accessibility', steps: 13 })).success, false);
	assert.equal((await smoke.run({ action: 'responsive', steps: 8 })).success, false);
	assert.equal((await smoke.run({ action: 'responsive', viewports: [{ width: 100, height: 200 }] })).success, false);
	assert.equal((await smoke.run({ action: 'navigation' })).success, false);
	assert.equal((await smoke.run({ action: 'form_validation', field_label: 'Email' })).success, false);
	assert.equal(calls.length, 0, 'invalid inputs must not reach the bridge');
	assert.equal((await media.run({ action: 'set_permission', permission: 'denied' })).success, true);
	assert.equal((await meeting.run({ selector: '#meeting' })).success, true);
	assert.equal((await smoke.run({ action: 'accessibility', steps: 8, reverse_steps: 2 })).success, true);
	assert.equal((await smoke.run({ action: 'navigation', links: ['Privacy'] })).success, true);
	assert.equal((await smoke.run({ action: 'form_validation' })).success, true);
	assert.equal((await smoke.run({ action: 'form_validation', field_label: 'Email', submit_name: 'Validate' })).success, true);
});

test('SQA browser budget blocks more browser work without blocking finalization tools', async () => {
	const session = {
		mode: 'sqa',
		activities: [
			{ toolName: 'browser_open', status: 'done' },
			{ toolName: 'browser_snapshot', status: 'done' }
		]
	};
	let browserCalls = 0;
	const guarded = guardSqaBrowserTool({
		name: 'browser_click',
		description: 'Click a control.',
		run: async () => { browserCalls++; return { success: true }; }
	}, session, 2);
	const blocked = await guarded.run({ selector: '#submit' }, {});
	assert.equal(blocked.success, false);
	assert.equal(blocked.code, 'SQA_BROWSER_BUDGET_EXHAUSTED');
	assert.equal(blocked.used, 2);
	assert.equal(blocked.limit, 2);
	assert.equal(browserCalls, 0);

	session.activities = [];
	session.tokenUsage = { inputTokens: 500 };
	const tokenBlocked = await guardSqaBrowserTool({
		name: 'browser_snapshot',
		run: async () => { browserCalls++; return { success: true }; }
	}, session, 99, 500).run({}, {});
	assert.equal(tokenBlocked.success, false);
	assert.equal(tokenBlocked.code, 'SQA_INPUT_TOKEN_BUDGET_EXHAUSTED');
	assert.equal(tokenBlocked.used, 500);
	assert.equal(tokenBlocked.limit, 500);
	assert.equal(browserCalls, 0);

	session.tokenUsage = { inputTokens: 0 };
	session.sqa = { observations: [{ controlId: 'SQA-WEB-001', status: 'pass' }] };
	session.activities = [
		{ toolName: 'record_sqa_control', status: 'done' },
		{ toolName: 'browser_snapshot', status: 'done' },
		{ toolName: 'browser_diagnostics', status: 'done' }
	];
	const checkpointBlocked = await guardSqaBrowserTool({
		name: 'browser_click',
		run: async () => { browserCalls++; return { success: true }; }
	}, session, 99, 500, 2).run({}, {});
	assert.equal(checkpointBlocked.success, false);
	assert.equal(checkpointBlocked.code, 'SQA_WORKFLOW_CHECKPOINT_REQUIRED');
	assert.equal(checkpointBlocked.used, 2);
	assert.equal(browserCalls, 0);

	let finalizerCalls = 0;
	const finalizer = guardSqaBrowserTool({
		name: 'finish_sqa_assessment',
		run: async () => { finalizerCalls++; return { success: true, published: true }; }
	}, session, 2);
	assert.equal((await finalizer.run({}, {})).success, true);
	assert.equal(finalizerCalls, 1);
});

test('SQA budget guard results map to one host-owned finalizer path', () => {
	assert.deepEqual(sqaAutomaticBudgetCloseoutInput({ code: 'SQA_INPUT_TOKEN_CLOSEOUT_REQUIRED' }), { close_from_saved_evidence: true });
	assert.deepEqual(sqaAutomaticBudgetCloseoutInput({ code: 'SQA_EVIDENCE_COLLECTION_COMPLETE' }), { close_from_saved_evidence: true });
	assert.deepEqual(sqaAutomaticBudgetCloseoutInput({ code: 'SQA_INPUT_TOKEN_BUDGET_EXHAUSTED' }), { close_after_safety_limit: true });
	assert.deepEqual(sqaAutomaticBudgetCloseoutInput({ code: 'SQA_BROWSER_BUDGET_EXHAUSTED' }), { close_after_safety_limit: true });
	assert.equal(sqaAutomaticBudgetCloseoutInput({ code: 'SQA_WORKFLOW_CHECKPOINT_REQUIRED' }), undefined);
	assert.deepEqual(sqaAutomaticBudgetCloseoutInput({ success: true }, {
		mode: 'sqa', sqa: {}, tokenUsage: { inputTokens: 300_000 }, activities: []
	}), { close_from_saved_evidence: true });
	assert.equal(sqaAutomaticBudgetCloseoutInput({ success: true }, {
		mode: 'sqa', sqa: {}, tokenUsage: { inputTokens: 299_999 }, activities: []
	}), undefined);
});

test('SQA threshold publishes through the host after any completed tool without another model turn', async () => {
	const fixture = runtimeFixture({
		mode: 'sqa',
		sqa: { scope: { applicableControlIds: [] }, observations: [] },
		tokenUsage: { inputTokens: 300_000 },
		status: 'running'
	});
	const closeoutInputs = [];
	const finalizer = {
		name: 'finish_sqa_assessment',
		async run(input) {
			closeoutInputs.push(input);
			fixture.session.sqa.finalizedAt = '2026-11-06T08:00:00.000Z';
			fixture.session.sqa.assessment = { assessmentId: 'sqa-host-closeout', verdict: 'blocked' };
			return { success: true, published: true, assessment_id: 'sqa-host-closeout', verdict: 'blocked' };
		}
	};
	fixture.record.runtime.headlessRuntime = { getTools: () => [finalizer] };
	let modelTurns = 0;
	fixture.record.runtime.run = async function* () {
		modelTurns++;
		yield {
			type: 'tool_result', toolName: 'update_todo', toolCallId: 'budget-plan', input: {},
			result: { success: true, todos: [] }
		};
		yield { type: 'text', content: 'This text must not require another turn.' };
	};

	await runTurn(fixture.session, { task: 'Complete the bounded SQA run.' }, fixture.store);

	assert.equal(modelTurns, 1);
	assert.deepEqual(closeoutInputs, [{ close_from_saved_evidence: true }]);
	assert.equal(fixture.session.status, 'done');
	assert.equal(fixture.session.sqa.assessment.assessmentId, 'sqa-host-closeout');
	assert.equal(fixture.session.activities.find(item => item.toolName === 'finish_sqa_assessment')?.status, 'done');
});

test('media evidence summaries fit Founder evidence limits and retain the latest app track state', () => {
	const summary = summariseResult('browser_media', { permission:'granted', observed:{requests:Array.from({length:50},()=>({source:'application',outcome:'granted',tracks:[{kind:'audio',enabled:false,readyState:'live'}]}))} });
	assert.ok(summary.length<=1000);
	assert.match(summary,/"enabled":false/);
	assert.match(summary,/"requestCount":50/);
	assert.ok(summariseResult('browser_test_meeting_link',{url:'https://example.test/'+'a'.repeat(4000),joined:false}).length<=1000);
});

for (const [mode, finalizer] of [['qa', 'finish_qa_report'], ['sqa', 'finish_sqa_assessment'], ['founder', 'finish_founder_review']]) {
	test(`${mode} publication stops the model before a later provider failure can corrupt run status`, async () => {
		const session = { id: randomUUID(), mode, targetUrl: 'https://example.test', messages: [], activities: [], secretNames: [] };
		let readAfterPublication = false;
		let streamClosed = false;
		const runtime = {
			async *run() {
				try {
					if (mode === 'qa') session.report = { ts: Date.now(), verdict: 'pass' };
					else session[mode] = { finalizedAt: new Date().toISOString() };
					yield { type: 'tool_result', toolName: finalizer, toolCallId: 'finish', result: { success: true, published: true } };
					readAfterPublication = true;
					throw new Error('Connection error after publication');
				} finally { streamClosed = true; }
			},
			getPendingQuestion: () => undefined
		};
		const record = { runtime, bridge: { hasPage: () => false, captureFrame: async () => {}, stopFrames() {} } };
		const store = {
			liveFor: () => record, listLive: () => [], publish() {}, commit: async () => {},
			setStatus: async (s, status) => { s.status = status; },
			addActivity: async (s, item) => { s.activities.push(item); return item; },
			updateActivity: async (s, id, patch) => Object.assign(s.activities.find(item => item.id === id), patch),
			addMessage: async (s, item) => { s.messages.push(item); return item; }
		};
		await runTurn(session, { task: 'Complete the qualification' }, store);
		assert.equal(session.status, 'done');
		assert.equal(readAfterPublication, false);
		assert.equal(streamClosed, true);
		assert.equal(session.messages.some(item => item.kind === 'error'), false);
		assert.equal(session.messages.filter(item => item.kind === 'qa-report').length, mode === 'qa' ? 1 : 0);
	});
}

test('QA completion posts the actual findings after progress text and before done, once per report', async () => {
	const fixture = runtimeFixture({ findings: [{ severity: 'high', title: 'Contact form fails', actual: 'HTTP 500 on submit' }] });
	let version = 1;
	fixture.record.runtime.run = async function* () {
		yield { type: 'chat_text', content: 'I will publish the report now.' };
		fixture.session.report = { ts: version, verdict: 'fail', summary: 'Public pages checked.', covered: ['Home', 'Contact'] };
		yield { type: 'tool_result', toolName: 'finish_qa_report', toolCallId: 'finish', result: { success: true, published: true } };
	};
	const setStatus = fixture.store.setStatus;
	fixture.store.setStatus = async (s, status, detail) => {
		if (status === 'done') assert.ok(s.messages.some(m => m.kind === 'qa-report' && m.text.includes('Contact form fails')));
		await setStatus(s, status, detail);
	};
	await runTurn(fixture.session, { task: 'Complete QA' }, fixture.store);
	assert.equal(fixture.session.messages.at(-1).kind, 'qa-report');
	assert.match(fixture.session.messages.at(-1).text, /HTTP 500/);
	await runTurn(fixture.session, { task: 'Repeat finalization' }, fixture.store);
	assert.equal(fixture.session.messages.filter(m => m.kind === 'qa-report').length, 1);
	version++;
	await runTurn(fixture.session, { task: 'Run QA again' }, fixture.store);
	assert.equal(fixture.session.messages.filter(m => m.kind === 'qa-report').length, 2);
});

test('a terminal run deletes its restart-safe credential material', async t => {
	const fixture = runtimeFixture();
	t.after(() => clearSecrets(fixture.session.id));
	storeSecrets(fixture.session.id, { qa_password: 'terminal-private-value' });
	fixture.session.secretNames = ['QA_PASSWORD'];
	fixture.record.runtime.run = async function* () {
		fixture.session.report = { ts: 123, verdict: 'pass' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', toolCallId: 'finish', result: { success: true, published: true } };
	};

	await runTurn(fixture.session, { task: 'Complete QA' }, fixture.store);
	assert.equal(fixture.session.status, 'done');
	assert.deepEqual(fixture.session.secretNames, []);
	assert.equal(resolveSecrets(fixture.session.id, '{{QA_PASSWORD}}'), '{{QA_PASSWORD}}');
});

test('graceful model cancellation stops without launching an automatic continuation', async () => {
	const fixture = runtimeFixture();
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		fixture.record.controller.abort();
	};
	await runTurn(fixture.session, { task: 'Run QA' }, fixture.store);
	assert.equal(calls, 1);
	assert.equal(fixture.session.status, 'interrupted');
	assert.equal(fixture.statuses.at(-1).detail, 'Stopped by user.');
	assert.equal(fixture.record.running, false);
	assert.equal(fixture.record.controller, undefined);
});

test('a recreated runtime restores the saved pending-question snapshot', () => {
	const snapshot = { conversation: [{ role: 'assistant', content: 'May I continue?' }] };
	const calls = [];
	const runtime = {
		restoreSessionSnapshot(value) { calls.push(value); },
		getPendingQuestion: () => ({ toolCallId: 'ask-1' })
	};
	const restored = restoreWaitingSnapshot(runtime, {
		id: 'wait-1', status: 'awaiting_input', pendingQuestion: { question: 'May I continue?' }
	}, () => snapshot);
	assert.equal(restored, true);
	assert.deepEqual(calls, [snapshot]);
});

test('an answer without a restorable SDK question continues as a recovery task', async () => {
	const fixture = runtimeFixture({
		status: 'awaiting_input',
		pendingQuestion: { toolCallId: 'ask-1', question: 'May I join the live meeting?' }
	});
	let recoveryTask;
	fixture.record.runtime.resumePendingQuestion = async function* () {
		throw new Error('must not resume missing SDK state');
	};
	fixture.record.runtime.run = async function* (task) {
		recoveryTask = task;
		fixture.session.report = { ts: 99, verdict: 'pass' };
		yield { type: 'tool_result', toolName: 'finish_qa_report', toolCallId: 'finish', result: { success: true, published: true } };
	};
	await runTurn(fixture.session, { resumeAnswer: 'Yes, join it.' }, fixture.store);
	assert.match(recoveryTask, /May I join the live meeting/);
	assert.match(recoveryTask, /Yes, join it/);
	assert.equal(fixture.session.status, 'done');
});

test('plural credentials in an SQA question select the secure credential form', async () => {
	for (const question of [
		{ question: 'Provide vaulted credentials to test authenticated workflows.', options: [] },
		{ question: 'How should the assessment proceed?', options: [{ label: 'Use vaulted credentials' }, { label: 'Public-only scope' }] }
	]) {
		const fixture = runtimeFixture({
			mode: 'sqa',
			sqa: { scope: { applicableControlIds: [] }, observations: [] }
		});
		fixture.record.runtime.getPendingQuestion = () => ({ toolCallId: 'ask-credentials', question });
		await runTurn(fixture.session, { task: 'Continue SQA' }, fixture.store);
		assert.equal(fixture.session.status, 'awaiting_input');
		assert.equal(fixture.session.pendingQuestion.credentialLike, true);
	}
});

test('ordinary SQA scope decisions remain normal option questions', async () => {
	const fixture = runtimeFixture({
		mode: 'sqa',
		sqa: { scope: { applicableControlIds: [] }, observations: [] }
	});
	fixture.record.runtime.getPendingQuestion = () => ({
		toolCallId: 'ask-scope',
		question: { question: 'Choose the assessment scope.', options: [{ label: 'Public pages' }, { label: 'Full product' }] }
	});
	await runTurn(fixture.session, { task: 'Continue SQA' }, fixture.store);
	assert.equal(fixture.session.pendingQuestion.credentialLike, false);
});

test('model activity deadline is bounded and rejects a silent stream', async () => {
	assert.equal(modelActivityTimeoutMs({ QASE_MODEL_ACTIVITY_TIMEOUT_MS: '1' }), 100);
	assert.equal(modelActivityTimeoutMs({ QASE_MODEL_ACTIVITY_TIMEOUT_MS: '9999999' }), 900_000);
	assert.equal(modelActivityTimeoutMs({ QASE_MODEL_ACTIVITY_TIMEOUT_MS: 'invalid' }), 180_000);
	let timeoutError;
	async function* silent() { await new Promise(() => {}); }
	await assert.rejects(async () => {
		for await (const _part of withModelActivityDeadline(silent(), {
			timeoutMs: 100,
			onTimeout(error) { timeoutError = error; }
		})) { /* no activity expected */ }
	}, error => error?.code === 'MODEL_ACTIVITY_TIMEOUT');
	assert.equal(timeoutError?.name, 'ModelActivityTimeoutError');
	const chunks = [];
	async function* active() {
		await new Promise(resolve => setTimeout(resolve, 60));
		yield 'first';
		await new Promise(resolve => setTimeout(resolve, 60));
		yield 'second';
	}
	for await (const chunk of withModelActivityDeadline(active(), { timeoutMs: 100 })) chunks.push(chunk);
	assert.deepEqual(chunks, ['first', 'second'], 'each streamed part resets the inactivity deadline');
	let externalTouch;
	async function* externallyActive() {
		await new Promise(resolve => setTimeout(resolve, 150));
		yield 'tool-complete';
	}
	setTimeout(() => externalTouch?.(), 70);
	const externalChunks = [];
	for await (const chunk of withModelActivityDeadline(externallyActive(), {
		timeoutMs: 100,
		registerTouch(touch) { externalTouch = touch; }
	})) externalChunks.push(chunk);
	assert.deepEqual(externalChunks, ['tool-complete'], 'host-observed activity extends the current wait');
});

test('host inactivity deadline aborts a stalled SQA model and resumes durable progress', async t => {
	const previous = process.env.QASE_MODEL_ACTIVITY_TIMEOUT_MS;
	process.env.QASE_MODEL_ACTIVITY_TIMEOUT_MS = '100';
	t.after(() => {
		if (previous === undefined) delete process.env.QASE_MODEL_ACTIVITY_TIMEOUT_MS;
		else process.env.QASE_MODEL_ACTIVITY_TIMEOUT_MS = previous;
	});
	const fixture = runtimeFixture({
		mode: 'sqa',
		sqa: {
			scope: { applicableControlIds: ['SQA-WEB-001'] },
			observations: [{ controlId: 'SQA-WEB-001', status: 'pass', evidence: [] }]
		}
	});
	let calls = 0;
	let stalledSignal;
	fixture.record.runtime.run = async function* (_task, signal) {
		calls++;
		if (calls === 1) {
			stalledSignal = signal;
			await new Promise((resolve, reject) => {
				const fallback = setTimeout(resolve, 5_000);
				signal.addEventListener('abort', () => {
					clearTimeout(fallback);
					reject(signal.reason ?? new Error('aborted'));
				}, { once: true });
			});
			return;
		}
		fixture.session.sqa.finalizedAt = new Date().toISOString();
		yield {
			type: 'tool_result', toolName: 'finish_sqa_assessment', toolCallId: 'finish',
			result: { success: true, published: true }
		};
	};
	await runTurn(fixture.session, { task: 'Complete SQA' }, fixture.store);
	assert.equal(calls, 2);
	assert.equal(stalledSignal.aborted, true);
	assert.equal(fixture.session.status, 'done');
	assert.ok(fixture.statuses.some(item => item.detail?.includes('model response timed out')));
	assert.equal(fixture.session.messages.some(item => item.kind === 'error'), false);
});

test('Stop remains effective during timeout backoff and releases the running lock', async () => {
	const fixture = runtimeFixture();
	let calls = 0;
	let stateAtStop;
	fixture.record.runtime.run = async function* () { calls++; throw new Error('Request timed out'); };
	const setStatus = fixture.store.setStatus;
	fixture.store.setStatus = async (session, status, detail) => {
		await setStatus(session, status, detail);
		if (detail?.includes('Retrying automatically')) {
			setImmediate(() => {
				stateAtStop = { running: fixture.record.running, hasController: Boolean(fixture.record.controller) };
				fixture.record.controller?.abort();
			});
		}
	};
	await runTurn(fixture.session, { task: 'Run QA' }, fixture.store);
	assert.deepEqual(stateAtStop, { running: true, hasController: true });
	assert.equal(calls, 1);
	assert.equal(fixture.session.status, 'interrupted');
	assert.equal(fixture.record.running, false);
	assert.equal(fixture.record.controller, undefined);
});

for (const mode of ['sqa', 'founder']) {
	test(`${mode} retries a transient provider disconnect and completes through its finalizer`, async () => {
		const fixture = runtimeFixture({
			mode,
			[mode]: mode === 'sqa'
				? { scope: { applicableControlIds: [] }, observations: [] }
				: { scope: {}, observations: [] }
		});
		let calls = 0;
		fixture.record.runtime.run = async function* () {
			calls++;
			if (calls === 1) throw new Error('Connection error: socket hang up');
			fixture.session[mode].finalizedAt = new Date().toISOString();
			yield {
				type: 'tool_result',
				toolName: mode === 'sqa' ? 'finish_sqa_assessment' : 'finish_founder_review',
				toolCallId: 'finish',
				result: { success: true, published: true }
			};
		};
		await runTurn(fixture.session, { task: `Complete ${mode}` }, fixture.store);
		assert.equal(calls, 2);
		assert.equal(fixture.session.status, 'done');
		assert.equal(fixture.session.messages.some(item => item.kind === 'error'), false);
		assert.ok(fixture.statuses.some(item => item.detail?.includes('interrupted')));
	});
}

test('SQA retries a gateway stream that ends with a bare terminated error', async () => {
	const fixture = runtimeFixture({
		mode: 'sqa',
		sqa: { scope: { applicableControlIds: [] }, observations: [] }
	});
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		if (calls === 1) throw new Error('terminated');
		fixture.session.sqa.finalizedAt = new Date().toISOString();
		yield {
			type: 'tool_result',
			toolName: 'finish_sqa_assessment',
			toolCallId: 'finish',
			result: { success: true, published: true }
		};
	};
	await runTurn(fixture.session, { task: 'Complete SQA' }, fixture.store);
	assert.equal(calls, 2);
	assert.equal(fixture.session.status, 'done');
	assert.ok(fixture.statuses.some(item => item.detail?.includes('interrupted')));
});

test('QA provider disconnect behavior is unchanged', async () => {
	const fixture = runtimeFixture();
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		throw new Error('Connection error: socket hang up');
	};
	await runTurn(fixture.session, { task: 'Run QA' }, fixture.store);
	assert.equal(calls, 1);
	assert.equal(fixture.session.status, 'error');
});

test('SQA does not retry authentication failures disguised as connection errors', async () => {
	const fixture = runtimeFixture({
		mode: 'sqa',
		sqa: { scope: { applicableControlIds: [] }, observations: [] }
	});
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		throw new Error('Connection error: 401 unauthorized API key');
	};
	await runTurn(fixture.session, { task: 'Complete SQA' }, fixture.store);
	assert.equal(calls, 1);
	assert.equal(fixture.session.status, 'error');
});

test('cancellation during unfinished-tool cleanup prevents a planned continuation', async () => {
	const fixture = runtimeFixture();
	let calls = 0;
	fixture.record.runtime.run = async function* () {
		calls++;
		yield { type: 'tool_start', toolName: 'browser_wait', toolCallId: 'unfinished', input: {} };
	};
	const updateActivity = fixture.store.updateActivity;
	fixture.store.updateActivity = async (session, id, patch) => {
		if (patch.error === 'The model turn ended before this tool returned.') fixture.record.controller.abort();
		return updateActivity(session, id, patch);
	};
	await runTurn(fixture.session, { task: 'Run QA' }, fixture.store);
	assert.equal(calls, 1);
	assert.equal(fixture.session.status, 'interrupted');
	assert.equal(fixture.record.controller, undefined);
});

for (const mode of ['sqa', 'founder']) {
	test(`${mode} idempotent finalizer succeeds without requiring artifact mutation`, async () => {
		const fixture = runtimeFixture({ mode, [mode]: { finalizedAt: '2026-09-09T00:00:00.000Z' } });
		const previous = fixture.session[mode];
		fixture.record.runtime.run = async function* () {
			yield { type: 'tool_result', toolName: mode === 'sqa' ? 'finish_sqa_assessment' : 'finish_founder_review', toolCallId: 'finish', result: { success: true, published: true, already_finalized: true } };
		};
		await runTurn(fixture.session, { task: 'Show the completed report' }, fixture.store);
		assert.equal(fixture.session.status, 'done');
		assert.equal(fixture.session[mode], previous);
		assert.equal(fixture.statuses.some(item => item.detail?.includes('Continuing automatically')), false);
	});
}

for (const mode of ['qa', 'sqa', 'founder']) {
	test(`${mode} stale report cannot mark an unfinalized follow-up successful`, async () => {
		const fixture = runtimeFixture({ mode, ...(mode === 'qa' ? { report: { ts: 1, verdict: 'pass' } } : { [mode]: { finalizedAt: '2026-09-09T00:00:00.000Z' } }) });
		await runTurn(fixture.session, { task: 'Retest', incompleteAttempt: Number.MAX_SAFE_INTEGER }, fixture.store);
		assert.equal(fixture.session.status, 'error');
		assert.equal(fixture.statuses.some(item => item.status === 'done'), false);
	});
}

test('Founder synthesis readiness retains every prerequisite and clears only the model transcript once', () => {
	const fixture = founderSynthesisFixture();
	assert.equal(isFounderSynthesisReady(fixture.session), true);
	for (const mutate of [
		session => { session.founder.observations.pop(); },
		session => { session.todos[0].status = 'pending'; },
		session => { session.activities = session.activities.filter(activity => activity.toolName !== 'browser_diagnostics'); },
		session => { session.activities.push({ id: 'running', toolName: 'browser_wait', status: 'running', ts: Date.now() }); },
		session => { session.founder.observations[0].title = 'Authentication required: cannot sign in'; },
		session => { session.founder.finalizedAt = '2026-09-09T00:00:00.000Z'; }
	]) {
		const candidate = structuredClone(fixture.session);
		mutate(candidate);
		assert.equal(isFounderSynthesisReady(candidate), false);
	}
	const before = structuredClone(fixture.session);
	assert.equal(prepareFounderSynthesis(fixture.session, fixture.record), true);
	assert.equal(fixture.clearCount(), 1);
	assert.deepEqual(fixture.session, before);
	assert.deepEqual(fixture.headless.getTools().map(tool => tool.name), ['finish_founder_review']);
	assert.deepEqual([...fixture.headless.toolsByName.keys()], ['finish_founder_review']);
	assert.match(fixture.record.runtime.getToolDescriptions(), /finish_founder_review/);
	assert.doesNotMatch(fixture.record.runtime.getToolDescriptions(), /browser_snapshot/);
	assert.equal(prepareFounderSynthesis(fixture.session, fixture.record), false);
	assert.equal(fixture.clearCount(), 1);
});

test('configured-provider Founder synthesis keeps durable draft tools and removes browser work at the SDK boundary',()=>{
 const f=founderSynthesisFixture();f.session.founder.reportGeneration={version:1,protocol:'section-draft-v1',evidenceHashVersion:1};
 const draft={name:'draft_founder_report_section',parametersSchema:{type:'object'}};f.headless.options.tools.push(draft);f.headless.toolsByName.set(draft.name,draft);
 const before=structuredClone(f.session);
 assert.equal(prepareFounderSynthesis(f.session,f.record),true);assert.equal(f.clearCount(),1);
 assert.deepEqual(f.headless.getTools().map(t=>t.name),['finish_founder_review','draft_founder_report_section']);
 assert.deepEqual(f.session,before);assert.match(f.record.runtime.getToolDescriptions(),/typed report draft/);
});

test('new configured report groups retain their native SDK tool across synthesis without changing saved state',()=>{
 const f=founderSynthesisFixture();f.session.founder.reportGeneration={version:1,protocol:'section-draft-v1',evidenceHashVersion:1,sectionBatchSize:3};
 for(const name of ['draft_founder_report_section','draft_founder_report_batch']){const tool={name,parametersSchema:{type:'object'}};f.headless.options.tools.push(tool);f.headless.toolsByName.set(name,tool);}
 const before=structuredClone(f.session);assert.equal(prepareFounderSynthesis(f.session,f.record),true);
 assert.deepEqual(f.headless.getTools().map(t=>t.name),['finish_founder_review','draft_founder_report_section','draft_founder_report_batch']);
 assert.deepEqual(f.session,before);assert.equal(f.clearCount(),1);assert.equal(prepareFounderSynthesis(f.session,f.record),false);
});

test('SQA context continuation clears only redundant model history at bounded evidence checkpoints', () => {
	const session = {
		mode: 'sqa',
		activities: Array.from({ length: 1 }, (_, index) => ({
			id: `browser-${index}`,
			toolName: 'browser_snapshot',
			status: 'done'
		})),
		sqa: { observations: [{ controlId: 'SQA-WEB-001', status: 'pass' }] }
	};
	let clearCount = 0;
	const record = { runtime: { agentSession: { clear() { clearCount++; } } } };
	const before = structuredClone(session);
	assert.equal(prepareSqaContextContinuation(session, record), true);
	assert.equal(clearCount, 1);
	assert.equal(record.sqaBrowserActivitiesAtCompaction, 1);
	assert.equal(record.sqaContextCompactions, 1);
	assert.deepEqual(session, before);
	assert.equal(prepareSqaContextContinuation(session, record), false);
	assert.equal(clearCount, 1);

	session.activities.push(...Array.from({ length: 1 }, (_, index) => ({
		id: `browser-next-${index}`,
		toolName: 'browser_click',
		status: 'done'
	})));
	assert.equal(prepareSqaContextContinuation(session, record), true);
	assert.equal(clearCount, 2);
	assert.equal(record.sqaBrowserActivitiesAtCompaction, 2);
	assert.equal(record.sqaContextCompactions, 2);
});

test('SQA control-result checkpoint starts one compact continuation and preserves durable progress', async () => {
	const activities = Array.from({ length: 24 }, (_, index) => ({
		id: `browser-${index}`,
		toolName: 'browser_snapshot',
		status: 'done',
		ts: Date.now()
	}));
	const fixture = runtimeFixture({
		mode: 'sqa',
		activities,
		todos: [{ text: 'Completed bounded workflow', status: 'completed' }],
		sqa: {
			scope: { applicableControlIds: ['SQA-WEB-001'] },
			observations: [{ controlId: 'SQA-WEB-001', status: 'pass', evidence: [] }]
		}
	});
	let calls = 0;
	let clears = 0;
	let readPastCheckpoint = false;
	fixture.record.runtime.agentSession = { clear() { clears++; } };
	fixture.record.runtime.run = async function* () {
		calls++;
		if (calls === 1) {
			yield {
				type: 'tool_result',
				toolName: 'record_sqa_control',
				toolCallId: 'checkpoint',
				result: { success: true, controlId: 'SQA-WEB-001', status: 'pass' }
			};
			readPastCheckpoint = true;
			return;
		}
		fixture.session.sqa.finalizedAt = new Date().toISOString();
		yield {
			type: 'tool_result',
			toolName: 'finish_sqa_assessment',
			toolCallId: 'finish',
			result: { success: true, published: true }
		};
	};
	await runTurn(fixture.session, { task: 'Complete SQA' }, fixture.store);
	assert.equal(calls, 2);
	assert.equal(clears, 1);
	assert.equal(readPastCheckpoint, false);
	assert.equal(fixture.record.sqaBrowserActivitiesAtCompaction, 24);
	assert.equal(fixture.session.status, 'done');
});

test('SQA todo updates do not interrupt parallel work when context compaction is due', async () => {
	const fixture = runtimeFixture({
		mode: 'sqa',
		activities: Array.from({ length: 24 }, (_, index) => ({
			id: `browser-${index}`,
			toolName: 'browser_snapshot',
			status: 'done',
			ts: Date.now()
		})),
		todos: [{ text: 'Complete bounded workflow', status: 'in_progress' }],
		sqa: {
			scope: { applicableControlIds: ['SQA-WEB-001'] },
			observations: [{ controlId: 'SQA-WEB-001', status: 'pass', evidence: [] }]
		}
	});
	let calls = 0;
	let clears = 0;
	let continuedAfterTodo = false;
	fixture.record.runtime.agentSession = { clear() { clears++; } };
	fixture.record.runtime.run = async function* () {
		calls++;
		yield {
			type: 'tool_result',
			toolName: 'update_todo',
			toolCallId: 'plan',
			result: { success: true, todos: fixture.session.todos }
		};
		continuedAfterTodo = true;
		fixture.session.sqa.finalizedAt = new Date().toISOString();
		yield {
			type: 'tool_result',
			toolName: 'finish_sqa_assessment',
			toolCallId: 'finish',
			result: { success: true, published: true }
		};
	};
	await runTurn(fixture.session, { task: 'Complete SQA' }, fixture.store);
	assert.equal(calls, 1);
	assert.equal(clears, 0);
	assert.equal(continuedAfterTodo, true);
	assert.equal(fixture.session.status, 'done');
});

test('deterministic fake-model SQA agent completes the real closeout path without a gateway', async () => {
	const browserActivity = {
		id: 'browser-evidence', toolName: 'browser_snapshot', status: 'done', ts: Date.now(),
		summary: 'Controlled fixture rendered and its bounded technical workflows completed.'
	};
	const sqa = createSqaState({
		authorizationConfirmed: true,
		profiles: ['core'],
		attributes: ['web_application', 'user_interface'],
		target: { name: 'Deterministic SQA agent fixture', release: 'phase-6', environment: 'test' }
	});
	const fixture = runtimeFixture({ mode: 'sqa', activities: [browserActivity], sqa });
	fixture.session.todos = createSqaTodoPlan(sqa);
	const commits = [];
	const commit = fixture.store.commit;
	fixture.store.commit = async (session, type, payload) => {
		commits.push({ type, payload });
		await commit(session, type, payload);
	};
	fixture.record.runtime.run = async function* () {
		const tools = createSqaTools(fixture.session, fixture.store);
		const record = tools.find(tool => tool.name === 'record_sqa_control');
		const finish = tools.find(tool => tool.name === 'finish_sqa_assessment');
		if (fixture.record.sqaSynthesis) {
			fixture.session.todos = fixture.session.todos.map(todo => ({ ...todo, status: 'completed' }));
			yield {
				type: 'tool_result', toolName: 'update_todo', toolCallId: 'complete-plan',
				result: { success: true, todos: fixture.session.todos }
			};
			const final = await finish.run({});
			assert.equal(final.success, true, final.error);
			yield { type: 'tool_result', toolName: 'finish_sqa_assessment', toolCallId: 'finish', result: final };
			return;
		}
		let callIndex = 0;
		const orderedControlIds = [
			...SQA_TECHNICAL_CONTROL_IDS.filter(controlId => fixture.session.sqa.scope.applicableControlIds.includes(controlId)),
			...fixture.session.sqa.scope.applicableControlIds.filter(controlId => !SQA_TECHNICAL_CONTROL_IDS.includes(controlId))
		].filter(controlId => getSqaControl(controlId).evidenceRequirements
			.some(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type)));
		for (const controlId of orderedControlIds) {
			const control = getSqaControl(controlId);
			const hasAgentEvidence = control.evidenceRequirements.some(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type));
			const allEvidenceIsAgentEvidence = control.evidenceRequirements.every(requirement => AGENT_EVIDENCE_TYPES.has(requirement.type));
			assert.equal(hasAgentEvidence, true);
			const input = allEvidenceIsAgentEvidence ? {
				control_id: controlId, status: 'pass',
				evidence: control.evidenceRequirements.flatMap(requirement => Array.from(
					{ length: requirement.minimum },
					(_, index) => ({ type: requirement.type, summary: `Deterministic result ${index + 1} for ${controlId}.` })
				))
			} : {
				control_id: controlId,
				status: 'blocked',
				rationale: 'The technical sample completed, but the required reviewed documentary evidence was not supplied.'
			};
			const result = await record.run(input);
			assert.equal(result.success, true, `${controlId}: ${result.error}`);
			yield { type: 'tool_result', toolName: 'record_sqa_control', toolCallId: `record-${callIndex++}`, input, result };
		}
		// This deterministic fixture uses the legacy runtime without the qualified
		// synthesis handoff. Reviewer prerequisites were still host-closed by the
		// final record call, so it can finish directly without a blocker tool call.
		fixture.session.todos = fixture.session.todos.map(todo => ({ ...todo, status: 'completed' }));
		yield {
			type: 'tool_result', toolName: 'update_todo', toolCallId: 'complete-plan',
			result: { success: true, todos: fixture.session.todos }
		};
		const final = await finish.run({});
		assert.equal(final.success, true, final.error);
		yield { type: 'tool_result', toolName: 'finish_sqa_assessment', toolCallId: 'finish', result: final };
	};
	await runTurn(fixture.session, { task: 'Complete deterministic SQA assessment' }, fixture.store);
	assert.equal(fixture.session.status, 'done', JSON.stringify({ messages: fixture.session.messages, activities: fixture.session.activities.slice(-4) }));
	assert.ok(fixture.session.sqa.finalizedAt);
	assert.equal(fixture.session.sqa.observations.length, fixture.session.sqa.scope.applicableControlIds.length);
	assert.equal(fixture.session.sqa.assessment.summary.not_assessed, 0);
	assert.equal(fixture.session.sqa.assessment.technicalSummary.verdict, 'pass');
	assert.equal(fixture.session.sqa.assessment.verdict, 'blocked');
	assert.equal(fixture.session.todos.every(todo => todo.status === 'completed'), true);
	assert.equal(fixture.session.activities.some(activity => activity.toolName === 'record_sqa_blockers'), false);
	assert.ok(commits.some(item => item.payload?.reviewerCloseout === true));
	assert.ok(commits.some(item => item.type === 'sqa' && item.payload?.final === true));
});

test('concurrent Founder run rejection cannot clear the active model session or narrow its tools', async () => {
	const fixture = founderSynthesisFixture();
	fixture.record.running = true;
	const toolsBefore = fixture.headless.getTools();
	await assert.rejects(runTurn(fixture.session, { task: 'Duplicate' }, fixture.store), /already running/);
	assert.equal(fixture.clearCount(), 0);
	assert.equal(fixture.headless.getTools(), toolsBefore);
	assert.equal(fixture.record.founderSynthesis, undefined);
});

test('Founder evidence handoff starts one synthesis turn with durable evidence preserved', async () => {
	const fixture = founderSynthesisFixture();
	fixture.session.todos.at(-1).status = 'pending';
	const observations = structuredClone(fixture.session.founder.observations);
	let calls = 0;
	let readPastHandoff = false;
	fixture.record.runtime.run = async function* () {
		calls++;
		if (calls === 1) {
			yield { type: 'tool_result', toolName: 'update_todo', toolCallId: 'complete-plan', result: { success: true, todos: fixture.session.todos.map(todo => ({ ...todo, status: 'completed' })) } };
			readPastHandoff = true;
		} else {
			assert.equal(fixture.record.founderSynthesis, true);
			fixture.session.founder.finalizedAt = new Date().toISOString();
			yield { type: 'tool_result', toolName: 'finish_founder_review', toolCallId: 'finish', result: { success: true, published: true } };
		}
	};
	await runTurn(fixture.session, { task: 'Complete Founder review', incompleteAttempt: Number.MAX_SAFE_INTEGER }, fixture.store);
	assert.equal(calls, 2);
	assert.equal(readPastHandoff, false);
	assert.equal(fixture.clearCount(), 1);
	assert.equal(fixture.session.status, 'done');
	assert.deepEqual(fixture.session.founder.observations, observations);
});

/* ── Pipeline Phase 4 (#15496): closeOtherBrowsers LRU eviction ── */

test('Phase 4: evicts oldest-idle same-owner browsers first; running + foreign-owner untouched', async () => {
	const { closeOtherBrowsers } = await import('./agent.js');
	// Capacity is max(2, clamp) — force a small, deterministic budget.
	process.env.QASE_MATRIX_PARALLEL = '1';
	// closeBrowser suspends the entry's bridge — record victims there
	// (the ESM namespace is frozen; patching exports is impossible).
	const victims = [];
	const makeEntry = (id, owner, running, lastUsedAt) => ({
		id,
		record: { running, lastUsedAt, bridge: { hasPage: () => true, suspend: async () => { victims.push(id); } }, idleTimer: null },
		owner
	});
	const keep = { id: 'keep', ownerUserId: 'owner-1' };
	const entries = [
		makeEntry('keep', 'owner-1', true, 999),
		makeEntry('running-sibling', 'owner-1', true, 998),
		makeEntry('idle-new', 'owner-1', false, 500),
		makeEntry('idle-old', 'owner-1', false, 100),
		makeEntry('idle-mid', 'owner-1', false, 300),
		makeEntry('foreign-idle', 'owner-2', false, 50),
		makeEntry('foreign-running', 'owner-2', true, 900)
	];
	const runStore = {
		listLive: () => entries,
		liveFor: (id) => entries.find((entry) => entry.id === id)?.record,
		get: async (id) => ({ id, ownerUserId: entries.find((entry) => entry.id === id)?.owner })
	};
	try {
		await closeOtherBrowsers(keep, runStore);
		// Budget: max(2, clamp)=2 on this container (cores 3 → clamp 1).
		// Same-owner: keep(1) + running-sibling(1) + 3 idle = 5 > 2 → evict 3 oldest.
		assert.ok(!victims.includes('running-sibling'), 'running sibling never evicted');
		assert.ok(!victims.includes('foreign-idle') && !victims.includes('foreign-running'), 'foreign-owner sessions never touched');
		assert.ok(!victims.includes('keep'), 'the keep session is never evicted');
		assert.ok(victims.length >= 3, `expected all same-owner idle browsers evicted when budget=2 (got ${victims.join(',')})`);
		// Oldest first.
		const order = victims.indexOf('idle-old');
		const mid = victims.indexOf('idle-mid');
		const newest = victims.indexOf('idle-new');
		assert.ok(order !== -1 && mid !== -1 && newest !== -1, 'all idle same-owner entries eligible');
		assert.ok(order < mid && mid < newest, `LRU order violated: ${victims.join(',')}`);
	} finally {
		delete process.env.QASE_MATRIX_PARALLEL;
	}
});

test('Phase 4: within budget nothing is evicted', async () => {
	const { closeOtherBrowsers } = await import('./agent.js');
	process.env.QASE_MATRIX_PARALLEL = '1';
	const victims = [];
	const makeEntry = (id, owner, running, lastUsedAt) => ({
		id,
		record: { running, lastUsedAt, bridge: { hasPage: () => true, suspend: async () => { victims.push(id); } }, idleTimer: null },
		owner
	});
	const keep = { id: 'keep', ownerUserId: 'owner-1' };
	const runStore = {
		listLive: () => [
			makeEntry('keep', 'owner-1', true, 999),
			makeEntry('one-idle', 'owner-1', false, 100)
		],
		liveFor: (id) => (id === 'one-idle' ? makeEntry('one-idle', 'owner-1', false, 100).record : undefined),
		get: async (id) => ({ id, ownerUserId: 'owner-1' })
	};
	try {
		await closeOtherBrowsers(keep, runStore);
		assert.deepEqual(victims, [], 'keep + 1 idle fits the floor-2 budget — no eviction');
	} finally {
		delete process.env.QASE_MATRIX_PARALLEL;
	}
});

// ── #16225 follow-up: runaway empty-completion loop abort ────────────────

test('consecutive empty provider completions abort the run as error, not interrupted', async () => {
	const { session, record, store } = runtimeFixture();
	const statuses = [];
	store.setStatus = async (s, status, detail) => { s.status = status; statuses.push(status); };
	record.runtime.cleanSlateService = {
		logProviderReportedUsage() { /* SDK original */ }
	};
	record.turnUsage = { reports: [], estimates: [] };
	// Mirror ensureRuntime: the wrapped provider-report hook feeds the run's
	// harvest, and runTurn wires record.onUsageHarvested as the observation
	// funnel — in production the SDK runtime invokes the wrapper, whose
	// harvestUsage calls record.onUsageHarvested. Simulate the same chain.
	const release = attachUsageCapture(record.runtime.cleanSlateService, {
		onUsage: usage => record.onUsageHarvested?.(usage)
	});
	record.runtime.logger = createUsageLogger({ onEstimate: () => undefined });
	const EMPTY_LIMIT = Number(process.env.QASE_EMPTY_COMPLETION_LIMIT ?? 5) || 5;
	let observed = 0;
	record.runtime.run = async function* () {
		for (let i = 0; i < EMPTY_LIMIT + 3; i++) {
			record.runtime.cleanSlateService.logProviderReportedUsage({}, { inputTokens: 27000, outputTokens: 0 });
			await new Promise(resolve => setImmediate(resolve));
			if (record.controller?.signal.aborted) return; // loop stopped us
			yield { type: 'context_usage', turnId: `t${i}` };
			observed = i + 1;
		}
	};
	await runTurn(session, { task: 'Run QA' }, store);
	assert.ok(observed < EMPTY_LIMIT, `the generator stopped before the finalizer (observed turn index ${observed}, limit ${EMPTY_LIMIT})`);
	assert.equal(session.status, 'error', 'loop abort ends as error');
	const errorMessages = (session.messages ?? []).filter(m => m.kind === 'error' && /empty responses/.test(m.text ?? ''));
	assert.ok(errorMessages.length >= 1, 'a user-visible error message explains the empty-completion stop');
	assert.equal(statuses.includes('interrupted'), false, 'loop abort is NOT a user stop');
	release();
});

test('a user stop still ends interrupted when completions are healthy', async () => {
	const { session, record, store } = runtimeFixture();
	const statuses = [];
	store.setStatus = async (s, status) => { s.status = status; statuses.push(status); };
	record.runtime.cleanSlateService = {
		logProviderReportedUsage() { /* SDK original */ }
	};
	record.turnUsage = { reports: [], estimates: [] };
	const release = attachUsageCapture(record.runtime.cleanSlateService, {
		onUsage: usage => record.turnUsage.reports.push(usage)
	});
	record.runtime.run = async function* () {
		record.runtime.cleanSlateService.logProviderReportedUsage({}, { inputTokens: 100, outputTokens: 80 });
		await new Promise(resolve => setImmediate(resolve));
		record.controller?.abort(); // user pressed Stop
	};
	await runTurn(session, { task: 'Run QA' }, store);
	assert.equal(session.status, 'interrupted', 'user stop keeps the historical outcome');
	release();
});

test('hybrid prose-only turns continue the same SDK session rather than marking unfinished work interrupted', async () => {
  const { session, record, store } = runtimeFixture({ qaExecutionMode: 'hybrid', hybrid: { scenarios: [] } });
  const checkpoints = []; let calls = 0;
  record.hybrid = { segmentProgress() { return "fixture"; }, async continueSegment() { return { continue: true }; }, async beginTurn() {}, async endTurn(status) { checkpoints.push(status); }, context() { return ''; } };
  record.runtime.getSessionSnapshot = () => ({});
  record.runtime.run = async function* () {
    calls++;
    if (calls === 1) { yield { type: 'chat_text', content: 'The next scoped test is ready.' }; return; }
    session.report = { ts: 42, verdict: 'partial', summary: 'Fixture finished with explicit gaps.' };
    yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
  };
  await runTurn(session, { task: 'Finish the scoped tests.' }, store);
  assert.equal(calls, 2); assert.equal(session.status, 'done');
  assert.deepEqual(checkpoints, ['running', 'done']);
});

for (const throws of [false, true]) test(`a hybrid budget abort that ${throws ? 'throws' : 'ends normally'} checkpoints a native approval question`, async () => {
  const { hybridProfile } = await import('./hybridConfig.js');
  const { session, record, store } = runtimeFixture({ qaExecutionMode: 'hybrid', ownerUserId: 'owner', hybrid: {
    continuationPolicyVersion: 1, budgets: hybridProfile({ apiKey: 'fixture-key' }, {}).budgets,
    telemetry: { reasoner: {}, classifier: {} }, scenarios: [], modelBudget: { roles: {} }
  } });
  const checkpoints = [];
  record.hybrid = { segmentProgress() { return "fixture"; }, async continueSegment() { return { continue: true }; }, async beginTurn() {}, async endTurn(status) { checkpoints.push(status); }, context() { return ''; } };
  record.runtime.getSessionSnapshot = () => ({});
  record.runtime.agentSession = { pauseForQuestion() {} };
  record.runtime.run = async function* () {
    record.hybridPause = Object.assign(new Error('Fixture time budget reached'), { code: 'HYBRID_TIME_BUDGET' });
    record.controller.abort(record.hybridPause);
    if (throws) throw record.hybridPause;
  };
  await runTurn(session, { task: 'Run the scoped tests.' }, store);
  assert.equal(session.status, 'awaiting_input'); assert.equal(session.pendingQuestion.hybridDecision, 'budget');
  assert.equal(session.pendingQuestion.credentialLike, false);
  assert.equal(checkpoints.at(-1), 'awaiting_input'); assert.equal(session.hybrid.budgets.reasonerTokens, 300000);
});

for (const stopped of [false, true]) test(`automatic hard-limit closeout ${stopped ? 'honors a simultaneous user stop' : 'finishes without an approval question'}`, async () => {
  const { session, record, store } = runtimeFixture({ qaExecutionMode: 'hybrid', ownerUserId: 'owner', hybrid: {
    continuationPolicyVersion: 2, executionPolicy: { mode: 'autonomous', limits: {} }, scenarios: [], modelBudget: { roles: {} }
  } });
  let calls = 0;
  record.hybrid = { segmentProgress() { return "fixture"; }, async continueSegment() { return { continue: true }; }, async beginTurn() {}, async endTurn() {}, context() { return ''; } };
  record.runtime.getSessionSnapshot = () => ({});
  record.runtime.run = async function* () {
    calls++;
    if (calls === 1) {
      record.hybridPause = Object.assign(new Error('Fixture configured limit'), { code: 'HYBRID_MODEL_BUDGET' });
      record.controller.abort(record.hybridPause);
      if (stopped) record.userStopRequested = true;
      throw record.hybridPause;
    }
    session.report = { ts: 88, verdict: 'blocked', summary: 'Configured limit reached; no passing coverage claimed.' };
    yield { type: 'tool_result', toolName: 'finish_qa_report', result: { success: true, published: true } };
  };
  await runTurn(session, { task: 'Run the authorized tests.' }, store);
  assert.equal(session.status, stopped ? 'interrupted' : 'done'); assert.equal(calls, stopped ? 1 : 2);
  assert.equal(session.pendingQuestion, undefined);
});

for (const mode of ['qa', 'sqa', 'founder']) test(`${mode} continuation retains device ownership and releases it exactly once`, async () => {
  const f = runtimeFixture({ mode }); let segments = 0, selections = 0; const releases = [];
  const devices = { async selectForRun() { selections++; return { executionLevel: 'SIMULATED', provider: 'fixture', deviceSession: { sessionId: 'device-fixture' } }; }, async completeSession(id) { releases.push(id); } };
  f.record.runtime.run = async function* () {
    if (++segments === 1) { yield { type: 'chat_text', content: 'Continue remaining work.' }; return; }
    if (mode === 'qa') f.session.report = { ts: 1, verdict: 'fail' };
    else f.session[mode] = { finalizedAt: '2026-11-03T00:00:00Z' };
    yield { type: 'tool_result', toolName: mode === 'qa' ? 'finish_qa_report' : mode === 'sqa' ? 'finish_sqa_assessment' : 'finish_founder_review', result: { success: true, published: true } };
  };
  await runTurn(f.session, { task: 'Complete fixture' }, f.store, devices);
  assert.equal(f.session.status, 'done'); assert.equal(segments, 2);
  assert.equal(selections, 1, 'Continuation must retain the already owned device rather than acquire another.');
  assert.deepEqual(releases, ['device-fixture']); assert.equal(f.record.deviceSessionId, null);
});

test('initial persistence failure releases the running lock and controller', async () => {
  const f = runtimeFixture(); f.store.setStatus = async () => { throw new Error('Fixture storage unavailable'); };
  await assert.rejects(runTurn(f.session, { task: 'Start fixture' }, f.store), /storage unavailable/);
  assert.equal(f.record.running, false); assert.equal(f.record.controller, undefined);
});

test('automatic continuation cannot reset the transient model retry allowance', async () => {
  const f = runtimeFixture({ mode: 'sqa' }); let segments = 0;
  f.record.runtime.run = async function* () {
    segments++;
    if (segments % 2) throw new Error('Connection error: socket hang up');
    yield { type: 'chat_text', content: 'Still working on the scoped controls.' };
  };
  await runTurn(f.session, { task: 'Assess fixture' }, f.store);
  assert.ok(segments <= 5, `Retry/continuation alternation must not replenish retry budget (${segments} segments).`);
  assert.equal(f.session.status, 'error');
});

test('device selection is single-owner and cancellation before selection returns cannot dispatch the SDK', async () => {
  const f = runtimeFixture(); let release, entered; const began=new Promise(resolve=>{entered=resolve;});
  let selections=0, calls=0, releases=0;
  const devices={async selectForRun(){selections++;entered();await new Promise(resolve=>{release=resolve;});return {deviceSession:{sessionId:'fixture'}};},async completeSession(){releases++;}};
  f.record.runtime.run=async function*(){calls++;};
  const first=runTurn(f.session,{task:'Start fixture'},f.store,devices);await began;
  await assert.rejects(runTurn(f.session,{task:'Duplicate'},f.store,devices),/already running/);
  f.record.userStopRequested=true;f.record.controller.abort();release();await first;
  assert.equal(selections,1);assert.equal(calls,0);assert.equal(releases,1);
  assert.equal(f.session.status,'interrupted');assert.equal(f.record.running,false);
});

test('checkpoint cleanup failure releases the runtime lock and device lease', async()=>{
  const f=runtimeFixture();let released=0;
  f.record.hybrid={segmentProgress(){return 'fixture';},async beginTurn(){},async continueSegment(){return {continue:true};},async endTurn(){throw new Error('Injected checkpoint failure');}};
  const devices={async selectForRun(){return {deviceSession:{sessionId:'fixture'}};},async completeSession(){released++;}};
  await assert.rejects(runTurn(f.session,{task:'Fixture'},f.store,devices),/checkpoint failure/);
  assert.equal(f.record.running,false);assert.equal(f.record.controller,undefined);assert.equal(released,1);
});
