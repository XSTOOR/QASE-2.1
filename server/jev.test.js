import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJevClient, JEV_ENDPOINT, validateJevResponse } from './jevClient.js';
import { installJevRuntime, jevActionCandidates, jevDiagnosticCandidates } from './jevRuntime.js';
import { createQaTools } from './qaTools.js';
import { createSqaState, createSqaTodoPlan } from './sqaService.js';
import { createSqaTools } from './sqaTools.js';
import { createFounderState, createFounderReviewTodos } from './founderService.js';
import { createFounderTools } from './founderTools.js';
import { getConfig, getPublicConfig, withUserConfiguration, testConnection, envKeyDestinationProblem, saveConfig } from './config.js';

const questions = { ready: { type: 'noul', instructions: 'Ready?' } };
const reply = (answers, extra = {}) => ({ id: randomUUID(), model: 'typesafe/jev-1.13-20260917', answers, usage: { input_tokens: 20, output_tokens: 8 }, ...extra });
test('JEV client uses the native contract and real usage, never chat or a fallback model', async () => {
  const usage = [];
  const calls = [];
  const client = createJevClient({ apiKey: 'private-test-key' }, { onUsage: value => usage.push(value), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(reply({ ready: { type: 'noul', noul: 0.99 } }));
  } });
  await client.decide({ evidence: 'ready' }, questions, { sessionId: 'run-1' });
  assert.equal(calls[0].url, JEV_ENDPOINT);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.model, 'jev-1.13');
  assert.equal(body.session_id, 'run-1');
  assert.equal(body.messages, undefined);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(usage[0].totalTokens, 28);
  assert.throws(() => createJevClient({ apiKey: 'test', baseUrl: 'https://attacker.test' }), /fixed/);
});
test('JEV refuses malformed, missing, wrong-model, and invented-choice answers', () => {
  assert.throws(() => validateJevResponse(reply({}), questions), /omitted/);
  assert.throws(() => validateJevResponse(reply({ ready: { type: 'noul', noul: 2 } }), questions), /probability/);
  assert.throws(() => validateJevResponse(reply({ ready: { type: 'noul', noul: 1 } }, { model: 'other-model' }), questions), /model/);
  const q = { action: { type: 'choice', instructions: 'Choose', criteria: { a: 'Open', finish: 'Finish' } } };
  assert.throws(() => validateJevResponse(reply({ action: { type: 'choice', choice: 'shell' } }), q), /unknown/);
});
test('credential echoes and failed requests cannot become successful decisions', async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: 'private-test-key' }, { fetchImpl: async () => { calls++; return Response.json({ error: { message: 'private-test-key' } }, { status: 401 }); } });
  await assert.rejects(client.decide('evidence', questions), error => /HTTP 401/.test(error.message) && !error.message.includes('private-test-key'));
  assert.equal(calls, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.decide('evidence', questions, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
test('JEV cancellation aborts the in-flight transport', async () => {
  const controller = new AbortController();
  let transportSignal;
  const client = createJevClient({ apiKey: 'test' }, { fetchImpl: async (_url, options) => {
    transportSignal = options.signal;
    controller.abort();
    throw options.signal.reason;
  } });
  await assert.rejects(client.decide('ready', questions, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(transportSignal.aborted, true);
});
test('candidate construction uses observed safe same-origin targets and honors selected scope', () => {
  const page = { success: true, url: 'https://site.test/', elements: [
    { href: '/help', text: 'Help' }, { href: '/delete-account', text: 'Delete' },
    { href: 'https://external.test', text: 'External' }, { href: '/action?delete=1', text: 'Go' },
    { role: 'button', text: 'Purchase', selector: '#purchase' }, { role: 'button', text: 'Open menu', selector: '#menu' }
  ] };
  const actions = jevActionCandidates(page, page.url);
  assert.equal(actions.length, 2);
  assert.equal(actions[0].input.url, 'https://site.test/help');
  assert.equal(jevActionCandidates(page, page.url, actions.map(item => item.key)).length, 0);
  assert.equal(jevActionCandidates(page, page.url, [], ['console_health']).length, 0);
  assert.equal(jevDiagnosticCandidates(page, { securityBlocks: [{ url: 'https://site.test/data' }], network: [{ url: 'https://site.test/data', statusCode: 403 }] }).length, 1); // only the empty-title candidate
});

function fixture(mode = 'qa', overrides = {}) {
  const session = { id: randomUUID(), mode, targetUrl: 'https://site.test/', secretNames: [], findings: [], messages: [], todos: [], activities: [], selectedTests: ['console_health'], runtimeFacts: { executionLevel: 'SIMULATED', userAgent: 'Mozilla/5.0 Chrome/151', os: 'macOS' }, ...overrides };
  const runStore = { async commit() {} };
  if (mode === 'sqa') {
    session.sqa = createSqaState({ authorizationConfirmed: true, profiles: ['core'], attributes: ['web_application'], target: { name: 'Test', release: '1', environment: 'test' } });
    session.todos = createSqaTodoPlan(session.sqa);
  }
  if (mode === 'founder') {
    session.founder = createFounderState({ authorizationConfirmed: true, target: { name: 'Test', url: session.targetUrl }, productContext: { stage: 'development', businessModel: 'Internal', targetCustomer: 'Testers', primaryGoal: 'Verify product' } });
    session.todos = createFounderReviewTodos();
  }
  const tools = [...createQaTools(session, runStore), ...(mode === 'sqa' ? createSqaTools(session, runStore) : mode === 'founder' ? createFounderTools(session, runStore) : [])];
  const calls = [];
  const runtime = {
    agentSession: { continueWithLatestUserMessage() {}, pauseForQuestion(call, question) { this.pending = { ...call, question }; } }, cleanSlateService: {},
    headlessRuntime: { async *executeTool(name, input, id) {
      calls.push({ name, input });
      let result;
      if (name === 'update_todo') { session.todos = input.items.map(item => ({ text: item.content, status: item.status })); result = { success: true }; }
      else if (name === 'browser_snapshot') result = { success: true, url: session.targetUrl, title: 'Test product', bodyText: 'A product for testers.', elements: [] };
      else if (name === 'browser_diagnostics') result = { console: [], network: [] };
      else if (name === 'browser_open') result = { success: true, url: session.targetUrl };
      else if (name === 'browser_qa_check') result = input.action === 'inspect'
        ? { success: true, action: 'inspect', inventory: { url: session.targetUrl, title: 'Test product', text: 'A product for testers.', viewport: { width: 1440, height: 900 }, links: [], forms: [], search: [], disclosures: [], images: 0, players: 0 }, assertions: [] }
        : { success: true, action: input.action, assertions: [], fields: [] };
      else if (name === 'browser_screenshot') result = { success: true };
      else result = await tools.find(tool => tool.name === name).run(input);
      if (name.startsWith('browser_')) session.activities.push({ id, ts: Date.now(), toolName: name, status: 'done', summary: 'Observed test page' });
      yield { type: 'tool_result', toolName: name, toolCallId: id, result };
    } }
  };
  let requested = 0;
  installJevRuntime(runtime, { session, runStore, configuration: { apiKey: 'test', model: 'jev-1.13' }, fetchImpl: async (url, options) => {
    assert.equal(url, JEV_ENDPOINT); requested++;
    const body = JSON.parse(options.body);
    return Response.json(reply(Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === 'noul' ? { type: 'noul', noul: 0.99 } : { type: 'choice', choice: id === 'verdict' ? 'pass' : id.startsWith('c') ? 'blocked' : id.startsWith('f') ? 'unknown' : 'finish' }]))));
  } });
  return { runtime, session, calls, requested: () => requested };
}
for (const mode of ['qa', 'sqa', 'founder']) test(`native ${mode} controller publishes its artifact through existing finalizer validation`, async () => {
  const f = fixture(mode);
  for await (const part of f.runtime.run('Review the authorized page.', new AbortController().signal)) assert.ok(part.type);
  const artifact = mode === 'qa' ? f.session.report : mode === 'sqa' ? f.session.sqa.assessment : f.session.founder.report;
  assert.ok(artifact);
  assert.ok(f.requested() > 0);
  assert.ok(f.calls.some(item => item.name === 'browser_snapshot'));
  await assert.rejects(f.runtime.cleanSlateService.chat(), /native JEV controller/);
});
test('completed browser checks with missing workflows publish partial, not blocked or pass', async () => {
  const f = fixture('qa', { selectedTests: ['console_health', 'forms', 'authentication'] });
  for await (const _ of f.runtime.run('Review.', new AbortController().signal)) { /* consume */ }
  assert.equal(f.session.report.verdict, 'partial');
  assert.ok(f.session.report.notCovered.some(item => item.includes('forms')));
  assert.ok(f.session.report.covered.some(item => item.includes('console_health (tested)')));
});
test('missing browser diagnostics cannot produce a passing console-health report', async () => {
  const f = fixture();
  const execute = f.runtime.headlessRuntime.executeTool;
  f.runtime.headlessRuntime.executeTool = async function* (name, input, id) {
    if (name === 'browser_diagnostics') yield { type: 'tool_result', toolName: name, toolCallId: id, result: { success: false, error: 'Renderer unavailable' } };
    else yield* execute(name, input, id);
  };
  for await (const _ of f.runtime.run('Review.', new AbortController().signal)) { /* consume */ }
  assert.equal(f.session.report.verdict, 'blocked');
  assert.ok(f.session.report.notCovered.some(item => item.includes('console_health')));
});
test('JEV config defaults and probes use decisions and never expose the key', async () => {
  const previous = { ...process.env };
  try {
    Object.assign(process.env, { QASE_PROVIDER: 'jev', JEV_API_KEY: 'private-jev-key' });
    delete process.env.QASE_MODEL; delete process.env.QASE_BASE_URL; delete process.env.QASE_API_KEY;
    await withUserConfiguration({}, () => {}, async () => {
      const config = getConfig();
      assert.equal(config.model, 'jev-1.13'); assert.equal(config.baseUrl, JEV_ENDPOINT);
      assert.equal(getPublicConfig().hasApiKey, true);
      assert.equal(JSON.stringify(getPublicConfig()).includes('private-jev-key'), false);
      assert.ok(envKeyDestinationProblem({ ...config, provider: 'custom' }));
      const result = await testConnection({}, { fetchImpl: async url => { assert.equal(url, JEV_ENDPOINT); return Response.json(reply({ ready: { type: 'noul', noul: 0.99 } })); } });
      assert.equal(result.decisionVerified, true);
      assert.equal(result.completionVerified, false);
    });
  } finally { for (const key of ['QASE_PROVIDER', 'JEV_API_KEY', 'QASE_MODEL', 'QASE_BASE_URL', 'QASE_API_KEY']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } }
});

test('operator model lock overrides saved account providers and rejects model switching', async () => {
  const keys = ['QASE_PROVIDER', 'QASE_MODEL', 'QASE_BASE_URL', 'JEV_API_KEY', 'QASE_LOCK_MODEL', 'QASE_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { QASE_LOCK_MODEL: 'true', QASE_PROVIDER: 'jev', QASE_MODEL: 'jev-1.13', QASE_BASE_URL: JEV_ENDPOINT, JEV_API_KEY: 'private-test-key' });
    delete process.env.QASE_API_KEY;
    await withUserConfiguration({ provider: 'anthropic', model: 'old-model', baseUrl: 'https://old.test', apiKey: 'old-user-key' }, async () => {}, async () => {
      assert.equal(getConfig().provider, 'jev');
      assert.equal(getConfig().model, 'jev-1.13');
      assert.equal(getConfig().apiKey, 'private-test-key');
      assert.equal(getPublicConfig().apiKeyFromEnv, true);
      assert.throws(() => saveConfig({ model: 'other-model' }), /locked/);
    });
  } finally { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
});
