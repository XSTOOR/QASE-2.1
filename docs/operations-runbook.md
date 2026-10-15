# Qase Operations Runbook

This runbook documents the **actual** production deployment path for Qase: a
single Drytis-managed pod running the Node server from a git checkout on the
`PUSHKAR` branch, fronted by Caddy. The Kubernetes baseline under
`deploy/kubernetes/` is not the current topology.

Last updated: 2026-09-28 (Phase 10, ticket #12962).

## 1. Deploy sequence (standard code push)

1. **Pre-deploy gate** — all commits pushed to `origin/PUSHKAR`. Production
   pulls from origin on container boot; unpushed commits are not deployed.
2. **Dev build & verify** — `npm run verify` green on the dev container;
   `npm run build`-equivalents (none today — plain Node, no bundler) and, when
   Postgres mode is configured, a migration dry-run.
3. **Push config tar** — `update_production_config` (rebuilds Caddyfile, env
   files, supervisor from backend records; no restart).
4. **Rolling restart** — `restart_production` (same public IP, same persistent
   volume; `drytis-init` re-pulls origin and runs the setup script).
5. **Verify** — `/` 200, `/healthz` 200, `/readyz` 200; `procmgr status` all
   RUNNING; smoke a QA run if the change touched the agent loop.

## 2. Environment quirks (know before debugging)

- **`.env` is a broken 0-byte virtiofs mount.** Env values reach the process
  via the background-service wrapper sourcing `/drytis-config/environments/*.env`
  before `exec node server/index.js`. Never debug by reading `/workspace/.env`;
  read the service definition and the share instead.
- **Split-horizon DNS.** The pod's resolver returns internal pod IPs for
  names under `*.prod.drytis.dev` (CNAME chains of public sites). Qase ships a
  pre-flight probe (`server/targetReachability.js`) that marks such targets
  with an environment note so the agent never reports a false CRITICAL. See
  `.drytis/memory/split-horizon-dns-false-critical.md`.
- **WebKit needs Xvfb + GTK libs.** The WPE build segfaults; the engine
  registry launches the bundled GTK MiniBrowser under `Xvfb :77`. OS deps are
  installed by the setup script; see
  `.drytis/memory/webkit-gtk-xvfb-multi-engine.md`.
- **Container pauses after 10 min idle.** Only `procmgr`-registered services
  survive. Keepalive self-pings `/healthz` via `QASE_PUBLIC_URL` during runs.

## 3. Migrations

- **Local store (current prod)** — `QASE_RUN_STORE=local`; JSON files under
  `.qase/`. No migrations. Migrating to Postgres later uses the legacy import
  job (`importBatch` in `server/postgres/runRepository.js`).
- **Postgres store** — forward-only checksummed migrations in
  `server/postgres/migrations/`, applied either by
  `QASE_DATABASE_MIGRATE_ON_START=true` (dev default) or explicitly via
  `npm run db:migrate` (honors `QASE_MIGRATION_DATABASE_URL`). In production,
  never rely on startup migration; run the explicit command during the deploy
  window. Migration 014 (`018_run_engine_device.sql`) adds
  `engine`/`device`/`device_landscape` columns with safe defaults — no
  backfill needed.

## 4. Health & monitoring

| Endpoint | Purpose |
|---|---|
| `/healthz` | Liveness only — is the process up |
| `/readyz` | Readiness — drain-aware, checks DB/Redis when configured |
| `/metrics` | Prometheus (requires `QASE_METRICS_TOKEN` bearer) |
| `/api/analytics/summary` | Local usage counters (thumbs feedback, run funnel) |

Logs go to stdout as structured JSON (`QASE_LOG_FORMAT=json`), correlated by
`X-Request-Id`. There is no file sink or shipper; platform log collection is
the retention layer. Alert rules: `deploy/observability/prometheus-rules.yaml`
targets the Prometheus-Operator topology (not deployed); for the actual
single-pod deployment use `deploy/observability/single-pod-alerts.md` — it
defines the scrape-absence / 5xx-burn / latency / overload / queue-wait /
expired-lease / RSS alerts against the deployed `/metrics` surface. Receiver
wiring is deployment-owned; run the alert-trigger + 24h-clean-window drill
from that file before launch.

## 5. Configuration decisions (current state)

| Setting | Value | Notes |
|---|---|---|
| `QASE_RUN_STORE` | `local` | Postgres + RLS is production-ready but not yet enabled |
| `QASE_DRYTIS_INTEGRATION_ENABLED` | `false` | Enable only after ticket #12961 review closes; requires Postgres store |
| `QASE_OPEN_REGISTRATION` | unset (closed) | Production registration stays closed; pilot users enter via invite codes |
| `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS` | unset | Own-origin always allowed; add hosts only for internal E2E |
| `QASE_METRICS_TOKEN` | set (secret, backend env key) | Mounted at launch prep; alert definitions in `deploy/observability/single-pod-alerts.md` |
| `QASE_PILOT_MODE` | `false` | Set `true` to show the pilot banner + invite-code field in the UI |
| `QASE_OPERATOR_EMAIL` / `QASE_OPERATOR_PASSWORD` | unset | Used only by `scripts/pilot-invite.mjs` |

## 6. Controlled pilot operating procedure

The pilot cohort is admitted through single-use invite codes — registration
never opens to the world.

1. **Enable pilot mode** — set `QASE_PILOT_MODE=true` (banner + invite field
   appear in the UI; registration stays closed without a code).
2. **Set metrics** — generate a ≥32-byte random token, set
   `QASE_METRICS_TOKEN`, verify `curl -H "Authorization: Bearer <token>" https://<host>/metrics`.
3. **Mint invites** — either:
   - CLI: `QASE_OPERATOR_EMAIL=… QASE_OPERATOR_PASSWORD=… node scripts/pilot-invite.mjs create --note "Acme pilot"`, or
   - API: `POST /api/auth/invites` logged in as any non-pilot account (owner).
   Each `qase-*` code admits exactly one user, who is registered with the
   `pilot` role. Pilot users are rejected from operator endpoints.
4. **Watch the funnel** — `GET /api/analytics/summary` (events carry
   `cohort=pilot` for pilot-role users: run_created, run_launched, feedback
   with thumbs ratings and notes).
5. **Triage feedback** — `GET /api/analytics/feedback` (operator-only) lists
   every session rating newest-first with notes; push actionable findings to
   the Drytis board from a run's report view.
6. **Pilot pass/fail gate** — before enabling open registration (Phase 12),
   review: runs completing rate, thumbs ratio, and unaddressed pilot notes.

## 7. Rollback

Rollback = point prod at the previous commit and restart:
`git checkout <previous-commit>` on the pod is NOT the mechanism — instead,
revert on the branch (or redeploy the prior commit on `PUSHKAR` via the
backend tools) and re-run steps 3–4 of the deploy sequence. The persistent
volume (runs, analytics, certs) is untouched by rollback. Schema rollback is
not supported (forward-only migrations); migration 014 is additive-only, so an
older server version ignores the new columns safely.

## 8. Backup & retention

- Local store: `.qase/` on the persistent volume — covered by platform volume
  snapshots. A restore drill is still outstanding (see
  `docs/production-readiness-report-2026-09-10.md`).
- Retention is **manual, not automatic**:
  - Local store (the deployed mode): `npm run prune:local` sweeps sessions
    older than `QASE_RUN_RETENTION_DAYS` (default 30) plus their snapshots and
    workspaces. Dry-run by default; `-- --apply` executes. Recommended
    cadence: weekly. `QASE_RUN_RETENTION_DAYS` is only a default for this
    command in local mode.
  - Postgres mode: `npm run data:governance` (`scripts/data-governance.mjs`,
    dry-run default) drives the soft-delete → purge pipeline per
    `docs/enterprise-migration/phase-10-data-governance.md`.
  - No scheduler runs either command automatically — put it on the ops calendar.

## 9. Known open items

- Analytics counters are single-node file state — fine for one pod, not for a
  multi-replica future.
- The setup script lives in the Drytis backend (not the repo); its content is
  reproduced in section 9 for audit.

## 10. Setup script (deploy-time, backend-managed)

Kept in sync by the backend `update_setup_script` tool; auditable here:
installs OS deps (Xvfb, GTK/WebKit and GStreamer libs, codecs), `npm ci`,
`npx playwright install chromium firefox webkit`, and — guarded on
`QASE_DATABASE_URL` being set — `npm run db:migrate` for Postgres mode.
Local-store deployments skip the migration step cleanly.
