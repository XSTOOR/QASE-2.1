/** Explicit OFFLINE local repair. Never starts a run or alters its limits.
 * Dry-run: node scripts/reconcile-hybrid-budget.mjs RUN_ID HOST_LOG
 * Apply, after stopping the local server: append --apply.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createHybridTelemetry } from '../server/hybridTelemetry.js';
import { createHybridBudgetLedger, reconcileLegacyBudget } from '../server/hybridBudgetLedger.js';
import { loadSessions, getSession, emit } from '../server/store.js';

if (process.env.NODE_ENV === 'production' || (process.env.QASE_RUN_STORE && process.env.QASE_RUN_STORE !== 'local')) throw new Error('This repair supports offline local development only.');
const [runId, logPath, apply] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/i.test(runId || '') || !logPath || (apply && apply !== '--apply')) throw new Error('Usage: node scripts/reconcile-hybrid-budget.mjs RUN_ID HOST_LOG [--apply]');
const storePath = path.resolve('.qase/sessions.json');
const sessions = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const session = sessions.find(item => item.id === runId);
if (!session || session.mode !== 'qa' || session.qaExecutionMode !== 'hybrid' || session.status !== 'interrupted' || !session.hybrid || sessions.some(item => item.status === 'running')) throw new Error('Only a paused hybrid run with no active local runs can be repaired.');
if (session.hybrid.telemetry.classifier.calls !== 0) throw new Error('Legacy logs lack role correlation; mixed-model accounting cannot be automatically reconciled.');
const log = fs.readFileSync(path.resolve(logPath), 'utf8');
const receipts = log.split('\n').flatMap(line => { try { const event = JSON.parse(line); return event.event === 'token_usage_commit' && event.runId === runId ? [event] : []; } catch { return []; } });
const sourceDigest = createHash('sha256').update(log).digest('hex');
createHybridBudgetLedger(session.hybrid, createHybridTelemetry(session.hybrid));
reconcileLegacyBudget(session.hybrid, 'reasoner', receipts, sourceDigest);
const result = { runId, applied: false, exactCalls: receipts.length, reportedTokens: session.hybrid.telemetry.reasoner.inputTokens + session.hybrid.telemetry.reasoner.outputTokens, pendingReservationTokens: session.hybrid.telemetry.reasoner.reservedTokens, limitsChanged: false, runStarted: false };
if (apply) {
  const port = Number(process.env.PORT || 5174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('A valid local server PORT is required.');
  const listening = await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', error => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(false); else reject(new Error('Could not verify the local server is stopped.')); });
    socket.on('timeout', () => { socket.destroy(); reject(new Error('Could not verify the local server is stopped.')); });
  });
  if (listening) throw new Error('Stop the local server first; concurrent history writers are not safe.');
  const backup = `${storePath}.before-budget-repair-${Date.now()}`;
  fs.copyFileSync(storePath, backup, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(backup, 0o600);
  // Commit through QASE's existing strict atomic local storage mechanism.
  loadSessions();
  // Store loading normally upgrades historical presentation fields. This
  // narrow repair must not opportunistically rewrite unrelated run records.
  for (const raw of sessions) {
    const loaded = getSession(raw.id);
    if (!loaded) throw new Error('History changed while loading; restore the backup before retrying.');
    for (const key of Object.keys(loaded)) if (!Object.hasOwn(raw, key)) delete loaded[key];
    Object.assign(loaded, raw);
  }
  const saved = getSession(runId);
  saved.hybrid.modelBudget = session.hybrid.modelBudget;
  saved.hybrid.telemetry.reasoner.reservedTokens = session.hybrid.telemetry.reasoner.reservedTokens;
  saved.hybrid.pauseReason = `Budget accounting reconciled from ${receipts.length} exact provider receipts. Resume to verify browser state and continue testing.`;
  saved.statusDetail = saved.hybrid.pauseReason;
  emit(saved, 'hybrid.state', {}, { durable: true });
  result.applied = true; result.backup = backup;
}
console.log(JSON.stringify(result, null, 2));
