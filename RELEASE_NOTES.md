# QASE deployment handoff

Release `qase-2026-10-16-single-browser-r4` retains the compact recent-run cards and updates the UI asset version to `20261016-3`.

## Single-run workflow

- “Let QASE choose” uses one Chrome desktop configuration. No alternative-engine fallback, tablet default, version selector, parent run or batch fan-out. The generic Windows Desktop is preferred on Windows/Linux hosts; macOS hosts use one compatible desktop from the catalog. Versions remain internal runtime metadata, not separate jobs.
- Custom selection chooses one browser and one compatible device. Search, device type, operating system and manufacturer filters compose. Filtering never clears the chosen pair, which stays in the summary. Old multi-version preferences migrate to one exact environment.
- Environment selection is separate from optional advanced checks. The review page names the chosen browser/device and one run. Unavailable browser choices explain their disabled state; emulation and engine-equivalence notes remain honest.
- The QA launch endpoint rejects multi-configuration and batch requests, including old clients. An owner's repeated request returns their existing active run. Concurrent submissions are guarded across HTTP awaits; a busy local execution service rejects before creating more waiting work and preserves the draft.
- Existing historical runs, legacy advanced matrix APIs, data and queued production work are preserved, not cancelled or deleted. The local admission guard is process-scoped: use the existing single-process local-store topology. Multi-API/distributed rollouts require explicit shared-capacity and duplicate-start canaries before promotion, not a concurrency increase to hide a backlog.
- Browser selection, HTTP admission, device filters, focus, stale preferences, feedback and existing runtime behavior have regression coverage. Production rollout and real-model canaries remain required.

## Automatic startup and feedback UX

- The default launcher is “Let QASE choose”. Browser/device selection is no longer required. Custom configurations remain an explicit option.
- The server plans one Chrome desktop configuration from the current catalog. After admission it checks that default profile. A failed Chrome launch is reported honestly without trying other engines or generating additional jobs. Browser processes are not probed outside the shared capacity budget.
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

Local r4 verification completed 1,886 tests: 1,859 passed, zero failed and 27 skipped. Syntax checks passed for 486 source files; private-path checks and the credential scan passed. Skips include opt-in integration checks and the POSIX file-mode assertion that is not applicable on Windows. UI verification covered combined device filters, single-pair review, popup-free startup and the narrow mobile layout. Its isolated runtime harness made no model calls; it is not a production agent canary. Linux image validation and authenticated production canaries remain mandatory.

The receiving deployment agent must build and scan the Linux image, configure secrets/DNS/TLS/persistence/SMTP, run the full verification suite, and pass authenticated QA/SQA/Founder canaries before switching traffic. Docker and the target production environment are not available in this handoff workspace, so this archive is not evidence of an already completed production deployment.

Read `DEPLOYMENT_PROMPT.md` for exact-version deployment, branch synchronization, migration precautions, and rollback requirements. Do not treat the local-store Compose baseline as a multi-replica design or replace an existing PostgreSQL production store with it.
