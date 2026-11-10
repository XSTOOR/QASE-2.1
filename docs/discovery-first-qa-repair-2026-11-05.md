# Discovery-first QA engine repair — 2026-11-05

Release verdict: **BLOCKED — EXECUTION OR COVERAGE** until the authenticated
Studio qualification is completed. Local fixture results are not proof that
every Studio feature works. No commit, push, merge, deployment or production
configuration/data change was performed.

## Reproduction and root causes

The original saved run is `bedfd688-d286-48be-8f15-3f54a0404d42`.
Its screenshot was taken during execution. The later persisted checkpoint has
1,853,073 Opus tokens, 12,220 JEV tokens, 89 Opus calls, 30 browser actions and
689,773 ms of active execution. It is waiting for input, without a final report.

The 1/11 indicator is **conclusive category coverage**, not the number of browser
checks executed: the authoritative ledger shows 8 attempted scenarios, 9
accountable dispositions, and 2 unresolved execution obligations. Reproduction
metadata is in `test-results/discovery-first/observed-run-replay.json`.

Confirmed integration defects:

1. The ledger created generic selected-category suites before actual application
   discovery. There was no receipt-backed prerequisite for planning or activation.
2. Navigation/responsive investigations reached their fixed limit of two, but
   remained in the scheduler's ready queue. `canInvestigate:false` contradicted
   both the ready queue and the publication gate. The model repeatedly tried to
   close or reinvestigate them.
3. The persisted frontier still contained a pending authenticated page and eight
   available slots, despite the model claiming the frontier was exhausted. No
   route batch had run. Model prose was not an accurate account of host state.
4. SPA state identity considered headings, navigation labels and field counts,
   but omitted general panel controls. Different panels at one URL could collapse
   into the same feature identity. Conversely, navigation used arbitrary text
   changes, allowing unrelated copy/clock updates to look like transitions.
5. Stall detection operated across completed SDK segments. Many unproductive
   inference turns inside one segment could consume substantial tokens first.
6. Acceptance repetition `971adc75-e8b7-4ffc-afea-fcfe84ae1667` found an additional
   avoidable failure: a disclosure was requested on the wrong page; its selector
   validation exception became an unresolved execution gap, and the investigation
   schema did not declare the feature strategy that the host required. It paused
   at 10/11 accountable scenarios with 382,313 tokens and no report. This failed
   repetition is preserved under `acceptance-fixture/healthy/`, not counted as a
   successful run. The final fix emits a typed `QA_CONTROL_STALE` refusal before
   dispatch, retains its failed tool receipt without treating it as an executed
   test or uncertain mutation, exposes actual target locations/controls in custom
   scenario context, and requires the investigation strategy in its schema.
   A real check remains mandatory; unknown or dispatched failures retain their
   original recovery gates. Post-fix qualification is recorded separately under
   `preflight-fixed-fixture/`.
7. A responsive-only SPA regression reproduced an implicit dependency on a
   selected navigation suite during feature restoration. The host now restores
   only the exact evidenced feature path under the route batch's private owner
   token, then starts the actual selected checks. It does not add navigation
   tests or grant ordinary model calls this setup capability. Combined-scope and
   responsive-only native browser cases pass, including the negative permission
   check. A unique selector alias remains supported by resolved DOM identity,
   rather than being rejected merely for differing from a canonical selector.

Tests reproduced missing discovery enforcement, exhausted investigations in the
ready queue, and same-URL panel identity collisions before their respective fixes.
Logs: `/private/tmp/qase-discovery-reproduction.log` and
`/private/tmp/qase-spa-reproduction.log`.

## Execution architecture after the repair

`Authorized scope → bounded discovery → persisted feature inventory → validated
plan → scheduled SDK browser execution → assertions/diagnostics → investigation
or recovery → independent publication gate`.

New UI-created hybrid runs pin `qaDiscoveryVersion:1`. Existing saved runs retain
their original execution strategy. Required category records initially retain
selected scope; they are obligations, not executable plans or passing tests.

The host executes `qa_discover_application` through native CleanSlate tool
dispatch. It inspects the current entry surface, dismisses eligible observed
overlays, and probes at most three actual safe navigation controls/pages. Its
private browser-ownership token permits only existing approved observation and
navigation tools. No arbitrary script, inferred URL or write permission is added.

The persisted inventory contains feature IDs, observed names, locations, state
identities, controls, permission requirements, source receipts, confidence and
testability. Same-URL transitions preserve evidence-backed navigation paths.
Inventory limits are explicit; newly observed states extend it incrementally.

Planning/activation and ordinary publication require intact discovery receipts
for the current authenticated access context. A ready flag or invented feature
cannot qualify it. Custom plans must reference actual discovered feature IDs.
Selected but missing scope remains visible. Initial discovery proof stays pinned
so later discoveries do not relock an executing scenario. Access changes require
fresh discovery and rebind required plans without deleting earlier evidence.

The scheduler now separates **ready**, **dependency-blocked**, and
**recovery-blocked** work. Fresh evidenced states can add at most two additional
investigation opportunities to the base allowance; repeated snapshots do not.
Discovery-first investigations require a distinct observed feature strategy.
Uncertain actions remain protected against automatic replay.

When three inference turns make no meaningful progress and observed routes are
still executable, the host can submit the existing `qa_test_routes` tool through
the same SDK loop. It uses validated pending route IDs and default selected
checks. Offered route IDs are checkpointed and not automatically offered again.
There are at most four such scheduler interventions per run. Mandatory discovery
dispatch is also bounded per access context. Every child browser action remains
serialized, permission-checked, budgeted and persisted.

Eight inference turns without new checks, features, assertions or accountable
outcomes checkpoint and pause. Reasoning text, repeated inspection, timestamps
and repeated disposition prose do not count as progress. Cumulative usage,
limits and retry history are not reset.

## CleanSlate and gateway qualification

Installed SDK: **0.1.0**. The native `run`, session continuation, snapshot and
tool executor remain in place. No SDK package files or model weights were edited.
Host-scheduled calls are native tool turns, not another autonomous framework.
Opus reasons and synthesizes; JEV classifies immutable observations; QASE retains
permissions, browser ownership, exact accounting and completion authority.

`npm run qualify:hybrid-gateway` actually passed all 13 checks: text, streaming,
native tools, multiple tools, tool-result continuation, cancellation, timeout,
usage, structured responses, image input, SDK loop, SDK usage and JEV. No model
substitution, usage estimation or certificate-expiry bypass was introduced.
Log: `test-results/discovery-first/verification/gateway.log`.

## Live browser/model evidence

These fixture runs used the real configured Opus/JEV gateways and installed SDK,
not mocked model responses. Every fixture scenario has actual host assertions;
every run persisted its checkpoint and report. Fixture writes: **zero**.

| Run | Actual scenario execution | Result | Provider tokens | Duration |
|---|---|---|---:|---:|
| `8525e640-684f-45a7-a6e2-4d09e96a0086` | 11/11 | 11 passed | 243,557 | 127,948 ms |
| `fd5ff6be-eccd-4fca-b5bc-d20b4038466e` | 11/11 | 9 passed, 2 failed; both expected defect groups filed | 349,405 | 163,688 ms |
| `6c6da360-89d4-42ce-8159-9542b88d0f79` | 11/11 | 11 passed | 229,576 | 134,219 ms |
| `c02fed22-6192-4e60-b939-4b93b807ba1b` | 11/11 | Post-preflight fix: 11 passed | 269,335 | 136,156 ms |
| `a6eb0c2d-2531-497b-b6ee-358a0b2c7c99` | 11/11 | Post-preflight fix: 9 passed, 2 failed; both expected defect groups filed | 310,989 | 149,271 ms |

Artifacts: `test-results/discovery-first/live-fixture/{healthy,realistic}/` and
`test-results/discovery-first/repeat-fixture/healthy/`. The final acceptance
repetition is recorded separately under `acceptance-fixture/`.

The healthy runs used 22,142 and 20,871 tokens per verified scenario, respectively.
The earlier comparable fixture run `2dd28a21-bd29-4e3a-aa02-e574be38fae3` used
376,847 tokens / 146,445 ms. Earlier healthy measurements also vary (including
266,479 tokens). These runs demonstrate reduced token consumption on this
fixture, not a universal performance improvement or production SLA. Discovery
adds browser work: the first new healthy run used 140 actions versus 108 in the
earlier fixture. The seeded run was slower than its historical comparison; this
cost is not hidden by reporting only the healthy result.

### Actual Studio execution

Public-only qualification `eb8d38d4-b987-4369-b6a7-aa6324b12371` completed with a
validated **partial** report: 11/11 accountable dispositions, 6 attempted suites,
3/11 conclusive coverage, 5 passed suite labels, 1 failed, 3 blocked, 2 not executed.
Some passed suites contain per-route gaps, so they do not count as conclusive.
It used 157,056 tokens, 85 browser actions and 157,833 ms active execution.
Its inventory has 45 features; the initial bounded proof had no eligible
navigation probe, with further surfaces discovered during actual execution.
One evidence-linked finding was filed. This is not authenticated product coverage.

Two preceding public attempts exposed integration mistakes during development:
the new tool was initially missing from the SDK allowed-tool list, and an
authentication form unnecessarily prevented safe public navigation discovery.
Both were corrected and covered by regression tests. Their interrupted outcomes
are retained, not presented as successes. The per-inference guard stopped the
first attempt instead of allowing another 89-call reasoning loop.

Public artifacts: `test-results/discovery-first/studio-public/`.
Its token count cannot be compared directly with the original authenticated run.

UI qualification run **`7bc328b1-75e2-4d6f-934f-7b5ada0de324`** reached the existing
secure credential handoff. The owner selected **Skip login**; the exact native
public-only answer is persisted. It subsequently completed as public-only:
11/11 accountable dispositions, 6 attempted suites, 3/11 conclusive coverage,
one confirmed finding, 289,178 exact provider tokens, 95 browser actions/receipts
and 289,254 ms active execution. Its partial report passed independent offline
validation. No credentials were supplied, copied from another run or fabricated;
the public-only choice is retained without repeated access questions.
Artifacts: `test-results/discovery-first/studio-ui-public/`.
Authenticated workspace/project/chat/meeting/settings depth remains **unverified**
and requires a separate future authorized qualification. Messages, meeting
creation, account changes and production record writes were excluded.

## Verification and reproducibility

Independent offline verifier:

Use Node 22–24. On this Mac the bundled runtime was used by prepending
`$PWD/.tooling/node-v24.22.1-darwin-arm64/bin` to `PATH`.

```sh
node scripts/verify-qa-discovery-evidence.mjs \
  test-results/discovery-first/live-fixture/healthy/checkpoint.json
```

It checks actual discovery proof, run-scoped receipt hashes/action links,
assertion provenance, current scheduler accounting, publication validation,
confirmed-finding reproduction and settled provider usage. It does not execute
models/browsers or modify checkpoints. It passed for both initial fixtures, the
healthy repeat and the public Studio run; results are saved as `verified.json`.
It also passed for both post-preflight fixtures. The latest healthy and seeded
runs used 24,485 and 28,272 tokens per verified scenario. Against the last
historical equivalent fixtures (376,847 and 361,022 tokens), this is approximately
28.5% and 13.9% lower, respectively. Workload/environment variance remains material.

Live fixture reproduction (requires configured secure key, current qualification
and explicit local-only opt-in):

```sh
QASE_LIVE_HYBRID_EXECUTION=true QASE_ALLOW_PRIVATE_NETWORK=true \
QASE_HYBRID_QA_ENABLED=true NODE_ENV=development \
node scripts/qualify-qa-scheduler.mjs
# Add --realistic for the two seeded defects.
```

Full verification with disposable PostgreSQL, Redis and browser tests enabled
passed **2,236 tests, zero failures, zero skipped** before the final bounded
scheduler intervention. The acceptance verification after that intervention is
saved separately in `verification/acceptance.log`; its actual result is appended
below when complete. Focused final scheduler/discovery/context tests passed 35/35,
and native SDK discovery/11-scenario continuation browser tests passed 2/2.
The complete suite includes QA, SQA, Founder, authorization, cancellation,
exact accounting, database and Redis restart tests. It is not a new live SQA or
Founder production qualification.

An earlier full run caught one real compatibility regression: adding discovery
tools to legacy catalogs violated the bounded legacy catalog contract. It was
fixed by exposing those tools only to discovery-first runs. The original
nine-defect-group depth browser test then passed unchanged.

### Final validation

The final complete verification passed **2,241 tests, zero failures, zero skipped**
in **295,012 ms**, including all available local infrastructure/browser gates.
Syntax checking covered 610 JavaScript sources; private-path checks and the
high-confidence credential scan passed. No test assertion was weakened.
The last two intermediate full-suite regressions (legacy tool catalog and unique
selector alias compatibility) were corrected and the original tests passed.
The scoped SPA browser tests passed for combined QA checks and responsive-only
checks, proving actual host-scheduled assertions after model segment endings and
rejection of attempts to use the private setup capability from ordinary tools.
All logs are retained under `test-results/discovery-first/verification/`.
Final release-manifest verification matched all **748** source-file SHA-256
entries. The disposable PostgreSQL and Redis instances were stopped after testing;
their local test data/binaries remain available for reproduction. QASE itself
remains running at `http://127.0.0.1:5174` with local hybrid testing enabled.

## Files and preservation

New engine modules: `server/qaApplicationDiscovery.js`,
`server/qaInferenceProgress.js`. New tests: `server/qaDiscoveryGate.test.js`,
`server/qaApplicationDiscovery.integration.test.js`. New offline verifier:
`scripts/verify-qa-discovery-evidence.mjs`.

Integration changes: `server/{store,agent,hybridQaRuntime,hybridQaTools,
hybridContext,hybridAutonomy,qaScenarioLedger,qaScenarioScheduler,
qaCompletionGate,qaFeatureState,hybridSummaries,hybridRouteExecution,jevBrowserChecks,jevInteractions}.js`;
`server/{qaScenarioScheduler,qaFeatureState,jevBrowserChecks}.test.js`;
`scripts/qualify-{qa-scheduler,hybrid-target}.mjs`.

Small status clarification: `public/hybridQaView.js` and its test distinguish
discovery, actual attempts, accountable dispositions and conclusive coverage.
They do not relabel blocked/inconclusive scenarios or redesign the UI.
The source manifest is regenerated for the complete preserved working tree.
All pre-existing local changes were retained; no branch/reset/remote sync occurred.

## Limitations and release gates

- Authenticated Studio depth, full feature coverage and long-running authenticated
  recovery remain unqualified after the owner's public-only choice. No additional
  credentials are requested for this closed review.
- Copy/design correctness needs supported expectations. An absent search/media
  control in a sample is not proof of site-wide absence or a passing workflow.
- Discovery and alternative investigations are bounded. Unknown action outcomes,
  missing exact usage, cancelled runs and hard resource limits still stop safely.
- Chromium, Firefox and WebKit fixture tests are included where enabled. Live
  model qualifications here use Chromium; no live three-engine Studio claim.
- Disposable local PostgreSQL/Redis tests qualify those exercised components,
  not production TLS, shared-volume permissions, container images, real customer
  concurrency or complete SDK/browser migration across distributed workers.
- Performance is measured on defined fixtures; no load/latency/cost SLA is proven.
- Production hybrid activation and deployment were not changed. Local hybrid
  remains enabled under the owner's earlier explicit local-testing instruction.

Rollback: retain the previous approved deployment artifact and existing data.
Drain or pause runs before changing engine versions; do not transfer new feature
path checkpoints to an older engine that cannot validate them. Preserve original
version workers/checkpoints for in-progress runs. This change adds no database
migration and requires no destructive data rollback. Do not use Git reset to
roll back this shared working tree.
