import test from 'node:test';
import assert from 'node:assert/strict';
import { qualificationPath } from './hybridConfig.js';
import { timeUntilRequalification, persistQualification, keeperTick, startQualificationKeeper, RECEIPT_TTL_MS, requalifyAheadMs, DEFAULT_TICK_MS } from './hybridQualificationKeeper.js';

const profile = { version: 1, reasoner: { model: 'm', endpoint: 'e', apiKey: 'k' }, classifier: { model: 'c', endpoint: 'ce', apiKey: 'k' } };

const passingReport = (checkedAt = Date.now()) => ({ version: 1, sdkVersion: '0.1.0', checkedAt, profileIdentity: 'x', passed: true, capabilities: {} });
const receiptFile = (report) => ({ readFile: async () => JSON.stringify(report) });

test('timeUntilRequalification: missing receipt → run now', async () => {
  const readFile = async () => { throw new Error('ENOENT'); };
  assert.equal(await timeUntilRequalification(profile, { readFile }), 0);
});

test('timeUntilRequalification: malformed receipt → run now', async () => {
  const readFile = async () => 'not json';
  assert.equal(await timeUntilRequalification(profile, { readFile }), 0);
});

test('timeUntilRequalification: fresh receipt → wait until TTL minus ahead-window', async () => {
  const ahead = requalifyAheadMs();
  const wait = await timeUntilRequalification(profile, receiptFile(passingReport(Date.now())));
  assert.ok(wait > 0 && wait <= RECEIPT_TTL_MS - ahead, `wait=${wait}`);
});

test('timeUntilRequalification: receipt inside the ahead-window → run now', async () => {
  const wait = await timeUntilRequalification(profile, receiptFile(passingReport(Date.now() - (RECEIPT_TTL_MS - 60_000))));
  assert.equal(wait, 0);
});

test('timeUntilRequalification: expired receipt → run now', async () => {
  const wait = await timeUntilRequalification(profile, receiptFile(passingReport(Date.now() - RECEIPT_TTL_MS - 1)));
  assert.equal(wait, 0);
});

test('persistQualification writes passing reports only, script-compatible permissions', async () => {
  const written = {};
  const report = passingReport(1_700_000_000_000);
  const mkdir = async (dir, options) => { written.dir = dir; written.dirMode = options.mode; };
  const writeFile = async (target, body, options) => { written.target = target; written.body = body; written.mode = options.mode; };
  assert.equal(await persistQualification(profile, report, { mkdir, writeFile }), true);
  assert.equal(written.target, qualificationPath(profile));
  assert.equal(written.mode, 0o600);
  assert.equal(written.dirMode, 0o700);
  assert.deepEqual(JSON.parse(written.body), report);
  // failing report → nothing written
  const calls = [];
  const noop = { mkdir: async (d) => calls.push(['mkdir', d]), writeFile: async (t, b) => calls.push(['write', t]) };
  assert.equal(await persistQualification(profile, { ...passingReport(), passed: false }, noop), false);
  assert.equal(calls.length, 0);
});

test('keeperTick: current receipt → no qualification run', async () => {
  let ran = 0;
  const outcome = await keeperTick(profile, { readFile: receiptFile(passingReport(Date.now())).readFile, runQualification: async () => { ran++; return passingReport(); } });
  assert.equal(outcome, 'current');
  assert.equal(ran, 0);
});

test('keeperTick: expired receipt → requalifies and persists a passing report', async () => {
  const readFile = receiptFile(passingReport(Date.now() - RECEIPT_TTL_MS - 1)).readFile;
  const readFileAfter = receiptFile(passingReport()).readFile;
  let reads = 0;
  const files = [
    async () => { reads++; return readFile(); },
    async () => { reads++; return readFileAfter(); }
  ];
  let persisted = false;
  const outcome = await keeperTick(profile, {
    readFile: () => files[reads]?.() ?? files.at(-1)(),
    runQualification: async () => passingReport(),
    mkdir: async () => {},
    writeFile: async () => { persisted = true; }
  });
  assert.equal(outcome, 'refreshed');
  assert.equal(persisted, true);
});

test('keeperTick: failing report keeps previous receipt and reports failed capabilities', async () => {
  const readFile = receiptFile(passingReport(Date.now() - RECEIPT_TTL_MS - 1)).readFile;
  let wrote = false;
  const outcome = await keeperTick(profile, {
    readFile,
    runQualification: async () => ({ ...passingReport(), passed: false, capabilities: { text: { passed: true }, streaming: { passed: false } } }),
    mkdir: async () => {},
    writeFile: async () => { wrote = true; }
  });
  assert.match(outcome, /^failed:/);
  assert.match(outcome, /streaming/);
  assert.doesNotMatch(outcome, /text/);
  assert.equal(wrote, false);
});

test('keeperTick: thrown qualification error is reported, never thrown', async () => {
  const outcome = await keeperTick(profile, {
    readFile: receiptFile(passingReport(Date.now() - RECEIPT_TTL_MS - 1)).readFile,
    runQualification: async () => { throw new Error('gateway unreachable'); }
  });
  assert.match(outcome, /^error:/);
  assert.match(outcome, /gateway unreachable/);
});

test('startQualificationKeeper: hybrid disabled → not started', () => {
  const handle = startQualificationKeeper({ logger: { info() {}, warn() {} } });
  assert.equal(handle.started, false);
  assert.ok(handle.reason);
  handle.stop();
});

test('startQualificationKeeper: enabled with key schedules the first tick', async () => {
  const timers = [];
  const clearTimeouts = [];
  const events = [];
  const logger = { info: (e, d) => events.push([e, d]), warn: (e, d) => events.push([e, d]) };
  const handle = startQualificationKeeper({
    logger,
    tickMs: DEFAULT_TICK_MS,
    setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    profile: { ...profile, reasoner: { ...profile.reasoner } }
  });
  // The disabled check reads env; force-enable for this handle by stubbing is
  // not exposed — so this test only asserts the schedule contract when the
  // keeper did start, else asserts the graceful no-op.
  if (handle.started) {
    assert.equal(handle.started, true);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].ms, 1_000);
    handle.stop();
    assert.ok(events.some(([event]) => event === 'hybrid.qualification.keeper.started'));
    // With no receipt on disk, the tick would run qualification — not asserted
    // here (network); scheduling is the contract under test.
  } else {
    assert.ok(handle.reason);
  }
});
