import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { ensureRuntime, runTurn, deleteRunSnapshot } from './agent.js';
import { withUserConfiguration } from './config.js';
import { JEV_ENDPOINT } from './jevClient.js';
import { hybridProfile, profileIdentity, REQUIRED_CAPABILITIES, HYBRID_SDK_VERSION } from './hybridConfig.js';
import { prepareHybridAuthGrant } from './hybridAuth.js';
import { storeSecrets, clearSecrets } from './secrets.js';

test('installed CleanSlate asks, pauses, resumes through secure host grant and performs exactly one guarded sign-in', { timeout: 60000 }, async t => {
  // Owned loopback fixture and scripted inference; no live model or real account.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qase-auth-sdk-')), qualification = path.join(root, 'qualification.json');
  const keys = ['QASE_HYBRID_QA_ENABLED', 'QASE_HYBRID_QUALIFICATION_FILE', 'QASE_LOCK_MODEL', 'QASE_HYBRID_OPUS_TOKENS', 'NODE_ENV', 'QASE_ALLOW_PRIVATE_NETWORK', 'JEV_API_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { QASE_HYBRID_QA_ENABLED: 'true', QASE_HYBRID_QUALIFICATION_FILE: qualification, QASE_LOCK_MODEL: 'false', QASE_HYBRID_OPUS_TOKENS: '2000000', NODE_ENV: 'development', QASE_ALLOW_PRIVATE_NETWORK: 'true', JEV_API_KEY: 'isolated-fixture-key' });
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { provider: 'jev', model: 'jev-1.13', baseUrl: JEV_ENDPOINT, apiKey: 'isolated-fixture-key', headless: true, maxTurns: 20 };
  const profile = hybridProfile(settings);
  fs.writeFileSync(qualification, JSON.stringify({ sdkVersion: HYBRID_SDK_VERSION, profileIdentity: profileIdentity(profile), checkedAt: Date.now(), capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(key => [key, { passed: true }])) }));
  const received = [], events = [];
  const server = http.createServer((req, res) => {
    received.push({ method: req.method, url: req.url });
    if (req.url === '/api/login' && req.method === 'POST') { req.resume(); res.setHeader('Set-Cookie', 'fixture_session=approved; HttpOnly; SameSite=Strict'); res.setHeader('Content-Type', 'application/json'); res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<title>Owned sign-in fixture</title><form id="login"><input type="email" name="email" required><input type="password" name="password" required><button type="submit">Sign in</button></form><script>
      login.addEventListener('input', () => fetch('/autosave', {method:'POST',body:'must-not-send'}).catch(()=>{}));
      login.onsubmit=async event=>{event.preventDefault(); const values=Object.fromEntries(new FormData(login));
        await fetch('/api/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
        fetch('/api/login', {method:'POST',body:JSON.stringify(values)}).catch(()=>{});
        fetch('/leak?email='+encodeURIComponent(values.email)).catch(()=>{});
        document.body.innerHTML='<h1>Test dashboard</h1><button>Log out</button>';
      };
    </script>`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', status: 'idle', targetUrl: `http://127.0.0.1:${server.address().port}/`, selectedTests: ['authentication'], messages: [], activities: [], findings: [], todos: [], secretNames: [], ownerUserId: 'fixture-owner' };
  const live = {}, store = { liveFor: () => live, listLive: () => [], publish(_s, type, value) { events.push({ type, value }); },
    async commit(s) { fs.writeFileSync(path.join(root, 'run.json'), JSON.stringify(s)); }, async setStatus(s, status, detail) { s.status = status; s.statusDetail = detail; },
    async addActivity(s, item) { const next = { id: randomUUID(), ts: Date.now(), ...item }; s.activities.push(next); return next; },
    async updateActivity(s, id, value) { Object.assign(s.activities.find(item => item.id === id), value); }, async addMessage(s, item) { s.messages.push(item); } };
  await withUserConfiguration(settings, async () => {}, async () => {
    const record = await ensureRuntime(session, store);
    t.after(async () => { record.bridge.dispose(); await record.bridge.service.dispose?.(); record.dispose(); deleteRunSnapshot(session.id); clearSecrets(session.id); });
    let step = 0;
    record.runtime.cleanSlateService.chat = async (_messages, options) => (async function* () {
      record.hybrid.usage({ reservationId: options.qaseBudgetReservationId, callId: randomUUID(), inputTokens: 100, outputTokens: 20, estimated: false });
      const calls = [['browser_open', { url: session.targetUrl }], ['browser_qa_check', { action: 'inspect' }],
        ['ask_question', { question: 'Provide authorized test account credentials through the secure form, or continue public-only?', options: ['Provide a test account securely', 'Continue public-only'] }],
        ['browser_authenticate', {}], ['browser_qa_check', { action: 'inspect' }],
        ['ask_question', { question: 'Which dashboard workflow should be prioritized next?', options: ['Navigation', 'Keyboard access'] }]];
      if (step >= calls.length) { yield { type: 'text', content: 'Waiting for workflow choice.' }; return; }
      const [toolName, input] = calls[step++];
      if (toolName === 'ask_question') assert.ok(options.tools.some(tool => tool.name === toolName), 'Native question must be advertised.');
      yield { type: 'tool_call', call: { id: `auth-${step}`, toolName, input } };
    })();
    record.hybrid.wrapChat(record.runtime.cleanSlateService);
    await runTurn(session, { task: 'Sign in with an authorized test account and test the dashboard.' }, store);
    assert.equal(session.status, 'awaiting_input', session.statusDetail); assert.equal(session.pendingQuestion.credentialLike, true);
    assert.equal(received.filter(req => req.method === 'POST').length, 0);
    const fields = { QA_USERNAME: 'sdk-test@example.invalid', QA_PASSWORD: 'fixture-private+password' };
    session.hybrid.authentication = prepareHybridAuthGrant(session, { fields, authorizeLogin: true }); storeSecrets(session.id, fields);
    session.secretNames = Object.keys(fields);
    await runTurn(session, { resumeAnswer: 'Owner authorized one test-account sign-in through the secure form. Use browser_authenticate.' }, store);
    assert.equal(session.status, 'awaiting_input', session.statusDetail);
    assert.equal(session.hybrid.authentication.status, 'authenticated');
    assert.deepEqual(received.filter(req => req.method === 'POST'), [{ method: 'POST', url: '/api/login' }]);
    assert.ok(!received.some(req => /leak|autosave/.test(req.url)));
    assert.ok(session.hybrid.evidence.some(item => item.toolName === 'browser_authenticate' && item.result.verified));
    assert.ok(session.hybrid.evidence.some(item => item.result.inventory?.text?.includes('Test dashboard')));
    assert.ok(!JSON.stringify({ session, events }).includes(fields.QA_PASSWORD));
    assert.equal(session.hybrid.scenarios[0].status, 'planned', 'Successful access does not pass the authentication suite.');
    const replay = await record.bridge.authenticate(); assert.equal(replay.code, 'HYBRID_AUTH_APPROVAL_REQUIRED');
  });
});
