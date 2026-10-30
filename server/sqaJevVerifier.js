/**
 * #17936 — SQA Mode: bounded JEV (jev-1.13) integration, evidence-first.
 *
 * Audit finding: JEV was NEVER invoked during SQA execution. The only two JEV
 * paths were `provider === 'jev'` (a full runtime replacement, not set here)
 * and the hybrid QA classifier (QA-only). SQA ran the plain generative
 * runtime. Nothing routed to JEV, so the "hybrid JEV + primary model"
 * architecture simply did not exist in SQA Mode.
 *
 * This module adds the architecture-supported bounded role — mirroring the
 * hybrid QA classifier pattern: JEV performs ADVERSARIAL VERIFICATION of pass
 * decisions only (is the supplied evidence control-specific and sufficient?).
 * It never plans, never drives the browser, never writes observations, and
 * never decides a verdict: the primary agent keeps planning/browser/completion,
 * and the deterministic evaluator keeps computing the final verdict.
 *
 * Properties (per the issue requirements):
 *  - Bounded: at most `maxVerifications` calls per run (default 12).
 *  - Advisory: a JEV challenge is appended to the observation's rationale as
 *    a note; it cannot flip pass→fail by itself. A challenge IS surfaced to
 *    the agent so a genuine mis-pass can be corrected by the agent re-checking
 *    — the human-visible evidence chain always shows both sides.
 *  - Fail-open: JEV unavailable → verification skipped and logged, the run
 *    proceeds on the primary model's evidence (like hybrid's
 *    allowWithoutClassifier). NEVER blocks an SQA run on a classifier outage.
 *  - Fully traced: every invocation logs model, duration, token usage, and
 *    outcome (json event `sqa_jev_verification`), enabling benchmarking
 *    JEV-enabled vs baseline runs from real traces.
 *  - Token-accounted: usage receipts flow to the shared accounting service
 *    (per-model breakdown in session.tokenUsage.byModel, #17934).
 */

import { createJevClient } from './jevClient.js';
import { redact } from './secrets.js';

const DEFAULT_MAX_VERIFICATIONS = Number(process.env.QASE_SQA_JEV_MAX_CALLS ?? 12);
const DEFAULT_TIMEOUT_MS = Number(process.env.QASE_SQA_JEV_TIMEOUT_MS ?? 20_000);

export function createSqaJevVerifier({ session, settings, onUsage, fetchImpl, maxVerifications = DEFAULT_MAX_VERIFICATIONS, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	// Explicit off switch: default ON (the integration is the point), but a
	// broken classifier path must never take SQA down with it.
	if (process.env.QASE_SQA_JEV === 'false') {
		return { verify: async () => null, enabled: false, calls: () => 0 };
	}
	let client;
	try {
		client = createJevClient(
			{ apiKey: settings?.apiKey, baseUrl: undefined, model: 'jev-1.13' },
			{ fetchImpl, timeoutMs }
		);
	} catch {
		return { verify: async () => null, enabled: false, calls: () => 0 };
	}
	let calls = 0;
	const history = session.sqaJev ??= { version: 1, model: 'jev-1.13', verifications: [] };

	/**
	 * Verify one pass decision. Returns { challenge?: string } or null when
	 * skipped (budget spent, wrong status, or classifier unavailable).
	 */
	async function verify({ controlId, status, rationale, evidence }, signal) {
		if (status !== 'pass') return null; // only pass decisions carry the mis-pass risk worth a second look
		if (calls >= maxVerifications) return null;
		calls += 1;
		const startedAt = Date.now();
		const state = {
			runId: session.id,
			controlId,
			claimedStatus: status,
			rationale: String(rationale ?? '').slice(0, 2000),
			evidence: (Array.isArray(evidence) ? evidence : []).slice(0, 10).map(item => ({
				type: item?.type,
				summary: String(item?.summary ?? '').slice(0, 1000)
			}))
		};
		const questions = {
			evidence_sufficiency: {
				type: 'choice',
				instructions: 'You are verifying a PASS decision in a scoped software-quality assessment. Judge ONLY whether the supplied evidence is control-specific, concrete, and plausibly sufficient for this single control. Do not invent requirements, do not demand artifacts the control does not require.',
				criteria: {
					sufficient: 'The evidence is control-specific and reasonably supports the pass claim.',
					insufficient: 'The evidence is generic, absent, unrelated to the control, or clearly too thin for a pass claim.'
				}
			}
		};
		try {
			const result = await client.decide(redact(session.id, state), questions, {
				signal,
				sessionId: session.id,
				onUsageReceipt: receipt => {
					// Authoritative token accounting for the shared service (#17934).
					onUsage?.({ ...receipt, model: 'jev-1.13' });
				}
			});
			const verdict = result?.answers?.evidence_sufficiency?.choice;
			const challenge = verdict === 'insufficient'
				? 'JEV verification flagged the evidence as generic or insufficient for a pass claim. Re-check this control with control-specific browser evidence before keeping the pass.'
				: null;
			const entry = {
				controlId, verdict: verdict ?? 'unknown',
				durationMs: Date.now() - startedAt,
				usage: result.usage ?? null,
				challenge, ts: Date.now()
			};
			history.verifications.push(entry);
			history.verifications = history.verifications.slice(-50);
			// Routing trace (#17936 benchmark evidence): model, latency, tokens.
			console.info(JSON.stringify({
				event: 'sqa_jev_verification', runId: session.id, mode: session.mode,
				model: 'jev-1.13', controlId,
				verdict: entry.verdict, challenge: Boolean(challenge),
				durationMs: entry.durationMs,
				usage: entry.usage,
				callIndex: calls, ts: new Date(entry.ts).toISOString()
			}));
			return { challenge };
		} catch (error) {
			// Fail-open: log the outage with its category, never block the run.
			history.verifications.push({ controlId, verdict: 'skipped', error: String(error?.code ?? error?.message ?? 'unknown').slice(0, 200), durationMs: Date.now() - startedAt, ts: Date.now() });
			console.warn(JSON.stringify({
				event: 'sqa_jev_verification_failed', runId: session.id, model: 'jev-1.13',
				controlId, code: error?.code ?? 'unknown',
				durationMs: Date.now() - startedAt, ts: new Date().toISOString()
			}));
			return null;
		}
	}

	return { verify, enabled: true, calls: () => calls };
}
