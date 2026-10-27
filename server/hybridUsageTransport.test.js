import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CleanSlateNodeAgentRuntime, createNodeProviderConfiguration } from '@cleanslate/sdk';
import { hybridProfile, OPUS_MODEL, OPUS_ENDPOINT, hybridEnabled, profileIdentity } from './hybridConfig.js';
import { createHybridUsageTransport, exactStreamUsage } from './hybridUsageTransport.js';
import { attachUsageCapture, createUsageLedger, applyUsage } from './usageCapture.js';
import { createHybridModelRouter } from './hybridModelRouter.js';
import { createHybridTelemetry } from './hybridTelemetry.js';

const profile = () => hybridProfile({ apiKey: 'isolated-transport-fixture' }, {});
const wire = event => `data: ${typeof event === 'string' ? event : JSON.stringify({ model: OPUS_MODEL, ...event })}\r\n\r\n`;
const usage = { prompt_tokens: 17, completion_tokens: 9, total_tokens: 26, prompt_tokens_details: { cached_tokens: 3 } };
const end = () => wire({ choices: [], usage }) + wire('[DONE]');
const text = content => wire({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
function response(body) {
  const bytes = new TextEncoder().encode(body); let index = 0;
  return new Response(new ReadableStream({ pull(controller) { if (index >= bytes.length) controller.close(); else { controller.enqueue(bytes.slice(index, index + 31)); index += 31; } } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
function sdk(t, transport, maxTurns = 4) {
  const runtime = new CleanSlateNodeAgentRuntime({ rootPath: fs.mkdtempSync(path.join(os.tmpdir(), 'qase-usage-sdk-')),
    configuration: createNodeProviderConfiguration({ provider: 'custom', model: OPUS_MODEL, baseUrl: transport.baseUrl, apiKey: transport.apiKey, maxTurns }),
    approveCommand: async () => false, approveTool: async ({ toolName }) => toolName === 'qa_echo',
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const reports = [];
  const release = attachUsageCapture(runtime.cleanSlateService, { onUsage: item => reports.push(item) });
  runtime.cleanSlateService.chat = transport.wrapChat(runtime.cleanSlateService.chat.bind(runtime.cleanSlateService));
  t.after(() => { release(); runtime.dispose(); transport.dispose(); });
  return { runtime, reports };
}
async function consume(stream) { const parts = []; for await (const item of stream) parts.push(item); return parts; }

test('installed SDK continues past the former false budget stop with correlated exact streaming receipts', { timeout: 20000 }, async t => {
  const p = profile(), session = { id: 'budget-sdk-fixture', hybrid: {} }, telemetry = createHybridTelemetry(session.hybrid);
  let durable, requests = 0, tools = 0;
  const router = createHybridModelRouter({ session, profile: p, telemetry, checkpoint: async () => { durable = structuredClone(session.hybrid); } });
  const transport = await createHybridUsageTransport(p, { onUsage: item => router.reasonerUsage(item), fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests++;
    assert.equal(body.qaseBudgetReservationId, undefined);
    assert.equal(body.stream_options.include_usage, true);
    if (requests > 1) assert.ok(body.messages.some(item => item.role === 'tool'));
    const finish = wire({ choices: [], usage: { prompt_tokens: 24000, completion_tokens: 100, total_tokens: 24100 } }) + wire('[DONE]');
    return response((requests <= 6 ? wire({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `receipt-${requests}`, type: 'function', function: { name: 'qa_echo', arguments: JSON.stringify({ value: String(requests) }) } }] }, finish_reason: 'tool_calls' }] }) : text('Complete fixture.')) + finish);
  } });
  const { runtime } = sdk(t, transport, 10);
  const original = runtime.cleanSlateService.chat.bind(runtime.cleanSlateService);
  runtime.cleanSlateService.chat = (messages, options) => router.reasoner(original, messages, options);
  const tool = { name: 'qa_echo', category: 'qa', description: 'Read-only fixture.', parametersSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }, async run() {
    tools++; assert.equal(telemetry.metrics.reasoner.reservedTokens, 0);
    assert.equal(telemetry.metrics.reasoner.inputTokens, tools * 24000); return { success: true };
  } };
  runtime.headlessRuntime.options.tools = [tool]; runtime.headlessRuntime.toolsByName.clear(); runtime.headlessRuntime.toolsByName.set(tool.name, tool);
  const parts = await consume(runtime.run('Read-only immutable fixture context: ' + 'x'.repeat(30000)));
  assert.equal(requests, 7, JSON.stringify({ requests, tools, events: parts.filter(item => item.type === 'error').map(item => item.message || item.error), calls: telemetry.metrics.reasoner.calls }));
  assert.ok(parts.some(item => item.type === 'chat_text' && item.content.includes('Complete fixture.')));
  assert.equal(requests, 7); assert.equal(tools, 6);
  assert.equal(durable.telemetry.reasoner.inputTokens + durable.telemetry.reasoner.outputTokens, 168700);
  assert.equal(durable.telemetry.reasoner.reservedTokens, 0);
  assert.equal(durable.modelBudget.roles.reasoner.reservations.every(item => item.status === 'settled'), true);
});

test('only exact consistent provider integers qualify; estimates and incomplete usage never qualify', () => {
  assert.deepEqual(exactStreamUsage(usage), { inputTokens: 17, outputTokens: 9, totalTokens: 26, cachedInputTokens: 3, estimated: false });
  for (const value of [undefined, {}, { ...usage, total_tokens: undefined }, { ...usage, total_tokens: 25 },
    { ...usage, prompt_tokens: -1 }, { ...usage, completion_tokens: 1.2 }, { ...usage, prompt_tokens: '17' },
    { ...usage, prompt_tokens_details: { cached_tokens: 18 } }]) assert.throws(() => exactStreamUsage(value), /usage could not be verified/);
});

test('adapter requests exact usage through the unmodified SDK loop, native multi-tool calls and continuation', { timeout: 20000 }, async t => {
  const calls = [], exact = [], forwarded = [];
  const transport = await createHybridUsageTransport(profile(), { onUsage: item => exact.push(item), fetchImpl: async (url, options) => {
    assert.equal(url, OPUS_ENDPOINT); assert.equal(options.headers.Authorization, 'Bearer isolated-transport-fixture');
    const body = JSON.parse(options.body); forwarded.push(body);
    assert.equal(body.stream_options.include_usage, true); assert.equal(body.model, OPUS_MODEL);
    if (body.messages.some(item => item.role === 'tool')) return response(text('fixture-received') + end());
    assert.ok(body.tools.some(item => item.function.name === 'qa_echo'));
    const tools = ['alpha', 'beta'].map((value, index) => ({ index, id: `echo-${index}`, type: 'function', function: { name: 'qa_echo', arguments: JSON.stringify({ value }) } }));
    return response(wire({ choices: [{ index: 0, delta: { tool_calls: tools }, finish_reason: null }] }) + wire({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }) + end());
  } });
  const { runtime, reports } = sdk(t, transport);
  assert.equal(runtime.run, Object.getPrototypeOf(runtime).run);
  const tool = { name: 'qa_echo', category: 'qa', description: 'Harmless observation.', parametersSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    async run(input) { assert.equal(exact.length, 1, 'Exact usage must be committed before executing a streamed tool'); calls.push(input.value); return { success: true, observation: 'fixture-received' }; } };
  runtime.headlessRuntime.options.tools = [tool]; runtime.headlessRuntime.toolsByName.clear(); runtime.headlessRuntime.toolsByName.set(tool.name, tool);
  const parts = await consume(runtime.run('Call qa_echo twice, then return fixture-received.'));
  assert.deepEqual(calls.sort(), ['alpha', 'beta']); assert.equal(forwarded.length, 2);
  assert.ok(parts.some(item => item.type === 'chat_text' && item.content.includes('fixture-received')));
  assert.equal(reports.length, 2); assert.equal(exact.length, 2);
  assert.equal(reports.reduce((n, item) => n + item.totalTokens, 0), 52);
  const ledger = createUsageLedger(); let total;
  for (const item of [...exact, ...exact]) { const tracked = ledger.track(item); if (tracked) total = applyUsage(total, tracked); }
  assert.equal(total.totalTokens, 52); assert.equal(total.estimated, false); assert.equal(total.cachedInputTokens, 6);
});

test('text streams before completion but tool calls never escape missing, conflicting or truncated accounting', { timeout: 20000 }, async t => {
  for (const suffix of [wire('[DONE]'), wire({ choices: [], usage }),
    end().replace(wire('[DONE]'), wire({ choices: [], usage: { ...usage, total_tokens: 27 } }) + wire('[DONE]'))]) {
    const exact = []; let attempts = 0;
    const transport = await createHybridUsageTransport(profile(), { onUsage: item => exact.push(item), fetchImpl: async () => { attempts++; return response(text('unverified') + wire({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'unverified-call', type: 'function', function: { name: 'qa_echo', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + suffix); } });
    const { runtime } = sdk(t, transport); const seen = [];
    await assert.rejects(async () => { for await (const part of await runtime.cleanSlateService.chat([{ role: 'user', content: 'fixture' }])) seen.push(part); });
    assert.equal(seen.some(item => item.type === 'tool_call'), false); assert.equal(exact.length, 0);
    assert.equal(attempts, 1, 'Malformed streams must not trigger invisible SDK HTTP retries');
  }
});

test('streaming remains incremental, client cancellation aborts upstream and a later call can recover', { timeout: 10000 }, async t => {
  let aborted = false, mode = 'stream', closeStream;
  let resolveAborted; const upstreamAborted = new Promise(resolve => { resolveAborted = resolve; });
  const transport = await createHybridUsageTransport(profile(), { fetchImpl: async (_url, options) => {
    if (mode === 'recovered') return response(text('OK') + end());
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(text('first chunk')));
      closeStream = () => { aborted = true; controller.error(new Error('cancelled fixture')); resolveAborted(); };
      options.signal.addEventListener('abort', closeStream, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const { runtime } = sdk(t, transport); const controller = new AbortController();
  const parts = [];
  try {
    for await (const part of runtime.run('Return text only.', controller.signal)) {
      parts.push(part); if (part.type === 'chat_text') { controller.abort(); break; }
    }
  } catch { /* cancellation may end or throw */ }
  assert.ok(parts.some(item => item.type === 'chat_text' && item.content === 'first chunk'));
  await upstreamAborted;
  assert.equal(aborted, true);
  mode = 'recovered';
  const recovered = await consume(await runtime.cleanSlateService.chat([{ role: 'user', content: 'fixture' }]));
  assert.ok(recovered.some(item => item.type === 'text' && item.content === 'OK'));
});

test('deadline aborts the transport; invalid upstream responses are not retried or exposed', { timeout: 10000 }, async t => {
  const p = profile(); p.budgets.reasonerTimeoutMs = 30; let aborted = false;
  const transport = await createHybridUsageTransport(p, { fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(options.signal.reason); }, { once: true });
  }) });
  const { runtime } = sdk(t, transport);
  await assert.rejects(consume(await runtime.cleanSlateService.chat([{ role: 'user', content: 'fixture' }])));
  assert.equal(aborted, true);
  let attempts = 0;
  const failing = await createHybridUsageTransport(profile(), { fetchImpl: async () => { attempts++; return new Response('SECRET_PROVIDER_BODY', { status: 503 }); } });
  const next = sdk(t, failing).runtime;
  await assert.rejects(consume(await next.cleanSlateService.chat([{ role: 'user', content: 'fixture' }])), error => !error.message.includes('SECRET_PROVIDER_BODY'));
  assert.equal(attempts, 1);
});

test('loopback is authenticated, fixed-destination and unavailable outside an active model call', async t => {
  let requests = 0;
  const p = profile();
  const transport = await createHybridUsageTransport(p, { fetchImpl: async () => { requests++; return response(end()); } });
  t.after(() => transport.dispose());
  const unauthorized = await fetch(`${transport.baseUrl}/chat/completions`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 403);
  const idle = await fetch(`${transport.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${transport.apiKey}` }, body: '{}' });
  assert.equal(idle.status, 403); assert.equal(requests, 0);
  assert.notEqual(transport.apiKey, p.reasoner.apiKey);
  await assert.rejects(createHybridUsageTransport({ ...p, reasoner: { ...p.reasoner, endpoint: 'https://outside.test/' } }), /OPUS_TRANSPORT_PROFILE/);
  assert.notEqual(profileIdentity(p), profileIdentity({ ...p, usageTransport: 'unqualified-adapter' }));
});

test('hybrid remains disabled by default independently of transport availability', () => {
  const saved = process.env.QASE_HYBRID_QA_ENABLED;
  try { delete process.env.QASE_HYBRID_QA_ENABLED; assert.equal(hybridEnabled(), false); }
  finally { if (saved !== undefined) process.env.QASE_HYBRID_QA_ENABLED = saved; }
});

test('wrong models, malformed events and repeated authorized requests fail without releasing tools', async t => {
  let upstream = 0;
  const transport = await createHybridUsageTransport(profile(), { fetchImpl: async () => { upstream++; return response(text('fixture') + end()); } });
  t.after(() => transport.dispose());
  const local = body => fetch(`${transport.baseUrl}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${transport.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const wrong = transport.wrapChat(async () => { const reply = await local({ model: 'unapproved-model', stream: true, messages: [] }); assert.equal(reply.status, 400); return (async function* () { yield { type: 'tool_call', call: { toolName: 'must-not-run' } }; })(); });
  await assert.rejects(consume(await wrong([], {})), error => error.code === 'OPUS_TRANSPORT_PROFILE');
  assert.equal(upstream, 0);
  const repeat = transport.wrapChat(async () => {
    const body = { model: OPUS_MODEL, stream: true, messages: [] };
    await (await local(body)).text();
    assert.equal((await local(body)).status, 400);
    return (async function* () { yield { type: 'tool_call', call: { toolName: 'must-not-run' } }; })();
  });
  await assert.rejects(consume(await repeat([], {})), error => error.code === 'OPUS_TRANSPORT_RETRY');
  assert.equal(upstream, 1);
  for (const body of [wire({ model: 'unapproved-model', choices: [] }) + end(), 'data: {invalid-json}\n\n' + end()]) {
    const invalid = await createHybridUsageTransport(profile(), { fetchImpl: async () => response(body) });
    const { runtime } = sdk(t, invalid);
    await assert.rejects(consume(await runtime.cleanSlateService.chat([{ role: 'user', content: 'fixture' }])));
  }
});
