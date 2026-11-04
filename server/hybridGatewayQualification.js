import { OPUS_MODEL, HYBRID_SDK_VERSION, profileIdentity, REQUIRED_CAPABILITIES } from './hybridConfig.js';
import { createJevClient } from './jevClient.js';

const tool = { type: 'function', function: { name: 'qa_echo', description: 'Harmless protocol probe. Return the supplied value.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } };
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export async function qualifyHybridGateway(profile, { fetchImpl = fetch, sdkProbe, imageUrl, now = Date.now } = {}) {
  const report = { version: 1, sdkVersion: HYBRID_SDK_VERSION, usageTransport: profile.usageTransport, checkedAt: now(), profileIdentity: profileIdentity(profile),
    reasoner: { model: profile.reasoner.model, endpoint: profile.reasoner.endpoint }, classifier: { model: profile.classifier.model, endpoint: profile.classifier.endpoint }, capabilities: {}, requests: 0 };
  async function test(name, work) {
    const began = now();
    try { const detail = await work(); report.capabilities[name] = { passed: true, elapsedMs: now() - began, ...(detail || {}) }; }
    catch (error) { report.capabilities[name] = { passed: false, elapsedMs: now() - began, reason: String(error.message || error.name).replaceAll(profile.reasoner.apiKey, '[REDACTED]').slice(0, 500) }; }
  }
  async function request(body, { signal, streaming = false } = {}) {
    report.requests++;
    const response = await fetchImpl(profile.reasoner.endpoint, { method: 'POST', redirect: 'error', signal: signal || AbortSignal.timeout(45000),
      headers: { Authorization: `Bearer ${profile.reasoner.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OPUS_MODEL, messages: [{ role: 'user', content: 'Reply with exactly OK.' }], max_tokens: 512, ...body }) });
    assert(response.ok, `Gateway HTTP ${response.status}`);
    if (streaming) return response;
    const bodyText = await response.text(); assert(bodyText.length < 1000000, 'Response limit exceeded');
    const data = JSON.parse(bodyText); assert(data.model === profile.reasoner.model, 'Gateway returned an unexpected model'); return data;
  }
  let basic, native;
  await test('text', async () => { basic = await request({ max_tokens: 32 }); assert(basic.choices?.[0]?.message?.content?.trim() === 'OK', 'Unexpected text response'); return { returnedModel: basic.model }; });
  await test('usage', async () => { assert(Number.isInteger(basic?.usage?.prompt_tokens) && Number.isInteger(basic?.usage?.completion_tokens), 'No valid usage in text response'); return { inputTokens: basic.usage.prompt_tokens, outputTokens: basic.usage.completion_tokens, ...(Number.isFinite(basic.usage.cost) ? { reportedCost: basic.usage.cost } : {}) }; });
  await test('streaming', async () => {
    const response = await request({ stream: true, stream_options: { include_usage: true }, max_tokens: 32 }, { streaming: true });
    assert(response.headers.get('content-type')?.includes('text/event-stream'), 'Missing event-stream content type');
    const text = await response.text(); assert(text.length < 1000000, 'Stream limit exceeded');
    const events = text.split(/\r?\n/).filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)));
    assert(events.map(event => event.choices?.[0]?.delta?.content || '').join('').trim() === 'OK', 'Stream did not reconstruct the response');
    assert(events.some(event => Number.isInteger(event.usage?.prompt_tokens)), 'No stream usage report');
    assert(events.filter(event => event.model).every(event => event.model === OPUS_MODEL), 'Unexpected stream model');
    return { usageReported: true };
  });
  await test('nativeTools', async () => {
    native = await request({ messages: [{ role: 'user', content: 'Call qa_echo with value alpha. Do not answer in prose.' }], tools: [tool], tool_choice: { type: 'function', function: { name: 'qa_echo' } } });
    const call = native.choices?.[0]?.message?.tool_calls?.[0];
    assert(call?.id && call.function?.name === 'qa_echo' && JSON.parse(call.function.arguments).value === 'alpha', 'Native tool call schema mismatch');
  });
  await test('multipleTools', async () => {
    const data = await request({ messages: [{ role: 'user', content: 'Make exactly two qa_echo calls in this response, one with value alpha and another with value beta. Do not answer in prose.' }], tools: [tool], parallel_tool_calls: true });
    const calls = data.choices?.[0]?.message?.tool_calls || [];
    assert(calls.length === 2 && new Set(calls.map(call => call.id)).size === 2 && calls.every(call => call.function?.name === 'qa_echo') && calls.map(call => JSON.parse(call.function.arguments).value).sort().join(',') === 'alpha,beta', 'Expected two valid distinct native calls');
  });
  await test('continuation', async () => {
    const message = native?.choices?.[0]?.message;
    assert(message?.tool_calls?.length === 1, 'Native-tool prerequisite failed');
    const data = await request({ messages: [{ role: 'user', content: 'Call qa_echo with value alpha, then answer only the returned value.' }, message,
      { role: 'tool', tool_call_id: message.tool_calls[0].id, content: 'alpha' }], tools: [tool], tool_choice: 'none', max_tokens: 64 });
    assert(data.choices?.[0]?.message?.content?.trim().toLowerCase() === 'alpha', 'Tool-result continuation failed');
  });
  await test('structured', async () => {
    const data = await request({ messages: [{ role: 'user', content: 'Return a JSON object with exactly one boolean field ok set to true.' }], response_format: { type: 'json_object' }, max_tokens: 64 });
    const value = JSON.parse(data.choices?.[0]?.message?.content); assert(value.ok === true && Object.keys(value).length === 1, 'Structured JSON response failed');
  });
  await test('image', async () => {
    assert(imageUrl?.startsWith('data:image/png;base64,'), 'A generated PNG fixture is required');
    const data = await request({ messages: [{ role: 'user', content: [{ type: 'text', text: 'What color fills this image? Reply with the color name only.' }, { type: 'image_url', image_url: { url: imageUrl } }] }], max_tokens: 32 });
    assert(/\bred\b/i.test(data.choices?.[0]?.message?.content || ''), 'Image fixture color was not recognized');
  });
  await test('cancellation', async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 100);
    try { await request({ max_tokens: 128, messages: [{ role: 'user', content: 'Count from one to one hundred.' }] }, { signal: controller.signal }); throw new Error('Request completed before cancellation could be verified'); }
    catch (error) { assert(controller.signal.aborted && error.name === 'AbortError', 'Client cancellation did not abort the request'); return { scope: 'client transport; server billing/cancellation is not observable' }; }
    finally { clearTimeout(timer); }
  });
  await test('timeout', async () => {
    try { await request({ max_tokens: 128 }, { signal: AbortSignal.timeout(1) }); throw new Error('Request completed before timeout could be verified'); }
    catch (error) { assert(error.name === 'TimeoutError', 'Client deadline was not enforced'); return { scope: 'client transport' }; }
  });
  let sdkResult;
  await test('sdkLoop', async () => { assert(typeof sdkProbe === 'function', 'Installed SDK loop probe is required'); sdkResult = await sdkProbe(); return sdkResult; });
  await test('sdkUsage', async () => { assert(sdkResult?.usageReported === true, 'Installed CleanSlate custom-provider stream does not expose provider usage; hybrid activation is blocked.'); return { usageReported: true }; });
  await test('jev', async () => {
    const response = await createJevClient({ apiKey: profile.classifier.apiKey, baseUrl: profile.classifier.endpoint, model: profile.classifier.model }, { fetchImpl, timeoutMs: 30000 }).decide({ fixture: 'A browser tool returned success=false. No defect has been verified.' }, { state: { type: 'choice', instructions: 'Classify only this supplied fixture.', criteria: { unresolved: 'Tool failed; target defect is not established.', confirmed: 'A reproduced target defect is established.' } } });
    assert(response.answers.state.choice === 'unresolved', 'Classifier could not distinguish an unresolved tool failure'); return { returnedModel: response.model };
  });
  report.passed = REQUIRED_CAPABILITIES.every(key => report.capabilities[key]?.passed === true);
  return report;
}
