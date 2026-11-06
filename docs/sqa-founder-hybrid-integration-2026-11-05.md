# SQA and Founder autonomous execution integration — 5 November 2026

This report covers uncommitted changes in the authoritative local checkout,
branch `codex/hybrid-production-readiness`, baseline
`ad0afcd3e1e13ee49e7ba86cea8e4602bcbfb76e`. No branch replacement, SDK package
edit, dependency update, commit, push, deployment or production migration occurred.
Final qualification results are recorded below; fixture success is not approval
for unrestricted production or authenticated application testing.

## Release verdict

**BLOCKED — INFRASTRUCTURE.** The scoped public-review implementation is
exercised through the real SDK and models, and Founder published after real
checkpoint recovery. Public SQA remains blocked by JEV HTTP 500 without an
authoritative usage receipt. Production container/topology and the full
mode-specific distributed recovery/authentication matrix are also unqualified.
Both production mode flags remain disabled by default. This is not deployment
approval and does not claim complete assessment of arbitrary applications.

## Audit and actual routing

The current baseline already contained opt-in generative mode execution. It was
incorrect to assume that SQA and Founder had no generative integration at all.
The live configuration selected JEV, and the per-mode reasoning flags defaulted
to false. Consequently new default SQA/Founder runs used `installJevRuntime`,
whose deliberately bounded assessment cannot deliver autonomous deep review.

The persisted user SQA run `b51cbc8e-6607-43cc-b592-5473a121adaf` confirms this:
12.461 seconds, 24,825 reported tokens, and only `browser_open`,
`browser_snapshot`, `browser_diagnostics`. Its six completed todos were workflow
steps. Its 22 blocked controls had zero attached evidence. The scope had no
`web_application` or `user_interface` attributes, excluding all six WEB controls.
Thus 6/6 workflow completion never meant full control execution or compliance.

| Mode | Routing retained/extended | Completion authority |
| --- | --- | --- |
| QA hybrid | Existing fixed Opus SDK loop plus advisory JEV | Existing QA scenario ledger and completion gate |
| Qualified SQA | Existing opt-in Opus SDK loop, now discovery and workflow gated; advisory JEV | Original control catalog, evidence contracts, deterministic evaluator, finalizer |
| Qualified Founder | Existing opt-in Opus SDK loop, now discovery/workflow gated with durable staged synthesis; advisory JEV | Original 17 lenses, canonical plan, full report normalizer and finalizer |
| Legacy SQA/Founder | Existing configured-provider/JEV behavior retained for rollback and in-progress runs | Existing mode contracts |

The exact qualified model pair remains `drytis/claude-opus-4.7` at the fixed chat
gateway and `jev-1.13` at the fixed Decisions endpoint. Credentials stay in the
existing secure configuration/transport. There is no substitute model, second
framework, replacement of qualified `runtime.run`, or new autonomous browser
owner. Flags remain disabled in defaults and production configuration; live
qualification enables them only in isolated processes. Saved strategy and
lifetime budgets survive flag rollback.

## Engineering changes and root causes

1. **Planning and evidence gates were too weak.** New qualified runs now require
   host-created discovery receipts before planning. `modeDiscovery.js` obtains
   inventories from real native browser calls, validates source actions and
   activities, probes at most three observed safe navigation controls, and
   persists an incremental feature index. Claimed discovery alone is rejected.
   Plans reference actual feature IDs, steps and expected observable behavior.
   One active workflow owns interactions; completed workflows cannot replay.
2. **Reviewed pages could substitute for executed workflows.** Independent mode
   publication entry points now require valid workflow proofs, no pending work,
   no uncertain action, sufficient observed surface depth, a real interaction,
   diagnostics and an advisory classification. Pass/fail derives from host
   assertion receipts. An unrelated page cannot pass a workflow; an observed
   link's actually tested destination does count. Known tool failures can
   support an honest blocker, whereas uncertain mutations still stop execution.
3. **Evidence attribution depended on recent generic activity.** Technical SQA
   controls now bind to their actual typed checks. Broader assurance claims
   require an explicitly relevant workflow. Missing reviewer artifacts remain
   blocked. A proposed technical PASS that contradicts failed matching host
   assertions is rejected before observation mutation. SQA defect findings
   require an intact failed host assertion and
   actual browser activity; prose or JEV agreement cannot confirm a defect.
4. **Rolling context could discard verification proof.** Closed workflows pin
   their verification receipts durably while inference keeps a bounded window.
   Large assertion sets preserve failure samples and full outcome counts;
   failure number 30 cannot disappear behind the first 25 passing assertions.
5. **JSONB changed object-key order and broke valid digests.** Reproduced with
   actual PostgreSQL. New receipts, inventories, workflow proofs and Founder
   drafts use versioned canonical JSON hashing. Legacy protocols are preserved;
   invalid historical receipts are not silently rewritten as valid evidence.
6. **Context projection sometimes enlarged paid requests.** Qualified modes now
   use concise phase briefs and pending catalog requirements, compact inference
   projections, lazy optional native tools and bounded browser composites.
   Original evidence, scope, accounting and failed assertions remain durable.
   Exact trusted SDK envelope duplicates are removed; arbitrary user content
   is not guessed away. Cached JEV results require unchanged intact evidence
   and classifier identity. Malformed/unavailable classification never becomes
   a successful advisory record.
   A real public run then exposed paid start/check/close overhead: seven planned
   workflows used 40 Opus calls and 934,744 total tokens before control closeout.
   `mode_run_workflow` now composes the existing activation, observed navigation,
   bounded native steps/checks and assertion-derived closure in one SDK call.
   It is bounded tool orchestration, not a second autonomous loop. Four actual
   installed-SDK/Chromium regressions verify serialized execution, zero fixture
   POST/WebSocket writes, persisted evidence and refusal to publish unfinished
   work (`/private/tmp/qase-mode-native-composition-tests.log`).
7. **SDK turns were mistaken for sufficient stopping boundaries.** Host-owned
   continuation retains unfinished workflows and meaningful-progress checks.
   At verified workflow boundaries the public SDK 0.1.0 `clearConversation()`
   starts a compact segment while preserving the browser owner and host state.
   Repeated model prose cannot publish. Three stagnant segments or eight
   unproductive inference turns stop with an honest checkpoint.
8. **Founder synthesis retained completed report arguments.** A live run reached
   all 17 lenses and all 11 draft sections but exhausted its existing budget
   before the finalizer. Each intact saved revision now creates one compact
   native SDK continuation boundary. Drafts still undergo the complete original
   semantic validator; model budget, retry counters and draft integrity persist.
   Qualified draft schemas also bound scalar verbosity and list sizes while
   retaining every required field, three recommendations and the full roadmap.
   A 39-test focused run verifies the constrained subset against the original
   complete normalizer; legacy report contracts remain unchanged.
9. **Qualified modes lacked QA's read-only network isolation.** The new contract
   now activates existing form/input egress isolation and blocks HTTP writes,
   WebSocket upgrades and other supported mutation transports. Native SDK calls
   retain normal browser policy and scoped workflow checks. No write exception
   was granted for authentication, GraphQL/read POST, or real-time applications.
10. **UI conflated workflow and assessment progress.** Recommended SQA website
    attributes now include browser controls. Existing UI shows discovery,
    workflow dispositions and separate control dispositions, explicitly stating
    that workflow completion does not prove evidence completeness/compliance.
    UI cache version is `20261105-2`; unrelated navigation is unchanged.
11. **The route gate and discovery/plan state could disagree.** The public run
    `70ca89ff-09e3-45e8-bb15-f1aba0ba3734` finished eight workflows but reviewed
    only four of the eight required pages. It entered control closeout anyway
    and exhausted 910,376 total tokens without publication. The first twelve
    raw links also let repeated/external CTAs hide authorized destinations:
    twelve observed routes existed but only seven distinct destinations were
    indexed. Discovery now bounds unique authorized links instead. At the last
    verified workflow boundary, unmet route/classification requirements enter
    `coverage_recovery`, expose actual missing URLs and observed feature IDs,
    and withhold closeout tools. Only verified coverage returns to evidence
    review. The eight-page gate and original budgets were not relaxed.
12. **A missing fill locator was treated as an uncertain mutation.** Public SQA
    `f07a5f6f-7ce6-4ba0-9711-f0818e3e1d18` stopped at 178,786 tokens when the
    model requested an absent `textarea`. Before editing, qualified modes now
    check visibility, uniqueness and editability with a 2.5-second bounded wait,
    returning `dispatched:false` for missing fields. Genuine failures after
    dispatch remain uncertain. Native SDK/browser tests reproduce the missing
    field and then successfully fill an actual observed input in both modes.
13. **Pure classification errors could strand browser recovery.** Immutable
    JEV classification is now treated as a read-only operation for action-state
    recovery. Unverified model usage still independently blocks dispatch. A
    failed classifier cannot become an advisory success or authorize browser
    replay. Nineteen focused runtime tests passed.
14. **The qualification watchdog could manufacture early cancellation.** Its
    ten-minute deadline interrupted public Founder
    `4ae37162-9119-4eb3-86f4-4f8ca0b1061d` during synthesis at 824,512 known
    tokens, despite the pinned host budget allowing fifteen minutes. The test
    harness now reads that existing duration after qualified startup and adds
    five seconds only for recording the terminal checkpoint. Engine budgets and
    gateway request timeouts are unchanged. Interrupted usage is not estimated
    or erased; that attempt is not a successful report.
15. **Host-tool confusion was incorrectly delegated to the user.** Public
    Founder `3793aabb-16a1-4af5-b753-d8767a80f4b2` requested user direction about
    exposing tools with seven routes reviewed. Coverage recovery now answers
    such internal capability questions with actual required route work, rather
    than issuing a user decision or permitting a report-gate override. Genuine
    missing access questions remain available. Two real-SDK/browser regressions
    verify no pending user question is created. Advertised tool names are now
    recorded as bounded host telemetry, without prompts or hidden reasoning.

## Files

New: `server/modeDiscovery.js`, `server/modeDiscovery.test.js`,
`server/modeIntegrity.js`, and this report.

Extended: `server/agent.js`, `modeReasoningRuntime.js` and its tests,
`modeReasoningContext.js` and its tests, `modeReasoning.integration.test.js`,
`browserBridge.js`, `sqaService.js`, `sqaTools.js`, `sqaUi.test.js`,
`founderService.js`, `founderReportDraft.js` and its tests, `qaTools.js`;
`public/app.js`, `modeReasoningView.js`, `index.html`, `release.json`;
`scripts/qualify-system-mode.mjs`, `qualify-system-ui.mjs`,
`verify-system-mode-evidence.mjs`; release source manifest regenerated separately.
`README.md` now links the current qualification boundaries and correct UI version.

## Reproducible validation and evidence

Gateway: all 13 actual protocol checks passed twice, using installed SDK 0.1.0.
Logs: `/private/tmp/qase-sqa-founder-gateway.log` and
`/private/tmp/qase-sqa-founder-gateway-repeat.log`. This verifies text,
streaming, native/multiple tools, tool-result continuation, cancellation,
timeout, exact usage, structured output, images, native SDK loop/accounting
and JEV. Protocol qualification does not prove arbitrary assessment depth.

Initial discovery/completion failures were reproduced before implementation in
`/private/tmp/qase-mode-discovery-reproduction.log`. JSONB ordering reproduction:
`/private/tmp/qase-mode-jsonb-reproduction.log`.

The full browser/PostgreSQL/Redis-enabled regression run passed 2,265 tests with
zero failures/skips including the failed-assertion SQA guard. Log:
`/private/tmp/qase-autonomous-release-verification.log`. The subsequent report
verbosity constraint passed 39 focused tests; final verification is recorded below.
These suites include actual PostgreSQL transaction/lease/RLS tests and Redis
restart/reconnect tests. Deterministic SDK tests use real Chromium and scripted
model responses; they prove integration boundaries, not live reasoning quality.

Live SQA fixture: `5e6b8e1f-b570-4221-9f97-482c5ecc7961`,
`test-results/mode-discovery/fixture-12/sqa/`.

- Real Opus/JEV, installed SDK and Chromium; no scripted model responses.
- Home, Documentation, Pricing and Practice actually reviewed.
- Four feature-linked workflows verified; 61 recorded assertion outcomes;
  real empty/one-character rejection and valid `Alpha` input followed by local
  `Local task saved` output. Zero server writes.
- All 30 controls dispositioned: 7 pass, 23 blocked. Workflow plan 6/6;
  conclusive control coverage 23.33%, evidence satisfaction 22.22%.
  The final assessment correctly remains `blocked`.
- 689,748 exact total tokens, 31 Opus calls, one JEV call, 71 browser actions,
  246.150 seconds; first browser dispatch 3.840 seconds. Sampled Node RSS peak
  254,427,136 bytes; browser child CPU unmeasured. Checkpoint writes consumed
  430.35 ms total; report commit 1.18 ms in the local fixture, not production DB.
- Independent offline evidence audit passed. Negative fill activity:
  `3a30913f-fd61-4cad-9e6d-33f3e30f711e`; positive fill:
  `312c633d-6a3e-418d-872c-9830cbd805ef`; positive snapshot receipt:
  `f984d32d-99b9-426b-b741-91dcd505f6a5`.

Failed runs are retained, not counted as successes. In particular Founder
`54f1a9f8-b548-46de-b369-7fa7f6c5b300` reached 17 observations and every draft
section, but stopped at 949,659 reasoner tokens (950,156 total), before report
publication. Duration 563.221 seconds. Its checkpoint is under
`test-results/mode-discovery/fixture-12/founder/`. Earlier disposable fixture
attempts under `fixture-1` through `fixture-11` include known gateway timeouts,
budget stops, and implementation defects subsequently fixed. None was erased,
silently resumed with reset accounting, or described as a completed assessment.

## Performance interpretation

The historical generative four-page SQA fixture used 933,225 tokens in 167.748
seconds, without the new discovery/workflow proof contract. The current fixture
uses 689,748 tokens (26.1% fewer) but takes 246.150 seconds (46.7% longer).
Both use the same application fixture, but the model-selected work differs;
this is not a controlled speed benchmark. Current tokens per verified workflow:
172,437. No claim of equivalent scope, lower total cost, universal speedup, or
adequate production SLA follows. The 11-second JEV-only sample was much cheaper
and much shallower; it is not an equivalent autonomous workload.

## Operation, rollback and remaining qualification

Qualification commands use per-process `QASE_SQA_REASONING_ENABLED=true` or
`QASE_FOUNDER_REASONING_ENABLED=true`, `QASE_LIVE_SYSTEM_QUALIFICATION=true`,
and the existing secure credential configuration. For the loopback fixture set
`QASE_ALLOW_PRIVATE_NETWORK=true` and run
`node scripts/qualify-system-mode.mjs sqa --deep` (or `founder --deep`).
`QASE_SYSTEM_QUALIFICATION_OUTPUT` selects an isolated artifact directory.
Audit a completed fixture with
`node scripts/verify-system-mode-evidence.mjs <mode-artifact-directory>`.
An explicitly authorized public realistic target uses
`QASE_SYSTEM_QUALIFICATION_TARGET=https://drytis.com/` without `--deep`;
fixture-specific expected outcomes must not be applied to that website.

To roll back new-run selection leave both mode flags false. Do not rewrite
saved execution strategies or migrate in-progress runs. No destructive data
change is necessary. New source requires its regenerated manifest and normal
deployment review; no deployment was performed here.

Remaining boundaries: bounded discovery (24 states, 160 features, at most 16
planned workflows) is not exhaustive exploration. The full per-mode live fault
matrix, authenticated/realtime application execution, distributed SDK/browser
restoration, production TLS/storage topology and operational SLA are separate
mandatory qualifications. Local queue fencing or JSONB round-trip success does
not prove a complete authenticated model/browser run survives worker loss.
Missing reviewer documents, customer evidence and business metrics stay explicit.

## Final qualification results

Founder fixture `17bf97f6-e6f2-4237-8e85-f2a6945fe4ec` published successfully:
`test-results/mode-discovery/fixture-14/founder/`. Independent evidence audit
passed, including actual empty/one-character rejection, valid local submission,
all four reviewed pages, all 17 evidence-backed lenses, all 11 report sections,
three recommendations and a populated 30/60/90-day roadmap. All eight canonical
todos and five feature-linked workflows were accounted for; 63 browser actions.

Exact usage: 546,112 tokens, 31 Opus calls and one JEV call. Duration 460.459 s;
first browser dispatch 3.088 s. Peak sampled Node RSS 262,914,048 bytes; checkpoint
writes 664.05 ms total and local report commit 1.35 ms. Negative input activity
`bd4bb470-60b0-4578-b601-b270424d9da9`, valid input activity
`8fceec6c-5baf-4f42-9981-fdb6085e017e`, successful snapshot receipt
`32738c98-9286-42ef-82cd-7bf88181c890`. The complete native report validator
reconstructed exactly the saved report. The audit now checks actual one-character
input, rather than wrongly requiring uppercase `A`; the model used lowercase
`a`. It still requires the intervening real submission and unsuccessful snapshot.

Compared with the preceding failed Founder attempt on the same fixture:
950,156 → 546,112 total tokens (42.5% fewer), and 563.221 → 460.459 seconds
(18.2% shorter). The earlier attempt did not publish; model-selected workflow
counts also differ. This is useful diagnostic evidence, not a controlled
production throughput/cost benchmark. Current tokens per verified workflow:
109,222.4. No complete Opus price receipt was available for cost comparison.

Current UI qualification passed with real Chromium, HTTP handlers and SSE:
`test-results/mode-discovery/ui/result.json`, log
`/private/tmp/qase-mode-discovery-ui.log`. It verifies authorization/default
scope, run refresh/navigation, finalized plan events, current SQA/Founder
report rendering, mobile layout and actual Markdown/PDF exports. Execution
services are injected and completed reports are replayed from separately
recorded real runs; this is not another live model qualification. Its QA report
is the historical real fixture, not a newly executed QA workload.

Public-site runs and final source verification are recorded next. This report
does not authorize deployment or production activation.

Final source regression log:
`/private/tmp/qase-mode-final-completion-verification.log`: **2,273 passed,
zero failed, zero skipped**, with actual browser engines and isolated
PostgreSQL/Redis. No production infrastructure was accessed.

Locator-recovery repeatability: an earlier combined four-case run timed out
in SQA, and a preceding run had anomalously extended wall-clock durations.
These were retained in `/private/tmp/qase-mode-fill-recovery-tests.log` and
`/private/tmp/qase-mode-fill-recovery-complete-repeat.log`. A traced four-case
repeat passed (`qase-mode-fill-trace.log`), five fresh isolated SQA repetitions
passed (`qase-mode-fill-repeat-1.log` through `-5.log`), and the final full suite
passed without increasing the 30-second test deadline. The cause of the earlier
combined-run timing failure is not established; these passes do not prove it
impossible under production contention.

Docker is not available in this environment, so a new production-container
smoke run is unverified. Generic PostgreSQL queue fencing, Redis restarts and
JSONB persistence passed; full per-mode distributed SDK/browser crash recovery,
authenticated/realtime workflows and production topology remain unqualified.

Public SQA `0b49f3cb-b47b-41af-8e01-241b640a8be7`:
`test-results/mode-discovery/public-5/sqa/`. The repaired engine reviewed 11
actual public pages, but final assessment publication is **BLOCKED**. JEV
returned `JEV_HTTP_REJECTED`, HTTP **500**, during dispatched classification,
with no verifiable usage receipt. The run retained 458,253 known tokens and
paused after 280.909 seconds. Classifier reservation
`91a5404c-71c5-4aba-9acd-ab5a39703f25` retains 21,960 tokens of exposure, **not
reported consumption**. No estimate, reservation deletion, fake control result
or report publication was used to turn this into success. Provider usage must
be reconciled before this particular run can resume.

After that HTTP 500, all **13 gateway checks passed again**:
`/private/tmp/qase-mode-final-gateway-qualification.log`. The native SDK usage
check matched 10,773 reported tokens across two calls; JEV returned the expected
qualified model. A successful new small request does not reconcile the failed
earlier request or prove larger workload reliability. Its reservation remains
untouched. This is not a silent fallback or an activation of production flags.

The isolated qualification harness can restore a saved public-only SQA/Founder
checkpoint into a fresh SDK/browser using
`QASE_SYSTEM_QUALIFICATION_RESUME=<checkpoint.json>`. It requires the synthetic
qualification owner, exact original mode/target, no vaulted credentials, no
uncertain/running action and no reserved/unverified usage. It preserves original
plans, receipts, lifetime budget, usage and elapsed execution time. The outer
watchdog uses only the remaining approved duration. It does not restore private
customer runs or authorize credentials, mutations, extra budget or report gaps.
The actual unresolved SQA checkpoint was rejected before model dispatch; log:
`/private/tmp/qase-mode-unresolved-usage-resume.log`.

### Real public Founder completion and recovery

Run `3793aabb-16a1-4af5-b753-d8767a80f4b2` resumed from the original saved
public checkpoint into a fresh SDK/browser and **published successfully**.
Artifacts: `test-results/mode-discovery/public-6-resume/founder/`, including
`report.md`, `checkpoint.json`, `result.json`, screenshots and the independent
`evidence-audit.json`. The original paused artifact remains unchanged under
`public-6/founder/`.

- Eight actual public pages reviewed; six workflows accounted for: five
  assertion-verified passes and one explicitly inconclusive FAQ/social-proof
  interaction. That inconclusive result was not converted to PASS.
- All 17 review lenses covered by 23 evidence-backed observations; all eleven
  native report sections, three recommendations and the 30/60/90-day roadmap
  persisted. Normalizing the complete saved draft exactly reproduces the report.
- 819,932 exact lifetime tokens, including the original 363,088; budgets were
  byte-for-byte unchanged, all model reservations settled, and old workflow
  statuses, receipt lists and frozen proofs remained unchanged.
- 76 lifetime browser actions; 461.730 seconds in the resumed attempt and
  653.675 seconds cumulative active execution, within the original 900-second
  lifetime budget. Waiting time between attempts was not treated as execution.
- Fresh browser verification receipt:
  `6414d1c5-3aed-4466-84ca-450c8111a81c`. Checkpoint SHA-256:
  `74d0dc8d99cf1ba2f7984261e98b4db71b9d9e78f1a13fe24e52c0c99d691863`.

This qualifies a scoped public product review and fresh-process host checkpoint
recovery. It does not establish authenticated Studio journeys, commercial
metrics, formal compliance, automatic cross-worker browser restoration, or
exhaustive coverage of drytis.com.

### Mode qualification matrix

| Gate | SQA | Founder |
| --- | --- | --- |
| Live multi-page fixture and report | PASS; 30 dispositions, final assessment legitimately blocked | PASS; 17 lenses and complete report |
| Real public application | BLOCKED; 11 pages, 7 passed/1 blocked workflows, JEV receipt missing before assessment closeout | PASS for scoped public review; 8 pages, 5 passed/1 inconclusive workflows |
| Deterministic evidence/completion gates | PASS in regression/native tests | PASS in regression/native tests and independent public artifact audit |
| Missing locator and bounded tool recovery | PASS in real SDK/browser tests; 5 isolated repetitions | PASS in real SDK/browser tests |
| SDK turn stop/prose cannot publish | PASS in native SDK regressions | PASS in native SDK regressions |
| Checkpoint/JSONB integrity | PASS with actual PostgreSQL | PASS with actual PostgreSQL and live fresh-process resume |
| Mode-specific distributed worker/browser crash | UNVERIFIED | UNVERIFIED; public fresh-process test is not distributed failover |
| Cancellation/stream failure | Shared unit/native transport checks pass; complete live per-mode fault matrix unverified | Same |
| Refresh, SSE and report exports | PASS in real dashboard browser test with injected execution services | Same |
| Exact model accounting | PASS for reported receipts; unresolved HTTP 500 correctly blocks | PASS including preserved lifetime accounting across resume |
| New qualified authenticated/realtime workflows | UNQUALIFIED; public read-only path only | UNQUALIFIED; public read-only path only |
| Full new-mode Firefox/WebKit report runs | UNVERIFIED; existing engine integration regressions pass | UNVERIFIED |
| Production container/topology | BLOCKED; Docker unavailable and production topology not exercised | Same |

### Required next steps before activation

1. Obtain an authoritative receipt or auditable usage reconciliation for the
   failed JEV reservation; do not infer zero cost from HTTP 500. Qualify reliable
   upstream failure receipts and repeat realistic SQA through publication.
2. Qualify the secure authenticated/realtime execution contract separately;
   do not make a new mode bypass the network write/credential boundaries.
3. Run the full per-mode interruption, concurrent execution and distributed
   SDK/browser worker recovery matrix in disposable deployment-like services.
4. Build/smoke the actual production image and selected browser engines; review
   TLS, shared storage, monitoring, rollback and workload-specific performance.
5. Review the earlier combined-run test timeout under realistic contention.
   Later green repetitions do not establish its root cause.

Only after those gates and explicit operator approval should new production
runs opt in. Disabling flags affects new selection; cancel/drain existing runs
through their supported controls rather than rewriting pinned execution state.
No commit, push, merge, production configuration change or deployment occurred.

`npm run release:manifest` and `npm run release:verify` passed for 752 source
files. `git diff --check` passed. The disposable PostgreSQL and Redis services
were stopped after testing; the user's QASE server and production services were
not restarted or stopped. Release identity is retained; UI cache identity is
`20261105-2`. The manifest verifies source integrity, not deployment readiness.

The public write counter belongs only to the disposable local fixture server;
it is not a server-side audit of drytis.com. Public target mutations are
prevented by the existing host network/action policy, verified independently
with real local POST/WebSocket probes. Do not interpret that local counter as
proof of all external server behavior.
