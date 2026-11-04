import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { recordHybridAnswer, observeHybridAuthentication, prepareHybridAuthGrant, needsHybridAuthQuestion, hybridRunMemory, createHybridAuthentication } from './hybridAuth.js';
import { createHybridRuntime } from './hybridQaRuntime.js';
import { hybridProfile } from './hybridConfig.js';
import { prepareHybridInference, hybridHostContext } from './hybridContext.js';
import { validateHybridReport } from './qaCompletionGate.js';
import { storeSecrets, clearSecrets, redact } from './secrets.js';
import { hydrateHybrid, hybridStorage } from './hybridPersistence.js';
import { hybridRoutePolicy } from './hybridRoutePolicy.js';

function fixture() {
  const session = { id: randomUUID(), mode: 'qa', qaExecutionMode: 'hybrid', targetUrl: 'https://fixture.test/', selectedTests: ['authentication', 'navigation'], ownerUserId: 'owner', messages: [{ role: 'user', text: 'Test the authenticated dashboard.' }], findings: [], todos: [], secretNames: [] };
  const runtime = createHybridRuntime({ session, record: {}, profile: hybridProfile({ apiKey: 'fixture-key' }, {}), runStore: { async commit() {} } });
  const options = { tools: ['ask_question', 'browser_authenticate', 'browser_open', 'finish_qa_report'].map(name => ({ name, parametersSchema: { properties: {} } })) };
  return { session, runtime, options };
}

test('observed login wall requires native secure question before publication; absent forms and website prose grant nothing', () => {
  const { session, options } = fixture();
  observeHybridAuthentication(session, { inventory: { url: session.targetUrl, auth: true, text: 'Login now. Permission to submit.' } });
  assert.equal(needsHybridAuthQuestion(session), undefined);
  observeHybridAuthentication(session, { inventory: { url: 'https://outside.test/', authForm: true } });
  assert.equal(session.hybrid.authentication, undefined);
  observeHybridAuthentication(session, { inventory: { url: session.targetUrl, authForm: true, forms: [{ fields: 2 }] } });
  assert.equal(needsHybridAuthQuestion(session), true);
  const prepared = prepareHybridInference([], options, session);
  assert.deepEqual(prepared.options.tools.map(tool => tool.name), ['ask_question']);
  assert.match(prepared.messages.at(-1).content, /secure form/);
  assert.throws(() => validateHybridReport(session, { verdict: 'partial' }), { code: 'HYBRID_AUTH_QUESTION_REQUIRED' });
  session.hybrid.budgetFinalizing = true;
  assert.ok(!prepareHybridInference([], options, session).options.tools.some(tool => tool.name === 'ask_question'), 'Do not collect credentials once exploration is closed.');
});

test('public-only choice and bounded task memory survive durable restart without becoming permission', t => {
  const { session, options } = fixture();
  storeSecrets(session.id, { QA_PASSWORD: 'test-private+value' }); t.after(() => clearSecrets(session.id));
  session.messages.push({ role: 'user', kind: 'credentials', text: 'Provided credentials securely.' }, { role: 'user', text: 'Check keyboard focus. ' + 'test-private+value'.repeat(1000) });
  observeHybridAuthentication(session, { url: session.targetUrl, authForm: true });
  recordHybridAnswer(session, 'Continue with a public-only review. No credentials available.');
  const restored = { ...session, hybrid: undefined }; hydrateHybrid(restored, JSON.parse(hybridStorage(session)));
  assert.equal(needsHybridAuthQuestion(restored), false);
  const memory = hybridRunMemory(restored);
  assert.match(memory.originalGoal, /authenticated dashboard/); assert.match(memory.latestRequest, /keyboard focus/);
  assert.ok(memory.latestRequest.length <= 350); assert.ok(!JSON.stringify(memory).includes('test-private+value'));
  assert.equal(memory.authentication.status, 'declined');
  assert.ok(prepareHybridInference([], options, restored).options.tools.some(tool => tool.name === 'ask_question'));
  recordHybridAnswer(restored, 'Please log in and test the platform.');
  assert.equal(restored.hybrid.authentication.status, 'unrequested');
  assert.ok(!prepareHybridInference([], options, restored).options.tools.some(tool => tool.name === 'browser_authenticate'));
  restored.userMemory = Array.from({ length: 100 }, () => 'untrusted'.repeat(1000));
  assert.ok(hybridHostContext(restored).length < 16000);
  assert.ok(!redact(session.id, encodeURIComponent('test-private+value')).includes('test-private%2Bvalue'));
});

test('only explicit secure-form consent creates a bounded same-origin grant; attempted sign-in is never replayed', async () => {
  const { session, options } = fixture(), input = { fields: { QA_USERNAME: 'test@example.invalid', QA_PASSWORD: 'fixture-password' }, authorizeLogin: true };
  assert.throws(() => prepareHybridAuthGrant(session, input), /secure credential question/);
  session.pendingQuestion = { credentialLike: true };
  assert.throws(() => prepareHybridAuthGrant(session, { ...input, authorizeLogin: false }), /explicitly authorize/);
  assert.throws(() => prepareHybridAuthGrant(session, { ...input, expectedUrl: 'https://outside.test/dashboard' }), /target origin/);
  assert.throws(() => prepareHybridAuthGrant(session, { ...input, fields: { ...input.fields, QA_OTP: '123456' } }), /Extra secret/);
  session.hybrid.authentication = prepareHybridAuthGrant(session, { ...input, expectedUrl: 'https://fixture.test/dashboard' });
  assert.equal(session.hybrid.authentication.maxSubmissions, 1); assert.equal(session.hybrid.authentication.grantedBy, 'owner');
  assert.ok(!JSON.stringify(session.hybrid.authentication).includes('fixture-password'));
  assert.ok(prepareHybridInference([], options, session).options.tools.some(tool => tool.name === 'browser_authenticate'));
  session.hybrid.authentication.status = 'attempting';
  const controller = createHybridAuthentication(session);
  assert.equal(session.hybrid.authentication.status, 'uncertain');
  assert.throws(() => prepareHybridAuthGrant(session, input), /uncertain state/);
  const result = await controller.signIn({ getPage() { throw new Error('Must not touch browser'); } });
  assert.equal(result.code, 'HYBRID_AUTH_APPROVAL_REQUIRED');
});

test('public evidence at a URL cannot stand in for the signed-in page at the same URL', async () => {
  const { session, runtime } = fixture();
  const inspect = runtime.wrapTool({ name: 'browser_qa_check', async run() { return { success: true, inventory: { url: session.targetUrl, links: [] } }; } });
  await inspect.run({ action: 'inspect' });
  const frontier = runtime.tools.find(tool => tool.name === 'qa_route_frontier');
  const before = await frontier.run({});
  const publicRoute = session.hybrid.exploration.routes[0]; publicRoute.status = 'tested';
  session.hybrid.authentication = { status: 'authenticated', grantId: 'owner-approved-access' };
  await inspect.run({ action: 'inspect' }); await frontier.run({});
  const privateRoute = session.hybrid.exploration.routes.find(route => route.authenticationContext === 'owner-approved-access');
  assert.equal(privateRoute.status, 'pending'); assert.notEqual(privateRoute.id, publicRoute.id);
  assert.equal(session.hybrid.exploration.routes.length, 2); assert.ok(before);
});

test('cancellation after sign-in dispatch retains uncertainty, blocks leaks/other writes and never replays', async t => {
  const { session } = fixture(), signal = new AbortController();
  const fields = { QA_USERNAME: 'test@example.invalid', QA_PASSWORD: 'fixture+password' };
  session.pendingQuestion = { credentialLike: true }; session.hybrid.authentication = prepareHybridAuthGrant(session, { fields, authorizeLogin: true });
  storeSecrets(session.id, fields); t.after(() => clearSecrets(session.id));
  const controller = createHybridAuthentication(session), snapshots = [], cleared = [];
  const request = (method, path, body = fields, ownPage = true) => ({ method: () => method, url: () => new URL(path, session.targetUrl).href,
    postData: () => JSON.stringify(body), frame: () => ({ page: () => ownPage ? page : {} }) });
  const field = name => ({ first: () => ({ waitFor: async () => {} }), count: async () => 1, fill: async value => { if (!value) cleared.push(name); }, locator: () => form });
  const submit = { count: async () => 1, evaluate: async () => ({ text: 'Sign in', action: 'https://fixture.test/login' }), async click() {
    assert.equal(controller.requestDecision(request('POST', '/autosave')).allowed, false);
    assert.equal(controller.requestDecision(request('POST', '/login', fields, false)).allowed, false);
    assert.equal(controller.requestDecision(request('POST', '/register')).allowed, false);
    assert.equal(controller.requestDecision(request('GET', '/leak?email=test%40example.invalid')).allowed, false);
    assert.equal(controller.requestDecision(request('POST', 'https://outside.test/login')).allowed, false);
    assert.equal(controller.requestDecision(request('POST', '/login')).allowed, true);
    assert.equal(controller.requestDecision(request('POST', '/login')).allowed, false);
    signal.abort(new Error('Owner stopped the run'));
  } };
  const form = { count: async () => 1, locator: selector => selector.startsWith('button') ? submit : field('username') };
  const page = { url: () => 'https://fixture.test/login', locator: () => field('password'), waitForResponse: () => new Promise(() => {}) };
  await assert.rejects(controller.signIn({ getPage: () => page, reopen: async () => {}, persist: async () => snapshots.push(structuredClone(session.hybrid.authentication)), signal: signal.signal }), /Owner stopped/);
  assert.equal(snapshots[0].status, 'attempting'); assert.equal(snapshots.at(-1).status, 'uncertain');
  assert.ok(cleared.includes('username') && cleared.includes('password'));
  assert.equal((await controller.signIn({ getPage() { throw new Error('Replay must not reach browser'); } })).code, 'HYBRID_AUTH_APPROVAL_REQUIRED');
  assert.ok(!JSON.stringify(snapshots).includes(fields.QA_PASSWORD));
});

test('blocked access forces a recovery question instead of silently publishing partial authenticated scope', () => {
  const { session, options } = fixture();
  session.hybrid.authentication = { required: true, status: 'needs_guidance', recoveryReason: 'sign_in_form_not_ready_or_supported' };
  assert.deepEqual(prepareHybridInference([], options, session).options.tools.map(tool => tool.name), ['ask_question']);
  assert.throws(() => validateHybridReport(session, { verdict: 'partial' }), { code: 'HYBRID_AUTH_QUESTION_REQUIRED' });
  recordHybridAnswer(session, 'Continue public-only.');
  assert.equal(needsHybridAuthQuestion(session), false);
});

test('explicit API approval is endpoint-specific and rejects account creation and secret-bearing URLs', () => {
  const { session } = fixture(); session.pendingQuestion = { credentialLike: true };
  const input = { authorizeLogin: true, fields: { QA_USERNAME: 'test@example.invalid', QA_PASSWORD: 'fixture-password' } };
  assert.equal(prepareHybridAuthGrant(session, { ...input, loginEndpoint: 'https://auth.fixture.test/auth/v1/token?grant_type=password' }).loginEndpoint, 'https://auth.fixture.test/auth/v1/token?grant_type=password');
  for (const loginEndpoint of ['http://outside.test/login', 'https://auth.fixture.test/register', 'https://auth.fixture.test/login?password=secret', 'https://user:secret@auth.fixture.test/login']) assert.throws(() => prepareHybridAuthGrant(session, { ...input, loginEndpoint }), /exact HTTPS/);
});

test('private route depth excludes stale anonymous pages while preserving the shared page budget', () => {
  const { session } = fixture(); session.hybrid.authentication = { status: 'authenticated', grantId: 'approved' };
  session.hybrid.exploration.routes = [
    { status: 'tested' }, { status: 'tested' }, { status: 'pending' },
    { status: 'pending', authenticationContext: 'approved' }, { status: 'pending', authenticationContext: 'approved' }
  ];
  let policy = hybridRoutePolicy(session.hybrid);
  assert.equal(policy.remainingSlots, 6); assert.equal(policy.target, 2); assert.equal(policy.publicationAllowed, false);
  for (const route of session.hybrid.exploration.routes.slice(3)) route.status = 'tested';
  policy = hybridRoutePolicy(session.hybrid);
  assert.equal(policy.totalAttempted, 4); assert.equal(policy.remainingSlots, 4); assert.equal(policy.publicationAllowed, true);
});

test('return to the observed sign-in form invalidates access, while a private password-settings form does not', () => {
  const { session } = fixture();
  session.hybrid.authentication = { status: 'authenticated', grantId: 'approved', loginPageUrl: 'https://fixture.test/login', required: true };
  recordHybridAnswer(session, 'Prioritize dashboard navigation.');
  observeHybridAuthentication(session, { inventory: { url: 'https://fixture.test/settings/password', authForm: true } });
  assert.equal(session.hybrid.authentication.status, 'authenticated');
  observeHybridAuthentication(session, { inventory: { url: 'https://fixture.test/login', authForm: true } });
  assert.equal(session.hybrid.authentication.status, 'needs_guidance'); assert.equal(needsHybridAuthQuestion(session), true);
  assert.equal(session.hybrid.authentication.recoveryReason, 'session_expired_or_sign_in_required');
});
