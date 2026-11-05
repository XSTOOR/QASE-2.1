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
