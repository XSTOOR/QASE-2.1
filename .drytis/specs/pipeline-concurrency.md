# Phase 4 — Bounded concurrency & browser-process hygiene

## Goal
Bounded, configurable parallel execution sized to real system capacity; browsers reliably
cleaned up; no PID/memory exhaustion at 2,000-item batches.

## Current state (recon)
- Worker pool exists: `drainQueued()` `matrixOrchestrator.js:206-229`, N workers,
  `configuredParallelism()` `:434-438` = `QASE_MATRIX_PARALLEL ?? 1` clamped 1–4.
- `MAX_MATRIX_CONCURRENT = 2` declared `:28` — dead constant, unenforced.
- Sequential default because `closeOtherBrowsers` (one-browser-at-a-time contract) suspends
  other sessions' browsers at turn start (`agent.js:628`, `:355-368`).
- PID exhaustion incident history: leaked browser zombies (PID 1 doesn't reap);
  RLIMIT_NPROC=7684.

## Changes
**server/matrixOrchestrator.js**
- Default `QASE_MATRIX_PARALLEL` stays conservative (2) but the clamp rises 1–8 with an
  environment-aware ceiling: min(configured, cpuCores-2, memoryBudget). Document that
  each parallel item holds one browser process (~300-500 MB realistic).
- Global admission gate: total concurrently RUNNING items across ALL runs ≤ configured
  pool size (enforce what `MAX_MATRIX_CONCURRENT` promised; remove or wire the dead
  constant — one mechanism, not two).
- Hard per-item watchdog: existing `QASE_MATRIX_ITEM_TIMEOUT_S` (60-3600s) retained; add
  kill-on-timeout: terminate the browser process group on timeout, mark item ERROR with
  reason, ensure zombie cannot linger (spawn with detached:false; document PID-1 reap
  caveat from the incident memory).
- Post-item cleanup from Phase 3 is the primary hygiene; here add a periodic sweep
  (piggyback the existing boot sweep `resumeRecovery()`:75-94) that suspends browsers for
  sessions belonging to finished items.

**closeOtherBrowsers contract**
- With parallelism >1 same-owner items each need their OWN live browser. Modify
  `ensureRuntime`/`runTurn` to close only OTHER sessions' browsers when capacity is
  exhausted (eviction by LRU), not unconditionally. Keep the invariant: total live
  browsers ≤ pool size.

## Acceptance criteria
- [ ] With QASE_MATRIX_PARALLEL=3 and a 9-item run, at most 3 items RUNNING at any moment (log-verified)
- [ ] A 2,000-item batch drains without fork failure (no spawn EAGAIN) on a healthy container
- [ ] Browser process count during the run never exceeds the configured pool (+small fixed overhead)
- [ ] Timed-out items end ERROR with reason, and their browser processes are gone
- [ ] Default (unset) config runs safely at parallelism 2 without cross-session interference

## Tests
- server/matrixOrchestrator.test.js: pool admission under multiple runs; eviction order;
  timeout kill marks ERROR.
- Keep isolation test (#14942) green.
- Documented live check: ps aux browser-count sample during a run (build-report evidence).

## Edge cases
- Container replacement mid-run (known operational reality) — resumeRecovery already
  marks orphaned RUNNING as ERROR; batches must surface that honestly in parent aggregate.
- QASE_MATRIX_PARALLEL set absurdly high → clamped by environment ceiling, logged.
