# Pipeline Phase 4 (#15496) review — ROUND 2: VERDICT PASS (round-1 FAIL resolved)

## Round-1 CRITICAL (gate slot leak → deadlock): FIXED
matrixOrchestrator.js acquireSlot/releaseSlot (~:253-274) reworked to slot-TRANSFER
semantics: waiter resolves without incrementing; releaseSlot hands off (counter
unchanged) or decrements. Invariant slotsUsed == live holders holds. Reviewer's isolated
repro of the new code (budget 1, two rounds × 4-item cross-run contention): used=0,
waiting=0 after both rounds — clean. Regression test `Phase 4 R2: cross-run handoff does
NOT leak slots` (4 runs, budget 1, one routed Proxy orchestrator, staggered starts,
poll-to-done with honest failure message) genuinely exercises waiters.

## Round-1 WARNs (closeOtherBrowsers): FIXED
agent.js:356-389: sameOwner async-filter removed; single sweep fetches each candidate
once, applies owner check to EVERY candidate (`candidate.ownerUserId !==
keepSession.ownerUserId → skip`), runningSiblings counted same-owner only, foreign-owner
never counted/touched. Double runStore.get sweep gone. 2 NEW eviction tests in
agent.test.js (LRU order idle-old→mid→new; running-sibling + foreign immunity; keep never
evicted; within-budget no-eviction; victims via record.bridge.suspend fixture since ESM
namespace frozen).

## Round-1 WARN (clamp log spam): FIXED
configuredParallelism() logs the clamp once per process (parallelismLogged flag, :556-571).

## Still-open advisory WARNs (accepted)
- matrixBrowserBudget() in agent.js duplicates the orchestrator clamp formula — drift risk
  (documented, unchanged from round 1).
- Timeout-kill coverage remains a static source-assertion test (60s floor makes behavioral
  test wedge the suite; rationale documented in test).
- Spec AC live evidence still not documented: 2,000-item batch drain (no EAGAIN) and ps-aux
  browser-count sample. Test-level only.
- Minor: a cancelled run's worker parked in waitQueue only exits after some future release
  wakes it (bounded by the other holder's item duration — delayed exit, not a leak).
- Orchestrator remains sequential on THIS container (3 cores → budget 1); parallel path
  verified by unit tests + repro only, no live ≥2-core evidence.

Tests round 2: orchestrator 22/22 + agent 38/38 (60/60 combined), policy 6/6,
matrixService 21/21, queued 5/5. Implementer's "95 total incl. isolation/rt2" is slightly
off — no isolation.test.js/rt2.test.js files exist; #14942 coverage lives in
reportMatrixSection.test.js / matrixApi.test.js.
