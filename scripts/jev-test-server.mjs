import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createJevClient } from '../server/jevClient.js';

export function createJevTestServer({ apiKey, fetchImpl = fetch } = {}) {
  const client = apiKey ? createJevClient({ apiKey }, { fetchImpl }) : undefined;
  let busy = false;
  return http.createServer(async (request, response) => {
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Use the local 127.0.0.1 page.' });
    if (request.method === 'GET' && request.url === '/healthz') return send(200, { status: 'ok', model: 'jev-1.13', configured: Boolean(client) });
    if (request.method === 'GET' && ['/', '/jev-test.js'].includes(request.url)) {
      const script = request.url !== '/';
      response.writeHead(200, { 'Content-Type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' });
      return response.end(readFileSync(new URL(script ? './jev-test.js' : './jev-test.html', import.meta.url)));
    }
    if (request.method !== 'POST' || request.url !== '/api/decision') return send(404, { error: 'Not found.' });
    if (request.headers.origin !== origin || !String(request.headers['content-type']).startsWith('application/json')) return send(403, { error: 'Use the local test form.' });
    if (!client) return send(503, { error: 'JEV_API_KEY is missing.' });
    if (busy) return send(429, { error: 'A decision is already running.' });
    busy = true;
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64000) return send(413, { error: 'Request is too large.' });
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(400, { error: 'Invalid JSON.' }); }
      if (typeof body.state !== 'string' || !body.state.trim() || body.state.length > 30000 || typeof body.instructions !== 'string' || !body.instructions.trim() || body.instructions.length > 4000 || !['noul', 'score', 'choice'].includes(body.type)) return send(400, { error: 'Supply evidence, instructions, and a supported decision type.' });
      const question = { type: body.type, instructions: body.instructions, ...(body.criteria === undefined ? {} : { criteria: body.criteria }) };
      const started = Date.now();
      const result = await client.decide(body.state, { result: question }, { signal: controller.signal });
      send(200, { ...result, elapsedMs: Date.now() - started });
    } catch (error) { if (!response.destroyed) send(502, { error: error.message }); }
    finally { busy = false; }
  });
}
