## DEV→NIHARIKA merge #14189 (merged 2026-10-12, commit 807bd76)

### Migration renumber resolution
DEV renumbered qa_test_selection/security_authorization 021/022 → 037/038; NIHARIKA kept 021/022. Resolution: NIHARIKA numbering won; DEV duplicates deleted; DEV's new founder_project_state renumbered 039→040. Set is now 001–040 contiguous, currentVersion 40.

**COMPATIBILITY CAVEAT (external PostgreSQL databases):** the migrator (server/postgres/migrations.js) validates applied history as a strict contiguous prefix with exact version+name+checksum match. Any EXTERNAL database that applied DEV's renumbered numbering (021/022 missing, qa_test_selection@037, security_authorization@038) will REJECT with "migration history is not a known contiguous prefix" / "name mismatch" and will not boot its migration path. Only NIHARIKA-numbered histories (021/022 present) are compatible. This workspace is unaffected (QASE_RUN_STORE=local, no DATABASE_URL). Before connecting any external PG database, check `SELECT version,name FROM qase_schema_migrations ORDER BY version` — if 037=qa_test_selection, a one-time compatibility migration of the tracking table is required.

### Interaction-model decision (survived the merge)
NIHARIKA's Phase-1 explicit selection model won over DEV's deselection model: per-device selection checkbox + View button (VIEW-only scope), uncapped selection, Phase-2 batching on submit (MATRIX_BATCH_SIZE=2000 per batch, planBatches + batchKeyFor idempotency, parent runs kind=parent). withinCap is deliberately NOT a launch gate — qaLaunchBlockedReason has no over-cap branch. Tests deviceSelectionUi.test.js and phase13eContract.test.js were rewritten to this contract.

### Environment gotchas (recurring)
- One-shot `node --test` full suite exhausts container fork limits (EAGAIN). Run in batches of ≤40 files, or per-file.
- Disk is 9.8G: freeing /home/coder/.cache/ms-playwright breaks WebKit tests. After cache loss: `npx playwright install webkit chromium-headless-shell` AND `npx playwright install-deps webkit` (apt libs are wiped on container restart, browser cache persists).
- Killed test batches orphan node processes → thread exhaustion → must restart container.
- Playwright install target is `chromium-headless-shell` (not chrome-headless-shell).

### Test account
.drytis/cred.json: tester@qase.dev, password rotated during smoke to smoke-reset-Pw1-2026x (reset flow exercised; old recovery codes invalidated).