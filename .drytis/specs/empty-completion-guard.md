# Empty-completion runaway guard (ticket #16225 follow-up)

## Problem (observed on production 2026-10-13 ~23:50)
Session `9a5d0b92` entered an infinite turn loop: the model gateway
(`z-ai/glm-5.2` via the custom provider) returned an EMPTY completion for
every turn (`outputTokens: 0`, ~27k input tokens each, one turn every ~2s,
100+ turns in 5 minutes). The vendored `@cleanslate/sdk` treats an empty
model response as "continue with another turn", so the loop never ends on
its own. Because the matrix orchestrator's global admission budget is
clamped to 1 on this container, the looping item held the ONLY execution
slot for its full 20-minute item timeout — every other run (258 QUEUED
items, including the customer's) sat "initializing"/Queued forever.

The small-probe gateway health check (`/api/config/test`) passes
(completion-verified with max_tokens 20), so this is not detectable at
config time — only at run time.

## Fix
1. `server/usageCapture.js` — new pure helper `createEmptyOutputGuard({limit, onBreach})`:
   counts consecutive REAL provider usage reports (not estimates) with
   `inputTokens > 0 && outputTokens === 0`; on the Nth consecutive empty
   report it fires `onBreach` once per breach and keeps firing on further
   empties (caller aborts idempotently); any non-empty report resets the
   counter.
2. `server/agent.js` — inside `runTurn`, a per-RUN guard
   (`record.emptyOutputGuard`) observes every harvested usage report via the
   existing `record.onUsageHarvested` funnel. On breach it sets
   `record.emptyLoopAbort = true` and aborts the turn's `AbortController`
   (same mechanism as user stop). Post-turn handling (both the normal path
   and the catch path) distinguishes the loop abort from a user stop:
   - user stop → `interrupted` "Stopped by user." (unchanged)
   - loop abort → system error message + status `error` ("model gateway
     returned empty responses") — an honest ERROR, so the matrix item ends
     ERROR and its slot frees immediately (~10–20s) instead of after 20 min.
   Limit: `QASE_EMPTY_COMPLETION_LIMIT` (default 5, clamped 1–50).
3. The orchestrator needs no change: `waitForSession` sees status `error`
   and the worker releases the slot.

## Files
- `server/usageCapture.js` (helper)
- `server/agent.js` (wiring + post-turn branch)
- `server/usageCapture.test.js` (unit tests for the guard)

## Acceptance criteria
- [ ] Guard fires after exactly N consecutive real empty reports; not before.
- [ ] A single non-empty report resets the streak.
- [ ] Estimated-only reports never trigger the guard.
- [ ] Reports with `inputTokens: 0` are ignored (not model completions).
- [ ] On breach the run is aborted and ends `error` (not `interrupted`).
- [ ] A user stop still ends `interrupted`.
- [ ] Full existing test suite stays green.

## Out of scope
- Fixing the gateway's empty completions themselves (upstream provider).
- Any orchestrator scheduling change.
