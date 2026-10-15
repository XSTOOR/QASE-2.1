import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunResume } from './runResume.js';

function interruptedSession(overrides = {}) {
	return {
		id: 'run-1',
		status: 'interrupted',
		interruptedFromRun: true,
		autoResumeCount: 0,
		mode: 'qa',
		ownerUserId: 'user-a',
		targetUrl: 'https://example.dev/',
		messages: [],
		...overrides
	};
}

function makeHarness({ sessions, snapshots, snapshotFor, restoreThrows, runtimeLacksRestore, listThrows, listInterrupted } = {}) {
	const turns = [];
	const restored = [];
	const log = [];
	const resume = createRunResume({
		logger: { info: (e, f) => log.push([e, f]), warn: (e, f) => log.push([e, f]) },
		attemptDelayMs: 1,
		withRequestActor: actor => work => {
			log.push(['actor', actor]);
			return Promise.resolve(work());
		},
		loadSnapshot: id => (snapshotFor ? snapshotFor(id) : undefined)
	});
	const api = {
		listSnapshots: async () => {
			if (listThrows) throw new Error('index unreadable');
			return snapshots ?? [];
		},
		listInterrupted: listInterrupted,
		get: async id => sessions.find(s => s.id === id),
		ensureRuntime: async session => {
			const runtime = {
				restoreSessionSnapshot(snapshot) {
					if (restoreThrows) throw new Error('corrupt snapshot');
					restored.push({ id: session.id, snapshot });
				}
			};
			if (runtimeLacksRestore) delete runtime.restoreSessionSnapshot;
			return { runtime };
		},
		runTurn: async (session, options) => { turns.push({ id: session.id, task: options.task }); },
		updateActivity: async (session, id, patch) => {
			const activity = session.activities?.find(candidate => candidate.id === id);
			if (activity) Object.assign(activity, patch);
			return activity;
		},
		addMessage: async (session, message) => {
			session.messages ??= [];
			session.messages.push(message);
			return message;
		},
		setStatus: async (session, status, detail) => {
			session.status = status;
			session.detail = detail;
		}
	};
	const resumeAll = () => resume.resumeAll({
		listSnapshots: api.listSnapshots,
		listInterrupted: api.listInterrupted,
		get: api.get,
		ensureRuntime: api.ensureRuntime,
		runTurn: api.runTurn,
		updateActivity: api.updateActivity,
		addMessage: api.addMessage,
		setStatus: api.setStatus
	});
	return { resume, api, resumeAll, turns, restored, log };
}

test('isResumable accepts a fresh interrupted run and rejects everything else', () => {
	const { resume } = makeHarness({});
	assert.equal(resume.isResumable(interruptedSession()), true);
	assert.equal(resume.isResumable(interruptedSession({ interruptedFromRun: false })), false, 'not mid-run');
	assert.equal(resume.isResumable(interruptedSession({ status: 'awaiting_input' })), false, 'wrong status');
	assert.equal(resume.isResumable(interruptedSession({ autoResumeCount: 3 })), false, 'attempt cap');
	assert.equal(resume.isResumable(interruptedSession({ report: { publishedAt: 1 } })), false, 'already published');
	assert.equal(resume.isResumable(interruptedSession({ mode: 'sqa', sqa: { finalizedAt: 1 } })), false, 'sqa published');
	assert.equal(resume.isResumable(interruptedSession({ mode: 'founder', founder: { finalizedAt: 1 } })), false, 'founder published');
	assert.equal(resume.isResumable(null), false);
});

test('recovery instruction names the target and forbids repeating steps', () => {
	const { resume } = makeHarness({});
	const instruction = resume.recoveryInstruction({ targetUrl: 'https://example.dev/' });
	assert.match(instruction, /interrupted by a server restart/);
	assert.match(instruction, /https:\/\/example\.dev\//);
	assert.match(instruction, /Do not repeat completed or irreversible steps/);
	assert.match(instruction, /publish the final report/);
});

test('SQA and Founder recovery instructions enforce their own completion contracts', () => {
	const { resume } = makeHarness({});
	const sqa = resume.recoveryInstruction(interruptedSession({ mode: 'sqa' }));
	assert.match(sqa, /preserve recorded control evidence/i);
	assert.match(sqa, /finish_sqa_assessment/);
	assert.doesNotMatch(sqa, /finish_founder_review/);

	const founder = resume.recoveryInstruction(interruptedSession({ mode: 'founder' }));
	assert.match(founder, /preserve recorded observations/i);
	assert.match(founder, /finish_founder_review/);
	assert.doesNotMatch(founder, /finish_sqa_assessment/);
});

test('a candidate with a snapshot is resumed inside its owner actor context', async () => {
	const session = interruptedSession({ id: 'run-a', ownerUserId: 'user-a' });
	const snapshot = { version: 1, agent: { history: ['x'] } };
	const { resumeAll, turns, restored, log } = makeHarness({
		sessions: [session],
		snapshots: [{ sessionId: 'run-a', ownerUserId: 'user-a', savedAt: 123 }],
		snapshotFor: id => (id === 'run-a' ? snapshot : null)
	});
	const count = await resumeAll();
	assert.equal(count, 1, 'exactly one run resumed');
	assert.equal(turns.length, 1);
	assert.deepEqual(restored, [{ id: 'run-a', snapshot }]);
	assert.equal(session.autoResumeCount, 1);
	assert.equal(session.interruptedFromRun, false);
	assert.match(turns[0].task, /interrupted by a server restart/);
	assert.ok(log.some(([event, fields]) => event === 'runresume.resumed' && fields.runId === 'run-a'), 'resume was logged');
	assert.ok(log.some(([event, actor]) => event === 'actor' && actor?.actorUserId === 'user-a'), 'owner actor context used');
});

test('candidates without a snapshot resume from the recorded transcript', async () => {
	const session = interruptedSession({ id: 'run-b', messages: [{ role: 'agent', text: 'Homepage verified.' }] });
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [{ sessionId: 'run-b', ownerUserId: 'user-a', savedAt: 5 }],
		snapshotFor: () => null
	});
	const count = await resumeAll();
	assert.equal(count, 1, 'resumes despite missing snapshot');
	assert.equal(turns.length, 1);
	assert.match(turns[0].task, /interrupted by a server restart/);
	assert.match(turns[0].task, /Homepage verified\./, 'transcript digest seeded into recovery instruction');
});

test('a lost snapshot directory still resumes an interrupted run from the store', async () => {
	// The production bug: the crash destroyed .qase/runsnapshots entirely, so
	// the snapshot index was empty and no candidate ever resumed.
	const session = interruptedSession({ id: 'run-j', messages: [{ role: 'agent', text: 'Careers page renders fine end-to-end.' }] });
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [], // snapshot directory wiped
		listInterrupted: async () => [session]
	});
	const count = await resumeAll();
	assert.equal(count, 1, 'resumes from store scan when snapshot index is empty');
	assert.equal(turns.length, 1);
	assert.match(turns[0].task, /Careers page renders fine/, 'transcript digest seeded');
	assert.equal(session.autoResumeCount, 1);
	assert.equal(session.interruptedFromRun, false);
});

test('no-snapshot recovery digest includes tool-activity summaries, not just assistant prose', async () => {
	// Regression for the field-name bug: transcriptDigestFor read the
	// nonexistent session.activity (singular) and silently dropped every tool
	// summary, so a recovered run saw only assistant text — weakening the
	// "do not redo irreversible steps" protection.
	const session = interruptedSession({
		id: 'run-digest',
		messages: [{ role: 'agent', text: 'Started exploring the site.' }],
		activities: [
			{ id: 'a1', toolName: 'browser_click', summary: 'Clicked "Send message" on the contact form (destructive: message).', ts: 5 },
			{ id: 'a2', toolName: 'browser_snapshot', summary: 'Captured homepage snapshot (24 elements).', ts: 6 }
		]
	});
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [],
		listInterrupted: async () => [session]
	});
	const count = await resumeAll();
	assert.equal(count, 1);
	assert.match(turns[0].task, /\[browser_click\] Clicked "Send message"/, 'tool summary present in digest');
	assert.match(turns[0].task, /\[browser_snapshot\] Captured homepage snapshot/, 'second tool summary present');
});

test('store scan respects the same resumability rules', async () => {
	const finished = interruptedSession({ id: 'run-k', status: 'done' });
	const waiting = interruptedSession({ id: 'run-l', interruptedFromRun: false });
	const { resumeAll, turns } = makeHarness({
		sessions: [finished, waiting],
		snapshots: [],
		listInterrupted: async () => [finished, waiting]
	});
	const count = await resumeAll();
	assert.equal(count, 0);
	assert.equal(turns.length, 0);
});

test('snapshot for a session that is not resumable is ignored', async () => {
	const finished = interruptedSession({ id: 'run-c', status: 'done' });
	const waiting = interruptedSession({ id: 'run-d', interruptedFromRun: false });
	const capped = interruptedSession({ id: 'run-e', autoResumeCount: 3 });
	const { resumeAll, turns } = makeHarness({
		sessions: [finished, waiting, capped],
		snapshots: ['run-c', 'run-d', 'run-e'].map(id => ({ sessionId: id, ownerUserId: 'user-a', savedAt: 1 }))
	});
	const count = await resumeAll();
	assert.equal(count, 0);
	assert.equal(turns.length, 0);
	assert.match(capped.messages.at(-1)?.text ?? '', /stopped after 3 attempts/, 'exhausted cap leaves an explanatory system message');
});

test('corrupt snapshot restore falls back to transcript resume', async () => {
	const session = interruptedSession({ id: 'run-f' });
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [{ sessionId: 'run-f', ownerUserId: 'user-a', savedAt: 1 }],
		restoreThrows: true
	});
	const count = await resumeAll();
	assert.equal(count, 1, 'corrupt snapshot must not strand the run');
	assert.equal(turns.length, 1);
});

test('runtime without snapshot restore support is skipped', async () => {
	const session = interruptedSession({ id: 'run-i' });
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [{ sessionId: 'run-i', ownerUserId: 'user-a', savedAt: 1 }],
		runtimeLacksRestore: true
	});
	const count = await resumeAll();
	assert.equal(count, 0);
	assert.equal(turns.length, 0);
});

test('snapshot index failure is swallowed and reported as zero', async () => {
	const { resumeAll } = makeHarness({ listThrows: true });
	const count = await resumeAll();
	assert.equal(count, 0);
});

test('at most one run resumes per boot pass', async () => {
	const a = interruptedSession({ id: 'run-g' });
	const b = interruptedSession({ id: 'run-h' });
	const { resumeAll, turns } = makeHarness({
		sessions: [a, b],
		snapshots: [
			{ sessionId: 'run-g', ownerUserId: 'user-a', savedAt: 2 },
			{ sessionId: 'run-h', ownerUserId: 'user-b', savedAt: 1 }
		]
	});
	const count = await resumeAll();
	assert.equal(count, 1);
	assert.equal(turns.length, 1);
	assert.equal(b.autoResumeCount ?? 0, 0, 'second candidate untouched');
});

test('resume fails activities still running from before the restart so publish cannot be vetoed', async () => {
	// Production incident shape: browser_click died with the process, the store
	// never failed it, and every finish_qa_report was rejected forever.
	const session = interruptedSession({
		id: 'run-stuck',
		activities: [
			{ id: 'call_stuck', ts: 1, status: 'running', toolName: 'browser_click' },
			{ id: 'done-probe', ts: 0, status: 'done', toolName: 'browser_snapshot' }
		]
	});
	const { resumeAll, turns } = makeHarness({
		sessions: [session],
		snapshots: [{ sessionId: 'run-stuck', ownerUserId: 'user-a', savedAt: 1 }]
	});
	const count = await resumeAll();
	assert.equal(count, 1);
	assert.equal(turns.length, 1, 'recovery turn still runs');
	const stuck = session.activities.find(activity => activity.id === 'call_stuck');
	const done = session.activities.find(activity => activity.id === 'done-probe');
	assert.equal(stuck.status, 'failed', 'orphaned running activity is failed before the turn');
	assert.match(stuck.error, /Interrupted by a server restart/);
	assert.equal(done.status, 'done', 'settled activities are untouched');
});
