# QASE deployment handoff

Release `qase-2026-10-15-run-cards-compact-r1` contains the current `qase-2.1` application, including compact recent-run cards and UI asset version `20261015-18` (compact card stylesheet revision `20261015-17`).

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

Before packaging, the recursive verification suite completed on Windows with Node.js 24: **1,855 tests, 1,828 passed, zero failed, 27 skipped**. Syntax checks passed for 473 JavaScript source files; private-path ignore checks and the high-confidence credential scan passed. Skips include opt-in integration checks and the POSIX file-mode assertion that is not applicable on Windows. Linux image validation and production canaries remain mandatory.

The receiving deployment agent must build and scan the Linux image, configure secrets/DNS/TLS/persistence/SMTP, run the full verification suite, and pass authenticated QA/SQA/Founder canaries before switching traffic. Docker and the target production environment are not available in this handoff workspace, so this archive is not evidence of an already completed production deployment.

Read `DEPLOYMENT_PROMPT.md` for exact-version deployment, branch synchronization, migration precautions, and rollback requirements. Do not treat the local-store Compose baseline as a multi-replica design or replace an existing PostgreSQL production store with it.
