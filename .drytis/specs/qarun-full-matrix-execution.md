# QA Run — full matrix execution, catalog depth & availability semantics (#14276)

## Context
Three customer-reported defects in the "Test your website" QA Run flow. Prior
session (ticket #15439, postmortem in `.drytis/memory/ticket-15439-matrix-postmortem.md`)
diagnosed and implemented the core fixes; they exist in this working tree
(uncommitted at session start) and are verified live here.

## Root causes (verified)
1. **Only two devices in checklist** — `/api/qa-configurations` paginated raw
   38k catalog rows in envId insertion order; the first 200-row window was all
   Samsung Galaxy A15/A25 → checklist showed two devices. Fix (live):
   `buildQaConfigurationsByDevice()` in `server/qaConfigurations.js` groups by
   device, round-robins platforms (ios→ipados→macos→android→windows) per
   window; frontend loads 12 device groups per window with "Load more".
   Verified live: 176 unique devices, per-platform ios 39 / ipados 25 /
   macos 18 / android 80 / windows 14.
2. **Multiple selections collapsed to 1×1** — disproven for the current
   pipeline: launcher pins every selected envId 1:1 (`matrixService.create`
   launcher mode), no `[0]`/`.find()` collapse anywhere in the live path. The
   perceived collapse came from sequential execution (QASE_MATRIX_PARALLEL=1
   default) plus items honestly BLOCKED when the agent paused awaiting input.
3. **Valid selections reported UNAVAILABLE** — `userAgentFor()` stamped a
   Chrome/CriOS UA on every non-Safari browser with the OS major in brand
   tokens → runtimeIdentity flagged browser/version mismatch → BLOCKED.
   Fix (live): brand-correct UAs per platform×browser (FxiOS/EdgiOS/OPiOS/
   Brave/DDG tokens, brand major = browser major). 44/44 identity tests green.

## Changes in THIS ticket
- Align the >2,000-configuration message to the customer's exact wording in
  `public/app.js` (submit gate) and `server/app.js` (422 response):
  `Too many configurations selected (X). The maximum per run is 2,000 — narrow the selection by platform, manufacturer, device, browser, or OS.`
- Log unknown configurationEnvIds as a mapping/configuration bug at run create
  (`server/matrixService.js`) — items still record honest BLOCKED.

## Availability vocabulary (unchanged, verified)
- AVAILABLE — compatible runner resolved.
- NOT_SUPPORTED — combination impossible under current infrastructure (reason preserved).
- UNAVAILABLE — runtime board OFFLINE/NOT_EXECUTABLE or env inactive (temporary).
- NOT_CONFIGURED — provider-backed row whose provider isn't connected (honest, distinct from UNAVAILABLE).
- NOT_RUN — deselected by user / intentionally skipped.
- Unknown mapping → logged mapping bug + BLOCKED item, never silent drop, never PASSED.

## 2,000 limit (unchanged)
Server 422 + client disabled Start, message above. Catalog size (38k+) is
independent of the ≤2,000 selected-execution-matrix cap.

## Acceptance criteria
- [x] All device categories in checklist (live count 176 devices, 5 platforms)
- [x] 7 browsers with real versions from runner capabilities
- [x] Multiple devices/browsers selectable; selection preserved (localStorage deselection model)
- [x] All valid selected combinations become items 1:1 (launcher mode)
- [x] One session/job per configuration; sequential queue by design
- [x] Results configuration-specific; unrun never PASSED (updateItem guard)
- [x] Availability semantics per vocabulary above
- [x] 2,000 cap enforced client + server with exact message
- [x] Architecture/UI/styling unchanged; no fake availability/results
- [x] Live 3×3 execution evidence captured: run `matrix-muzbv50u-a65c3f3f`
  — 9 items, 9 distinct real agent sessions, per-device UAs (iOS CriOS / Android
  Chrome/FxiOS-Gecko tokens), individual findings, all completed (BLOCKED
  verdicts = genuine defects found in the demo target: 404 chart image,
  non-persisting Settings Save). Full board shown per config.
- [x] Reviewer + tester pass: reviewer PASS (96/96 tests, all criteria);
  tester PASS 5/5 (176-device checklist, 7 browsers with reasons, 9-config
  multi-select preserved, 2000-cap messaging live, no console errors).

## Tests
- Unit: `server/deviceRuntimeProfiles.test.js`, `server/runtimeIdentity.test.js`,
  `public/qaConfigMatrix.test.js` (44/44 pass), plus matrixService tests for
  unknown-envId behavior.
- Live evidence: 3×3 matrix run (iPhone 15 Pro / Galaxy S24 / Pixel 9 ×
  Chrome/Firefox/Edge) → 9 items, 9 sessions, per-item verdicts.
