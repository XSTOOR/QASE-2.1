import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ALL_TOOLS, CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile, OPUS_MODEL } from './hybridConfig.js';
import { applyHostDecision } from './hybridContinuation.js';
import { createQaTools } from './qaTools.js';

test('installed SDK pauses for a host budget decision and resumes the same loop only after explicit approval', { timeout: 20000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-continuation-sdk-'));
  const sdk = new CleanSlateNodeAgentRuntime({ rootPath: root,
    configuration: createNodeProviderConfiguration({ provider: 'custom', model: OPUS_MODEL, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', maxTurns: 4 }),
    approveCommand: async () => false, approveTool: async ({ toolName }) => toolName === 'ask_question', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  t.after(() => { sdk.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: 'https://fixture.test/', ownerUserId: 'owner', selectedTests: ['responsive'], messages: [], todos: [], findings: [], secretNames: [] };
  const hybrid = createHybridRuntime({ session, record: {}, profile: hybridProfile({ apiKey: 'fixture-key' }, {}), runStore: { async commit() {} } });
  t.after(() => hybrid.endTurn('cancelled'));
  const tools = [ALL_TOOLS.find(tool => tool.name === 'ask_question'), createQaTools(session, { async commit() {} }).find(tool => tool.name === 'finish_qa_report')].map(tool => hybrid.wrapTool(tool));
  sdk.headlessRuntime.options.tools = tools; sdk.headlessRuntime.toolsByName.clear(); for (const tool of tools) sdk.headlessRuntime.toolsByName.set(tool.name, tool);
  // Exact synthetic prior receipts, not a live model measurement.
  const metric = session.hybrid.telemetry.reasoner;
  Object.assign(metric, { inputTokens: 295000, outputTokens: 0, calls: 1 });
  session.hybrid.modelBudget.roles.reasoner.reservations.push({ id: 'prior-fixture', status: 'settled', tokens: 295000, receipt: { inputTokens: 295000, outputTokens: 0, callId: 'prior-fixture' } });
  let requests = 0;
  sdk.cleanSlateService.chat = async (_messages, options) => (async function* () {
    requests++;
    hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: 'continued-fixture', inputTokens: 20, outputTokens: 10, estimated: false });
    yield { type: 'text', content: 'Continuing the remaining scoped checks.' };
  })();
  hybrid.wrapChat(sdk.cleanSlateService);
  await hybrid.beginTurn(t.signal);
  for await (const _part of sdk.run('Finish the requested responsive checks.', t.signal)) { /* installed SDK pause */ }
  await hybrid.endTurn('awaiting_input');
  assert.equal(requests, 0, 'Asking for budget must not spend another model call.');
  const pending = sdk.getPendingQuestion(), decision = session.hybrid.pendingDecision;
  assert.ok(pending); assert.equal(pending.toolCallId, decision.id); assert.equal(decision.kind, 'budget');
  assert.equal(session.hybrid.budgetFinalizing, undefined, 'Do not switch to report-only closeout before the user chooses it.');
  session.pendingQuestion = { toolCallId: pending.toolCallId, hybridDecision: 'budget' };
  applyHostDecision(session, decision.input.options[0]);
  assert.equal(session.hybrid.budgets.reasonerTokens, 600000); assert.equal(metric.inputTokens, 295000);
  await hybrid.beginTurn(t.signal);
  for await (const _part of sdk.resumePendingQuestion(decision.input.options[0], t.signal)) { /* same installed SDK agent session */ }
  await hybrid.endTurn('awaiting_input');
  assert.equal(requests, 1); assert.equal(metric.inputTokens, 295020); assert.equal(metric.outputTokens, 10);
  assert.equal(sdk.getPendingQuestion(), undefined);
  assert.equal(session.hybrid.scenarios[0].status, 'planned', 'A model continuation is not evidence that testing passed.');
});

test('installed SDK can publish an explicit gap report at an exhausted budget without another model request', { timeout: 20000 }, async t => {
  const { pauseForBudgetApproval } = await import('./hybridContinuation.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-closeout-sdk-'));
  const sdk = new CleanSlateNodeAgentRuntime({ rootPath: root,
    configuration: createNodeProviderConfiguration({ provider: 'custom', model: OPUS_MODEL, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', maxTurns: 6 }),
    approveCommand: async () => false, approveTool: async () => true, logger: { debug() {}, info() {}, warn() {}, error() {} } });
  t.after(() => { sdk.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: 'https://fixture.test/', ownerUserId: 'owner', selectedTests: ['responsive', 'security_authentication'], messages: [], activities: [], todos: [], findings: [], secretNames: [] };
  const store = { async commit() {} }, hybrid = createHybridRuntime({ session, record: {}, profile: hybridProfile({ apiKey: 'fixture-key' }, {}), runStore: store });
  t.after(() => hybrid.endTurn('done'));
  const tools = [ALL_TOOLS.find(tool => tool.name === 'ask_question'), ...hybrid.tools, ...createQaTools(session, store)].map(tool => hybrid.wrapTool(tool));
  sdk.headlessRuntime.options.tools = tools; sdk.headlessRuntime.toolsByName.clear(); for (const tool of tools) sdk.headlessRuntime.toolsByName.set(tool.name, tool);
  const metric = session.hybrid.telemetry.reasoner;
  Object.assign(metric, { inputTokens: 310000, outputTokens: 0, calls: 1 });
  session.hybrid.modelBudget.roles.reasoner.reservations.push({ id: 'exact-fixture', status: 'settled', tokens: 310000, receipt: { inputTokens: 310000, outputTokens: 0, callId: 'exact-fixture' } });
  let requests = 0; sdk.cleanSlateService.chat = async () => { requests++; throw new Error('No additional paid call authorized'); };
  hybrid.wrapChat(sdk.cleanSlateService);
  const decision = await pauseForBudgetApproval(session, sdk, { code: 'HYBRID_MODEL_BUDGET' });
  session.pendingQuestion = { toolCallId: decision.id };
  const answer = decision.input.options.at(-1); applyHostDecision(session, answer);
  await hybrid.beginTurn(t.signal);
  for await (const _part of sdk.resumePendingQuestion(answer, t.signal)) { /* actual SDK dispositions and report */ }
  assert.equal(requests, 0); assert.equal(metric.inputTokens, 310000);
  assert.equal(session.report.verdict, 'blocked'); assert.ok(session.report.notCovered.length);
  assert.equal(session.report.securityOutcomes[0].outcome, 'not_tested');
  assert.ok(session.hybrid.scenarios.every(scenario => !['planned', 'running', 'passed'].includes(scenario.status)));
  assert.equal(session.hybrid.budgets.reasonerTokens, 300000, 'Publication cannot grant more model budget.');
});
