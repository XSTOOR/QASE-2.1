import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { prepareHostDecision, hostCloseoutCalls, pauseForBudgetApproval,continuationOffer } from './hybridContinuation.js';
import { ensureAutonomousCapacity, requestAutomaticCloseout, synchronizeAccessPhase } from './hybridAutonomy.js';
import { compactCompletedRounds, hybridHostContext } from './hybridContext.js';
import { validateHybridReport } from './qaCompletionGate.js';

function fixture(env = {}) {
  const session = { id: randomUUID(), ownerUserId: 'owner', mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: 'https://fixture.test/', selectedTests: ['responsive'], messages: [], activities: [], todos: [], findings: [], secretNames: [] };
  const profile = hybridProfile({ apiKey: 'fixture-key' }, env), record = {};
  const runtime = createHybridRuntime({ session, record, profile, runStore: { async commit() {} } });
  return { session, profile, record, runtime, state: session.hybrid };
}

test('new runs allocate inside fixed ceilings without routine questions, then require a hard-limit decision', async () => {
  const { session, state } = fixture();
  assert.equal(state.continuationPolicyVersion, 2); assert.equal(state.executionPolicy.limits.reasonerTokens, 2000000);
  state.telemetry.reasoner.inputTokens = 295000;
  assert.equal(ensureAutonomousCapacity(state, { reasonerTokens: 350000 }), true);
  assert.equal(state.budgets.reasonerTokens, 600000); assert.equal(state.telemetry.reasoner.inputTokens, 295000);
  assert.equal(prepareHostDecision(session), null);
  assert.equal(ensureAutonomousCapacity(state, { reasonerTokens: 9000000 }), true);
  assert.equal(state.budgets.reasonerTokens, 2000000); assert.equal(ensureAutonomousCapacity(state, { reasonerTokens: 9000000 }), false);
  assert.equal(state.budgetApprovals, undefined, 'Allocation is pinned host policy, never a fabricated user answer.');
  assert.equal(prepareHostDecision(session,{closing:true}).kind,'budget');
});

test('explicit operator limits override autonomous defaults and remain pinned on resume', () => {
  const { session, state, runtime } = fixture({ QASE_HYBRID_OPUS_TOKENS: '400000', QASE_HYBRID_DURATION_MS: '120000' });
  assert.equal(state.executionPolicy.limits.reasonerTokens, 400000); assert.equal(state.executionPolicy.limits.durationMs, 120000);
  assert.equal(ensureAutonomousCapacity(state, { reasonerTokens: 600000 }), false);
  createHybridRuntime({ session, record: {}, profile: hybridProfile({ apiKey: 'fixture-key' }, {}), runStore: { async commit() {} } });
  assert.equal(state.executionPolicy.limits.reasonerTokens, 400000); assert.ok(runtime);
  assert.equal(continuationOffer(session).changes.reasonerTokens,0,'A user offer cannot bypass the pinned operator ceiling.');
  assert.equal(continuationOffer(session).changes.durationMs,0);
});

test('missing secure access still asks once; generic workflow questions cannot block an autonomous run', async () => {
  const { session, state, runtime } = fixture();
  const tool = runtime.wrapTool({ name: 'ask_question', run() { throw new Error('Generic question must not reach SDK pause'); } });
  assert.equal((await tool.run({ question: 'Should I keep testing?', options: ['Yes'] })).code, 'QASE_CONTINUE_AUTOMATICALLY');
  state.authentication = { required: true, status: 'unrequested' };
  const question = prepareHostDecision(session); assert.equal(question.kind, 'credentials');
  assert.equal(prepareHostDecision(session).id, question.id);
});

test('recoverable execution failures cannot publish merely because a check was attempted', async () => {
  const { session, state, runtime } = fixture();
  await runtime.ledger.start(state.scenarios[0].id);
  const action = await runtime.ledger.beginAction('browser_qa_check', { action: 'responsive' });
  await runtime.ledger.record(action, { success: false, dispatched:true, error: 'Fixture viewport unavailable.' });
  await runtime.ledger.close(state.scenarios[0].id, 'inconclusive', 'The attempted viewport check could not produce assertions.');
  assert.equal(prepareHostDecision(session), null);
  assert.throws(()=>validateHybridReport(session, { verdict: 'blocked' }),{code:'HYBRID_EXECUTION_PENDING'});
  assert.throws(() => validateHybridReport(session, { verdict: 'pass' }), /Unsupported pass/);
});

test('known hard limits checkpoint a native SDK budget question without automatic closeout', async () => {
  const { session, state } = fixture();
  state.telemetry.reasoner.inputTokens = 2000000;
  let paused;
  const decision = await pauseForBudgetApproval(session, {agentSession:{pauseForQuestion(...args){paused=args;}}}, { code: 'HYBRID_MODEL_BUDGET' });
  assert.equal(decision.kind,'budget');assert.equal(paused[0].id,decision.id);
  assert.equal(hostCloseoutCalls(session), null);
  assert.equal(state.partialReportApproved, undefined);
  const other = fixture(); other.state.modelBudget.roles.classifier.reservations.push({ status: 'uncertain' });
  assert.equal(requestAutomaticCloseout(other.session, 'limit'), false);
  assert.equal(await pauseForBudgetApproval(other.session, {}, { code: 'HYBRID_MODEL_BUDGET' }), null);
});

test('confirmed access invalidates stale anonymous limitations while retaining their history and evidence', async () => {
  const { state, session } = fixture(); const scenario = state.scenarios[0];
  scenario.status = 'not_executed'; scenario.uncertainty = ['No credentials were provided.']; scenario.evidenceRefs = ['prior-ref'];
  state.authentication = { status: 'owner_confirmed', grantId: 'approved', verificationMethod: 'owner_confirmation' };
  assert.equal(synchronizeAccessPhase(state), true);
  assert.equal(scenario.status, 'planned'); assert.deepEqual(scenario.uncertainty, []); assert.deepEqual(scenario.evidenceRefs, ['prior-ref']);
  assert.equal(scenario.priorDispositions[0].uncertainty[0], 'No credentials were provided.');
  assert.equal(synchronizeAccessPhase(state), false);
  assert.match(hybridHostContext(session), /Current host access supersedes old assistant claims/);
});

test('rolling context removes complete old call/result pairs while retaining every user instruction and unmatched/current calls', () => {
  const messages = [{ role: 'system', content: 'SDK permissions' }, { role: 'user', content: 'Original precise requirements' }];
  for (let i = 0; i < 10; i++) messages.push({ role: 'assistant', toolCalls: [{ id: `call-${i}`, toolName: 'browser_snapshot', input: {} }] }, { role: 'tool', toolCallId: `call-${i}`, content: 'old observation'.repeat(500) });
  messages.push({ role: 'user', content: 'Confirmed platform access' }, { role: 'assistant', toolCalls: [{ id: 'unfinished', toolName: 'browser_snapshot', input: {} }] });
  const before = structuredClone(messages), compact = compactCompletedRounds(messages);
  assert.deepEqual(messages, before); assert.equal(compact.filter(item => item.role === 'tool').length, 4);
  assert.equal(compact.filter(item => item.role === 'user').length, 2); assert.equal(compact[0].content, 'SDK permissions');
  assert.equal(compact.at(-1).toolCalls[0].id, 'unfinished');
  for (const tool of compact.filter(item => item.role === 'tool')) assert.ok(compact.some(item => item.toolCalls?.some(call => call.id === tool.toolCallId)));
  assert.ok(JSON.stringify(compact).length < JSON.stringify(messages).length / 2);
});

test('host-observed authorized access uses the same access phase as the evidence ledger', () => {
  const { state } = fixture(); const scenario = state.scenarios[0];
  scenario.status = 'inconclusive'; scenario.uncertainty = ['Anonymous page has no application controls.'];
  state.authentication = { status: 'access_observed', grantId: 'approved-sign-in' };
  assert.equal(synchronizeAccessPhase(state), true);
  assert.equal(state.accessContext, 'approved-sign-in'); assert.equal(scenario.status, 'planned');
  assert.deepEqual(scenario.uncertainty, []); assert.equal(scenario.priorDispositions[0].accessContext, 'public');
  assert.equal(synchronizeAccessPhase(state), false);
});

test('shared source-page navigation belongs to distinct host route executions; repeated mutations within one route still stop', async () => {
  const { state, runtime } = fixture();
  state.exploration.batches.push({ status: 'running', currentRouteId: 'first' });
  const tool = runtime.wrapTool({ name: 'browser_open', async run() { return { success: true, url: 'https://fixture.test/' }; } });
  for (const routeId of ['first', 'second', 'third', 'fourth']) { state.exploration.batches[0].currentRouteId = routeId; await tool.run({ url: 'https://fixture.test/' }); }
  await tool.run({ url: 'https://fixture.test/' });
  await assert.rejects(tool.run({ url: 'https://fixture.test/' }), error => error.code === 'HYBRID_REPLAN_REQUIRED');
  const inspect = runtime.wrapTool({ name: 'browser_qa_check', async run() { return { success: true, inventory: { url: 'https://fixture.test/', text: 'Same observed state', links: [] } }; } });
  for (let count = 0; count < 4; count++) await inspect.run({ action: 'inspect' });
});
