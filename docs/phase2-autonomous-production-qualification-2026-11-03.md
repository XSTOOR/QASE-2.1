# QASE Phase 2 — autonomous execution and production qualification

Date: 3 November 2026. Checkout: `QASE-2.1`, branch
`codex/hybrid-production-readiness`, original HEAD `9e9e68f`.

## Release verdict

**BLOCKED — EXTERNAL DEPENDENCY.** The basic gateway protocol qualifies, and
live QA and generative SQA publish valid reports. Generative Founder reaches
all 17 lenses but its large native report call produces malformed arguments;
the subsequent request times out with unverifiable usage. The precise
model/gateway/SDK attribution of that malformed output is not established.
No substitute model, invented report, estimated receipt, or permissive fallback
was used. Founder activation remains blocked.

Production qualification also remains incomplete for the full per-mode fault
matrix and distributed authenticated-browser restoration. One synthetic
microphone capture failed during the browser-enabled full suite and passed a
focused rerun and final full rerun; its intermittent cause remains unverified. These limitations
prevent a production-readiness claim even if the final regression suite passes.

Both new mode flags remain disabled by default. They were enabled only inside
isolated qualification processes. No deployment, push, commit, merge,
production migration, account-setting change, or production activation occurred.

## Preservation and architecture

The entire current working tree was used as the baseline. Its 40 initially
modified/untracked files were fingerprinted in
`/private/tmp/qase-phase2-initial-tree.json`. The preceding stabilization report
and existing source were inspected before implementation. No reset, revert,
checkout, pull, branch change, SDK package edit, or dependency replacement was
performed. Existing Phase 1 changes remain present.

| Mode | Execution after these changes | Final authority |
| --- | --- | --- |
| QA | Existing Opus/JEV hybrid and its native CleanSlate SDK loop; existing JEV-only and configured-provider paths remain available | Existing scenario/evidence ledger and QA completion gate |
| SQA | Legacy behavior by default; opt-in qualified Opus SDK reasoning with bounded JEV evidence classification | Existing control catalog, deterministic evaluator and SQA finalizer |
| Founder | Legacy behavior by default; experimental Opus SDK reasoning with bounded JEV evidence classification; activation remains unqualified | Existing 17-lens observation registry, evidence contracts, canonical plan and full report schema |

`modeReasoningRuntime.js` wraps the existing SDK's model service and approved
tools. It does not replace `runtime.run` or introduce another autonomous loop.
The host continues unfinished SDK segments only while meaningful progress is
being made, stopping after three stagnant segments or a real terminal condition.
Browser/tool execution is serialized. JEV receives immutable, redacted summaries,
can classify them or report insufficient evidence, and cannot execute browser
actions, grant permissions, assign compliance verdicts or publish reports.

New runs opt in with `QASE_SQA_REASONING_ENABLED=true` or
`QASE_FOUNDER_REASONING_ENABLED=true`; both examples/defaults are false. Saved
strategy, credential/model identity, accounting and lifetime budgets remain
pinned across restart or flag rollback. Active legacy runs are not migrated.
The existing exact-key/model/SDK 24-hour qualification gate remains enforced.

## Root causes and fixes

1. **SQA and Founder selected the bounded JEV adapter.** Their generative
   path now uses the already-qualified fixed Opus transport and native SDK,
   with independent persistent mode state. JEV remains advisory. Each mode
   retains its original prompts, schemas, allowlists and publication rules.
2. **Redundant inference context consumed the finishing budget.** Completed
   native tool rounds are compacted using the existing protocol-safe helper;
   matched calls/results are removed together, while human instructions,
   unfinished calls, recent observations, host plan and evidence references
   remain available. Large Founder final-report schemas are withheld until
   their prerequisites are present. Full mode evidence/accounting is retained.
3. **Classifier receipts were confused with browser evidence IDs.** Live
   Founder attempted to cite `modeEvidenceId` values as `evidence_activity_ids`.
   Native tool responses and host context now distinguish classification
   receipts from actual completed browser activity IDs. The original strict
   Founder evidence validator is unchanged.
4. **Activity persistence trailed dependent SDK tools.** An asynchronous
   activity scope now follows native tool execution. The activity is committed
   before serialized ownership is released, so a queued evidence tool sees
   completed browser evidence. The outer stream does not duplicate activities
   or repeat their completed writes.
5. **SQA could account for controls but exhaust context before publication.**
   Once every control has a disposition, pass evidence is sufficient, no
   authenticated-scope decision remains and exploration prerequisites pass,
   the supported `agentSession.clear()` starts a compact SQA synthesis segment.
   Only plan updates and the existing SQA finalizer are advertised. The host
   does not mark todos complete itself; finalization still checks them.
6. **Publication and SDK prefetch could disagree.** A successful durable mode
   finalizer supplies the publication receipt before the SDK consumes its
   result. Later SDK prefetch cannot dispatch another paid call or overwrite
   that durable success. Model prose and old artifacts are not receipts.
7. **Uncertain actions could continue within the same segment.** Unknown
   mutation or evidence-write outcomes now prevent subsequent dispatch and
   model continuation, not merely restart. Read-only snapshot/diagnostic
   failures remain distinguishable and can recover without replaying a
   mutation. Unverified model usage continues to fail closed.
8. **Fresh tenant bootstrap failed under actual forced RLS.** User visibility
   required membership before bootstrap could create membership. Migration
   `043_actor_bootstrap_visibility.sql` admits only the trusted transaction-local
   actor's own user row with tenant scope present. Membership is established
   before updating an existing user; active membership checks and forced RLS
   remain in place. Raw connections still see no users or runs.
9. **Real PostgreSQL rejected previously untested SQL bind types.** Nullable
   pause/failure fields and cleanup timestamps now have explicit SQL types.
   Reads on one PostgreSQL client are awaited sequentially, eliminating the
   driver's concurrent-query deprecation without reducing actual parallelism.
10. **Negative authentication waited for nonexistent proof.** A changed,
    rendered response surface without a session receipt now ends the readiness
    wait, then undergoes the same independent verification. It remains
    `verification_needed` when proof is absent. Cleanup no longer waits for
    removed credential inputs to reappear. No timeout was increased and no
    verification assertion was weakened.
11. **Qualification mistook a draft assessment for publication.** SQA computes
    a draft assessment after every observation. The live harness now requires
    `finalizedAt` before reporting publication. Earlier failed SQA artifact
    files may say `reportPublished: true` for drafts; they were not final reports
    and are not counted as successful executions here.
12. **An optional security fixture did not await bridge initialization.** Its
    setup now awaits the existing asynchronous API. Five real security cases
    that failed setup subsequently passed, including planted XSS/SQL fixtures.

## Files changed in Phase 2

New modules/tests:

- `server/modeReasoningRuntime.js` and `.test.js`: mode strategy, persistent
  budgets/receipts, serialization, scoped activity ownership, advisory JEV,
  interruption policy and checkpointing.
- `server/modeReasoningContext.js` and `.test.js`: bounded inference projection,
  authoritative mode memory and distinct evidence identifiers.
- `server/modeReasoning.integration.test.js`: installed SDK plus actual browsers
  with deterministic model fixtures, dependent evidence and continuation tests.
- `public/modeReasoningView.js` and `.test.js`: actual saved strategy, execution
  state, sampled page coverage and provider-reported usage; no private reasoning.
- `server/redisEvents.integration.test.js`: actual local Redis qualification.
- `server/postgres/migrations/043_actor_bootstrap_visibility.sql`: forward-only
  schema change tested only in disposable schemas.
- This engineering report.

Extended existing files:

- `server/agent.js`, `server/agent.test.js`, `server/hybridModelRouter.js`:
  qualified mode integration, supported continuation/synthesis, durable
  publication, snapshot restore and router state isolation.
- `server/sqaPrompt.js`, `server/sqaTools.js`, `server/founderTools.js`:
  mode-specific closeout and exploration prerequisites; existing deterministic
  evaluation/report validation remains intact.
- `server/postgres/runRepository.js`, `.test.js`, `integration.test.js`,
  `migrations.test.js`: RLS bootstrap, bind types, durable reasoning state,
  transaction interruption, concurrent saves and crashed-process lease fencing.
- `server/hybridAuth.js`, `.browser.test.js`: readiness/cleanup fix and repeated
  asynchronous real-browser authentication fixtures.
- `server/securitySuite.integration.test.js`,
  `server/browserMedia.integration.test.js`: awaited bridge fixture and richer
  failure diagnostics; microphone assertions remain strict.
- `public/app.js`, `public/founderView.js`: mode status panel using existing
  styling. Existing navigation and report actions are preserved.
- `.env.example`, `scripts/qualify-system-mode.mjs`: disabled flags and a
  reproducible four-page live fixture with actual final-artifact checks.
- `SOURCE_MANIFEST.json`: refreshed after verification to inventory this tree.

This list describes this phase; `git status` also contains preserved work from
before the phase. No change list is presented as a new commit.

## Gateway and actual autonomous executions

All **13 live protocol checks passed** using installed CleanSlate SDK 0.1.0:
text, streaming, native tools, multiple tools, tool-result continuation,
cancellation, timeout, usage, structured JSON, image input, SDK loop, SDK usage
and JEV. Log: `/private/tmp/qase-phase2-gateway.log`. The existing qualification
file contains the full credential-fingerprinted result without the credential.
These basic checks do not prove compatibility with Founder's large report call.

The live fixture has Home, Documentation, Pricing and Practice pages; it has
documented empty/one-character input rejection and a valid DOM-only task save.
It has no actual account, commercial metrics, reviewer artifacts or server
writes. Gateway/model responses are real; no scripted agent responses were
used for these runs. Separate deterministic SDK tests are labelled as such.

| Mode | Actual run | Result | Duration | Verified tokens |
| --- | --- | --- | ---: | ---: |
| QA | `27a14954-fe86-4dc2-bc74-5902914b845a` | Published `partial`: navigation, responsive and accessibility scenarios passed; search is inconclusive because the fixture has no search feature | 115.459 s | 241,315 |
| SQA | `7c1053f4-a3f7-4bfb-b4eb-1e5bdfa8c4c2` | Published `blocked`: all 30 controls dispositioned, 8 pass and 22 blocked; all four pages reviewed; 100% observed control disposition, 26.67% conclusive coverage, 47.22% evidence satisfaction | 167.748 s | 933,225 |
| Founder | `fb860941-831d-4b24-8d3f-8411ff9ea7cb` | All four pages reviewed, 17 evidence-backed lenses; report arguments failed native JSON decoding, then request timed out; no final report | 261.136 s | 714,652 known; final usage unresolved |

Artifacts:

- QA: `test-results/phase2-activity-qualified/qa/`.
- SQA: `test-results/phase2-sqa-closeout/sqa/`.
- Founder failure: `test-results/phase2-activity-qualified/founder/`.

Each contains the actual run checkpoint and measured result; successful runs
also contain their report. These ignored fixture files contain synthetic data,
not customer sessions. Earlier failures are retained under
`phase2-generative*` and `phase2-final-live`; no failed attempt was erased or
counted as success. Founder finalization remains blocked after the failed
request's 121,005-token exposure reservation; that is not verified usage.

Example persisted evidence references:

- SQA: `qase://runs/7c1053f4-a3f7-4bfb-b4eb-1e5bdfa8c4c2/activities/toolu_018JpCWdZcwY4YiJjHY3dJ5B/evidence/a271e2cfe4b95b89e340788b`.
- Founder: `qase://runs/fb860941-831d-4b24-8d3f-8411ff9ea7cb/activities/toolu_018rHMcyiQg2nNQnsS9azTYU/founder-evidence/9335cfd7bd162d051e1e5f95`.

## Distributed reliability

Real isolated PostgreSQL 17.6 and Redis 7.4.6 were built locally from official
source into `/private/tmp/qase-phase2-infra`; no system installation or production
service was changed. Source build guidance:
[PostgreSQL](https://www.postgresql.org/docs/17/install-make.html) and
[Redis](https://redis.io/docs/latest/operate/oss_and_stack/install/build-stack/).
The installed macOS 27 SDK failed linking; the installed macOS 15.4 SDK allowed
the disposable builds without global toolchain changes.

PostgreSQL listened on loopback port 55432, database `qase_phase2`, under a
dedicated non-superuser, non-BYPASSRLS role. Tests migrate and drop only random
isolated schemas. Redis listened on loopback port 56379 with persistence disabled.

Verified with actual dependencies:

- Durable run/control/reasoning-state round trips, exact accounting retention,
  optimistic locking and tenant/default-deny RLS.
- Concurrent publication with exactly one successful aggregate writer.
- Abrupt termination of only a test database transaction; its partial update
  rolled back, the pool reconnected and the previous report remained intact.
- Killing a separate claiming process, waiting for its actual lease expiry,
  competing restart claims, one winner with a new token, and rejection of the
  old process's completion. The saved completed-action marker and usage survived.
- Cancellation propagated through the actual queue heartbeat/completion path.
- Redis cross-replica event/frame delivery, tenant separation, cancellation
  status, replacement of stale pending frames, explicit client reconnection
  and resource closure.
- The separate real control-plane PostgreSQL integration also passes.

Important boundary: job claiming/leasing is PostgreSQL-backed. Redis carries
live events and frames; it is not falsely described as the authoritative queue.
The killed-process test qualifies queue fencing/checkpoint retention, not an
entire authenticated SDK/browser workflow migrating between production workers.
Redis server failover, database disk/node failure, production TLS topology,
shared snapshot storage and cross-worker browser restoration remain unqualified.

## Authentication and performance

The same negative sign-in oracle measured **12,692.412 ms** before the readiness
fix. Six subsequent immediate-render cases passed with median **340.575 ms**
(317.450–396.081 ms). Six delayed-render cases passed with median **461.138 ms**
(401.315–494.197 ms). Both stress processes ran concurrently, with six repetitions
of each verified, unverified and readable-access case: 36 repeated browser cases,
plus two separate cross-origin sign-in cases, zero failures. Additional auth unit
tests passed. Logs: `/private/tmp/qase-phase2-auth-stress-{fast,delayed}.log`.
This is a fixture-specific before/after measurement, not whole-application latency.

| Measurement | QA live | SQA live | Founder live failure |
| --- | ---: | ---: | ---: |
| Agent construction | 9 ms | 12 ms | 9 ms |
| Completed browser activities | 54 | 21 | 20 |
| Reasoner calls, including unresolved calls | 18 | 27 | 23 |
| Classifier calls | 1 | 1 | 1 |
| Measured reasoner request latency sum | 93,680 ms | 155,270 ms | 250,437 ms |
| Classifier latency | 1,123 ms | 1,238 ms | 1,329 ms |
| Process RSS before/after | 166.95/173.22 MiB | 167.50/242.36 MiB | 167.16/186.75 MiB |

RSS values are samples, not peak process or browser memory. First-browser-action,
database-query and report-generation phase latency were not independently
instrumented in these runs. No reliable full-workflow pricing or cost comparison
is available. There is no claim that the generative modes are cheaper than the
old JEV-only template workflow, or that differing workloads prove a speedup.
The high SQA context/token cost remains an operational qualification concern.

## Validation scope and release gates

The installed-SDK/real-browser mode regressions verify batched browser activity
completion before dependent observations, evidence persistence across SDK segment
boundaries, bounded stagnation and rejection of final-looking prose as completion.
Other focused tests cover cancellation, safe read recovery, uncertain mutations,
budget exhaustion, missing/unqualified credentials, usage uncertainty after
restart, mode pinning, classification caching and publication prefetch failures.

The actual dashboard loaded saved live QA/SQA reports and the preserved Phase 1
legacy Founder report; launcher authorization, page refresh, retained run route,
Markdown/PDF download and desktop/mobile rendering passed with zero page errors.
`test-results/system-mode-ui/result.json` labels the injected UI execution
services. This does not qualify generative Founder report publication.

| Mode | Live execution | Recovery qualification | Final report | Performance | Verdict |
| --- | --- | --- | --- | --- | --- |
| QA | PASS for the defined four-page fixture; partial scope disclosed | Regression coverage passes; full live distributed matrix unverified | PASS, valid partial report | Measured fixture | Production review still conditional |
| SQA | PASS, multi-page generative fixture | Native SDK/host regression coverage; full per-mode live fault matrix unverified | PASS, legitimately blocked assessment | Measured, high token cost | Experimental, disabled by default |
| Founder | FAIL at final structured output after meaningful exploration | Safe interrupted checkpoint retained; unresolved usage blocks replay | BLOCKED | Measured failed run | Activation blocked |

Final full regression counts and any remaining failures are recorded in the
verification addendum below. Passing unit/integration tests do not turn untested
matrix cells into PASS. In particular, long-running authenticated assessments,
live model interruption in each mode, complete browser-session migration,
production multi-user load, backup restoration and deployment rollback drills
remain unverified.

## Reproduction and rollback

Use Node 22–24; this workspace used its installed Node 24.22.1 toolchain. Existing
secure account configuration is loaded by the live scripts; never put a key in
these commands or output.

```sh
# Existing thirteen-check live qualification (does not activate a mode)
NODE_ENV=development node scripts/qualify-hybrid-gateway.mjs

# Isolated live SQA fixture; replace sqa flag/mode with founder to reproduce
# the still-blocked Founder experiment. These flags affect only this process.
NODE_ENV=development QASE_ALLOW_PRIVATE_NETWORK=true \
QASE_LIVE_SYSTEM_QUALIFICATION=true QASE_SQA_REASONING_ENABLED=true \
QASE_SYSTEM_QUALIFICATION_OUTPUT=test-results/requalification \
node scripts/qualify-system-mode.mjs sqa --deep

# Full verification, using only disposable local test services
QASE_RUN_BROWSER_TESTS=1 \
QASE_TEST_DATABASE_URL=postgresql://qase_phase2_test@127.0.0.1:55432/qase_phase2 \
QASE_TEST_CONTROL_DATABASE_URL=postgresql://qase_phase2_test@127.0.0.1:55432/qase_phase2 \
QASE_TEST_REDIS_URL=redis://127.0.0.1:56379 npm run verify
```

Rollback new-run selection by leaving/unsetting both reasoning flags, or setting
them false. Existing legacy behavior is retained; already selected generative
runs retain their strategy, evidence and accounting. Do not convert an interrupted
run into another architecture or clear its usage reservations to resume it.
Never reset production data. Migration 043 was authored and tested locally only;
its production application requires separate authorization and review. If later
applied, use a reviewed forward migration for any correction rather than rewriting
the recorded migration history.

Before release: resolve large Founder native-argument compatibility, requalify
its actual final report and uncertainty handling, finish the live per-mode fault
matrix, investigate the intermittent synthetic microphone failure, review costs,
and qualify the actual production database/Redis/TLS/shared-storage/browser
topology, migration procedure, monitoring and rollback. No production gate is
waived by this report.

## Verification addendum

Full verification executed with `QASE_RUN_BROWSER_TESTS=1` and real local
PostgreSQL/control-plane/Redis URLs: **2,182 passed, zero failed, zero skipped**,
31 suites, 277,989.784 ms. Syntax checks passed for 592 source files, private-path
ignore checks passed, and the high-confidence source credential scan passed.
Log: `/private/tmp/qase-phase2-release-verify.log`.

An earlier browser-enabled run had 2,176 passes and six failures: five setup
failures in the stale security fixture and one microphone capture failure.
The ten-case focused security/media rerun passed. The final full run passed all
cases without weakening assertions or increasing timeouts; it does not erase
the intermittent microphone risk. The standard recursive run before those
optional checks passed 2,152 tests with 24 explicitly skipped browser tests.
Test glob scopes differ from `npm test`; those totals are not added together.

Other independently executed checks:

- Thirteen live gateway capabilities: all pass.
- Two new native-SDK/real-browser mode integration regressions: both pass.
- Focused lifecycle/context/prompt/UI set: 73 pass; the additional safe-read
  recovery test also passes and is included in the final full run.
- Real PostgreSQL repository, crashed claiming process, concurrent finalization
  and interrupted transaction: three tests pass; separate control-plane test
  passes. Real Redis event transport test passes.
- Authentication stress: 38 actual browser cases across both processes, zero
  failures; associated nine auth unit tests also pass.
- Actual dashboard/report refresh and exports: all five recorded UI check groups
  pass with zero page errors. Founder exports in this UI test use the preserved
  legacy live report, not a nonexistent generative report.
- `git diff --check` passes. Source manifest regeneration/verification records
  the current local files, not a commit or production release approval.

After that full run, a final defensive change bounds untrusted page titles,
URLs and selector metadata before checkpointing/classification. The affected
agent/context/runtime/UI tests, including both installed-SDK/real-browser mode
integrations and an oversized hostile-metadata regression, were rerun:
**76 passed, zero failed, zero skipped** in 5,093.560 ms. The full 2,182-test run
was not repeated after this bounded-metadata change; it is not described as a
fresh full-tree result. Log: `/private/tmp/qase-phase2-last-focused.log`.

Raw qualification/test logs are also copied to the ignored
`test-results/phase2-evidence/` directory with a SHA-256 evidence index. All 40
baseline files remain present; after source manifest regeneration, 33 retain
their initial byte hashes and seven were intentionally extended. Git HEAD and
the branch remain unchanged.

Disposable dependency services were stopped after qualification. Their isolated
data/build directories and logs remain for reproduction. To restart them locally:

```sh
/private/tmp/qase-phase2-infra/pgsql/bin/pg_ctl \
  -D /private/tmp/qase-phase2-infra/pgdata \
  -l /private/tmp/qase-phase2-infra/postgres.log \
  -o '-h 127.0.0.1 -p 55432 -k /private/tmp/qase-phase2-infra' start
/private/tmp/qase-phase2-infra/redis-7.4.6/src/redis-server \
  --bind 127.0.0.1 --port 56379 --save '' --appendonly no \
  --dir /private/tmp/qase-phase2-infra
```
