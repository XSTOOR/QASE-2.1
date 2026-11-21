# Operations

How to run, verify, release and deploy QASE. Incident response lives in
[operations-runbook.md](operations-runbook.md); infrastructure design history
in `docs/enterprise-migration/`.

## Local development

```bash
npm ci
npm run install-browser          # Chromium, Firefox, WebKit for Playwright 1.62
npm start                        # http://127.0.0.1:5173
```

- Model settings come from the environment (`QASE_PROVIDER`, `QASE_API_KEY`,
  `QASE_BASE_URL`, `QASE_MODEL`, `JEV_API_KEY`) or Settings in the dashboard.
  `npm run start:local -- --env-file ../path/.env` imports only model settings
  from an explicit file.
- QA runs work without any model key (deterministic detectors only); add keys
  to enable AI exploration, visual review and JEV verification.
- Outside production, practice targets are served at `/demo` (sign in with
  `demo@qase.dev` / `demo1234`) and the seeded-defect QA Lab at `/demo/qa-lab/`.
- To test a site on your own machine or LAN, set `NODE_ENV=development` and
  `QASE_ALLOW_PRIVATE_NETWORK=true`, or allow specific hosts with
  `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS`.
- JEV-only local setup and its model lab: [jev-integration.md](jev-integration.md).

All variables, with defaults, are documented in `.env.example`.

## Verification

| Command | What it checks | Cost |
| --- | --- | --- |
| `npm test` | Unit, integration and browser tests (server, QA engine, PostgreSQL contracts, control plane, dashboard view logic) | free |
| `npm run verify` | Syntax, source credential signatures, ignore rules, then `npm test` | free |
| `npm run test:browser` | Real-Chromium integration runs of the QA, SQA and Founder engines | free |
| `npm run test:dashboard`, `test:ui`, `test:acceptance`, `test:auth`, `test:reset` | Dashboard flows against the real app with stub models | free |
| `npm run test:sqa` | SQA compliance test end to end in the real UI (scripted model, local search stub) | free |
| `npm run qualify:qa-live [-- <url>]` | QA engine with the real reasoner and JEV against the QA Lab (+ optional target) | capped model usage |
| `npm run test:founder` | Founder business review end to end in the real UI (scripted model, local search stub) | free |

PostgreSQL integration tests run when `QASE_TEST_DATABASE_URL` and
`QASE_TEST_CONTROL_DATABASE_URL` point to disposable databases (CI provisions
them); otherwise they skip. Firefox/WebKit tests need those browser bundles.

## CI (`.github/workflows/`)

- **verify.yml** — on every push/PR: dependency audit, browser install,
  `npm run verify`, the QA-engine end-to-end suite, auth/reset, UI follow-up in
  all engines, Founder and SQA browser suites, then a hardened production image
  build and smoke test without live model calls, and a source ZIP artifact.
  CI never deploys.

## Releasing

1. Update `RELEASE_NOTES.md` and `public/release.json` (`releaseId`,
   `uiVersion`).
2. `npm run release:manifest` regenerates `SOURCE_MANIFEST.json` (the source
   inventory); `npm run release:verify` checks it. The Dockerfile runs the same
   verification before building runtime layers.
3. `npm run package` writes `qase-share.zip` — source only, without
   `node_modules`, `.env`, `.qase` state or run history. Never zip the working
   folder directly: `.env` and `.qase/` contain keys and customer runs.

## Deploying

Production origin: `https://qase.drytis.com`. Build the root `Dockerfile`
(Node 22, Playwright 1.62 browsers, Xvfb) and deploy the image by digest.

**Single host (Compose)** — `deploy/production/compose.yaml` runs one app
container (local store, local execution, read-only root filesystem, state and
evidence volumes) behind Caddy for TLS. Copy `deploy/production/.env.example`
to `.env.production` on the host and fill secrets from the secret manager.
Do not scale this service to replicas: the local store is single-process.

**Kubernetes** — `deploy/kubernetes/README.md`: API replicas, workers,
PostgreSQL (`QASE_RUN_STORE=postgres`), Redis (`rediss://`), shared evidence
volume, migration Jobs, probes and the optional observability overlay
(`deploy/observability/`).

Before promoting a release:

1. Back up production data and confirm the restore procedure.
2. Apply new PostgreSQL migrations with the migration role
   (`npm run db:migrate`, `npm run control:db:migrate`); application startup
   never migrates. This release adds no migration (QA engine state uses the
   existing `hybrid_qa` column from migration 043).
3. Deploy, then check `GET /healthz` (liveness) and `GET /readyz` (storage
   readiness), `node scripts/check-deployed-release.mjs` (public release
   identity), `npm run deployment:smoke`, and one QA run against
   `/demo/qa-lab/` on a non-production instance or an approved staging target.
4. Roll back by redeploying the previous image digest; run state is
   backward compatible.

Production rules: `NODE_ENV=production` disables the demo routes and enforces
private-network blocking; keep `QASE_AUTH_REQUIRED=true`, set
`QASE_TRUST_PROXY=true` behind exactly one proxy, and never copy developer
`.qase` state into production.

## Operator scripts

| Script | Purpose |
| --- | --- |
| `scripts/bootstrap-operator.mjs` | One-time owner account bootstrap for an empty local auth store |
| `scripts/pilot-invite.mjs` | Mint/list pilot invite codes |
| `scripts/prune-local.mjs` (`npm run prune:local`) | Local-store retention sweep |
| `scripts/data-governance.mjs` (`npm run data:governance`) | PostgreSQL retention/legal-hold previews and applies |
| `scripts/import-sessions.mjs` (`npm run db:import`) | Import local JSON runs into PostgreSQL |
| `scripts/migrate.mjs`, `migrate-control-plane.mjs` | Database migrations |
| `scripts/generate-environments.mjs`, `validate-matrix.mjs` | Regenerate/validate the device–browser environment catalog |
| `scripts/smoke-deployment.mjs`, `load-placement.mjs`, `release-gate.mjs`, `evaluate-capacity.mjs` | Deployment smoke, placement load, read-only release gate, capacity evaluation (see `load/README.md`) |
| `scripts/check-deployed-release.mjs` | Read-only public checks of a deployed release |
| `scripts/smoke-production-image.mjs` | Boot and probe a built image (CI) |
| `scripts/qualify-*.mjs` | Opt-in qualification workloads for the QA engine and the launchers |
| `scripts/start-local.mjs`, `start-jev-local.mjs`, `jev-test-server.mjs` | Local start helpers and the JEV model lab |
