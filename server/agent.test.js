import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { allowedToolNames, ensureRuntime, isFounderSynthesisReady, prepareFounderSynthesis, runTurn, summariseResult } from './agent.js';
import { createBrowserTools } from './browserTools.js';
import { createFounderReviewTodos, FOUNDER_CATEGORY_IDS } from './founderService.js';

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

test('each mode exposes only its own finalizer and browser capabilities', () => {
	for (const [mode, finalizer] of [['qa', 'finish_qa_report'], ['sqa', 'finish_sqa_assessment'], ['founder', 'finish_founder_review']]) {
		const names = allowedToolNames(mode);
		assert.equal(names.has('browser_media'), true);
		assert.equal(names.has('browser_test_meeting_link'), true);
		assert.equal(names.has('run_command'), false);
		assert.deepEqual([...names].filter(name => name.startsWith('finish_')), [finalizer]);
		assert.equal(names.has('report_finding'), mode !== 'founder');
	}
});

test('the real SDK registry and advertised descriptions enforce each mode boundary', async () => {
	const saved = process.env.QASE_API_KEY;
	process.env.QASE_API_KEY ||= 'qualification-placeholder';
	try {
		for (const mode of ['qa','sqa','founder']) {
			const live = {};
			const session = {id:randomUUID(),mode,secretNames:[],activities:[],findings:[],todos:[],messages:[]};
			const record = ensureRuntime(session, {liveFor:()=>live,publish(){},commit:async()=>{}});
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

test('new browser capabilities validate model arguments before invoking the bridge', async () => {
	const calls = [];
	const [media, meeting] = createBrowserTools(() => ({
		media: async input => { calls.push(input); return { success: true, synthetic: true }; },
		testMeetingLink: async input => { calls.push(input); return { success: true }; }
	}));
	for (const input of [null, {}, { action: 'record' }, { action: 'set_permission' }, { action: 'probe', durationMs: Infinity }]) {
		assert.equal((await media.run(input)).success, false);
	}
	assert.equal((await meeting.run({})).success, false);
	assert.equal((await meeting.run({ url: 10 })).success, false);
	assert.equal(calls.length, 0);
	assert.equal((await media.run({ action: 'set_permission', permission: 'denied' })).success, true);
	assert.equal((await meeting.run({ selector: '#meeting' })).success, true);
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
	assert.equal(fixture.session.status, 'idle');
	assert.equal(fixture.statuses.at(-1).detail, 'Stopped by user.');
	assert.equal(fixture.record.running, false);
	assert.equal(fixture.record.controller, undefined);
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
	assert.equal(fixture.session.status, 'idle');
	assert.equal(fixture.record.running, false);
	assert.equal(fixture.record.controller, undefined);
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
	assert.equal(fixture.session.status, 'idle');
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
