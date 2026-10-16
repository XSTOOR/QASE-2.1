# Production single-run workflow

Deploy release `qase-2026-10-16-single-browser-r4`, UI `20261016-3`.

## What changed

The old picker expanded device/browser pairs into multiple OS/browser-version jobs. Separate submissions also waited for a capacity-limited local browser. The launcher now creates exactly one configuration and no batches.

- Default: Chrome on one catalog desktop. Prefer the generic Windows Desktop on Windows/Linux hosts; select one compatible desktop on macOS. No tablet default or alternate-engine retry.
- Custom: one browser, one compatible device, managed runtime version. Filters for type, OS, manufacturer and search do not mutate selection.
- Repeated owner requests return their active test. Concurrent HTTP submissions are guarded. Busy execution capacity returns 503 with Retry-After and no new waiting run; the UI retains the draft.
- Existing queued runs remain real saved work. Do not erase state, cancel customer work or claim the backlog has disappeared.

## Deployment

1. Use the verified r4 ZIP or a reviewed Git commit whose manifest verifies as r4. An existing r3 branch/commit is not this release. Record the source identity.
2. Preserve production architecture, accounts, gateway keys, database, evidence, persistent storage and active work. Read DEPLOYMENT_PROMPT.md. Do not import development state.
3. Install locked dependencies on Node 22/24, install Playwright's browser dependencies, run npm run verify and build/scan the Linux image. Keep a rollback image and state backup.
4. Inspect the currently held browser slot and worker logs. Old processes must be drained/restarted through an approved rollout; new code cannot repair an old in-memory hung call. Do not stop another customer's run without operator approval.
5. Preserve the single-process local-store topology. Admission is process-scoped; this is not a shared database lease. If production uses multiple API replicas/distributed workers, validate cross-replica duplicate-start and shared-capacity behavior before promotion and implement a shared lease if the topology requires one. Do not switch an existing distributed deployment to local storage.
6. Preserve the bounded runtime initialization deadline (120s default) and existing safety limits. Do not raise concurrency/deadlines to conceal unreachable models or capacity exhaustion.
7. Verify health/readiness and run node scripts/check-deployed-release.mjs https://qase.drytis.com from the exact verified source. It checks the release and thirteen live asset hashes, including the new picker and selection model. Reload stale client tabs.

## Required acceptance checks

- With an operator-owned test account, start a disposable non-security smoke test against a controlled target. Confirm one Chrome desktop item and actual agent activity; no matrix popup or browser/version setup is required.
- Custom mode: select another available browser, filter type/OS/manufacturer, search for a device and select it. Confirm the review names one pair and that only one item/session starts. No version choices, recipes, bulk selects or batches.
- Repeated click/retry or a lost create acknowledgement must not create another active run for that owner. Their existing active test opens instead. Another account must not see its identity or contents.
- With execution capacity occupied on staging, submit from a second controlled account: require a clear busy response, a retained draft, no persisted waiting record and a safe manual retry after capacity becomes available. Do not test against unrelated customer work.
- Confirm existing queued records remain discoverable/cancellable by their owners and are not silently discarded. A legacy queued record may still show its real position.
- Test unavailable Chrome and runtime initialization failure: require an honest error, no alternate-engine fan-out and bounded slot release. Never use simulated UI results as a production QA verdict.
- After a real terminal run, save feedback once, reopen/edit the same record and retry a lost save acknowledgement without duplicate records/notifications. Confirm notification status reflects actual delivery.
- Verify account isolation, login, QA/SQA/Founder launch, live events, reports and compact cards. Inspect logs and OOM/restart counters. Run Linux-only and opt-in integrations on deployment infrastructure.
- Report the source commit/image digest, release, health checks and real canary IDs. Pulling code or receiving HTTP 201 is not a completed deployment.

## Rollback

Restore the previous reviewed image while retaining state and keys. Do not roll back database data without a reviewed restore/compatibility plan. Clearly report that the previous release has the old picker/admission behavior.
