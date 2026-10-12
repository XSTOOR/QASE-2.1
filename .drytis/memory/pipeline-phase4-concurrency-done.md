# Pipeline Phase 4 (#15496 bounded concurrency) — DONE 2026-10-08

Reviewer round 1: FAIL (slot-leak deadlock reproduced). Round 2: PASS after fixes.

## Final implementation
- matrixOrchestrator.js:
  - Global admission gate (ONE mechanism; dead MAX_MATRIX_CONCURRENT removed): `slotsUsed` counter + `waitQueue` per orchestrator instance, shared across ALL runs. **Transfer semantics**: acquireSlot fast-path = sync check-and-reserve (no TOCTOU); waiting path pushes ONLY the resolver (NO increment in callback); releaseSlot = shift waiter → call resolver with counter UNCHANGED (slot transfers) else decrement. Invariant slotsUsed == live holders. executeItem wrapped try/finally releaseSlot; cancelled-while-waiting releases and exits.
  - configuredParallelism(): default 2 (was 1), clamp 1–8 = min(configured, cores−2 floor 1, (totalMB−1536)/600 floor 1 cap 8); clamp warning logged ONCE per process (module flag). This container: 3 cores → budget 1 (sequential here).
  - waitForSession timeout: `services.agent?.stop?.(sessionId)` (guarded) BEFORE throwing MATRIX_ITEM_TIMEOUT → ERROR marking; Phase-3 finally close is second line.
  - resumeRecovery: orphaned RUNNING items → ERROR + best-effort agent.stop on their sessions.
- agent.js closeOtherBrowsers (exported now): capacity-aware LRU eviction. Single sweep with owner check on EVERY candidate (round-1 bug: async filter predicate → Promise, always truthy; runningSiblings counted without owner check). `over = 1 + same-owner-runningSiblings + idle-evictable − max(2, matrixBrowserBudget())`; evict oldest lastUsedAt first; running siblings + foreign-owner NEVER touched/touched. matrixBrowserBudget duplicates the orchestrator formula (documented drift risk).

## Tests
matrixOrchestrator 22/22 (3 Phase-4: 9-item peak==clamped budget; two-run shared budget via run-id-routed Proxy; R2 leak regression — 4 runs, 2 contention rounds on budget 1, asserts all drain; timeout static contract). agent 38/38 (2 new eviction tests via record.bridge.suspend fixtures — ESM namespace frozen, cannot patch exports). Sweep 92 green.

## Reviewer WARNs carried (advisory)
- matrixBrowserBudget formula duplication with configuredParallelism.
- No live 2,000-item no-EAGAIN drain / ps-count browser sample — deferred to Phase 6 E2E evidence.
- Budget 1 on this container → live parallelism sequential here; ≥2 path unit-tested only.

## Gotchas learned
- node --test with a never-finishing session wedges the run (600s tool timeout kills it) — NEVER set QASE_MATRIX_ITEM_TIMEOUT_S=60 and wait live; use static source assertions for the watchdog (documented in-test, matrixapi-node-test-wedge.md).
- matrixOrchestrator.test.js POLL_INTERVAL_MS=2000 makes multi-item tests slow — poll for completion in a loop, don't single-shot sleep.
- configuredParallelismForTest() helper in the test file mirrors the clamp so budget assertions stay honest on any machine.