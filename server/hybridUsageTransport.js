/** Hybrid-only HTTP adapter at the SDK's supported custom-provider baseUrl.
 * No SDK/package/global-fetch patches. The SDK still serializes messages,
 * parses SSE and owns its agent loop. Only include_usage is added on the wire.
 */
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { OPUS_ENDPOINT, OPUS_MODEL, HYBRID_USAGE_TRANSPORT } from './hybridConfig.js';

export class HybridUsageError extends Error {
  constructor(code = 'OPUS_USAGE_UNVERIFIED') {
    super(`${code}: exact provider usage could not be verified; hybrid execution must pause.`);
    this.name = 'HybridUsageError'; this.code = code;
  }
}

export function exactStreamUsage(value) {
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  if (!value || !fields.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
      value.total_tokens !== value.prompt_tokens + value.completion_tokens) throw new HybridUsageError();
  const cached = value.prompt_tokens_details?.cached_tokens;
  if (cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0 || cached > value.prompt_tokens)) throw new HybridUsageError();
  return { inputTokens: value.prompt_tokens, outputTokens: value.completion_tokens, totalTokens: value.total_tokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}), estimated: false };
}

export async function createHybridUsageTransport(profile, { fetchImpl = fetch, onUsage = () => {} } = {}) {
  if (profile.reasoner.endpoint !== OPUS_ENDPOINT || profile.reasoner.model !== OPUS_MODEL || !profile.reasoner.apiKey) throw new HybridUsageError('OPUS_TRANSPORT_PROFILE');
  const apiKey = randomBytes(32).toString('hex');
  const controllers = new Set();
  let active, disposed = false, authority;
  const server = http.createServer(async (request, response) => {
    const scope = active;
    // A random per-runtime credential, exact host/path and no CORS. The real
    // account key never traverses loopback or appears in SDK configuration.
    if (disposed || request.method !== 'POST' || request.url !== '/v1/chat/completions' ||
        request.headers.host !== authority || request.headers.authorization !== `Bearer ${apiKey}` || !scope || scope.cancelled) {
      request.resume(); response.writeHead(403); response.end(); return;
    }
    if (scope.length) {
      scope.error = new HybridUsageError('OPUS_TRANSPORT_RETRY');
      request.resume(); response.writeHead(400); response.end(); return;
    }
    const controller = new AbortController(); controllers.add(controller);
    let resolveDone;
    const receipt = { callId: randomUUID(), done: new Promise(resolve => { resolveDone = resolve; }) };
    scope.push(receipt);
    const cancel = () => controller.abort();
    response.on('close', cancel);
    const timer = setTimeout(cancel, profile.budgets.reasonerTimeoutMs);
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw new HybridUsageError('OPUS_REQUEST_LIMIT');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (body.model !== OPUS_MODEL || body.stream !== true || !Array.isArray(body.messages)) throw new HybridUsageError('OPUS_TRANSPORT_PROFILE');
      const upstream = await fetchImpl(OPUS_ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${profile.reasoner.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream_options: { ...body.stream_options, include_usage: true } }) });
      if (!upstream.ok || !upstream.headers.get('content-type')?.includes('text/event-stream') || !upstream.body) throw new HybridUsageError('OPUS_TRANSPORT_RESPONSE');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      response.flushHeaders();
      const reader = upstream.body.getReader(), decoder = new TextDecoder();
      let buffer = '', received = 0, ended = false, usage;
      const write = async frame => { if (!response.write(frame)) await once(response, 'drain', { signal: controller.signal }); };
      async function frame(raw) {
        const lines = raw.split(/\r?\n/).filter(line => line.startsWith('data:'));
        if (!lines.length) return;
        const data = lines.map(line => line.slice(5).trimStart()).join('\n');
        if (data === '[DONE]') {
          if (!usage) throw new HybridUsageError();
          receipt.usage = { ...usage, callId: receipt.callId }; ended = true;
        } else {
          const event = JSON.parse(data);
          if (event.error || (event.model !== undefined && event.model !== OPUS_MODEL)) throw new HybridUsageError('OPUS_TRANSPORT_RESPONSE');
          if (event.usage != null) {
            const next = exactStreamUsage(event.usage);
            if (usage && JSON.stringify(usage) !== JSON.stringify(next)) throw new HybridUsageError('OPUS_USAGE_CONFLICT');
            usage = next;
          }
        }
        await write(`${raw}\n\n`);
      }
      try {
        while (!ended) {
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > 4 * 1024 * 1024) throw new HybridUsageError('OPUS_RESPONSE_LIMIT');
          buffer += decoder.decode(part.value, { stream: true });
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const raw = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            await frame(raw); if (ended) break;
          }
        }
        if (!ended) throw new HybridUsageError();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      response.end();
    } catch (error) {
      receipt.error = error instanceof HybridUsageError ? error : new HybridUsageError(controller.signal.aborted ? 'OPUS_TRANSPORT_CANCELLED' : 'OPUS_TRANSPORT_FAILED');
      // Never reflect upstream bodies/errors (may contain prompts or secrets).
      // A non-retriable status prevents the SDK client's automatic HTTP retry.
      if (!response.headersSent) { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: receipt.error.message } })); }
      else if (!response.destroyed) response.end(`data: ${JSON.stringify({ error: { message: receipt.error.message } })}\n\n`);
    } finally { clearTimeout(timer); response.off('close', cancel); controllers.delete(controller); resolveDone(); }
  });
  server.requestTimeout = profile.budgets.reasonerTimeoutMs;
  server.headersTimeout = Math.min(10000, profile.budgets.reasonerTimeoutMs);
  server.maxConnections = 4;
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); server.unref();
  authority = `127.0.0.1:${server.address().port}`;
  return {
    baseUrl: `http://${authority}/v1`, apiKey, version: HYBRID_USAGE_TRANSPORT,
    wrapChat(chat) {
      return async (messages, options = {}) => {
        // QASE-only correlation metadata never reaches the SDK or gateway.
        const { qaseBudgetReservationId, ...sdkOptions } = options;
        // A cancelled SDK run can finish before its prefetched stream read
        // unwinds. Drain only that cancelled scope; concurrent live model
        // calls still fail closed instead of sharing accounting ownership.
        if (active?.cancelled) await active.closed;
        if (active || disposed) throw new HybridUsageError('OPUS_TRANSPORT_BUSY');
        if (options?.cancellationToken?.isCancellationRequested) return (async function* () {})();
        const scope = []; active = scope;
        let resolveClosed;
        scope.closed = new Promise(resolve => { resolveClosed = resolve; });
        const subscription = options?.cancellationToken?.onCancellationRequested(() => { scope.cancelled = true; for (const controller of controllers) controller.abort(); });
        const publish = () => { for (const entry of scope) if (entry.usage && !entry.published) { entry.published = true; onUsage({ ...entry.usage, ...(qaseBudgetReservationId ? { reservationId: qaseBudgetReservationId } : {}) }); } };
        const release = async () => {
          for (const controller of controllers) controller.abort();
          await Promise.all(scope.map(entry => entry.done));
          try { publish(); }
          finally { subscription?.dispose(); if (active === scope) active = undefined; resolveClosed(); }
        };
        let stream;
        try { stream = await chat(messages, sdkOptions); }
        catch (error) { await release(); if (options?.cancellationToken?.isCancellationRequested) return (async function* () {})(); throw scope.error || scope.find(entry => entry.error)?.error || new HybridUsageError('OPUS_TRANSPORT_FAILED'); }
        return (async function* () {
          const tools = [];
          try {
            for await (const part of stream) {
              // The SDK can execute tools while it reads the provider stream.
              // Hold them until terminal usage is validated, not just until
              // the gateway's earlier finish_reason=tool_calls arrives.
              if (part.type === 'tool_call') tools.push(part);
              else yield part;
            }
            await Promise.all(scope.map(entry => entry.done)); publish();
            if (options?.cancellationToken?.isCancellationRequested) return;
            if (scope.error || !scope.length || scope.some(entry => entry.error || !entry.usage)) throw scope.error || scope.find(entry => entry.error)?.error || new HybridUsageError();
            for (const part of tools) yield part;
          } catch (error) {
            // CleanSlate may leave a prefetched iterator.next() outstanding
            // on explicit cancellation. Resolve that read without releasing
            // any tool; missing usage is never synthesized or accounted.
            if (!options?.cancellationToken?.isCancellationRequested) throw scope.error || scope.find(entry => entry.error)?.error || (error instanceof HybridUsageError ? error : new HybridUsageError('OPUS_TRANSPORT_FAILED'));
          } finally { await release(); }
        })();
      };
    },
    dispose() {
      disposed = true; for (const controller of controllers) controller.abort();
      server.closeAllConnections(); server.close();
    }
  };
}
