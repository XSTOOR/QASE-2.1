# SQA candidate review — 2026-11-05

Release: `qase-sqa-2026-11-05-readiness-r1`. UI: `20261105-2`.

The SQA branch preserves its original corrected-base work in local checkpoint
`467fb52`, then integrates the five newer upstream commits through
`ad0afcd3e1e13ee49e7ba86cea8e4602bcbfb76e`. These inherited commits include shared
agent, SQA/Founder publication and cancellation changes, so the merged source
requires fresh validation rather than inheriting an earlier green result.

## Reviewed SQA behavior

- Bounded browser workflows, input-token limits, context compaction and model
  inactivity recovery for legacy SQA execution.
- Deterministic evidence contracts and confirmed-finding/control consistency.
- Human evidence review with trusted roles, stale-write rejection, rollback and
  bounded immutable published history.
- Authenticated evidence inspection with retained redacted JSON bundles, digest
  checks and explicit unavailable, mismatched or external-unverified states.
- Shared report traceability and technical-result-first presentation.
- Three-engine desktop/mobile acceptance and real browser bridge checks.
- Patched dependencies, audit gates and reproduced security regressions.

Merge resolutions preserve these protections alongside upstream qualified mode
reasoning. Qualified synthesis keeps control-recording tools until confirmed
findings are reconciled; the legacy compactor does not clear its runtime.
Publication commits plan completion and version history together, restoring both
on a failed write. Reviewer publication continues to require an authorized human.
Single and batch observations retain the qualified runtime's live progress
ledger instead of detaching it through an assessment copy. The regression checks
also preserve observation rollback and prior-array isolation.

The inherited qualification tests use native resolved paths. Their Unix 0600
check runs on Unix filesystems; Windows mode bits do not validate ACL privacy.
Operators must secure qualification files with private Windows ACLs where that
platform is used. No permission or qualification check is bypassed in the service.

## Validation evidence and remaining scope

Before the upstream integration, Phase 12 passed 2,107 repository tests with 27
skips and zero failures, 153 SQA contract tests and six browser acceptance
journeys. A real gateway-backed fixture passed all six technical controls,
thirteen evidence records, exports, access isolation and restart persistence.
Its npm audit reported zero findings. These are historical results for the
pre-merge source, not an assertion that this merged candidate has passed CI.

The merged candidate `55cced1` passed local verification (2,262 passes, 31
skips, no failures), the dashboard fixture and both hosted SQA acceptance jobs
(Ubuntu and Windows). Its live GLM fixture passed all six technical controls,
verified 18 evidence bundles and covered all 30 controls: 13 passed and 17
remained blocked for missing assurance artifacts. Historical exports, restart
persistence, account isolation and credential scans passed. These results do
not establish the missing assurance artifacts or optional qualified mode.

The full Linux release job for that commit failed before image validation.
Follow-up test corrections retain the gateway mock's pending I/O handle until
abort, select the installed browser version for runtime identity verification,
and isolate matrix/test-case records through supported backend factories. The
retry route fixture models an active worker rather than starting external
probes while overwriting that worker's state. Runtime identity, timeout,
retry-limit and honest-status assertions remain required. Hosted verification
of a follow-up commit, including the image checks, remains outstanding until
its workflow succeeds. Do not interpret the local results as a green image gate.

A subsequent Node 22 local run exposed a cold first-paint race in the live
input fixture. Its control-readiness check correctly returned a coverage gap
before the first compositor frame. The fixture now waits for paint before
starting trials and includes result diagnostics on a field-count failure.
Five separate repeat runs passed with the same input, restoration, delayed
autosave and no-submission assertions. The production readiness window and
network quarantine were not relaxed; full-suite revalidation remains required.

Commit `42ce007` passed local verification and both hosted SQA jobs, but the
full Linux job still reproduced the matrix request timeout. Investigation found
concurrent cold registry reads launching independent browser-version subprocesses
before the cache was populated. A regression reproduced 256 lookups instead
of one; the catalog can fan out across thousands of environment records. This
was invisible on hosts without binaries at the registry's Linux paths.

The follow-up registry change shares pending probes with identical lookup and
launch requirements, retains explicit forced refreshes and prevents invalidated
or superseded results from overwriting a newer cache. Failed lookups release
their waiters and can be retried. Launch verification cannot be satisfied by
a pending version-only lookup. Five regressions cover these cases; three fail
against the previous implementation. Matrix route isolation alone did not fix
the Linux timeout, and image validation remains pending until hosted CI passes.

For the exact committed source, require `npm run audit:dependencies`,
`npm run verify`, `npm run test:sqa-release`, `npm run release:verify`, the
production-image build and `npm run test:production-image`. The GitHub checks on
the final commit identify the authoritative hosted result. The source manifest
must match the committed LF bytes; regenerate it after any inventoried edit.
The package excludes private runtime data and environment files.

No passing browser sample implies whole-product certification, physical-device
coverage or the presence of missing reviewer artifacts. Qualified Opus/JEV mode
requires its own exact gateway/SDK qualification and operator opt-in; the legacy
gateway fixture does not establish that optional architecture's production
readiness. Verify actual deployment identity, storage, ingress and schema before
promotion, including upstream migration 043 where applicable.

This branch is a source candidate for review and CI. A commit, branch push or
passing workflow does not authorize deployment, database changes, merging into
another branch or production traffic changes.
