# drytis/jev-1.13 gateway inconsistency + config-test false-positive fix (#15380, #14938)

## Gateway behavior (verified live 2026-10)
- `drytis/jev-1.13` IS listed by https://llm.drytis.ai `/v1/models` and `/models` (11 models total for the QASE key), but `/chat/completions` AND `/v1/chat/completions` both reject it: `400 Invalid model name passed in model=drytis/jev-1.13`. Same shape as the 2026-10-01 incident in .qase/sessions.json. Gateway-side issue — cannot be fixed from QASE.
- Working model remains `z-ai/glm-5.2`. Stored config untouched throughout the fix (verified via GET /api/config).

## Defect fixed in QASE
- `server/config.js` `testConnection()` only checked the model LISTING, so `/api/config/test` returned `matched:true` for jev — a false positive that would wedge every run if a user switched. Second occurrence of this trap (first was #14938).

## Fix (Phase 6, ticket #15380)
- `parseCompletionProbeUrl()` — derives `/chat/completions` from the same base, same URL hardening.
- `verifyModelCompletion()` — POSTs a tiny streaming completion (`max_tokens:1024`, prompt "ready"). 200 → verified; 404/405/501 → fall back to listing verdict (endpoint unsupported); 401/403 → key-rejection downgrade; other errors → downgrade `matched:false` + `completionVerified:false` + gateway `error.message` surfaced (bounded read via readBoundedJson). Transport failures tolerated (listing verdict stands). Same `assertSafeDestination` SSRF + env-key exfil guard as the listing probe.
- `finalizeProbeResult()` — runs only when listing `matched:true`; monotonic (can only downgrade, never flips ok).
- SSE 200 body never parsed or echoed.
- Frontend `public/app.js` probeModelEndpoint: when `completionVerified === false` show ONLY the completion message; the "not in the list — choose another model" sentence is suppressed for that case (it was factually wrong — the model IS listed).
- Tests: 6 new in `server/config.test.js` (happy, jev-400 downgrade, 404 fallback, 403 downgrade, transport tolerance, skip-when-unlisted); redirect/credential test updated to find the LISTING request explicitly (it asserted the last fetch call, which is now the completion probe).

## Gotchas
- `finalizeProbeResult` receives `createTimeoutSignal` via `options` — passing the destructured local fails (`createTimeoutSignal is not defined`); pass `options.createTimeoutSignal`.
- GET /api/config/test requires CSRF header (X-CSRF-Token from qase_csrf cookie) — use the double-submit pattern with a cookie jar.
- Reviewer WARN (not fixed): 200 SSE response body left unconsumed until the probe timeout fires — minor resource note.

Full suite after fix: 865 tests, 845 pass, 0 fail, 20 hardware skips. Reviewer PASS; browser tester PASS 4/4 (both rounds).