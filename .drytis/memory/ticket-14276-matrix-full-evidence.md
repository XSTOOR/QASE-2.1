# #14276 — QA run full-matrix verification (supersedes/adds to #15439 postmortem)

## Status
All three customer-reported defects verified fixed with live execution
evidence. Reviewer + tester + infra_verifier all PASS (2026-10-08).

## Additional changes in #14276 (on top of #15439 set)
- `server/matrixOrchestrator.js`: MAX_ITEM_MS now env-configurable
  `QASE_MATRIX_ITEM_TIMEOUT_S` (default 20min, clamp 60–3600s). The old fixed
  8-min ceiling killed nearly every real agent pass as timeout — root cause of
  "no item ever finishes" symptoms, NOT a dispatch collapse.
- `server/matrixService.js`: console.warn mapping-bug log for unknown
  configurationEnvId (item still honest BLOCKED).
- `server/app.js` + `public/app.js`: exact customer 2000-limit message.
- `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS` env key (id 50925) refreshed to current
  preview host qase-2-1-cvtryq.drytis.dev (was stale s1dpov).

## Live execution evidence (matrix-muzbv50u-a65c3f3f)
3×3 (iPhone 15 Pro / Galaxy S24 / Pixel 9 × Chrome/Firefox/Edge) → 9 items,
9 distinct real sessions, per-config UAs verified (CriOS 148 iOS token,
Android FxiOS/Gecko 141/150, Chrome 140/148), all 9 completed BLOCKED verdict
— honest: the demo target has REAL defects (404 /demo/img/chart.png, Settings
Save no-op). Per-item findings differ (item 8 uniquely found the missing
autocomplete attr). Run duration ~35min sequential (QASE_MATRIX_PARALLEL=1).

## Gotchas
- Container idles out (~10min) mid-matrix-run during long polling gaps; the
  server's own public-URL keepalive (server/index.js) should prevent this but
  did NOT reliably during manual waits — generate edge traffic (curl preview
  /healthz every ~20s) while monitoring long runs, or the in-flight item dies
  as "Interrupted" (recoverable via per-item retry endpoint
  POST /api/matrix-runs/:id/items/:itemId/retry).
- Matrix run fetch endpoint is /api/matrix-runs/:id (NOT /api/qa-matrix-runs,
  which is POST-create only).
- Full run JSON: items carry runtimeFacts as JSON STRING (parse before use).
- Tester noted a transient re-render quirk: 2 of 9 version clicks didn't
  survive a DOM re-render while the total count held — unconfirmed selection
  ref-staleness, watch for it next time.

## Uncommitted
Entire #15439 + #14276 fix set still needs publishing (ask customer first).
