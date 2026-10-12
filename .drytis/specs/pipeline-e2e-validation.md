# Phase 6 — Progressive E2E validation & regression suite

## Goal
Prove the pipeline with real executions, progressively, per the customer's test ladder;
lock everything in with regression tests; produce the final report.

## Test ladder (each must run against the LIVE preview URL with the real local-browser
registry; evidence: screenshots + run records)

### TEST 1 — 1 device × 1 browser
- Select exactly one device × one browser (one envId), start run.
- Assert: selection count 1, one job created, status transitions QUEUED → RUNNING →
  PASSED/FAILED observed live, per-row evidence exists (runtime facts, screenshots).

### TEST 2 — 3 devices × 3 browsers (iPhone 15 Pro, Galaxy S24, Pixel 9 × Chrome, Firefox, Edge)
- Assert: selected count = 9 compatible configurations (or fewer WITH explicit
  per-combination reasons for any excluded), jobs = selected, dispatches = jobs, results
  rows = requested, per-status totals correct. All rows show real execution outcomes.

### TEST 3 — Tablets as independent profiles
- iPhone (phone) + iPad + Android phone + Android tablet across multiple supported browsers.
- Assert: tablet rows render and execute as their own profiles (not folded into phone
  profiles), distinct viewport/emulation evidence.

### TEST 4 — >2,000 selection with batching
- Select >2,000 configurations (e.g. via Select All on a subset or full catalog).
- Assert: selection NOT truncated (UI count matches), batches created each ≤2,000,
  bounded concurrency observed (max RUNNING ≤ pool), eventually every executable
  configuration has a result, zero duplicate jobs (item count == requested count),
  no fork failures.
- NOTE: a full 37,244 run is long; a reduced-but->2,000 selection (e.g. 2,100) satisfies
  this test honestly. Full-catalog run optional if time permits — report either way.

## Regression suite additions (new tests)
- Select All / Deselect All (devices & browsers) preserve full counts.
- Multi-device + multi-browser selection persistence across filter/search/scope changes.
- Device scope click does not mutate selection; exit scope restores view.
- Cartesian/flat selection: every selected device×browser row included (no silent drops).
- >2,000 selection preserved client-side (no slice) — planBatches correctness.
- Batching: parent+batches, idempotency (double-submit same batchKey → no dupes).
- Duplicate-job prevention (envId uniqueness across batches).
- Availability resolution: DDG stays NOT_SUPPORTED w/ reason; branded binaries resolve
  LOCAL BROWSER; WebKit = ENGINE EQUIVALENT (no REAL DEVICE label).
- Job creation & status transitions incl. health-gate UNAVAILABLE.
- Existing suites stay green: matrixApi, app, qaConfigMatrix, matrixService,
  matrixOrchestrator (+queued/isolation/rt2), qaMatrixResults{,View}, environmentHealth,
  browserSupportResolution, localBrowserRegistry, qaConfigurations, deviceMatrixView.

## Final report (customer contract)
1. Root cause: Select All failure (no affordance + derived-capped model)
2. Root cause: selection capped at 2,000 (computeCappedSelection slice)
3. Root cause: device-scope replacing selection (scope resets + unreachable exit)
4. Root cause: false UNAVAILABLE (prior tickets #15439 UA identity + RT2 health; verify
   none remain)
5. Root cause: not all selected configs executing (BLOCKED-on-question + no batching)
6. Files changed (full list)
7. Device catalog count (from live catalog API)
8. Browser catalog count (7 families, with honest per-family resolution)
9-12. E2E numbers: selected / jobs created / actually executed / PASS-FAIL-UNAVAILABLE-
   NOT_SUPPORTED counts per test
13. Runner/provider per execution type
14. Browsers/devices needing external infrastructure (DDG, real Safari, real devices)
15. Automated test results (targeted suites; full-suite caveat per PID incident memory)
16. Multi-device/multi-browser E2E evidence (run ids, screenshots)

## Operational notes for the builder
- Container may be freshly replaced: WebKit deps reinstall needed before Safari/WebKit
  tests (memory: webkit-trixie-runtime-deps.md). Run targeted suites, not full blast,
  until stability confirmed (incident-pid-exhaustion-zombies.md).
- CSRF for scripted API calls: cookie qase_csrf → X-CSRF-Token header (memory
  ticket-15439). /api/auth/csrf does not exist.
- `.local-browsers` was deleted 2026-10-08 for disk space; setup script re-extracts
  Brave/Edge/Opera on next container start — verify branded-browser resolution before
  E2E TEST 2.
- Disk at ~90%: browser evidence accumulates; prune old run videos if space is needed
  (they were archived to the customer zip already).
