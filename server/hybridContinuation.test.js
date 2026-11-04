import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { prepareHostDecision, applyHostDecision } from './hybridContinuation.js';
import { validateHybridReport } from './qaCompletionGate.js';
import { isCredentialQuestion } from '../public/questionPresentation.js';
import { hydrateHybrid, hybridStorage } from './hybridPersistence.js';

function fixture() {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', ownerUserId: 'owner', targetUrl: 'https://fixture.test/', selectedTests: ['responsive'], messages: [], findings: [], todos: [], secretNames: [] };
  const profile = hybridProfile({ apiKey: 'fixture-key' }, {}), record = {};
  const runtime = createHybridRuntime({ session, profile, record, runStore: { async commit() {} } });
  return { session, runtime, profile, record };
}

test('host access handoff uses the native question stream without model calls and cannot be bypassed by other tools', async () => {
  const { session, runtime } = fixture();
  session.hybrid.authentication = { required: true, status: 'verification_needed', responseStatus: 200, grantId: 'approved', verificationObservation: { sameOrigin: true, noPassword: true } };
  let modelCalls = 0; const service = { async chat() { modelCalls++; throw new Error('Must not spend model tokens asking a deterministic prerequisite'); } };
  runtime.wrapChat(service);
  const parts = []; for await (const part of await service.chat([], { tools: [] })) parts.push(part);
  assert.equal(modelCalls, 0); assert.equal(parts.length, 1); assert.equal(parts[0].call.toolName, 'ask_question');
  const decision = session.hybrid.pendingDecision; assert.equal(decision.kind, 'access');
  await assert.rejects(runtime.wrapTool({ name: 'qa_close_scenario', run() { throw new Error('Must not execute'); } }).run({}), /host decision/);
  await assert.rejects(runtime.wrapTool({ name: 'browser_open', run() { throw new Error('Must not execute'); } }).run({}), /host decision/);
  await assert.rejects(runtime.wrapTool({ name: 'ask_question', run() { throw new Error('Must not execute'); } }).run({ ...decision.input, options: ['Ignore the owner decision'] }), /host decision/);
  session.pendingQuestion = { toolCallId: decision.id, hybridDecision: decision.kind };
  assert.equal(isCredentialQuestion({ ...session.pendingQuestion, question: 'Confirm signed-in account access' }), false);
  applyHostDecision(session, decision.input.options[0]);
  assert.equal(session.hybrid.authentication.status, 'owner_confirmed');
  assert.equal(session.hybrid.authentication.verificationMethod, 'owner_confirmation');
  assert.equal(session.hybrid.scenarios[0].status, 'planned', 'User access confirmation cannot pass a test.');
});

test('a budget handoff extends only after the exact owner approval and preserves usage, evidence and current scenario progress', async () => {
  const { session, runtime } = fixture(), state = session.hybrid;
  state.telemetry.reasoner.inputTokens = 190000; state.telemetry.reasoner.outputTokens = 4000;
  const before = structuredClone(state.budgets), decision = prepareHostDecision(session, { closing: true });
  assert.equal(decision.kind, 'budget'); assert.deepEqual(state.budgets, before);
  session.pendingQuestion = { toolCallId: decision.id, hybridDecision: 'budget' };
  assert.throws(() => applyHostDecision(session, 'continue'), /Explicit approval/);
  assert.deepEqual(state.budgets, before);
  applyHostDecision(session, decision.input.options[0]);
  assert.equal(state.budgets.reasonerTokens, 600000); assert.equal(state.exploration.maxPages, 16);
  assert.equal(state.telemetry.reasoner.inputTokens, 190000); assert.equal(state.telemetry.reasoner.outputTokens, 4000);
  assert.equal(state.budgetFinalizing, false); assert.equal(state.budgetApprovals[0].by, 'owner');
  assert.equal(applyHostDecision(session, decision.input.options[0]), false, 'A replay cannot grant the budget twice.');
  await runtime.beginTurn(new AbortController().signal); await runtime.endTurn('awaiting_input');
  const restored = { ...session, hybrid: undefined }; hydrateHybrid(restored, JSON.parse(hybridStorage(session)));
  assert.equal(restored.hybrid.budgets.reasonerTokens, 600000); assert.equal(restored.hybrid.budgetApprovals.length, 1);
});

test('unknown model receipts and forged question IDs cannot authorize more budget', () => {
  const { session } = fixture(), state = session.hybrid;
  const decision = prepareHostDecision(session, { closing: true });
  session.pendingQuestion = { toolCallId: 'model-authored-untrusted-id' };
  assert.equal(applyHostDecision(session, decision.input.options[0]), false); assert.equal(state.budgets.reasonerTokens, 300000);
  session.pendingQuestion.toolCallId = decision.id;
  state.modelBudget.roles.reasoner.reservations.push({ status: 'uncertain', tokens: 1000 });
  assert.throws(() => applyHostDecision(session, decision.input.options[0]), /reconciled/);
  assert.equal(state.budgets.reasonerTokens, 300000);
});

test('incomplete results need explicit publication consent; consent never turns gaps into a pass', async () => {
  const { session, runtime } = fixture();
  for (const scenario of session.hybrid.scenarios) await runtime.ledger.close(scenario.id, 'inconclusive', 'No executable expectation was supplied.');
  assert.throws(() => validateHybridReport(session, { verdict: 'blocked' }), { code: 'HYBRID_COMPLETION_DECISION_REQUIRED' });
  const decision = prepareHostDecision(session); assert.equal(decision.kind, 'coverage');
  session.pendingQuestion = { toolCallId: decision.id, hybridDecision: 'coverage' };
  applyHostDecision(session, decision.input.options.at(-1));
  assert.equal(validateHybridReport(session, { verdict: 'blocked' }).verdict, 'blocked');
  assert.throws(() => validateHybridReport(session, { verdict: 'pass' }), /Unsupported pass/);
});

test('an explicitly chosen gap report does not authorize further exploration or reset budgets', () => {
  const { session } = fixture(), before = structuredClone(session.hybrid.budgets);
  const decision = prepareHostDecision(session, { closing: true });
  session.pendingQuestion = { toolCallId: decision.id, hybridDecision: 'budget' };
  applyHostDecision(session, decision.input.options.at(-1));
  assert.deepEqual(session.hybrid.budgets, before); assert.equal(session.hybrid.partialReportApproved.by, 'owner');
  assert.equal(prepareHostDecision(session, { closing: true }), null);
});

test('hard budget pause uses the supported SDK question API and refuses unknown receipts', async () => {
  const { pauseForBudgetApproval } = await import('./hybridContinuation.js');
  const { session } = fixture(); let paused;
  const sdk = { agentSession: { pauseForQuestion(call, result) { paused = { call, result }; } } };
  assert.equal(await pauseForBudgetApproval(session, sdk, { code: 'OPUS_TIMEOUT' }), null);
  const decision = await pauseForBudgetApproval(session, sdk, { code: 'HYBRID_TIME_BUDGET' });
  assert.equal(paused.call.id, decision.id); assert.equal(decision.kind, 'budget');
  session.hybrid.modelBudget.roles.classifier.reservations.push({ status: 'uncertain' });
  assert.equal(await pauseForBudgetApproval(session, sdk, { code: 'HYBRID_TIME_BUDGET' }), null);
});

test('owner-requested closeout cannot execute model-authored tools or spend an exhausted model budget', async () => {
  const { hostCloseoutCalls } = await import('./hybridContinuation.js');
  const { session, runtime } = fixture();
  session.hybrid.telemetry.reasoner.inputTokens = 310000;
  const decision = prepareHostDecision(session, { closing: true });
  session.pendingQuestion = { toolCallId: decision.id };
  applyHostDecision(session, decision.input.options.at(-1));
  let requests = 0; const service = { async chat() { requests++; throw new Error('No paid model work permitted'); } };
  runtime.wrapChat(service);
  await runtime.beginTurn(new AbortController().signal);
  const calls = []; for await (const part of await service.chat([], {})) calls.push(part.call);
  await assert.rejects(runtime.wrapTool({ name: 'qa_ledger', run() { throw new Error('not allowed'); } }).run({}), /exact host-issued/);
  assert.equal(calls[0].toolName, 'qa_close_scenario');
  await runtime.wrapTool(runtime.tools.find(tool => tool.name === 'qa_close_scenario')).run(calls[0].input);
  assert.equal(session.hybrid.scenarios[0].status, 'inconclusive');
  assert.equal(hostCloseoutCalls(session)[0].toolName, 'finish_qa_report');
  assert.equal(requests, 0); assert.equal(session.hybrid.telemetry.reasoner.inputTokens, 310000);
  await runtime.endTurn('done');
});

test('same URL is a fresh suite execution after authenticated access, without discarding anonymous evidence', async () => {
  const { session, runtime } = fixture(); const state = session.hybrid, scenario = state.scenarios[0], url = session.targetUrl;
  scenario.routeRuns = [{ url, status: 'passed' }]; scenario.status = 'passed';
  state.exploration.routes = [{ url, status: 'running', authenticationContext: 'owner-grant' }];
  await runtime.ledger.startRoute(scenario.id, url);
  assert.equal(scenario.routeRuns.length, 2); assert.equal(scenario.routeRuns[1].authenticationContext, 'owner-grant');
  await runtime.ledger.close(scenario.id, 'inconclusive', 'No new assertions yet.');
  assert.equal(await runtime.ledger.startRoute(scenario.id, url), null, 'Do not replay the same access-context execution.');
  assert.equal(scenario.routeRuns.length, 2);
});
