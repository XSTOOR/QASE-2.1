import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { watchTurn, WATCHDOG_CONFIG, isTerminalStatus, setWatchdogConfig } from './runWatchdog.js';

// Short windows for THIS suite only. WATCHDOG_CONFIG is module-global, and
// under `node --test --test-isolation=none` node imports every test file
// BEFORE running any tests, so a module-level setWatchdogConfig() would
// shrink the window for ALL suites sharing the process (agent.test.js
// provider-retry tests legitimately sleep ~700ms with no heartbeat and get
// aborted by the watchdog). Shrink in test.before, restore in test.after.
import { invalidTransition, deriveOutcome, recordLifecyclePhase, lifecycleDocument, outcomeForLegacySession, SESSION_STATUSES } from './runLifecycle.js';

function makeController() { return { aborted: false, abort() { this.aborted = true; this.onAbort?.(); } }; }


// Short windows for THIS suite only — describe-scoped so the shrunken
// WATCHDOG_CONFIG never leaks into other suites sharing the process under
// `node --test --test-isolation=none` (agent.test.js provider-retry tests
// legitimately sleep ~700ms with no heartbeat).
describe('runWatchdog', () => {
  const watchdogDefaults = { ...WATCHDOG_CONFIG };
  before(() => { setWatchdogConfig({ stallMs: 700, deadlineMs: 0, graceMs: 250 }); });
  after(() => { setWatchdogConfig(watchdogDefaults); });

  test('watchdog aborts a turn that goes silent (stall detection)', async () => {
  	const controller = makeController();
  	let settle;
  	const turn = new Promise(r => { settle = r; });
  	let stallReason;
  	const wd = watchTurn({
  		sessionId: 'run-1', controller,
  		getStatus: () => 'running',
  		getActiveStep: () => ({ toolName: 'browser_open', since: Date.now() - 90_000 }),
  		onStall: reason => { stallReason = reason; },
  		turnPromise: turn,
  		runStore: { addMessage: async () => {}, setStatus: async () => {} }
  	});
  	await new Promise(r => setTimeout(r, 1000));
  	assert.equal(controller.aborted, true, 'controller must be aborted after the stall window with no beats');
  	assert.match(stallReason, /No execution progress/);
  	assert.match(stallReason, /browser_open/);
  	wd.dispose(); settle();
  });

  test('watchdog does NOT abort while heartbeats keep arriving', async () => {
  	const controller = makeController();
  	let settle;
  	const turn = new Promise(r => { settle = r; });
  	const wd = watchTurn({
  		sessionId: 'run-2', controller,
  		getStatus: () => 'running', getActiveStep: () => undefined,
  		turnPromise: turn,
  		runStore: { addMessage: async () => {}, setStatus: async () => {} }
  	});
  	// Beat every 300ms for 1.6s — longer than the 1s stall window.
  	for (let i = 0; i < 6; i++) {
  		await new Promise(r => setTimeout(r, 250));
  		wd.beat();
  	}
  	assert.equal(controller.aborted, false, 'heartbeats must keep the turn alive');
  	wd.dispose(); settle();
  });

  test('watchdog fail-safe terminalizes a run whose turn settled without a status', async () => {
  	const controller = makeController();
  	const statuses = [];
  	const messages = [];
  	let statusNow = 'running';
  	let settle;
  	const turn = new Promise(r => { settle = r; });
  	const wd = watchTurn({
  		sessionId: 'run-3', controller,
  		getStatus: () => statusNow,
  		getActiveStep: () => undefined,
  		turnPromise: turn,
  		runStore: {
  			addMessage: async (_s, m) => { messages.push(m); },
  			setStatus: async (_s, status, detail) => { statuses.push({ status, detail }); statusNow = status; }
  		}
  	});
  	settle(); // turn ends, cascade never sets a status
  	await new Promise(r => setTimeout(r, 450));
  	assert.deepEqual(statuses, [{ status: 'error', detail: 'The agent turn ended without setting a final run status.' }]);
  	assert.ok(messages[0].text.includes('Run monitor'));
  	wd.dispose();
  });

  test('watchdog fail-safe leaves awaiting_input runs untouched', async () => {
  	const controller = makeController();
  	const statuses = [];
  	let settle;
  	const turn = new Promise(r => { settle = r; });
  	const wd = watchTurn({
  		sessionId: 'run-4', controller,
  		getStatus: () => 'awaiting_input',
  		getActiveStep: () => undefined,
  		turnPromise: turn,
  		runStore: { addMessage: async () => {}, setStatus: async (_s, s) => { statuses.push(s); } }
  	});
  	settle();
  	await new Promise(r => setTimeout(r, 450));
  	assert.deepEqual(statuses, [], 'a run waiting on a human must never be terminalized');
  	wd.dispose();
  });

  test('isTerminalStatus distinguishes terminal from active/paused', () => {
  	assert.equal(isTerminalStatus('done'), true);
  	assert.equal(isTerminalStatus('error'), true);
  	assert.equal(isTerminalStatus('cancelled'), true);
  	assert.equal(isTerminalStatus('running'), false);
  	assert.equal(isTerminalStatus('awaiting_input'), false);
  	assert.equal(isTerminalStatus('interrupted'), false);
  	assert.equal(isTerminalStatus(undefined), false);
  });

  // ---- lifecycle ----

  test('lifecycle rejects invalid transitions out of terminal states', () => {
  	assert.match(invalidTransition('done', 'error'), /Invalid run status transition done → error/);
  	assert.match(invalidTransition('error', 'done'), /Invalid run status transition error → done/);
  	assert.match(invalidTransition('done', 'awaiting_input'), /Invalid/);
  	assert.equal(invalidTransition('running', 'done'), null);
  	assert.equal(invalidTransition('running', 'error'), null);
  	assert.equal(invalidTransition('awaiting_input', 'running'), null);
  	assert.equal(invalidTransition('done', 'running'), null, 'explicit resume stays allowed');
  	assert.equal(invalidTransition('running', 'running'), null, 'idempotent re-set allowed');
  	assert.match(invalidTransition('running', 'bogus'), /Invalid run status/);
  });

  test('deriveOutcome maps terminal statuses to mandated outcomes', () => {
  	assert.equal(deriveOutcome('done', '', {})?.outcome, 'completed');
  	assert.equal(deriveOutcome('done', '', { incompleteCoverage: true })?.outcome, 'partial');
  	assert.equal(deriveOutcome('cancelled', '')?.outcome, 'cancelled');
  	assert.equal(deriveOutcome('error', 'No execution progress for 300s while the run was active.')?.outcome, 'timed_out');
  	assert.equal(deriveOutcome('error', 'provider request timed out')?.outcome, 'timed_out');
  	assert.equal(deriveOutcome('error', 'Action blocked pending authorization')?.outcome, 'blocked');
  	assert.equal(deriveOutcome('error', 'SDK exploded')?.outcome, 'failed');
  	assert.equal(deriveOutcome('running', '') , null);
  });

  test('recordLifecyclePhase tracks phase transitions and outcomes', () => {
  	const session = { status: 'idle' };
  	recordLifecyclePhase(session, 'queued', '');
  	assert.equal(session.lifecycle.phase, 'PLANNING');
  	recordLifecyclePhase(session, 'running', '');
  	assert.equal(session.lifecycle.phase, 'RUNNING');
  	recordLifecyclePhase(session, 'awaiting_input', 'question');
  	assert.equal(session.lifecycle.phase, 'PAUSED');
  	recordLifecyclePhase(session, 'running', '');
  	recordLifecyclePhase(session, 'done', 'Report published.');
  	assert.equal(session.lifecycle.phase, 'TERMINAL');
  	assert.equal(session.lifecycle.outcome, 'completed');
  	assert.ok(session.lifecycle.endedAt > 0);
  });

  test('outcomeForLegacySession derives from historical data', () => {
  	assert.equal(outcomeForLegacySession({ status: 'done' })?.outcome, 'completed');
  	assert.equal(outcomeForLegacySession({ status: 'error', failureReason: 'request timed out' })?.outcome, 'timed_out');
  	assert.equal(outcomeForLegacySession({ status: 'running' }), null);
  	assert.equal(outcomeForLegacySession({ lifecycle: { outcome: 'partial' }, status: 'done' }), 'partial');
  });

  test('setStatus rejects invalid transitions and preserves state (integration with store)', async () => {
  	const { setStatus } = await import('./store.js');
  	const session = { id: 'legacy-1', status: 'running', activities: [] };
  	setStatus(session, 'done', 'finished');
  	assert.equal(session.status, 'done');
  	// Illegal: done → error must be rejected silently (logged), state kept.
  	setStatus(session, 'error', 'late failure');
  	assert.equal(session.status, 'done', 'done run must not flip to error');
  	// Legal: explicit resume.
  	setStatus(session, 'running', 'resumed');
  	assert.equal(session.status, 'running');
  	assert.equal(SESSION_STATUSES.includes('awaiting_input'), true);
  });
});
