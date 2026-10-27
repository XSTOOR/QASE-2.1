# QASE hybrid production candidate

Release: `qase-2026-10-28-hybrid-production-r3`. UI: `20261028-1`.
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

- Existing interactive runs retain host-authored access and continuation questions through the
  native SDK pause/resume lifecycle. For those runs, budget limits do not silently publish
  unfinished work: the owner can approve a displayed bounded extension or
  explicitly request a gap report. Exact usage and prior evidence are retained.
- Premature prose-only stops get bounded automatic continuation. Budget abort
  cleanup preserves the pending decision and vault; duplicate approvals are
  rejected. Explicit closeout uses the same native ledger/report tools without
  another paid model request, including at an exhausted budget.
- Sign-in can recognize a bounded successful session receipt plus a rendered
  changed route, with an explicit owner confirmation fallback. HTTP 200 alone
  cannot prove access. Anonymous and signed-in executions of the same URL are
  tracked separately. These controls apply to new continuation-policy runs;
  existing closed reports are preserved.

## Automatic completion in r2

New runs use continuation policy 2: no token-budget, workflow-priority or generic
coverage-approval questions. Capacity is allocated automatically within a pinned
operator envelope; explicit QASE_HYBRID_* limits remain hard ceilings. Without
explicit overrides, ceilings are 2M Opus / 500k JEV tokens, 200/100 calls, 1,000
browser tool actions and 60 active minutes. Observed page attempts expand up to
40 by default, configurable to 80. At a configured limit, the host closes out
honestly through the same native SDK tools without another model request.
Unverified usage and uncertain actions still fail closed. Missing secure access
can still require the owner. Set QASE_HYBRID_AUTONOMOUS_COMPLETION=false to
retain the prior interactive policy for newly created runs; existing runs keep
their originally pinned policy.

Rolling inference context retains every human instruction and SDK policy,
recent tool rounds and durable evidence references. Old anonymous limitations
become history after confirmed access. Guarded onboarding Skip/dismiss and
observed navigation-region buttons reveal routes that anchor-only discovery
missed; writes remain blocked and navigation restores its source. A failed
restore requires state verification. No complete-site or exhaustive workflow
coverage is inferred from these bounded checks.

## Stalled-run repair in r3

A delayed onboarding modal could obstruct a navigation control after the initial
inspection. The host now refreshes observations and dismisses supported safe
close controls at action boundaries, including before trial-clicking. Only a
confirmed pre-dispatch obstruction can be retried once; dispatched or uncertain
actions are never replayed. Onboarding preparation no longer requires a model
to create a separate plan item. Actual checks still require their scenario and
host evidence.

Cancelled/already-handled Playwright requests no longer escape asynchronous
routing handlers and terminate the API process. Unexpected routing failures
abort fail-closed and produce sanitized diagnostics. The dashboard explicitly
shows reconnection and last-received progress during stream loss, then
resynchronizes the authoritative state without navigating to Results. A prior
run whose crash lost a provider receipt still needs exact reconciliation; the
fix does not erase billing exposure or invent successful completion.

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
