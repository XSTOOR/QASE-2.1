# Deploy the current QASE release to production

This is the operator runbook for the reviewed release targeting **https://qase.drytis.com**. Publishing source or opening a pull request does not authorize deployment, production activation, migrations, or changes to other branches. Promote only the reviewed commit and immutable image after required checks and explicit deployment approval.

## Required release

- Release ID: `qase-2026-10-27-hybrid-production-r1`.
- UI version: `20261027-6`, including hybrid-only QA setup, precise coverage/closeout, explicit Results navigation, host continuation decisions and the completed-run startup fix.
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

## Preserve repository and production history

The source is based on main commit `82911f8db54f7eb3efeb9b45e96d12c21805756f`, the October 15 production handoff. Preserve its earlier authentication, tenant, PostgreSQL/distributed execution, deployment resilience and Drytis integration commits. Review this release on `codex/hybrid-production-readiness`; do not force-push, rewrite main, or propagate to other branches without a separate request.

The public production metadata observed during preparation reports `qase-2026-10-16-single-browser-r4` / UI `20261016-3`, newer than GitHub main. Before promotion, compare the actual deployment checkout and infrastructure with this branch; public health/version checks cannot establish backend source parity. Preserve production-only changes and existing storage/identity settings. Record the currently deployed image digest for rollback.

After intentional source edits, run `npm run release:manifest` and commit the regenerated `SOURCE_MANIFEST.json`. `npm run release:verify` must pass on the exact checkout and package. Create new release identities for subsequent releases; never move historical tags. Do not automatically merge or deploy this review branch.

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

## Qualify and enable hybrid on the execution host

New QA setup uses hybrid exclusively. Leaving hybrid disabled or unqualified intentionally blocks new QA launches; it does not silently fall back to another agent. Existing JEV-only/legacy runs, SQA and Founder retain their respective paths.

1. Provision the approved account/server gateway key through the secret manager. Hybrid roles are fixed to Opus `drytis/claude-opus-4.7` at `https://llm.drytis.ai/v1/chat/completions` and JEV `jev-1.13` at `https://llm.drytis.ai/typesafe/api/alpha/decisions`. `QASE_PROVIDER=custom`, the `/v1` base URL and the Opus model in the template also supply the generative SQA/Founder path. Preserve reviewed per-account settings; do not import a developer key.
2. For PostgreSQL, apply reviewed migrations **041 and 042 before enabling hybrid or accepting this release's partial QA reports**, using the normal maintenance job and a tested backup/restore procedure. Migration 041 extends report verdicts with `partial`; 042 adds bounded hybrid JSON state. Legacy reads tolerate the absent optional column, but hybrid writes require it. No production migration was run during release preparation.
3. Using the intended image, key and durable state volume, run the harmless gateway/SDK qualification and startup checks. For the single-host Compose baseline:

```bash
docker compose -f deploy/production/compose.yaml run --rm \
  -e QASE_HYBRID_QA_ENABLED=true app node scripts/qualify-hybrid-gateway.mjs
docker compose -f deploy/production/compose.yaml run --rm \
  -e QASE_HYBRID_QA_ENABLED=true app node scripts/qualify-hybrid-startup.mjs
```

These use the configured paid gateway for bounded protocol fixtures; they do not test a customer site. All 13 capabilities must pass, including the actual CleanSlate loop, image/tool continuation and exact streaming usage. Never copy `.qase` state or locally generated receipts into production. Receipts are tied to model/key/SDK identity, expire after 24 hours, and default to `/app/.qase/qualifications/hybrid/`. Keep them available to API and execution workers and renew through an approved operator process before expiry; monitor availability. Do not extend expiry or bypass failed qualification.

4. After qualification and activation approval, set `QASE_HYBRID_QA_ENABLED=true` in the deployment's config system and recreate the drained service. Keep `QASE_HYBRID_ALLOW_WITHOUT_JEV=false` unless degradation is separately approved. Repository defaults remain disabled. Missing usage receipts pause safely; budgets and uncertain browser actions must not be reset to force progress.
5. On an authorized staging target, verify live actions, negative inputs without submission, selected-device restoration, evidence-linked findings, honest partial coverage, cancellation and refresh. The image canary verifies startup/auth/browser installation; it does not certify SMTP, tenant integration or live model execution.

## Deploy using Compose when that topology is appropriate

Use an always-on Linux host with Docker Engine and Compose. Size CPU, memory, disk, browser concurrency, and model quotas from a staging canary; start conservatively with one concurrent browser assessment. Browser-heavy runs need more resources than a static website.

The commands below run from the extracted source root. Provision `deploy/production/.env.production` from `deploy/production/.env.example` through the secret manager, replace every placeholder, and restrict its permissions before continuing. The Compose file explicitly enforces closed registration, authentication, local storage, the public URL, and production mode.

```bash
export QASE_IMAGE=qase:qase-2026-10-27-hybrid-production-r1
node scripts/verify-release.mjs
docker build --pull --build-arg QASE_SOURCE_REVISION="$(git rev-parse HEAD)" --tag "$QASE_IMAGE" .
node scripts/smoke-production-image.mjs "$QASE_IMAGE"
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
2. Current QASE branding, status lights, readable buttons and responsive layout. Confirm `app.js?v=20261027-6` is served. Test hybrid-only setup, selected browser, pause/recovery, root entry/refresh staying on the run workspace, explicit Results/Back navigation and the stable selected-device preview.
3. With an authorized staging test account and an explicitly owned test target, run bounded QA, SQA, and Founder canaries. Confirm actual browser actions, live activity/SSE, questions/credential requests, persistence after refresh, stopping, and recorded evidence/report downloads. In hybrid, test secure-form consent, one approved sign-in, explicitly consented separate authentication API, rejected duplicate/unrelated writes, remembered Skip login, fresh signed-in observations and no replay after uncertain dispatch. Native-form username/password sign-in is supported; SSO/MFA and unapproved cross-origin sign-in are explicit limitations, not compatibility claims. Never use a production target for destructive tests, payments, signup spam, intrusive exploitation, or uncontrolled paid AI generation.
4. Model requests actually succeed from the execution host. A ready API without gateway connectivity or browser executables is not acceptance.
5. Agent streams stay live through the ingress/CDN. Disable proxy buffering and inappropriate caching for `/api/*` and SSE; do not impose a short execution/request timeout on live streams. The Caddy baseline uses `flush_interval -1`. Do not cache private API data.
6. Remove stale CDN copies of HTML and affected assets through the approved cache controls. Existing browser tabs must detect the new UI version or reload cleanly; a service worker or old image must not continue serving the prior build. Keep the cache-busting query versions intact.
7. Restart/recreate the application only after draining active canary runs, then confirm accounts, runs, evidence, settings, and reports persist. Verify graceful shutdown, disk capacity, log rotation, health monitoring, backup restore, and target/model quota alerts.

## Rollback and completion report

Keep the previous verified production image/digest and consistent data backup available until acceptance completes. Roll back through the deployment platform to that recorded digest if health, security, data integrity, or canary checks fail. Do not automatically roll back database schema changes against live data; use the reviewed migration/restore plan. A rollback is an explicitly reported emergency exception to the request to use the new source, never a silent deployment of an old ZIP.

Return the live URL, release ID, ZIP SHA-256, reviewed source commit/PR, app/proxy image digests, deployment path, storage/backup locations without secrets, DNS/TLS outcome, test totals/skipped reasons and canary evidence. Distinguish a published branch from an approved production deployment. Do not claim promotion or production acceptance until exact-source verification and required canaries pass.

## Reference documentation

- [Playwright container and dependency guidance](https://playwright.dev/docs/docker).
- [Caddy reverse proxy and streaming configuration](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
- Included operational details: `docs/operations-runbook.md`, `docs/smtp-password-reset-setup.md`, `docs/sqa-runtime.md`, and `deploy/kubernetes/README.md`.
