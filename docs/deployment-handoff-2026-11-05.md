# Drytis deployment-agent prompt — current QASE plus deployment repair

Copy the following assignment to the Drytis deployment agent. Supply the
deployment-repair patch with it if these changes have not yet been pushed.
This document authorizes no action by itself; the operator must authorize the
deployment in the deployment environment. Local preparation has not changed
production, scheduled paid probes, committed or pushed this repair.

---

Deploy the latest reviewed QASE implementation to **https://qase.drytis.com**.
Use the current application, preserve production data, and complete the exact
source, CI, image, staging and canary gates below. A failed gate means STOP;
keep the healthy existing deployment serving traffic and return the evidence.
Do not describe a published branch or a healthy old server as a successful
upgrade.

## 1. Pin the correct version and preserve current state

Repository: `https://github.com/XSTOOR/QASE-2.1`

Branch: `codex/hybrid-production-readiness`

Application baseline: `524a55593201321eb427df78186c9847797656be`.

Release ID: `qase-2026-10-28-hybrid-production-r5`.

UI version: `20261105-2`.

Working checkout: `/workspace/QASE-hybrid-b930996`. Do not deploy the parent
`/workspace`, its other application copies or an old branch. Preserve any local
changes; never reset, force-push or silently deploy `ad0afcd`/`3e6d040` instead.

Read `DEPLOYMENT_PROMPT.md`,
`docs/sqa-founder-hybrid-integration-2026-11-05.md` and
`docs/hybrid-qualification-renewal-2026-11-05.md` from the candidate source.
Inspect actual Drytis deployment configuration, running source, service manager,
data paths, mounted secrets, image digest and active runs. Historical deployment
numbers and the September runbook are context, not a current inventory.
Record the old immutable image/config and take a consistent backup of accounts,
runs, reports and evidence. Verify the restore procedure. Preserve DNS, TLS,
SMTP, identities, tenant mappings, database/Redis and mounted volumes.

## 2. Apply the necessary deployment repairs before CI

The application baseline is not a green deployment candidate:

- GitHub run `41924149473` at `ad0afcd` was cancelled during verification by
  its 30-minute job deadline. Browser/OS dependency installation consumed about
  27 minutes of that job, with slow Ubuntu downloads. Image build and image
  smoke did not run. Do not incorrectly attribute all 30 minutes to the suite.
- Run `42003905508` at `524a555` failed verification: 2,236 pass, one failure,
  two cancellations and 32 skips. The gateway fixture relied on an unreferenced
  Node 22 abort timer with no pending transport handle. The native-browser
  fixture implicitly chose the runner's independently updated branded Chrome
  while assuming a fixed catalog version.

If the attached deployment-repair patch is not already in this branch, apply it
to the preserved baseline with `git apply --check` followed by `git apply`.
If it conflicts, inspect and reconcile just those files; do not overwrite
unrelated changes. The repair must include:

1. A finite 90-minute CI job deadline, retained verification logs and unchanged
   failure gating. Agent budgets/timeouts must not be increased.
2. A bounded referenced mock transport in
   `server/hybridGatewayQualification.test.js`, still requiring the real abort
   and exact usage checks to pass on Node 22.
3. An explicitly bundled simulated browser in
   `server/runtimeFinalization.integration.test.js`, plus a real-browser test
   proving version mismatches remain blocked. Do not weaken the production
   identity gate or force a PASS.
4. Commit-specific image tags, exact revision-label validation in image smoke,
   and a successful-run image archive/checksum/identity artifact.

Run the focused tests and `npm run release:verify`. After any intentional
source edit regenerate the manifest with `npm run release:manifest` and verify
it again. Commit and push only the reviewed focused repair on this branch if
authorized by the operator. Record the resulting full commit as `EXPECTED_SHA`;
it must contain baseline `524a555` and the repair. Deploy that exact commit.
Do not keep calling the changed source `524a555`.

## 3. Require new successful CI for EXPECTED_SHA

Use Node 22 (or separately qualified Node 24), the locked dependencies and real
Chromium/Firefox/WebKit bundles. No dependency upgrades, `continue-on-error`,
required-test skips or edited assertions to hide failures.

Run the repaired `.github/workflows/verify.yml` on `EXPECTED_SHA`. Retrying the
old commit still uses the old workflow and fixtures; it cannot incorporate the
repair. Verify actual workflow `head_sha`, conclusion, test totals and every
required job step. A cancelled or skipped image gate is a failure.

Require: `npm ci`, browser installation, full `npm run verify`, live-preview
UI qualification, source-manifest verification, Docker image build, hardened
production-image smoke and successful artifact packaging. Review optional
infrastructure skips against the actual deployment topology. If GitHub access
returns 401/403, restore the repository connection and CI permission through
the supported authorization flow; never request tokens in chat or bypass CI.

## 4. Build and promote the exact tested image

Do not require a Docker daemon in the development IDE container. Use the
approved Docker-capable builder/deployment host and the successful CI image
artifact `qase-production-image-<EXPECTED_SHA>`.

Verify `qase-image-<EXPECTED_SHA>.tar.gz.sha256` before loading the archive.
Inspect the resulting image: non-root user `node`, correct release label, and
`org.opencontainers.image.revision` exactly `EXPECTED_SHA`.

Run on the Docker-capable host from the matching checkout:

```bash
node scripts/smoke-production-image.mjs "qase:sha-${EXPECTED_SHA}" "$EXPECTED_SHA"
```

Promote the same smoke-tested image to the approved registry, scan it under the
organization's policy and deploy its immutable registry digest. Record the
archive checksum, image ID and registry digest separately. They are not
interchangeable. Do not deploy a mutable `latest` tag, rebuild different source
after smoke, mount a Docker socket into QASE or substitute an untested image.

This is a persistent Node/Express application, not a static build. Preserve
the actual approved topology; do not convert PostgreSQL/distributed production
to the local-store Compose example. Preserve local-store volumes if production
uses them. Do not apply migrations to a local store. If PostgreSQL is actually
used, check its checksummed schema against all candidate migrations and use
the normal backed-up maintenance procedure with separate migration credentials.

## 5. Qualify model access and keep qualification renewed

Use the deployment's existing secret manager and effective account/server key.
Do not import developer configuration, keys, user sessions or receipts.

- Opus: `drytis/claude-opus-4.7`, fixed chat-completions endpoint.
- JEV: `jev-1.13`, fixed Decisions endpoint.
- Preserve the single CleanSlate SDK loop and host security/evidence gates.

Run `npm run qualify:hybrid-gateway` and
`npm run qualify:hybrid-startup` in the candidate deployment runtime with
matching credentials and persistent qualification storage. All 13 protocol
checks must pass, including native SDK continuation, cancellation and exact
streaming usage. No model substitution, estimated authoritative usage or
qualification-expiry bypass is permitted.

Before enabling QA traffic, configure an operator-owned serialized renewal
job, for example every 12 hours, in that same protected runtime/environment
and storage. Verify one real renewal and restart persistence; alert on failure
and before expiry. Distributed API/worker replicas must see the same receipt.
Do not claim the application contains an automatic keeper. Its operator button
can renew compatibility, but the receipt still expires after 24 hours.

Keep JEV degradation disabled. Preserve approved QA settings. Keep new SQA and
Founder reasoning flags disabled unless their separate documented qualification
and activation gates have passed. In particular, a new successful gateway probe
does not reconcile the earlier public SQA HTTP 500's missing usage receipt.

## 6. Real staging acceptance before promotion

Use the same image and production-shaped configuration with isolated accounts,
storage and owned targets. Confirm authentication required, registration closed,
`/demo` unavailable, accurate release assets and working browser engines.

The previous deployment report explicitly recorded composer-driven QA runs
ending `interrupted` with `HYBRID_NO_PROGRESS`. A scripted test passing does
not waive this. Run the real UI composer and normal new-run launcher. Require
actual useful interactions, evidence, accurate accountable scenario dispositions,
safe continuation and a persisted report. Record run IDs, model usage and final
status. If executable work is abandoned or the same interruption recurs, do not
promote; preserve checkpoints and diagnose the actual failure.

Test refresh/SSE reconnection, cancellation without late publication, secure
credential handoff, report downloads and explicit Results navigation. Do not
use arbitrary customer targets for writes or perform destructive testing.
Check existing SQA/Founder paths too; do not call missing reviewer evidence a
compliance PASS or silently activate their new reasoning strategy.

## 7. Promote, verify and roll back safely

Only after all required gates pass and operator deployment approval is present,
drain active runs and promote the pinned image through the actual Drytis
deployment mechanism. Preserve backups, service configuration, resource limits,
secrets, ingress/SSE settings and persistent volumes. No branch rewrite or
unrelated platform redesign.

Run `node scripts/check-deployed-release.mjs https://qase.drytis.com` from the
unchanged matching checkout. Verify HTTPS, `/healthz`, `/readyz`, UI `20261105-2`,
six asset hashes, deployed source revision and registry digest. Then verify
login, isolated authorized canaries, report persistence, exports and refresh.
A healthy old deployment is not a successful upgrade. Roll back to the recorded
previous image/config if post-promotion checks fail; preserve data and report
the failure. Never delete volumes or reset customer state to recover.

Return the deployed full SHA, release/UI versions, successful CI URL and
step/test results, artifact checksum, image/registry digest, model qualification
expiry and renewal evidence, backup/rollback reference, canary run IDs,
health/auth/SSE/export results and remaining limitations. If blocked, identify
the exact failed gate and confirm production remains on its previously verified
version. Do not claim deployment until the live identity matches.

---

## Local repair validation (preparation evidence, not production acceptance)

On November 5, the two cancelled gateway tests were reproduced with the exact
CI Node version, 22.23.4. With the bounded transport fixture they passed ten
isolated repetitions without cancellation. The native Chromium finalization
fixture and its added mismatch-blocking case both passed on Node 22. No
production runtime identity or agent permission gate was changed.

`npm run verify` on Node 22.23.4 completed with **2,241 passed, zero failed,
zero cancelled, 32 skipped** out of 2,273 tests, in **257,550.076 ms**. Syntax,
private-path and credential checks passed. Optional media, engine, SDK/browser
and PostgreSQL/Redis cases remain skipped in this invocation and must not be
represented as passes. Log:
`/private/tmp/qase-deployment-repair-node22-verify.log`.

The real Chromium/HTTP/SSE live-preview gate passed, including secure credential
consent, accurate partial coverage, refresh, cancellation recovery messaging and
explicit Results navigation; no page errors. It uses an injected executor and
is not a live-model QA/composer qualification. Log:
`/private/tmp/qase-deployment-repair-live-preview.log`.

Focused release/image/gateway checks passed on Node 22; the gateway and image
identity checks also passed on Node 24. The official checksummed actionlint
1.7.12 workflow validation passed (optional shellcheck was not installed).
The image-identity test rejects wrong commits despite matching release labels,
wrong releases, invalid revisions and root users.

Docker/image execution and a new GitHub run remain **unverified** here. This
repair has not been committed, pushed, deployed or used to activate flags.
Full production acceptance still requires the gates in the prompt above,
particularly the real composer path, image smoke and qualification renewal.
