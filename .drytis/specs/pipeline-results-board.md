# Phase 5 — Results board across batches + honest statuses end-to-end

## Goal
One results surface for the full selection (across batches): every requested configuration
has a row with an accurate status; parent-run progress (Total/Queued/Running/Passed/Failed/
Unavailable/Unsupported/Completed) is always visible and live.

## Current state (recon)
- Per-configuration board exists (public/qaMatrixResultsView.js, Phase 4 #14942): grouped,
  facet-filtered, evidence links, polling every 2.5 s; wired in app.js:6884-6911.
- Server emits matrix SSE events (`matrix_run_started`/`matrix_item`/`matrix_run_done`,
  server/app.js:927-943) with ZERO frontend consumers — UI polls.
- Statuses already honest: MATRIX_ITEM_STATUSES includes UNAVAILABLE/NOT_SUPPORTED/BLOCKED/
  ERROR etc.; health gate blocks honestly; DuckDuckGo NOT_SUPPORTED with reason.

## Changes
**public/qaMatrixResultsView.js / qaMatrixResults.js**
- Parent-run view: when the opened run is a parent, rows = union of batch items (via the
  Phase 2 aggregated GET); totals chips reflect the FULL selection. Progress line exactly:
  Total / Queued / Running / Passed / Failed / Unavailable / Unsupported / Completed.
- Consume the existing server SSE events (matrix_item etc.) for push updates instead of
  pure polling; keep polling as fallback (SSE reconnect → poll). Modest, no redesign.
- Ensure every requested configuration appears: including NOT_RUN rows for executable
  configs never dispatched (parent with cancelled batches) and NOT_SUPPORTED rows with the
  explicit reason string (already carried by items; surface in the row + tooltip).

**Status vocabulary audit (verify, mostly already true)**
- AVAILABLE/BUSY/UNAVAILABLE/NOT_SUPPORTED/CONFIGURATION_ERROR (catalog/board),
  NOT_RUN/QUEUED/RUNNING/PASSED/FAILED/ERROR/BLOCKED (run items) — verify each renders
  with its distinct label and reason; add CONFIGURATION_ERROR only if a real code path
  produces it (do not invent).
- Execution-type labels (REAL DEVICE / EMULATED / SIMULATED / VIRTUAL MACHINE / ENGINE
  EQUIVALENT / LOCAL BROWSER): already honest per RT1/D-series work — verify no path labels
  Playwright emulation as REAL DEVICE (grep label sources; report findings, fix only real
  mislabels).

**Duplicate-UI audit (explicit requirement)**
- Walk the QA-run flow; list every device section, browser section, filter, results panel,
  API call site. Remove ONLY true duplicates (same purpose, same data, redundant render);
  keep components serving different workflows (launcher dialog vs coverage tab vs
  environments admin are different). Consolidate shared selection logic into
  qaConfigMatrix.js. No visual redesign.

## Acceptance criteria
- [ ] A parent run of 5,250 shows 5,250 rows (or explicit NOT_RUN for never-dispatched) with correct per-status totals
- [ ] Status changes appear live during execution (SSE push or ≤2.5 s worst-case)
- [ ] Every unsupported combination row shows its reason (e.g. DuckDuckGo: mobile-only, no Linux build)
- [ ] No PASSED row exists for a configuration that did not execute (spot-check against session evidence)
- [ ] Duplicate UI sections found by the audit are removed or justified in the build report

## Tests
- public/qaMatrixResults{,View}.test.js: parent aggregation rendering, totals, SSE event →
  row update (simulated), fallback polling.
- server: aggregated GET shape.

## Edge cases
- Parent view opened mid-batch-creation (batches still being POSTed) — show planned
  total with "creating batches…" state, not a wrong count.
- Row pagination (50/page) must not hide totals chips accuracy.
