# QA scenario scheduling and completion repair — 4 November 2026

## Outcome and scope

The targeted QA execution repair is implemented in the existing working tree.
Two real Opus/JEV runs through installed CleanSlate SDK 0.1.0 exercised eleven
scenarios each, retained browser evidence, and published host-validated reports.
The healthy fixture resolved 11 passing scenarios. The seeded task workspace
resolved 9 passing and 2 failing scenarios and filed both reproduced defects.
Neither run used a mocked model response or a replacement `runtime.run`.

This qualifies the targeted behavior on disposable local applications. It is
not a fresh authenticated end-to-end qualification of the current live Drytis
AI Studio deployment, nor a whole-platform production-readiness claim.
No commits, pushes, deployments, production migrations, SDK-package edits, or
persistent feature-flag activations were performed.

## Actual historical failure

The inspected saved run is `424036b1-34d0-400a-a4dd-9a32b965bf9a`:

| Measurement | Saved result |
|---|---:|
| Provider-reported tokens | 328,886 |
| Active duration | 315,604 ms |
| Browser actions | 85 |
| Planned category suites | 11 |
| Passed / failed / blocked / inconclusive / not executed | 3 / 1 / 2 / 4 / 1 |
| Conclusive category coverage | 3/11, 27.27% |
| Areas with an intact execution attempt | 8/11 |

The 3/11 indicator did **not** mean only three areas received tool calls.
The UI/host calculation counts conclusive category coverage, excluding passing
suites that retain route gaps. Attempts, accountable dispositions, and passing
coverage are different quantities.

This was not exhaustion of the recorded 600,000-token Opus allocation,
100,000-token JEV allocation, 180 browser actions, or 900,000 ms execution
budget. Opus had used 302,455 tokens and JEV 26,431. The active authenticated
frontier contained two attempted states and no eligible pending route. Public
routes from an earlier access context were correctly not treated as new
authenticated work.

The previous gate accepted terminal scenario labels plus an exhausted observed
frontier. An attempted check discharged its execution obligation even when its
receipt retained a recoverable click failure. Navigation and responsive checks
therefore remained inconclusive without follow-up. The saved forms suite also
has an older, untyped exclusion gap, which cannot safely be retroactively
classified from prose alone. No evidence indicates an SDK segment boundary or
JEV lifecycle decision caused this particular termination.

A read-only replay through the repaired gate now rejects that same saved state
with `HYBRID_EXECUTION_PENDING` for navigation, forms, and responsive obligations.
The original saved user run was not rewritten. Filtered replay metadata is in
`test-results/qa-scheduler/observed-run-replay.json`.

## Repairs

### Scheduling, activation and continuation

- Added an authoritative schedule derived from intact scenario/action receipts,
  dependencies, access context, unresolved execution gaps, and dispositions.
- Added native `qa_work_schedule` and `qa_investigate_scenario` tools to the same
  approved CleanSlate registry. There is no second autonomous framework.
- A bounded investigation requires a fresh, intact observation of the affected
  surface, verified action state, and a new matching check. Two investigation
  attempts are permitted. Exhausted investigation capacity produces a native
  host decision; it does not buy unlimited model continuations.
- Browser mutations, scenario activation, ledger updates, and closure share the
  existing serialized ownership boundary. Completed outcomes cannot be relabeled
  or replayed merely to obtain a pass.
- Dependencies are checked before activation. Unknown references and cycles are
  rejected atomically. A failed prerequisite may support a blocked dependent;
  it never manufactures execution or passing coverage.
- A model stop still ends only a native SDK segment. Continuation preserves
  evidence, scenario ownership, exact usage, and retry history. Three segments
  without meaningful execution progress checkpoint an incomplete run. Changing
  snapshot text or a clock cannot disguise stalled execution.

### Completion and reporting

- Terminal labels no longer discharge actionable browser failures. Publication
  is rejected while eligible execution/investigation obligations remain.
- Uncertain operations and unreconciled model usage remain fail-closed.
- New autonomous runs pause at a genuine hard resource limit. They cannot
  silently turn a budget boundary into a completed report. Native approval
  offers remain within pinned operator ceilings. Explicit owner closeout can
  publish honest gaps, but cannot authorize more exploration or forgive unknown
  usage/actions.
- Added separate `accountability` counts to host/public state and reports.
  Report summaries distinguish attempts, accountable outcomes, and conclusive
  category coverage. No test is converted into PASS to make counts reach 100%.
- Reproduced fixed-oracle failure groups must be filed with `report_finding`
  before normal publication. This closes an additional observed failure: the
  first seeded live run detected both defects in assertions but published zero
  finding records.
- Finding deduplication now includes the affected surface URL. Previously,
  identical geometry failures on a dashboard and settings page could collapse
  into one key, making the second surface impossible to file. Existing saved
  keys are re-evaluated from intact evidence for compatibility.

### Browser precision and efficiency

- Native modal ownership now excludes inert background tabs, forms, inputs,
  and accessible-name checks. Earlier same-URL exploration attempted background
  clicks through an open dialog and compared values against the wrong control.
  The fix changes inventory eligibility, not click force or timeout values.
- Safe search inputs now receive the existing synthetic text/Unicode/length
  cases under egress quarantine and restoration. They previously became
  unsupported-input gaps despite being editable and authorized.
- Typed host safety exclusions remain coverage limitations. They do not trigger
  repeated attempts to edit prefilled/sensitive/excess fields. A timeout in the
  same result still requires investigation.
- Acknowledged owner-authorized test submissions without an authoritative
  business expectation remain explicit limitations; they are not passes and
  are never automatically resubmitted. Uncertain submissions still block.
- Invalid pre-dispatch checks explicitly report `dispatched: false`; they cannot
  count as meaningful test attempts.
- Context retains a compact next-work summary and failure references. Schedule
  evaluation shares receipt-integrity checks and indexes within each projection;
  original observations and native call/result linkage remain durable.

## Changed files for this repair

The pre-existing Phase 1/2 changes were retained. Forty-nine previously dirty
files remained byte-for-byte unchanged at the task comparison checkpoint.
The initial fingerprint inventory is `/private/tmp/qase-qa-completion-initial-tree.json`.
This repair touches the following implementation areas:

| Area | Files |
|---|---|
| New schedule | `server/qaScenarioScheduler.js` |
| Execution receipts, progress, ledger | `server/qaExecutionState.js`, `server/qaScenarioLedger.js` |
| Native registry, routing and context | `server/agent.js`, `server/hybridQaRuntime.js`, `server/hybridQaTools.js`, `server/hybridContext.js` |
| Budgets and handoff | `server/hybridAutonomy.js`, `server/hybridContinuation.js` |
| Publication and finding integrity | `server/qaCompletionGate.js`, `server/qaTools.js` |
| Browser inventories and safe inputs | `server/browserTools.js`, `server/jevBrowserChecks.js`, `server/jevAccessibility.js`, `server/qaLiveForms.js`, `server/qaTestWrites.js` |
| Reproducible live qualification | `server/qaSchedulerFixture.js`, `scripts/qualify-qa-scheduler.mjs` |
| Regression tests | `qaScenarioScheduler.test.js`, `qaExecutionState.test.js`, `qaLiveForms.test.js`, `hybridAutonomy.test.js`, `hybridContinuation.test.js`, `hybridAuth.integration.test.js`, `hybridAutonomy.integration.test.js`, `hybridContinuation.integration.test.js`, `hybridDepth.integration.test.js`, `hybridFeatures.integration.test.js` under `server/` |
| Release/documentation | This report and regenerated `SOURCE_MANIFEST.json` |

No UI redesign, model substitution, direct Opus execution bypass, SDK-internal
change, global budget increase, or arbitrary timeout increase is part of this
repair. SQA, Founder, and legacy QA retain their existing execution contracts.
The shared modal/input corrections are covered by the full regression suite.

## Actual live model/browser evidence

All runs used the configured `drytis/claude-opus-4.7` reasoner and `jev-1.13`
classifier through the native SDK and approved QASE harness. No production
customer account or authenticated Studio session was used.

| Measurement | Healthy task workspace | Seeded task workspace |
|---|---:|---:|
| Run ID | `f5b18805-fd2b-475a-a27c-74fa47774810` | `633493dd-a362-49e5-802c-2e23961f74fa` |
| Accounted / attempted | 11/11 / 11/11 | 11/11 / 11/11 |
| Passed / failed | 11 / 0 | 9 / 2 |
| Blocked / inconclusive / pending | 0 / 0 / 0 | 0 / 0 / 0 |
| Conclusive category coverage | 100% | 100% |
| Confirmed findings | 0 | 2 |
| Provider-reported tokens | 266,479 | 361,022 |
| Tokens per conclusive scenario | 24,225.36 | 32,820.18 |
| Opus calls / JEV calls | 17 / 1 | 22 / 3 |
| Browser actions | 106 | 108 |
| Duration | 122,341 ms | 149,842 ms |
| Filled field trials / negative input cases | 8 / 9 | 8 / 9 |
| Repeated-action keys with count >1 | 0 | 0 |
| Server writes | 0 | 0 |
| Outstanding token reservations | 0 | 0 |

The eleven scenarios comprise eight supported browser categories, a supplied
content expectation, an independent FAQ/keyboard disclosure contract, and a
task-view tab/panel contract. Four pages and a discovered same-URL state were
explored. These are distinct contracts, not eleven copies of one geometry test.

The two seeded findings are:

1. `/docs` horizontal overflow, finding `e43c6368-fb40-4d88-bf37-b916c76d3200`,
   assertion `30e59af5-feaf-46e5-9a49-7c3ff9b33477`, evidence
   `635cc8f8-1e3b-44d7-9d8d-4fd77c086086`.
2. `/practice` unnamed interactive control, finding
   `4861f73c-38cf-4036-b936-b0150193eae6`, assertion
   `863acf1f-e5f0-46a6-b6b4-53f427f5aa0c`, evidence
   `e8f406dc-2340-44e6-8f5c-d42804d0a928`.

The fixture detection result is 2/2 expected defect groups and zero unexpected
groups. This is fixture recall, not a universal defect-recall claim.

Results, durable checkpoints, and final reports are saved under:

- `test-results/qa-scheduler/healthy/`
- `test-results/qa-scheduler/realistic/`
- `test-results/qa-scheduler/realistic-before-finding-gate/` retains the failed
  intermediate qualification with two failed scenarios but zero filed findings.

Both successful reports are intentionally `partial`: fixed checks do not prove
all business submissions, remote search relevance, or full accessibility.
Accountable selected scope is not a claim that every possible workflow passed.

## Performance interpretation

The historical run and local fixtures are different workloads. Their tokens per
conclusive scenario are descriptive; they are **not** a controlled before/after
claim of production token savings. The finding-gate rerun cost more model calls
than the intermediate run that omitted findings. Correct reporting takes
priority over appearing cheaper.

On the saved 11-scenario, 108-receipt seeded checkpoint, 100 isolated scheduler
evaluations measured p50 0.391 ms and p95 0.615 ms on this Mac. This measures the
pure scheduler, not network inference, browser startup, or production throughput.
The profile is `test-results/qa-scheduler/scheduler-profile.json`. No reliable
end-to-end dollar pricing was available, so no total cost estimate is asserted.

## Verification

- All 13 live gateway checks passed, including streaming, native/multiple tool
  calls, continuation, cancellation, images, structured output and exact usage.
- The eleven-segment native SDK/browser regression rejects early publication,
  continues after final-looking text, and executes each saved scenario once.
- Focused regressions cover dependency cycles, receipt integrity, pre-dispatch
  refusals, bounded investigation, uncertain-action recovery, stale absence,
  snapshot-only stalls, missing expectations, false-positive prevention,
  cancellation-safe finalization, budgets, modal ownership, and finding filing.
- Actual same-URL browser workflows run both with test writes disabled and with
  explicitly authorized namespaced writes. No unverified write is replayed.
- The complete regression suite includes real browser engines and isolated
  PostgreSQL/Redis tests. Final complete-suite result: **2,197 passed, 0 failed, 0 cancelled, 0 skipped; 263,844 ms**.

Intermediate full runs failed before the submission-limitation and surface-key
repairs. Those failures are retained in `/private/tmp/qase-scheduler-full-verify.log`
and `/private/tmp/qase-scheduler-final-verify.log`; they are not counted as passes.
The final run log is `/private/tmp/qase-scheduler-release-verify.log`.

Reproduce using the installed supported Node 24 binary:

```sh
cd /Users/mishal/Documents/QASE/QASE-2.1
export PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH"
NODE_ENV=development node scripts/qualify-hybrid-gateway.mjs
NODE_ENV=development QASE_ALLOW_PRIVATE_NETWORK=true \
  QASE_HYBRID_QA_ENABLED=true QASE_LIVE_HYBRID_EXECUTION=true \
  node scripts/qualify-qa-scheduler.mjs
NODE_ENV=development QASE_ALLOW_PRIVATE_NETWORK=true \
  QASE_HYBRID_QA_ENABLED=true QASE_LIVE_HYBRID_EXECUTION=true \
  node scripts/qualify-qa-scheduler.mjs --realistic
```

The live commands consume configured model usage and require current gateway
qualification. They use loopback fixtures only. The full-suite reproduction
also needs disposable PostgreSQL/Redis; use the isolated setup documented in
`docs/phase2-autonomous-production-qualification-2026-11-03.md`.

## Remaining limits and release verdict

**Targeted QA fixture qualification: verified. Full production readiness: not
established.** A fresh authenticated Drytis AI Studio run, production load and
deployed worker behavior have not been qualified by these two local runs.
Missing product/design expectations, credentials, exact usage receipts,
permissions, uncertain mutations and hard resource limits still produce honest
blockers or native host decisions. No implementation can promise all possible
features and edge cases from a URL alone.

This repair does not clear the separate Founder live-synthesis limitation from
the Phase 2 report or activate its/SQA's experimental reasoning flags. The live
gateway qualification has its existing expiry policy; that gate was refreshed,
not disabled.

Review the focused changes and verification artifacts before a release. To
withdraw this repair, remove only its reviewed hunks/new modules while retaining
the prior local Phase 1/2 work. Do not reset the dirty tree to a historical commit.
No destructive rollback or data migration is required. Existing explicit legacy
QA rollback remains available through its established execution-mode interface;
there is no silent fallback from hybrid.
