# Deploy the current QASE release to production

You are the Drytis coding and deployment agent. Deploy the attached QASE source snapshot to **https://qase.drytis.com** and propagate this source version to every maintained repository branch. Use the supplied ZIP as the authoritative application source, not an older checkout, previous ZIP, scaffold, Docker image, or cached build.

## Required release

- Release ID: `qase-2026-10-15-run-startup-r2`.
- UI version: `20261015-19`, including the production queue/startup hotfix and the existing compact run cards (`runCard.css?v=20261015-17`).
- Read `docs/production-run-startup.md` first. A successful POST is not proof of execution: verify a visible queued run, an allocated session, live activity, and a terminal outcome. Do not cancel other users' work to free capacity.
- For Git-based deployment instead of a ZIP, use `https://github.com/XSTOOR/QASE-2.1`, branch `codex/fix-production-run-startup`, and record the checked-out commit. Verify its `SOURCE_MANIFEST.json` before building. Never substitute the old r1 main-branch snapshot.
- The application root is the extracted folder containing `package.json`, `public/`, and `server/`. It is a Node.js Express application serving static ES modules, NOT a Next.js or Vite build. Do not deploy the parent workspace, an old `apps/` project, or a generated `dist/` directory.
- Run Node.js 22 or 24. Keep `package-lock.json` and Playwright `1.62.0` unchanged; use `npm ci`, not dependency upgrades.
- Preserve all current QA, SQA, Founder, authentication, reports, browser/runtime, device matrix, and UI functionality. Do not redesign or replace the application during deployment.

## Establish the exact source before making changes

1. Verify the ZIP against its separately supplied `.sha256` file. Extract into a NEW, empty release directory. Do not overlay extraction onto an old application directory: that can leave stale executable files behind.
2. From the extracted root run `node scripts/verify-release.mjs`. Every entry in `SOURCE_MANIFEST.json` must match. Record the release ID and the ZIP SHA-256 in the deployment log. The hashes establish content identity; protect the handoff/checksum channel because the manifest is not a digital signature.
   The package canonicalizes UTF-8 text to LF line endings, matching `.gitattributes`; do not let an editor or checkout rewrite those bytes to CRLF before verification or building.
3. Read `RELEASE_NOTES.md`, `Dockerfile`, `deploy/production/compose.yaml`, and existing production architecture before selecting a deployment path.
4. Inventory the actual repository/remotes, default branch, all maintained remote branches, existing deploy triggers, production service, DNS provider, TLS termination, registry, runtime data volumes, account store, database, and rollback image. Do not assume infrastructure names or access credentials.
5. Back up existing production data and record a tested restore procedure BEFORE changing deployment paths, storage, or migrations. Keep a backup of each branch's pre-update commit. Do not import `.qase`, `.drytis`, uploaded user documents, credentials, model keys, local accounts, or run history from a developer machine.

## Synchronize branches without reintroducing older code

The user wants this source version on all branches. Inventory and report every maintained remote branch, including the default branch and production/staging/development branches; do not silently update just one.

1. Create a reviewed import commit on `codex/qase-production-release` from the target repository's actual default branch. Place this snapshot at the REAL deployment application root. If the repository contains multiple apps, preserve unrelated applications and infrastructure.
2. Within the reviewed QASE application path, replace obsolete application code with this snapshot rather than blending old implementations back in. Review removals of obsolete executable files explicitly. Preserve production data and external secrets. Do not run broad recursive deletion against a repository or filesystem root.
3. Commit `SOURCE_MANIFEST.json` with the snapshot. Verify the committed application tree against it. Keep protected-branch rules enabled; use pull requests and required checks, never force pushes or rewritten history. Do not delete branches, tags, audit history, or unmerged work.
4. Merge or cherry-pick the reviewed import commit onto each maintained branch using a branch-specific review. Resolve conflicts so the QASE source matches this release. Do not overwrite another branch's unrelated work. If exact QASE-tree parity conflicts with pending changes, stop that branch update for a maintainer decision and report it explicitly.
5. Verify `node scripts/verify-release.mjs` on EVERY updated branch and record each branch's resulting commit SHA. Old release tags remain historical references, not deployment targets. Archived/vendor branches that cannot be changed require an explicit reported exception rather than a force update.
6. Point every active QASE deployment workflow at the new application path/reviewed commit and immutable image. Disable or retarget obsolete QASE deploy jobs with review so an old branch cannot automatically redeploy the previous version. Do not disable unrelated service pipelines.
7. Create a release tag only after required checks pass. Never move an existing tag. Future intentional source edits require a new release ID, regenerated manifest, new image, and review; do not edit this snapshot while retaining its identity.

## Verify before building

Run on the intended Linux execution host or CI runner with browser process permissions and outbound package access:

```bash
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run verify
node scripts/verify-release.mjs
```

`npm run verify` performs syntax checks, a high-confidence credential scan, private-path ignore checks, and the recursive test suite. It requires Git and a repository initialized at the extracted source. The committed workflow `.github/workflows/verify.yml` also builds the container. Browser-dependent tests must run with real installed bundles; do not turn failures into fabricated passes or silently skip them.

If a test requires PostgreSQL, Redis, or a configured external integration, supply isolated test services and review documented opt-in skips. Capture totals and skipped reasons. A local machine's browser-launch or network restrictions do not establish production readiness. A failing required test or failed image build blocks promotion. Report a genuine infrastructure blocker and the exact failing check instead of deploying an older version.

## Choose the deployment topology

For an existing managed Drytis deployment, retain its approved ingress, secrets, data store, worker topology, and backups. Build this root Dockerfile and deploy its immutable digest through that platform. Expose container port **5173**, set `QASE_HOST=0.0.0.0`, and route the public hostname to that service. This is a long-running browser workload: do not use a static-only host, request-limited serverless functions, or a container that sleeps during a run.

The included Compose setup is a **single-host, single-application-replica** baseline with a local durable store and Caddy TLS. It is not a high-availability or autoscaling configuration. Use it only for a fresh deployment or a reviewed compatible local-store upgrade. If production already uses PostgreSQL/distributed workers, DO NOT switch it to local storage or use these Compose defaults. Follow `deploy/kubernetes/README.md` and existing approved overlays, run migrations with separate DDL credentials, preserve tenant IDs, use TLS for database/Redis, and share durable evidence storage as documented. Existing Kubernetes manifests contain placeholders and must not be blindly applied.

Browser execution can visit untrusted sites. Keep this service on dedicated execution infrastructure, restrict access to cloud metadata and private management networks at the host/network layer, keep application/browser egress policy enabled, enforce resource/concurrency limits, and never grant Docker socket access, privileged mode, host networking, or broad production credentials to browser containers. Bundled Chromium/Firefox/WebKit do not prove a native Safari or physical mobile-device execution; preserve the UI's honest runtime labels.

## Configure secrets and access

Keep secrets in the platform secret manager or a root-readable deployment environment file, never in source, ZIPs, images, frontend assets, chat, or build logs.

- `NODE_ENV=production`, `PORT=5173`, `QASE_HOST=0.0.0.0`.
- `QASE_PUBLIC_URL=https://qase.drytis.com`.
- `QASE_AUTH_REQUIRED=true`, `QASE_OPEN_REGISTRATION=false`.
- `QASE_TRUST_PROXY=true` ONLY when the application port is reachable exclusively through the trusted edge; never publish port 5173 directly to the internet. Review forwarded-header behavior if Drytis adds another proxy.
- Managed models: `QASE_PROVIDER=custom`, `QASE_BASE_URL=https://llm.drytis.ai/v1`, `QASE_API_KEY` from the operator's secrets manager, and `QASE_MODEL` set to an ID actually returned/accepted by that gateway. Confirm its `/v1` path against the live gateway. No per-user provider onboarding or hardcoded key.
- Browser defaults: `QASE_HEADLESS=true`. Permit outbound DNS/HTTPS to the model gateway and authorized test targets. Allowlist additional authentication origins only after review using `QASE_BROWSER_ALLOWED_ORIGINS`. Do not disable SSRF/private-network protections to make a test pass.
- Configure real SMTP using `QASE_MAIL_MODE=smtp` and the `QASE_MAIL_*` settings in `deploy/production/.env.example`; verify delivery to the approved operator account. Mock mail is not production password recovery.
- For a NEW deployment, set three distinct real bootstrap UUIDs and approved operator email/name using `QASE_BOOTSTRAP_ORGANIZATION_ID`, `QASE_BOOTSTRAP_PROJECT_ID`, `QASE_BOOTSTRAP_USER_ID`, `QASE_BOOTSTRAP_USER_EMAIL`, and `QASE_BOOTSTRAP_USER_NAME`. For upgrades preserve existing identities and ownership mappings.
- Keep `.qase/config.json` and per-user saved model preferences under review during migration: persisted settings can override environment defaults. Do not delete customer configuration blindly. Use the supported settings flow and a controlled settings migration if old preferences point at an unavailable model.

For first login to an EMPTY local store, keep the app stopped and supply a NEW approved operator email and unique password (at least 14 characters) via protected environment variables. Run `scripts/bootstrap-operator.mjs` once in the app image with the durable state volume mounted. It refuses to change a populated account store. Do not open public registration for bootstrap. For existing accounts, reuse the established operator/recovery process; do not reset passwords or overwrite authentication data.

## Deploy using Compose when that topology is appropriate

Use an always-on Linux host with Docker Engine and Compose. Size CPU, memory, disk, browser concurrency, and model quotas from a staging canary; start conservatively with one concurrent browser assessment. Browser-heavy runs need more resources than a static website.

The commands below run from the extracted source root. Provision `deploy/production/.env.production` from `deploy/production/.env.example` through the secret manager, replace every placeholder, and restrict its permissions before continuing. The Compose file explicitly enforces closed registration, authentication, local storage, the public URL, and production mode.

```bash
export QASE_IMAGE=qase:qase-2026-10-15-run-cards-compact-r1
node scripts/verify-release.mjs
docker build --pull --tag "$QASE_IMAGE" .
docker compose -f deploy/production/compose.yaml config --quiet
```

Scan the resulting app image and Caddy image against the organization's current vulnerability policy. Resolve app and base/proxy image digests in the registry and pin the DEPLOYED images by digest. Do not use `latest`, reuse a mutable old application tag, or assume a historical base tag has passed today's scan. A required security update must become a separately identified, reviewed release rather than an invisible replacement of this snapshot.

For a NEW EMPTY local account store ONLY, with the app not running and operator variables already provided privately:

```bash
docker compose -f deploy/production/compose.yaml run --rm \
  -e QASE_OPERATOR_EMAIL -e QASE_OPERATOR_PASSWORD \
  app node scripts/bootstrap-operator.mjs
```

Unset the operator bootstrap password variable immediately after use. Never pass plaintext secrets as command-line values or print a resolved Compose configuration containing secrets.

Provision DNS A/AAAA or a platform-approved CNAME for `qase.drytis.com`; remove a stale AAAA record if IPv6 is not actually served. Confirm no conflicting old route continues to serve the prior application. Direct ports 80/443 to the TLS edge and allow certificate issuance/renewal. If Drytis already terminates TLS, integrate with its existing ingress instead of starting a conflicting Caddy listener.

```bash
docker compose -f deploy/production/compose.yaml up -d
docker compose -f deploy/production/compose.yaml ps
```

The default named volumes hold application/accounts/run state, evidence, and TLS material. Preserve their project name (`qase-production`) and volume mappings across upgrades. For existing data, migrate it using a reviewed, downtime-consistent restore into the intended volumes and UID/GID 1000 permissions; a new empty volume is not a successful migration. Back up state and evidence together and test restore. Do not use `docker compose down -v`, `docker volume prune`, or data deletion as a troubleshooting step.

## Validate the live deployment before promotion

From the unchanged extracted snapshot:

```bash
node scripts/check-deployed-release.mjs https://qase.drytis.com
```

This checks HTTPS health/readiness, the exact release ID, and SHA-256 for six public release assets. Also inspect the app image digest and committed source SHA. A `/healthz` response alone is not proof that the correct frontend or a working agent is deployed.

In a clean browser, verify:

1. TLS and canonical hostname; login, logout, account isolation, closed registration, and SMTP recovery. Unauthenticated `/api/sessions` must not return private runs. Production `/demo` must not expose test fixtures.
2. Current white QASE dark-mode branding, semantic status lights, compact recent-run cards, readable buttons, responsive layout, and device/browser matrix. Confirm `runCard.css?v=20261015-17` is in the served HTML. Test search, run selection, collapse, results/report routing, and the browser preview control.
3. With an authorized staging test account and an explicitly owned test target, run bounded QA, SQA, and Founder canaries. Confirm actual browser actions, live activity/SSE, questions/credential requests, persistence after refresh, stopping, and recorded evidence/report downloads. Never use a production target for destructive tests, payments, signup spam, intrusive exploitation, or uncontrolled paid AI generation.
4. Model requests actually succeed from the execution host. A ready API without gateway connectivity or browser executables is not acceptance.
5. Agent streams stay live through the ingress/CDN. Disable proxy buffering and inappropriate caching for `/api/*` and SSE; do not impose a short execution/request timeout on live streams. The Caddy baseline uses `flush_interval -1`. Do not cache private API data.
6. Remove stale CDN copies of HTML and affected assets through the approved cache controls. Existing browser tabs must detect the new UI version or reload cleanly; a service worker or old image must not continue serving the prior build. Keep the cache-busting query versions intact.
7. Restart/recreate the application only after draining active canary runs, then confirm accounts, runs, evidence, settings, and reports persist. Verify graceful shutdown, disk capacity, log rotation, health monitoring, backup restore, and target/model quota alerts.

## Rollback and completion report

Keep the previous verified production image/digest and consistent data backup available until acceptance completes. Roll back through the deployment platform to that recorded digest if health, security, data integrity, or canary checks fail. Do not automatically roll back database schema changes against live data; use the reviewed migration/restore plan. A rollback is an explicitly reported emergency exception to the request to use the new source, never a silent deployment of an old ZIP.

Return the live URL, release ID, ZIP SHA-256, source commit, app/proxy image digests, deployment path, storage/backup locations without secrets, DNS/TLS outcome, full test totals and skipped reasons, canary evidence, and a branch-by-branch table of resulting SHAs/PRs and unresolved protected-branch exceptions. State clearly whether traffic has been promoted and whether any branch still differs. Do not report completion until the exact-source live verification and required canaries pass.

## Reference documentation

- [Playwright container and dependency guidance](https://playwright.dev/docs/docker).
- [Caddy reverse proxy and streaming configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- Included operational details: `docs/operations-runbook.md`, `docs/smtp-password-reset-setup.md`, `docs/sqa-runtime.md`, and `deploy/kubernetes/README.md`.
