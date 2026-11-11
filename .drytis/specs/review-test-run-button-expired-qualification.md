# Fix "Review test run" button blocked by expired Hybrid QA qualification (prod)

## Problem (user report, qase.drytis.com, 2026-10-29)
On the New test run wizard Coverage step, "Review test run →" is dead and the QA-team
panel shows: "Hybrid QA is unavailable because its compatibility check expired. The
server operator must rerun the gateway checks; refresh this page after they pass."
plus "Hybrid QA is not ready — Refresh model status or choose Existing QA."

## Root cause
- `server/hybridConfig.js validateQualification` expires qualification receipts after
  24h (`86400000`). Receipts are produced ONLY by the manual deploy script
  `scripts/qualify-hybrid-gateway.mjs` — nothing ever re-runs it. Every deployment
  therefore dead-ends the hybrid launcher ~24h later, exactly as in the screenshot.
- Frontend chain (working as designed, evidence only): `hybridQaView.hybridLaunchOptions`
  throws when `config.hybridQa.available === false` → `app.js qaLaunchBlockedReason`
  → `qaJourney.js` disables `journey-next` (label "Review test run →").
- The "Refresh model status" action only re-fetches `/api/config` — it can never clear
  an expired receipt. UI itself needs no change.

## Fix (server-side automatic requalification keeper)
New module `server/hybridQualificationKeeper.js`:
1. On server boot (from `server/index.js`, hybrid enabled + account key present) and
   then on a recurring timer, check the receipt age:
   - expired or missing → re-run the FULL gateway qualification
     (`qualifyHybridGateway` + SDK probe + PNG image fixture via Playwright
     chromium, mirroring `scripts/qualify-hybrid-gateway.mjs`) in-process.
   - within `QASE_HYBRID_REQUALIFY_AHEAD_MS` (default 2h) of expiry → re-run early.
   - otherwise idle.
2. Failed requalification keeps the previous receipt (it is still loadQualification
   that decides availability; an expired one stays expired — honest, fail-closed) and
   retries on the next tick.
3. Errors never crash the server; all activity logged via the operational logger.
4. Receipt written exactly like the script: `qualificationPath(profile)`, mode 0o600.

Sequence in `server/index.js`: started after `app.listen` (non-blocking, timer .unref),
so a slow/cold gateway cannot delay boot.

## Acceptance criteria
- [ ] With an expired receipt and a working gateway, the keeper produces a fresh
      passing receipt and `/api/config` reports `hybridQa.available === true` within
      one tick.
- [ ] Review test run button unblocks end-to-end once config is re-fetched.
- [ ] Unit tests: keeper schedules first run for missing/expired/valid receipts,
      survives qualification failure (retry, no throw), persists a passing report
      to qualificationPath, and writes nothing when qualification fails.
- [ ] `npm run test:hybrid` green; app.test.js still green (route surface unchanged).
- [ ] Full `npm run verify` on dev; deploy to prod; verify /api/config hybridQa
      available on qase.drytis.com.
- [ ] Existing dev receipt (checkedAt 2026-10-28) kept valid by the keeper.

## Out of scope
- UI copy changes; qualification TTL length changes; legacy qualification path.
