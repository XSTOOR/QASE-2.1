import test from 'node:test';
import assert from 'node:assert/strict';
import { createHybridTelemetry } from './hybridTelemetry.js';
import { createHybridBudgetLedger } from './hybridBudgetLedger.js';
import { createHybridModelRouter } from './hybridModelRouter.js';
import { hybridRecoveryProblem, reconcileHybridUsageBeforeResume } from './hybridRecoveryGate.js';
import { JEV_ENDPOINT, JEV_MODEL } from './jevClient.js';

/* #18637 — "A Model usage receipt is missing" must never appear for a run
 * whose usage IS actually accounted for. Root cause: the router's reasoner()
 * finally-block fired `void iterator.return?.()` (the transport unwind that
 * publishes a verified receipt) and IMMEDIATELY persisted the reservation as
 * 'uncertain' via checkpoint(). The receipt landing microseconds later settled
 * only in memory with no re-checkpoint — so every later runtime recreated the
 * ledger from the stale durable snapshot and the recovery gate 409-blocked
 * Resume forever. The fix: bounded drain of the unwind BEFORE uncertain();
 * late receipts still heal via reasonerUsage() which now re-checkpoints.
 *
 * B. Hybrid QA disabled / non-hybrid sessions: the gate must not fire at all.
 */

function sessionFixture(reservation) {
	const session = { id: 'gate-fixture', mode: 'qa', qaExecutionMode: 'hybrid', status: 'interrupted',
		hybrid: { modelBudget: { version: 1, roles: { reasoner: { reservations: [reservation], legacyCalls: 0, legacyExposure: 0 },
			classifier: { reservations: [], legacyCalls: 0, legacyExposure: 0 } } } } };
	return session;
}

test('gate blocks resume for genuinely unverified usage (uncertain stays blocked)', () => {
	const session = sessionFixture({ id: 'r1', tokens: 500, status: 'uncertain' });
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED');
});

test('gate ignores non-hybrid sessions entirely', () => {
	const legacy = { id: 'x', mode: 'qa', status: 'interrupted' };
	assert.equal(hybridRecoveryProblem(legacy), null);
	const sqa = { id: 'y', mode: 'sqa', status: 'interrupted' };
	assert.equal(hybridRecoveryProblem(sqa), null);
});

test('#18637: a late verified receipt settles an uncertain reservation durably and re-checkpoints', async () => {
	// Turn unwound and checkpointed 'pending' before the receipt was published
	// (the exact race): durable snapshot now holds pending → next construction
	// marks uncertain. The late receipt arrives via reasonerUsage().
	const session = sessionFixture({ id: 'late-1', tokens: 700, status: 'pending' });
	const telemetry = createHybridTelemetry(session.hybrid);
	// Runtime #2 reconstructs from the stale snapshot: pending → uncertain.
	const ledger2 = createHybridBudgetLedger(session.hybrid, telemetry);
	assert.ok(ledger2.unresolved('reasoner'));
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED');

	// The verified receipt surfaces after the turn ended (late publish).
	const checkpoints = [];
	const router = createHybridModelRouter({ session, profile: { budgets: { durationMs: 60000, reasonerTimeoutMs: 10000, classifierTimeoutMs: 10000, outputTokens: 4096, reasonerCalls: 10, classifierCalls: 10, reasonerTokens: 1000000, classifierTokens: 1000000 }, classifier: { apiKey: 'fixture-key', endpoint: JEV_ENDPOINT, model: JEV_MODEL } }, telemetry, fetchImpl: async () => new Response('{}'), checkpoint: async () => { checkpoints.push(structuredClone(session.hybrid)); } });
	router.reasonerUsage({ reservationId: 'late-1', inputTokens: 650, outputTokens: 50, estimated: false, callId: 'call-late-1' });
	// reasonerUsage() fire-and-forgets its re-checkpoint; flush the microtask queue.
	await new Promise(resolve => setImmediate(resolve));

	assert.equal(hybridRecoveryProblem(session), null, 'resume must be unblocked after the verified receipt settles');
	const lastCheckpoint = checkpoints[checkpoints.length - 1];
	assert.equal(lastCheckpoint.modelBudget.roles.reasoner.reservations[0].status, 'settled');
	assert.equal(lastCheckpoint.telemetry.reasoner.inputTokens, 650);
});

test('#18637: settle() heals uncertain reservations (ledger invariant kept) and is idempotent', () => {
	const session = sessionFixture({ id: 'heal-1', tokens: 400, status: 'uncertain' });
	const telemetry = createHybridTelemetry(session.hybrid);
	const ledger = createHybridBudgetLedger(session.hybrid, telemetry);
	assert.ok(ledger.unresolved('reasoner'));
	assert.equal(ledger.settle('reasoner', 'heal-1', { inputTokens: 360, outputTokens: 40, estimated: false, callId: 'c1' }), true);
	assert.equal(ledger.unresolved('reasoner'), false);
	// Duplicate receipt → idempotent false, no conflict, no double count.
	assert.equal(ledger.settle('reasoner', 'heal-1', { inputTokens: 360, outputTokens: 40, estimated: false, callId: 'c1' }), false);
	assert.equal(telemetry.metrics.reasoner.inputTokens, 360);
	assert.equal(telemetry.metrics.reasoner.outputTokens, 40);
});

test('#18637: estimate or fractional receipts never settle — fail-closed preserved', () => {
	const session = sessionFixture({ id: 'fake-1', tokens: 400, status: 'uncertain' });
	const telemetry = createHybridTelemetry(session.hybrid);
	const ledger = createHybridBudgetLedger(session.hybrid, telemetry);
	assert.throws(() => ledger.settle('reasoner', 'fake-1', { inputTokens: 360, outputTokens: 40, estimated: true }));
	assert.throws(() => ledger.settle('reasoner', 'fake-1', { inputTokens: 360.5, outputTokens: 40 }));
	assert.ok(ledger.unresolved('reasoner'));
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED');
});

test('#18637: resume preflight heals a stale reservation from the durable receipt log', async () => {
	// Process restarted between stop and resume: the persisted snapshot holds
	// 'pending' (frozen to uncertain on next runtime construction) while the
	// VERIFIED receipt WAS durably logged. The preflight must unblock resume.
	const session = sessionFixture({ id: 'race-1', tokens: 900, status: 'pending' });
	session.hybrid.telemetry = { reasoner: { inputTokens: 850, outputTokens: 50, reservedTokens: 900, calls: 1 }, classifier: { inputTokens: 0, outputTokens: 0, reservedTokens: 0, calls: 0 } };
	session.hybrid.modelBudget.receiptLog = [{ role: 'reasoner', reservationId: 'race-1', callId: 'call-race-1', inputTokens: 850, outputTokens: 50, settledAt: Date.now() - 1000 }];
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED', 'gate fires before heal');
	const healed = await reconcileHybridUsageBeforeResume(session);
	assert.equal(healed, 1);
	assert.equal(hybridRecoveryProblem(session), null, 'resume must be unblocked after healing from the durable log');
	const item = session.hybrid.modelBudget.roles.reasoner.reservations[0];
	assert.equal(item.status, 'settled');
	assert.equal(item.receipt.inputTokens, 850);
	assert.equal(item.reconciledFromLog, true);
	// Exposure recomputed: the settled reservation no longer reserves tokens.
	assert.equal(session.hybrid.telemetry.reasoner.reservedTokens, 0);
	// Repeated resume attempts are idempotent.
	assert.equal(await reconcileHybridUsageBeforeResume(session), 0);
	assert.equal(hybridRecoveryProblem(session), null);
});

test('#18637: resume preflight never heals without durable evidence — fail-closed preserved', async () => {
	const session = sessionFixture({ id: 'no-evidence-1', tokens: 300, status: 'uncertain' });
	session.hybrid.telemetry = { reasoner: { inputTokens: 0, outputTokens: 0, reservedTokens: 300, calls: 1 }, classifier: { inputTokens: 0, outputTokens: 0, reservedTokens: 0, calls: 0 } };
	assert.equal(await reconcileHybridUsageBeforeResume(session), 0);
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED', 'no log entry ⇒ stays blocked, error names the operator path');
	// Malformed log entries are ignored, not trusted.
	session.hybrid.modelBudget.receiptLog = [{ role: 'reasoner', reservationId: 'no-evidence-1', inputTokens: -5, outputTokens: 40 }];
	assert.equal(await reconcileHybridUsageBeforeResume(session), 0);
	assert.equal(hybridRecoveryProblem(session)?.code, 'HYBRID_USAGE_UNRESOLVED');
	// Non-hybrid / non-QA sessions: no-op, never throws.
	assert.equal(await reconcileHybridUsageBeforeResume({ id: 'x', mode: 'sqa' }), 0);
	assert.equal(await reconcileHybridUsageBeforeResume(null), 0);
});

test('#18637: ledger settle() writes the durable receipt log entry in the same checkpoint', () => {
	const session = sessionFixture({ id: 'log-1', tokens: 200, status: 'pending' });
	const telemetry = createHybridTelemetry(session.hybrid);
	const ledger = createHybridBudgetLedger(session.hybrid, telemetry);
	assert.equal(ledger.settle('reasoner', 'log-1', { inputTokens: 180, outputTokens: 20, estimated: false, callId: 'call-log-1' }), true);
	const log = session.hybrid.modelBudget.receiptLog;
	assert.equal(log.length, 1);
	assert.equal(log[0].reservationId, 'log-1');
	assert.equal(log[0].inputTokens, 180);
	// Idempotent duplicate does NOT append a second entry.
	ledger.settle('reasoner', 'log-1', { inputTokens: 180, outputTokens: 20, estimated: false, callId: 'call-log-1' });
	assert.equal(session.hybrid.modelBudget.receiptLog.length, 1);
});
