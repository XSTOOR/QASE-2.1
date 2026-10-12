# Pipeline fix plan (2026-10-08) — selection→matrix→batching→availability→queue→runner→results

Customer spec for complete device/browser selection + real multi-config execution.
Recon (researcher, verified file:line) done; specs written at
.drytis/specs/pipeline-{selection-model,batching,unattended-authorization,concurrency,results-board,e2e-validation}.md

## What's ALREADY FIXED (do not regress, do not re-plan)
- Two-devices-only catalog → #15439 (device-grouped pagination, 176 devices)
- 3×3 collapsing to 1 job → DISPROVEN for launcher path (#15439); targets[0] collapse DOES exist in test-case path matrixService.js:142 (expandMatrixItems) — out of scope unless customer hits it
- False UNAVAILABLE → #15439 (brand-correct UAs) + RT1 #14753 (branded binaries) + RT2 #14704 (health gates); DDG honestly NOT_SUPPORTED; Safari = engine-equivalent

## Real defects found (plan targets these)
1. No Select All; selection is derived (catalog minus deselection store) then silently sliced to 2,000 at qaConfigMatrix.js:147. No explicit selectedDeviceIds/selectedBrowserIds anywhere.
2. Device-row click = scope; scope resets explicit selections (app.js:5136-5141) and qaMatrixSetDeviceScope(null) unreachable — scope is a trap, cannot exit.
3. No parent-run/batching: hard 422 >2,000 (app.js:973-981); client mirrors gate.
4. Matrix children terminally BLOCK on any ask_question (agent.js:1001-1007 → orchestrator.js:289-297): securityAuthorization is inherited but NEVER consumed; no auto-answer mechanism (only founder-mode has one).
5. Orchestrator has no browser cleanup per item; QASE_MATRIX_PARALLEL clamp 1-4 default 1; MAX_MATRIX_CONCURRENT=2 dead constant.
6. Results board exists (#14942) but polls 2.5s; server matrix SSE events have ZERO frontend consumers.

## Key code anchors (recon-verified)
- Selection: public/qaConfigMatrix.js (createDeselectionStore:47-95, computeCappedSelection:133-147, MAX_RUN_CONFIGURATIONS:437); app.js qaUi.matrix ~4808-5920; family checkboxes 5183-5213; device-row scope click 5260-5282; effective selection 5118-5125.
- Submit: app.js 5905-5915 POST /api/qa-matrix-runs {configurationEnvIds}; server route app.js:953-1025; matrixService.create 302-456 (launcher mode: envId→item 1:1).
- Orchestrator: matrixOrchestrator.js drainQueued 206-229, parallelism 434-438, item timeout 425-429, awaiting_input→BLOCKED 289-297, resumeRecovery 75-94.
- Availability: browserSupportResolution.js (canonical 7 codes; DDG static not_supported :67-69,:130-137), environmentHealth.js (6 probes READY/BLOCKED, TTL 30s), qaConfigurations.js availabilityFor (NOT_SUPPORTED/NOT_CONFIGURED/AVAILABLE/UNAVAILABLE), board reseed 60s.
- Results: qaMatrixResultsView.js (rows, facets, pollMs 2500); SSE emit app.js:927-943 unconsumed.

## Ops constraints for the builder
- .local-browsers DELETED 2026-10-08 (disk); setup script re-extracts on next container start — verify branded browsers before E2E.
- Disk ~90%; PID-exhaustion history — run targeted node --test suites, not full blast.
- WebKit deps lost on every restart (webkit-trixie-runtime-deps.md).
- CSRF scripting: qase_csrf cookie → X-CSRF-Token header.
- Ticket 2,000-cap regression tests from #14276 must be UPDATED not deleted (they encode UX truth).
