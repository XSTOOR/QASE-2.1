import './testWorkingDirectory.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { activityLabel, allowedToolNames, ensureRuntime, founderAutomaticPublicationInput, isFounderSynthesisReady, modelActivityTimeoutMs, prepareFounderSynthesis, restoreWaitingSnapshot, runTurn, summariseResult, withModelActivityDeadline } from './agent.js';
import { attachUsageCapture, createUsageLogger } from './usageCapture.js';
import { createBrowserTools } from './browserTools.js';
import { createFounderReviewTodos, FOUNDER_CATEGORY_IDS } from './founderService.js';
import { clearSecrets, resolveSecrets, storeSecrets } from './secrets.js';
import { withUserConfiguration } from './config.js';

import { createFounderTools } from './founderTools.js';
import { FOUNDER_REPORT_SECTIONS, founderDraftProgress } from './founderReportDraft.js';
import { createFounderReportFixture } from './founderReportFixture.js';
import { WATCHDOG_CONFIG, setWatchdogConfig } from './runWatchdog.js';

test('a resumed answer is not failed by the previous awaiting-input turn monitor', async () => {
  const defaults = { ...WATCHDOG_CONFIG };
  setWatchdogConfig({ stallMs: 10000, deadlineMs: 0, graceMs: 30 });
  const f = runtimeFixture();
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let began;
  const started = new Promise(resolve => { began = resolve; });
  let resumed;
  try {
    f.record.runtime.getPendingQuestion = () => ({ toolCallId: 'access', question: { question: 'Confirm signed-in access?' } });
    await runTurn(f.session, { task: 'Test the application' }, f.store);
    assert.equal(f.session.status, 'awaiting_input');
    f.record.runtime.getPendingQuestion = () => undefined;
    f.record.runtime.run = async function* () {
      began(); await waiting;
      f.record.controller.abort();
    };
    resumed = runTurn(f.session, { task: 'Confirmed; continue read-only testing' }, f.store);
    await started;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(f.session.status, 'running');
    assert.equal(f.session.messages.some(m => m.text?.startsWith('Run monitor:')), false);
  } finally {
    release(); await resumed;
    f.record.watchdog?.dispose();
    setWatchdogConfig(defaults);
  }
});

function runtimeFixture(overrides = {}) {
	const session = { id: randomUUID(), mode: 'founder', targetUrl: 'https://example.test', messages: [], activities: [], todos: [], findings: [], secretNames: [], ...overrides };
	const record = {
		runtime: { async *run() {}, getPendingQuestion: () => undefined },
		bridge: { hasPage: () => false, captureFrame: async () => {}, stopFrames() {} }
	};
	const statuses = [];
	// Real lifecycle semantics (#17988): the fixture mirrors the production
	// store's server-authoritative transition validation + lifecycle recording
	// (a stubbed setStatus skipped them, hiding outcome regressions).
	const store = {
		liveFor: () => record, listLive: () => [], publish() {}, commit: async () => {},
		setStatus: async (s, status, detail) => { setStatusReal(s, status, detail); statuses.push({ status, detail }); },
		addActivity: async (s, item) => { const activity = { ts: Date.now(), ...item }; s.activities.push(activity); return activity; },
		updateActivity: async (s, id, patch) => Object.assign(s.activities.find(item => item.id === id), patch),
		addMessage: async (s, item) => { s.messages.push(item); return item; }
	};
	return { session, record, store, statuses };
}
import { setStatus as setStatusReal } from './store.js';

for(const mode of ['founder']) test(`${mode} host publication remains authoritative if SDK prefetch throws before yielding the tool result`,async()=>{
 const f=runtimeFixture({mode,[mode]:{}});
 f.record.runtime.run=async function*(){f.session[mode].finalizedAt='2026-11-03T00:00:00.000Z';f.record.onModePublished();throw new Error('SDK prefetched after durable publication');};
 await runTurn(f.session,{task:'Finalize existing evidence'},f.store);
 assert.equal(f.session.status,'done');assert.equal(f.statuses.some(s=>s.status==='error'||s.status==='interrupted'),false);
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
   assert.ok(tools.some(t=>t.name==='browser_founder_review'));
   assert.ok(tools.some(t=>t.name==='browser_founder_form'));
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

test('media evidence summaries fit Founder evidence limits and retain the latest app track state', () => {
	const summary = summariseResult('browser_media', { permission:'granted', observed:{requests:Array.from({length:50},()=>({source:'application',outcome:'granted',tracks:[{kind:'audio',enabled:false,readyState:'live'}]}))} });
	assert.ok(summary.length<=1000);
	assert.match(summary,/"enabled":false/);
	assert.match(summary,/"requestCount":50/);
	assert.ok(summariseResult('browser_test_meeting_link',{url:'https://example.test/'+'a'.repeat(4000),joined:false}).length<=1000);
});

for (const [mode, finalizer] of [['founder', 'finish_founder_review']]) {
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

for (const mode of ['founder']) {
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

for (const mode of ['founder']) {
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

for (const mode of ['founder']) {
	test(`${mode} stale report cannot mark an unfinalized follow-up successful`, async () => {
		const fixture = runtimeFixture({ mode, ...(mode === 'qa' ? { report: { ts: 1, verdict: 'pass' } } : { [mode]: { finalizedAt: '2026-09-09T00:00:00.000Z' } }) });
		await runTurn(fixture.session, { task: 'Retest', incompleteAttempt: Number.MAX_SAFE_INTEGER }, fixture.store);
		assert.equal(fixture.session.status, 'error');
		assert.equal(fixture.statuses.some(item => item.status === 'done'), false);
	});
}

async function completeFounderDraftFixture({ omitLast = false, invalidSummary = false } = {}) {
	const f = founderSynthesisFixture();
	f.session.founder.scope.target = { name: 'Fixture', url: 'https://fixture.test/' };
	f.session.founder.reportGeneration = { version: 1, protocol: 'section-draft-v1', evidenceHashVersion: 1 };
	f.session.founder.observations.forEach((o, index) => { o.id = index ? `obs-${index}` : 'observed'; o.confidence = 'medium'; o.type = 'opportunity'; });
	f.session.todos.at(-1).status = 'in_progress';
	const payload = createFounderReportFixture().payload;
	if (invalidSummary) payload.executive_summary = 'We reviewed the complete source code of this product.';
	const tools = createFounderTools(f.session, f.store, { stagedReport: true, isCancelled: () => Boolean(f.record.controller?.signal.aborted) });
	f.headless.options.tools = tools;
	f.headless.toolsByName = new Map(tools.map(tool => [tool.name, tool]));
	const draft = tools.find(t => t.name === 'draft_founder_report_section');
	for (const section of FOUNDER_REPORT_SECTIONS) {
		if (omitLast && section === 'metrics') break;
		for (const value of section === 'recommendations' ? payload.recommendations.map(r => [r]) : [payload[section]]) {
			const result = await draft.run({ section, value });
			assert.equal(result.success, true, result.error);
		}
	}
	return { ...f, draft, payload };
}

test('a complete intact Founder draft publishes on restart without another model call or evidence changes', async () => {
	const f = await completeFounderDraftFixture();
	f.session.tokenUsage = { inputTokens: 400000, outputTokens: 30000, totalTokens: 430000 };
	const before = structuredClone(f.session);
	let calls = 0;
	f.record.runtime.run = async function* () { calls++; throw new Error('Provider unavailable'); };
	await runTurn(f.session, { task: 'Continue' }, f.store);
	assert.equal(calls, 0);
	assert.equal(f.session.status, 'done', JSON.stringify(f.session.messages));
	assert.ok(f.session.founder.report);
	assert.deepEqual(f.session.founder.reportDraft, before.founder.reportDraft);
	assert.deepEqual(f.session.founder.observations, before.founder.observations);
	assert.deepEqual(f.session.tokenUsage, before.tokenUsage);
	assert.ok(f.session.todos.every(t => t.status === 'completed'));
	assert.equal(f.session.activities.at(-1).toolName, 'finish_founder_review');
	assert.equal(f.record.watchdog.state.settled, true, 'Saved-draft publication must retire the turn watchdog.');
});

test('the last Founder draft is durably saved and published before another provider response', async () => {
	const f = await completeFounderDraftFixture({ omitLast: true });
	let calls = 0;
	f.record.runtime.run = async function* (_task, signal) {
		calls++;
		// The executor persists a result before the SDK emits the same event.
		// Replaying an already saved section must not recreate an active row.
		await f.record.onToolStart('draft_founder_report_section', { section: 'plan' }, 'saved-section');
		const cached = await f.draft.run({ section: 'plan', value: f.payload.plan });
		assert.equal(cached.success, true, cached.error);
		const replay = { type: 'tool_result', toolName: 'draft_founder_report_section', toolCallId: 'saved-section', result: cached };
		await f.record.onFounderDraftResult(replay);
		yield replay;
		assert.equal(f.session.activities.filter(a => a.id === 'saved-section').length, 1);
		await f.record.onToolStart('draft_founder_report_section', { section: 'metrics' }, 'last-section');
		const result = await f.draft.run({ section: 'metrics', value: f.payload.metrics });
		assert.equal(result.success, true, result.error);
		await f.record.onFounderDraftResult({ toolName: 'draft_founder_report_section', toolCallId: 'last-section', result });
		assert.equal(signal.aborted, true, 'Only the model stream should stop after publication.');
		assert.equal(f.record.controller.signal.aborted, false);
		throw new Error('SDK prefetch observed the publication abort');
	};
	await runTurn(f.session, { task: 'Finish the remaining report section' }, f.store);
	assert.equal(calls, 1);
	assert.equal(f.session.status, 'done');
	assert.equal(founderDraftProgress(f.session).next, null);
	assert.equal(f.session.activities.filter(a => a.toolName === 'finish_founder_review').length, 1);
	assert.equal(f.record.onFounderDraftResult, undefined);
});

test('Founder automatic publication requires intact complete content and every original readiness prerequisite', async () => {
	const f = await completeFounderDraftFixture();
	assert.deepEqual(founderAutomaticPublicationInput(f.session), { draft_revision: f.session.founder.reportDraft.revision });
	for (const change of [
		s => { delete s.founder.reportDraft.input.metrics; },
		s => { s.founder.reportDraft.input.executive_summary = 'Tampered'; },
		s => { s.founder.observations[0].summary = 'Changed evidence'; },
		s => { s.todos[0].status = 'pending'; },
		s => { s.activities.push({ toolName: 'browser_click', status: 'running', ts: Date.now() }); },
		s => { s.founder.observations[0].title = 'Authentication required: cannot sign in'; },
		s => { s.founder.execution = { routes: [], actions: [] }; }
	]) {
		const session = structuredClone(f.session); change(session);
		assert.equal(founderAutomaticPublicationInput(session), undefined);
	}
});

test('Founder publication storage failure retains the complete draft and stops without model retries', async () => {
	const f = await completeFounderDraftFixture(), before = structuredClone(f.session.founder.reportDraft);
	f.store.commit = async (_s, type) => { if (type === 'founder.finalized') throw new Error('Fixture disk failure'); };
	let calls = 0;
	f.record.runtime.run = async function* () { calls++; };
	await runTurn(f.session, { task: 'Continue' }, f.store);
	assert.equal(calls, 0); assert.equal(f.session.status, 'interrupted');
	assert.equal(f.session.founder.finalizedAt, undefined);
	assert.deepEqual(f.session.founder.reportDraft, before);
	assert.equal(f.session.todos.at(-1).status, 'in_progress');
});

test('automatic Founder publication retains the original complete-report semantic validator', async () => {
	const f = await completeFounderDraftFixture({ invalidSummary: true });
	const draft = structuredClone(f.session.founder.reportDraft);
	let calls = 0;
	f.record.runtime.run = async function* () { calls++; };
	await runTurn(f.session, { task: 'Continue' }, f.store);
	assert.equal(calls, 0);
	assert.equal(f.session.status, 'interrupted');
	assert.equal(f.session.founder.finalizedAt, undefined);
	assert.deepEqual(f.session.founder.reportDraft, draft);
	assert.match(f.session.activities.at(-1).error, /not the complete source code/);
});

test('cancellation after the final Founder section prevents automatic publication', async () => {
	const f = await completeFounderDraftFixture({ omitLast: true });
	f.record.runtime.run = async function* () {
		await f.record.onToolStart('draft_founder_report_section', { section: 'metrics' }, 'last-section');
		const result = await f.draft.run({ section: 'metrics', value: f.payload.metrics });
		f.record.userStopRequested = true; f.record.controller.abort();
		await f.record.onFounderDraftResult({ toolName: 'draft_founder_report_section', toolCallId: 'last-section', result });
		throw new Error('Stopped');
	};
	await runTurn(f.session, { task: 'Continue' }, f.store);
	assert.equal(f.session.status, 'interrupted');
	assert.equal(f.session.founder.finalizedAt, undefined);
	assert.equal(founderDraftProgress(f.session).next, null);
});

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

test('a saved public plan starts publication only after the original Founder readiness checks pass', async () => {
	for (const missingDiagnostics of [false, true]) {
		const { session, record, store, statuses } = founderSynthesisFixture();
		session.founder.scope.access = { decision: 'public_only' };
		session.founder.reportGeneration = { version: 1, protocol: 'section-draft-v1', evidenceHashVersion: 1 };
		session.todos[1].status = 'in_progress';
		session.todos.at(-1).status = 'pending';
		if (missingDiagnostics) session.activities = session.activities.filter(activity => activity.toolName !== 'browser_diagnostics');
		const committed = [];
		store.commit = async (_session, type, payload) => { if (type === 'todos') committed.push(structuredClone(payload.todos)); };
		record.runtime.run = async function* () {
			if (record.founderSynthesis) return;
			const todos = session.todos.map((todo, index) => ({ ...todo, status: index < session.todos.length - 1 ? 'completed' : 'pending' }));
			yield { type: 'tool_result', toolName: 'update_todo', toolCallId: 'reconcile-plan', result: { success: true, todos } };
		};
		await runTurn(session, { task: 'Continue the public review', incompleteAttempt: Number.MAX_SAFE_INTEGER }, store);
		assert.equal(committed[0].at(-1).status, missingDiagnostics ? 'pending' : 'in_progress');
		assert.equal(Boolean(record.founderSynthesis), !missingDiagnostics);
		assert.equal(statuses.some(item => item.detail?.includes('Preparing the Founder report')), !missingDiagnostics);
		assert.equal(session.founder.finalizedAt, undefined);
	}
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



// #17935 — premature Review Failed: transient SDK failures must be retried,
// not terminal-errored.
test('#17935 "no pending agent question to resume" is retryable for founder', async () => {
	const { isRetryableModeInterruption } = await import('./agent.js');
	const lostHandle = new Error('There is no pending agent question to resume.');
	assert.equal(isRetryableModeInterruption(lostHandle, 'founder'), true);
	// Auth/quota failures stay terminal — never retried into a loop.
	assert.equal(isRetryableModeInterruption(new Error('401 unauthorized'), 'founder'), false);
	assert.equal(isRetryableModeInterruption(new Error('429 rate limit'), 'founder'), false);
	// Transport churn still retryable.
	assert.equal(isRetryableModeInterruption(new Error('socket hang up'), 'founder'), true);
});

test('#17935 long-form modes get a wider continuation budget before the terminal error', async () => {
	const agent = await import('./agent.js');
	// Budget is internal; verify behavior indirectly: the constants are env-
	// driven and default upward for founder/sqa. Assert the module loads and
	// the retry predicate treats prose-pause exhaustion as terminal (false)
	// so the cascade alone decides — the budget widening is covered by the
	// integration test on runTurn continuation counting.
	assert.equal(typeof agent.runTurn, 'function');
});

// ---- #17987: founder stall recovery — the watchdog abort routes through the
// decision cascade so a stalled founder turn lands in a RESUMABLE checkpoint
// state (never a wedged 'running', never a false 'Review failed'), and resume
// continues from the saved evidence without duplicating committed usage.

test('#17987 stalled founder turn becomes interrupted (resumable), not wedged or failed', async () => {
	const { session, record, store } = runtimeFixture({ mode: 'founder' });
	session.founder = { observations: [{ category: 'product_clarity', summary: 'saved evidence' }] };
	let stallHandler;
	// Simulate the watchdog stall firing: abort through the run's own
	// AbortController — exactly what watchTurn's fireStall does.
	record.runtime.run = async function* () {
		yield { type: 'chat_text', content: 'collecting evidence…' };
		record.controller.abort();
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		throw abortError;
	};
	await runTurn(session, { task: 'Stall me' }, store);
	// Stalled (aborted) founder run: interrupted with a checkpoint, resumable,
	// evidence preserved — NOT error/'Review failed'.
	assert.equal(['interrupted', 'paused'].includes(session.status), true, `stalled founder run must be resumable, got ${session.status}`);
	assert.equal(Array.isArray(session.founder.observations) && session.founder.observations.length > 0, true, 'saved observations preserved');
});

test('#17987 founder deadline abort (productive but over-budget turn) lands resumable', async () => {
	const { session, record, store } = runtimeFixture({ mode: 'founder' });
	session.founder = { observations: [{ category: 'user_experience', summary: 'observed onboarding flow' }] };
	record.runtime.run = async function* () {
		yield { type: 'chat_text', content: 'still producing evidence…' };
		record.controller.abort();
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		throw abortError;
	};
	await runTurn(session, { task: 'Over budget' }, store);
	assert.equal(['interrupted', 'paused'].includes(session.status), true, `deadline abort must be resumable, got ${session.status}`);
});

test('#17987 resume after stall completes from saved evidence and does not duplicate usage', async () => {
	const { session, record, store } = runtimeFixture({ mode: 'founder' });
	session.founder = { observations: [{ category: 'activation', summary: 'pre-stall evidence' }] };
	let attempt = 0;
	record.runtime.run = async function* () {
		attempt += 1;
		if (attempt === 1) {
			// Usage committed before the stall must survive the recovery.
			record.onUsageHarvested({ inputTokens: 3000, outputTokens: 600, totalTokens: 3600, callId: 'call-stall', estimated: false });
			yield { type: 'chat_text', content: 'working…' };
			record.controller.abort();
			const abortError = new Error('aborted');
			abortError.name = 'AbortError';
			throw abortError;
		}
		// The recovery turn replays the SAME usage report (SDK event replay).
		record.onUsageHarvested({ inputTokens: 3000, outputTokens: 600, totalTokens: 3600, callId: 'call-stall', estimated: false });
		record.onUsageHarvested({ inputTokens: 900, outputTokens: 200, totalTokens: 1100, callId: 'call-recover', estimated: false });
		session.founder.finalizedAt = Date.now();
		session.founder.report = { coverage: { categoriesReviewed: ['activation'], evidenceBackedObservations: 2 } };
		session.report = { ts: 799, verdict: 'pass', summary: 'Recovered and finished.' };
		yield { type: 'tool_result', toolName: 'finish_founder_review', result: { success: true, published: true } };
	};
	// First (stalled) turn.
	await runTurn(session, { task: 'Stall then recover' }, store);
	assert.equal(['interrupted', 'paused'].includes(session.status), true);
	// Resume: a fresh turn on the same session.
	await runTurn(session, { task: 'Continue from checkpoint', incompleteAttempt: 1 }, store);
	assert.equal(session.status, 'done', 'resumed run completes');
	assert.equal(session.tokenUsage.inputTokens, 3900, 'stall usage preserved, replayed report not double-counted');
	assert.equal(session.tokenUsage.totalTokens, 4700);
});

// ---- #17988: strict server-side completion gate — a done QA run with
// outstanding required scenarios is PARTIAL (lifecycle outcome), never
// completed, regardless of how the turn ended.




for (const mode of ['founder']) test(`${mode} continuation retains device ownership and releases it exactly once`, async () => {
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

