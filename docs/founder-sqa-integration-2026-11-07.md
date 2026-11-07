# Founder and SQA integration - 7 November 2026

## Phase 0: preserved baseline

- Original checkout: `qase-2.1-sqa-hybrid`, branch `Push-SQA`.
- Baseline: `6f4a4d8c5a29642ec00a368e5014ddfcf38f09de`.
- Recovery branch: `baseline/push-sqa-20261107` at the same commit.
- Incoming branch: `codex/hybrid-production-readiness` at
  `21aeb0b1968e8a15a86290578c93ff67ca7486e2`, including
  `524a55593201321eb427df78186c9847797656be`.
- Common ancestor: `ad0afcd3e1e13ee49e7ba86cea8e4602bcbfb76e`.
- Divergence: 11 Push-SQA commits and two incoming commits; 18 shared files.
- Integration branch: `integration/founder-sqa-20261107`, in the separate
  `qase-2.1-founder-integration` worktree. Original application state, environment
  configuration, and the user's PDF output stay in the original checkout.

Two original local Founder runs establish the failure baseline. One retained
21 observations, with publication rejected for truncated JSON at character
33827 and then for an unresolved authentication boundary. Another retained 20
observations and ended in error after malformed JSON at character 11014. Neither
had a published report at the start of this integration. No customer run was
resumed or rewritten to establish these facts.

## Phase 1: reconciliation decisions

The merge conflicted in 13 files. Reconciliation preserves both sets of changes:

- Keep required browser attributes, expanded-scope explanations, device/readiness
  validation, and SQA evidence review in the launcher.
- Combine workflow-specific evidence binding with retained redacted digest
  bundles used by SQA evidence inspection and historical reports.
- Keep the SQA failed-assertion guard, browser/token limits, automatic reviewer
  closeout, bounded plans, and saved-evidence closeout behavior.
- Combine SQA's smaller recent inference window with the incoming trusted
  context deduplication, observed discovery/workflow gates, canonical evidence
  hashing, and durable Founder report sections.
- Preserve the existing SDK loop and the incoming verified workflow/report
  continuation boundaries. Default mode flags and saved run strategies retain
  their existing behavior.
- Keep dependency security checks and serial browser contracts, and incorporate
  CI diagnostic retention and exact smoke-tested production-image identity.
- Use the bundled browser explicitly in the identity fixture while deriving its
  version from the installed engine; test mismatched selections separately.
- Give the combined candidate its own release/UI identity and regenerate the
  source manifest after source edits.

## Phase 2: local verification complete

Local verification used Node 24.18.0, installed SDK 0.1.0 and Playwright 1.62.0.
Isolated HTTP/browser tests and deterministic model transports exercise the
installed SDK; they do not establish live gateway, authenticated-product, Docker,
or distributed-worker qualification.

| Check | Observed result |
| --- | --- |
| Full `node scripts/verify.mjs` | Syntax passed for 639 files; private-path and credential scans passed. 2,349 tests: 2,315 passed, 33 skipped and one release-ID failure. |
| Release-ID failure correction | Dockerfile still had the old default release ID. Aligned it with this candidate; all four `releaseSource` and `productionImageIdentity` tests then passed. The full seven-minute suite was not repeated for this metadata-only fix. |
| Merge-specific native SDK/browser regressions | 29 passed, two optional PostgreSQL JSONB subtests skipped, zero failed. Includes the matching-control evidence bundle inspector and mismatched-browser identity refusal. |
| Founder completion browser | All 11 checks passed, zero page errors: either publication event order, saved report display, mobile Results navigation, switching/reopening runs, reconnect and duplicate events, and incomplete/other-mode negative cases. |
| System mode launch browser | Both Founder and SQA launch, authorization, real HTTP creation, SSE subscription and reload passed. Recorded live report replay was not requested. |
| Dashboard browser | Live progress, nested activity, disconnect/resync, completion navigation, pause timing, secure credential consent, remembered public-only decision and budget continuation checks passed; zero page errors. |
| SQA launch browser | Desktop/mobile readiness and delayed device restoration passed. Exactly one explicit launch dispatch and zero model calls. |
| SQA evidence browser | Inspection states, injection prevention, two retained versions, server restart, historical Markdown/PDF and mobile overflow checks passed; zero model calls or page errors. |

Full-run log: `test-results/integration/full-verification.log`. The correction is
recorded separately in `release-contracts.log`, without rewriting the initial
failure. Browser summaries and logs are also under `test-results/integration/`;
Founder completion has its result and screenshots under
`test-results/founder-completion/`. These generated artifacts remain local.

The 33 optional skips include unavailable PostgreSQL/Redis integrations,
opt-in SDK/security fixtures, and POSIX permissions not enforced by Windows.
Linux/Node 22 CI, Docker execution, live model/provider checks and the broader
production qualification matrix remain for release qualification. The CI
workflow now runs the repaired Founder completion and mode launcher checks and
retains their diagnostic artifacts.

The stale Founder completion test now starts an isolated server by default,
opens the explicit run route, waits for the current stream/route contract and
uses valid cross-mode fixtures. It follows the explicit mobile Results and
Run workspace actions. The system UI harness now supplies required SQA
release/environment/device inputs and supports a launch-only check when recorded
live report checkpoints are unavailable. Full report replay remains an explicit
separate mode and still requires its recorded checkpoints.

Phases 0-2 are complete for this local integration milestone. The tested changes
are kept on the integration branch. Push-SQA promotion, remote publication and
production activation remain part of Phase 8.

## Remaining Founder phases

3. Completed locally: upfront public/authenticated scope, business context or
   explicit assumptions, device preflight and secure pre-start credential
   handling. See [Phase 3 setup and verification](founder-setup-2026-11-07.md).
4. Completed locally for durable report generation and recovery on the
   configured-provider path: eleven sections, exact-revision publication,
   preserved checkpoints and working Markdown/PDF exports verified with the
   live gateway. At this milestone, autonomous investigation still reached the
   fixture ceiling; Phase 5's controlled qualification is recorded below. See
   [Phase 4 report completion](founder-report-completion-2026-11-07.md).
5. Completed and qualified locally: real stage/section counters, actionable
   pause reasons, guarded continuation, durable checkpoints/usage/Stop status,
   retained browser facts and bounded report groups. Full regression: 2,367
   passed, zero failed, 33 optional skips. The four-route live review published
   all seventeen lenses, eleven sections and three recommendations in 14 minutes
   18 seconds at 420,423 input estimates, within the original ceilings. Immediate
   report restart, content/usage preservation, no browser replay, Markdown/PDF,
   final restart and account isolation passed. Seven recovery, eleven completion
   and five launcher browser groups passed. See
   [Phase 5 live qualification](founder-live-qualification-2026-11-07.md) and the
   historical [progress and recovery milestone](founder-progress-recovery-2026-11-07.md).
6. Clickable evidence, visible assumptions, section navigation and preserved
   focus, scroll, disclosure and selection state.
7. Reliable recommendation saving and immediate Studio delivery feedback,
   duplicate prevention, retry and export fallback.
8. Live qualification of representative modes, access/recovery cases, required
   CI/container checks, and release promotion to Push-SQA.

The incoming report's unresolved JEV usage receipt, authenticated/realtime paths,
distributed failover and production-topology checks remain separate release
requirements. No production activation is implied by this integration.
