import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createHybridAuthentication, prepareHybridAuthGrant } from './hybridAuth.js';
import { storeSecrets, clearSecrets } from './secrets.js';

test('an exact owner-approved authentication API permits one cross-origin sign-in without widening other writes', { timeout: 25000 }, async t => {
  const endpoint = 'https://auth.fixture.test/v2/session/issue', accepted = [], blocked = [];
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>API sign-in fixture</title><form><input type="email" required><input type="password" required><button type="submit">Sign in</button></form><script>
      document.querySelector('form').onsubmit=async event=>{event.preventDefault(); const fields={email:document.querySelector('input[type=email]').value,password:document.querySelector('input[type=password]').value};
        const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(fields)};
        await fetch(${JSON.stringify(endpoint)},options);
        fetch(${JSON.stringify(endpoint)},options).catch(()=>{});
        fetch('https://unapproved.fixture.test/login',options).catch(()=>{});
        document.body.innerHTML='<h1>Private dashboard</h1><button>Sign out</button>';
      };
    </script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', ownerUserId: 'owner', targetUrl: `${origin}/`, hybrid: {}, pendingQuestion: { credentialLike: true } };
  const fields = { QA_USERNAME: 'test@example.invalid', QA_PASSWORD: 'fixture-private-password' };
  session.hybrid.authentication = prepareHybridAuthGrant(session, { authorizeLogin: true, fields, loginEndpoint: endpoint });
  storeSecrets(session.id, fields); t.after(() => clearSecrets(session.id));
  const controller = createHybridAuthentication(session), browser = await chromium.launch();
  t.after(() => browser.close()); const context = await browser.newContext({ serviceWorkers: 'block' });
  // The HTTPS API is a deterministic transport fixture, never a live host.
  await context.route('**/*', async route => {
    const request = route.request(), decision = controller.requestDecision(request);
    if (decision?.allowed === false) { blocked.push(decision.code); await route.abort(); return; }
    if (request.url() === endpoint) {
      if (request.method() === 'POST') accepted.push({ method: request.method(), url: request.url() });
      await route.fulfill({ status: request.method() === 'OPTIONS' ? 204 : 200, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type' }, contentType: 'application/json', body: request.method() === 'OPTIONS' ? '' : '{}' }); return;
    }
    if (request.url().startsWith(origin) && request.method() === 'GET') { await route.continue(); return; }
    await route.abort();
  });
  const page = await context.newPage(); await page.goto(session.targetUrl);
  const result = await controller.signIn({ getPage: () => page, reopen: url => page.goto(url, { waitUntil: 'domcontentloaded' }) });
  assert.equal(result.status, 'authenticated', JSON.stringify(result)); assert.equal(result.verified, true);
  assert.deepEqual(accepted, [{ method: 'POST', url: endpoint }]); assert.ok(blocked.length >= 2);
  assert.ok(!JSON.stringify(result).includes(fields.QA_PASSWORD));
  assert.equal((await controller.signIn({ getPage: () => page })).code, 'HYBRID_AUTH_APPROVAL_REQUIRED');
});

for (const recognized of [true, false]) test(`sign-in without a logout marker ${recognized ? 'recognizes a bounded session receipt' : 'does not treat HTTP 200 as authenticated access'}`, { timeout: 25000 }, async t => {
  const endpoint = 'https://auth.fixture.test/session/login';
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<form><input type="email" required><input type="password" required><button type="submit">Sign in</button></form><script>
      document.querySelector('form').onsubmit=async event=>{ event.preventDefault();
        await fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.querySelector('input[type=email]').value,password:document.querySelector('input[type=password]').value})});
        history.replaceState({},'', '/private'); document.body.innerHTML='<h1>Platform workspace</h1>';
      };
    </script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', ownerUserId: 'owner', targetUrl: `${origin}/login`, hybrid: {}, pendingQuestion: { credentialLike: true } };
  const fields = { QA_USERNAME: 'test@example.invalid', QA_PASSWORD: 'fixture-private-password' };
  session.hybrid.authentication = prepareHybridAuthGrant(session, { authorizeLogin: true, fields, loginEndpoint: endpoint });
  storeSecrets(session.id, fields); t.after(() => clearSecrets(session.id));
  const controller = createHybridAuthentication(session), browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const responseBody = JSON.stringify(recognized ? { access_token: 'fixture-session-token-123456789', token_type: 'bearer' } : { error: 'fixture login not established' });
  await context.route('**/*', async route => {
    const request = route.request(), decision = controller.requestDecision(request);
    if (decision?.allowed === false) return route.abort();
    if (request.url() === endpoint) return route.fulfill({ status: request.method() === 'OPTIONS' ? 204 : 200,
      headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Content-Length': String(request.method() === 'OPTIONS' ? 0 : Buffer.byteLength(responseBody)) },
      contentType: 'application/json', body: request.method() === 'OPTIONS' ? '' : responseBody });
    if (request.url().startsWith(origin) && request.method() === 'GET') return route.continue();
    return route.abort();
  });
  const page = await context.newPage(); await page.goto(session.targetUrl);
  const result = await controller.signIn({ getPage: () => page, reopen: url => page.goto(url, { waitUntil: 'domcontentloaded' }) });
  assert.equal(result.status, recognized ? 'authenticated' : 'verification_needed', JSON.stringify(result));
  assert.equal(Boolean(result.verified), recognized);
  assert.ok(!JSON.stringify(session.hybrid.authentication).includes('fixture-session-token'));
  assert.ok(!JSON.stringify(result).includes(fields.QA_PASSWORD));
});
