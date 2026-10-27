import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridProfile, OPUS_MODEL } from './hybridConfig.js';
import { qualifyHybridGateway } from './hybridGatewayQualification.js';

function gatewayFixture() {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.includes('/decisions')) return Response.json({ model: 'typesafe/jev-1.13-20260917', answers: { state: { type: 'choice', choice: 'unresolved' } }, usage: { input_tokens: 2, output_tokens: 2 } });
    if (body.max_tokens === 128) return new Promise((resolve, reject) => { const cancel = () => reject(options.signal.reason); if (options.signal.aborted) cancel(); else options.signal.addEventListener('abort', cancel, { once: true }); });
    if (body.stream) return new Response(`data: ${JSON.stringify({ model: OPUS_MODEL, choices: [{ delta: { content: 'OK' } }] })}\n\ndata: ${JSON.stringify({ model: OPUS_MODEL, choices: [], usage: { prompt_tokens: 2, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    let message = { content: 'OK' };
    if (body.tools && body.tool_choice !== 'none') message = { content: null, tool_calls: (body.parallel_tool_calls ? ['alpha', 'beta'] : ['alpha']).map((value, index) => ({ id: `call-${index}`, type: 'function', function: { name: 'qa_echo', arguments: JSON.stringify({ value }) } })) };
    else if (body.tool_choice === 'none') message = { content: 'alpha' };
    else if (body.response_format) message = { content: '{"ok":true}' };
    else if (Array.isArray(body.messages[0].content)) message = { content: 'red' };
    return Response.json({ model: OPUS_MODEL, choices: [{ message }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
  };
}

test('gateway qualification verifies protocol behavior and a separate actual-SDK usage prerequisite', async () => {
  const profile = hybridProfile({ apiKey: 'fixture-key' }, {});
  const report = await qualifyHybridGateway(profile, { fetchImpl: gatewayFixture(), sdkProbe: async () => ({ continuationVerified: true, usageReported: false }), imageUrl: 'data:image/png;base64,fixture' });
  assert.equal(report.capabilities.nativeTools.passed, true);
  assert.equal(report.capabilities.multipleTools.passed, true);
  assert.equal(report.capabilities.continuation.passed, true);
  assert.equal(report.capabilities.streaming.passed, true);
  assert.equal(report.capabilities.cancellation.passed, true);
  assert.equal(report.capabilities.timeout.passed, true);
  assert.equal(report.capabilities.sdkLoop.passed, true);
  assert.equal(report.capabilities.sdkUsage.passed, false);
  assert.equal(report.passed, false);
  assert.doesNotMatch(JSON.stringify(report), /fixture-key/);
});
