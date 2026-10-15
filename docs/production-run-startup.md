# Production run startup hotfix

Deploy release `qase-2026-10-16-automatic-startup-r3`, UI `20261016-2`.

## Diagnosis and boundaries

An authenticated production canary was accepted with a QUEUED configuration and no child session while another account held the shared local browser slot. The launcher closed, retained the old paused run, and provided no persistent queue destination. This made an accepted run appear lost. Earlier runs in the screenshot did execute; their 20-minute item deadlines and safety-limit pauses are not evidence of failure to initialize.

Code inspection also identified an unbounded `sendTask` call: browser/model initialization occurred before the item execution deadline began. That could indefinitely hold the shared slot. The fix bounds that call, aborts late model-turn startup, records startup failure, and bounds browser cleanup. It does not promise to survive arbitrary host outages or remove safety limits. Local execution remains capacity-limited; do not increase parallelism without measuring RAM and browser limits.

## Rollout instructions for the Drytis deployment agent

1. Use the attached r3 ZIP or the Git branch `codex/automatic-browser-startup` in `https://github.com/XSTOOR/QASE-2.1`. Record the exact Git commit or ZIP SHA-256. Extract/clone to a fresh directory; do not overlay the old workspace. Run `node scripts/verify-release.mjs` and require the r3 release ID.
2. Read `DEPLOYMENT_PROMPT.md` and preserve the existing production architecture, authentication, model gateway, keys, database, evidence and persistent state. Never print secrets or copy development state. Keep Node 22/24 and locked dependencies. Do not reset production data to make the queue disappear.
3. Run `npm ci`, install locked Playwright browser dependencies, run `npm run verify`, and build/scan the Linux image. This local handoff does not include a verified Docker build. Keep a rollback image and database/state backup.
4. Inspect active workers and their logs for the currently held slot. Do not stop another customer's run without operator approval. Coordinate a maintenance/drain window for an existing stuck worker; deploying new code alone cannot change the call stack of an already-running old process. Restart only after an approved drain. Existing recovery marks interrupted work honestly and requeues remaining work; check its result before resuming anything manually.
5. Ensure an always-on production process with restart policy, sufficient RAM/shared memory, persistent state, outbound model access, SSE proxy support and no workspace sleep/idle timeout. A browser page remaining open is not a substitute for a production worker. Keep one local-store execution host; multiple replicas require the supported distributed architecture and shared persistence.
6. The default initialization deadline is 120s (`QASE_MATRIX_PRELAUNCH_TIMEOUT_S`, supported range 1–600). Do not raise it to conceal an unreachable model gateway. Preserve existing execution/turn safety limits; a long test can legitimately finish partially or need user input.
7. Switch traffic to the reviewed image. Run `node scripts/check-deployed-release.mjs https://qase.drytis.com` from this verified source. Confirm `/release.json` is r3 and `/api/config` reports `20261016-2`; reload any stale browser tab. The checker now verifies nine assets, including the startup view and stylesheet.

## Required acceptance checks

- Sign in with an operator-owned test account. Start a one-configuration, non-security smoke test of `https://example.com` with the goal: open the homepage, check its heading, capture one screenshot, finish; no forms or mutations.
- Leave “Let QASE choose” selected: no browser/device configuration is required. Confirm the actual selected profile and observed runtime facts agree, and confirm Chromium-unavailable fallback on staging. Browser probes must occur under scheduler admission, not once per waiting user request.
- Require a full-page startup view, not an automatically opened QA matrix dialog. The diagnostics dialog should open only from Technical details.
- After completion, submit feedback once, reopen it, edit the same record, and verify ownership and draft retention. On staging simulate a lost save acknowledgement and retry: no duplicate feedback/notification should be created. Confirm notification state reflects actual delivery; do not enable real notifications for local fixtures.
- Creation must immediately show the new queue route, not a previous paused run. Under contention, the queued card must remain in Recent tests and a reload must retain queue status. Closing the queue is not cancellation. Cancel the disposable smoke run if it is no longer needed.
- When a slot is allocated, the selected run must be its actual child session and stream real activity, not invented progress. Require a terminal outcome and inspect evidence. If model/browser initialization fails, require a visible ERROR with its cause, and verify the next controlled run can acquire a slot.
- Use two controlled accounts to check that one account cannot list, read, subscribe to, start, cancel or retry the other's matrix runs. Requests by a different account should return 404 for individual records. Never perform this test against unrelated customer data.
- Verify login, QA/SQA/Founder launch, status streaming, report downloads and existing compact cards. Check console/server logs, readiness and OOM/restart counters. Run Linux-only/opt-in integrations in the deployment environment.
- Report the deployed commit/image digest, release ID, health checks and canary session IDs. Do not report success just because the POST returned 201 or the dashboard rendered.

## Rollback

Restore the previous reviewed image while retaining persistent volumes and keys. Do not roll back databases without a reviewed compatibility/restore plan. If rollback is needed, explicitly report that r1's invisible queue and unbounded initialization remain unresolved.
