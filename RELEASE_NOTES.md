# QASE hybrid production candidate

Release: `qase-2026-10-27-hybrid-production-r1`. UI: `20261027-5`.
Target: `https://qase.drytis.com`. This is a source/image handoff, not a record
of deployment or production activation.

## Preserved history and compatibility

Based on GitHub main `82911f8db54f7eb3efeb9b45e96d12c21805756f`, preserving its
authentication, tenant isolation, local/PostgreSQL stores, distributed workers,
SQA/Founder, integration, evidence and deployment-resilience foundations.
The public site currently reports the October 16 single-browser release;
compare its actual checkout/infrastructure before promotion because that release
is newer than the GitHub baseline. No production files, secrets or data were
changed during preparation.

## Application changes since the previous GitHub release

- Opus 4.7 reasoning and JEV 1.13 typed classification through one CleanSlate
  loop, with host permission, usage, budget and completion authority.
- Durable scenarios, evidence, conservative usage recovery and explicit gaps;
  no unexecuted scenario or model agreement can become a passing test.
- Scoped route exploration uses remaining page slots correctly; report
  publication and closeout share one depth policy. Completed closeout runs do
  not spend additional model calls republishing their existing report.
- Guarded live input/negative-path checks restore fields without submission,
  and responsive samples restore the selected device preview.
- Hybrid-only QA launcher, clearer recovery/buttons, explicit Results/Back,
  and startup/refresh restoring the run workspace rather than auto-opening Results.
- Existing run execution modes remain pinned. Legacy/JEV-only rollback APIs,
  SQA and Founder paths remain available.
- Hybrid exposes native blocking questions and requires an access decision at
  observed login walls. Secure explicit consent grants one guarded test-account
  sign-in; successful access enables fresh signed-in route observations without
  treating access as a passed authentication suite. Scope decisions and bounded
  goal memory survive restart. Failed credential validation retains the form.
- Sign-in waits for client rendering instead of inspecting immediately after
  DOMContentLoaded. Explicit exact authentication-API consent supports a separate
  backend without granting arbitrary cross-origin writes. Blocked access requires
  a recovery decision; private route depth and session-expiry detection are scoped
  to the current access state. Compact ledger-based closeout preserves more of the
  existing budget for exploration. Plan resolution is shown separately from coverage.

## Deployment changes

- Shared source inventory and `npm run release:manifest` regenerate the checked-in
  SHA-256 manifest. Docker verifies it in a source stage before runtime layers.
- Source-only Docker context excludes developer state and dependencies. The
  runtime retains the locked Node 22/Playwright installation, non-root user,
  health check and persistent state/evidence paths, with release/revision labels.
- CI verifies source/tests, builds the image, boots an isolated hardened
  container, checks protected APIs/closed registration/demo exclusion and launches
  Chromium, Firefox and WebKit. It also uploads the source ZIP and checksum.
  CI does not publish images, deploy, migrate data or activate models.
- Production environment examples and runbook document target-host gateway
  qualification, receipt persistence/renewal, optional PostgreSQL migrations
  041/042, draining and rollback. No dependency versions were upgraded.

## Required operator gates

Docker is not installed on the preparation machine; Linux image checks must
pass in CI or on the approved build host. Test/CI outcomes belong to the review
commit and must not be inferred from this document. Opt-in database/integration
skips require isolated staging verification where those services are used.

Keep authentication required and registration closed. Preserve production
identity, database, Redis, volumes and account settings. Apply migrations through
the reviewed process before hybrid/partial-report writes on PostgreSQL. Never
replace an existing distributed deployment with the single-host Compose example.

Hybrid remains disabled by default. Before activation, qualify all 13 gateway/
SDK capabilities inside the target image using the provisioned account key;
receipts expire after 24 hours and must be renewed through approved operations.
Do not copy developer keys or `.qase` state, weaken receipt checks, reset budgets,
or silently substitute models. Then run authorized staging QA/SQA/Founder,
SMTP recovery, isolation, evidence-persistence and ingress/SSE canaries.

Read `DEPLOYMENT_PROMPT.md` for exact steps and rollback. Publishing this branch
does not authorize merging, switching traffic, or changing other branches.
