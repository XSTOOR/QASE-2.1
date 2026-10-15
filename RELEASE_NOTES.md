# QASE deployment handoff

Release `qase-2026-10-16-automatic-startup-r3` retains the compact recent-run cards and updates the UI asset version to `20261016-2`.

## Automatic startup and feedback UX

- The default launcher is “Let QASE choose”. Browser/device selection is no longer required. Custom configurations remain an explicit option.
- The server plans one desktop configuration from the current catalog. After scheduler admission it performs health checks and selects a healthy Chromium, Firefox or WebKit-compatible environment. Browser processes are not probed outside the shared capacity budget, and unavailable environments fail honestly rather than claiming execution.
- Startup uses a dedicated full-page status view, not the technical QA-run popup. It explains capacity waiting, reports queue position when available, transitions to the real session, and makes diagnostics optional. Leaving the page stops its polling/navigation. Interrupted queued work can reconnect once without creating another run.
- Feedback loads and submissions are bound to their run. Late responses cannot overwrite another run; a duplicate save acknowledgement recovers the existing record for editing while preserving the draft. Background synchronization never opens a feedback modal automatically.
- Local UI verification uses an explicitly labelled simulated agent with notifications disabled. It is not evidence of a successful production model run. Live authenticated canaries remain a rollout gate.

## Production startup hotfix

- Accepted test runs open a durable queue route immediately, not a previous paused session. Pending work remains discoverable in Recent tests, survives reload, and transitions to its real session only while the user is viewing that queue.
- Runtime initialization now has the existing configurable prelaunch deadline (120 seconds by default). Timeout aborts late turn startup, records an error, and lets the queue proceed. Browser cleanup is bounded to five seconds so a cleanup hang cannot indefinitely retain an execution slot.
- Stopping the queue view invalidates in-flight updates; transient status-read failures continue polling rather than silently dropping live updates.
- Matrix status, event and control endpoints enforce run ownership while the internal scheduler retains its system-level view.
- The login document is served relative to the public root, including installations beneath hidden release directories, without permitting access outside that root.
- New regression coverage exercises queued routes, stale responses, runtime timeout/slot release and account isolation. Production rollout and authenticated canaries remain required; see `docs/production-run-startup.md`.

## Included deployment changes

- Docker browser dependencies follow the locked Playwright installer; the image uses a non-root account, a health check, container binding, and writable state/evidence directories.
- A single-host Compose baseline includes a TLS reverse proxy, persistent volumes, closed registration, private application port, and streaming configuration.
- The source ZIP has a generated per-file SHA-256 manifest, a ZIP checksum sidecar, source verification, and a live release/asset verification command.
- Packaged UTF-8 text uses canonical LF line endings so the same source hashes survive Linux Git checkout; application behavior and binary assets are unchanged.
- CI checks the source and builds the image. A one-time offline operator bootstrap refuses populated local account stores.
- Existing application features and data-store implementations remain intact. Developer state, secrets, uploads, browser bundles, dependencies, and previous archives are excluded.
- Browser capability detection confirms touch injection on an isolated blank page, avoiding false hardware-touch reports for non-touch contexts. Browser fixture tests use their own local servers; verification no longer assumes Linux-only files or preinstalled branded browsers.
- Client and server compare revision numbers numerically, so revision 17 correctly supersedes revision 9 during stale-tab detection.

## Required production gates

The prior r1 baseline completed 1,855 tests with zero failures. The r2 handoff includes a separate verification log; do not use the prior baseline as evidence that this hotfix has passed. Skips include opt-in integration checks and the POSIX file-mode assertion that is not applicable on Windows. Linux image validation and production canaries remain mandatory.

The receiving deployment agent must build and scan the Linux image, configure secrets/DNS/TLS/persistence/SMTP, run the full verification suite, and pass authenticated QA/SQA/Founder canaries before switching traffic. Docker and the target production environment are not available in this handoff workspace, so this archive is not evidence of an already completed production deployment.

Read `DEPLOYMENT_PROMPT.md` for exact-version deployment, branch synchronization, migration precautions, and rollback requirements. Do not treat the local-store Compose baseline as a multi-replica design or replace an existing PostgreSQL production store with it.
