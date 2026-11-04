# QASE system stabilization — 3 November 2026

## Executive status

Focused shared-engine defects were reproduced and fixed in the authoritative
local checkout. This is **not production approval**. Live models and real local
browsers exercised all three configured mode paths, and each produced a durable
report. QA completed four selected suites but reported remaining limitations;
SQA correctly returned a blocked assessment; Founder produced the existing
bounded JEV template review. These results do not prove deep review of arbitrary
platforms, compliance certification, or distributed production recovery.

The current configuration selects hybrid Opus/JEV for QA only. SQA and Founder
still select the existing JEV-only controller because the configured provider is
JEV. No mode was migrated, no model was silently substituted, and no SDK package
file was edited. A generative SQA/Founder run needs an explicitly configured,
authorized generative provider before its reasoning quality can be qualified.

## Preservation and initial audit

- Checkout: `/Users/mishal/Documents/QASE/QASE-2.1`.
- Branch retained: `codex/hybrid-production-readiness`; initial HEAD `9e9e68f`.
- No staged changes initially. Twenty-eight modified/untracked files already
  existed; baseline fingerprints were recorded in
  `/private/tmp/qase-stabilization-initial-tree.json`. Existing changes were
  retained and extended where required. No reset, checkout, pull or branch switch.
- Initial full validation: 2,118 passed, 26 skipped, zero failed (2,144 tests).
  Log: `/private/tmp/qase-stabilization-baseline.log`.
- Authoritative architecture references: `docs/hybrid-qa-implementation-report.md`,
  `docs/sqa-runtime.md`, `docs/founder-mode.md`, `docs/operations-runbook.md`;
  dependency and deployment definitions in `package.json`, `deploy/production/`,
  `deploy/kubernetes/` and the distributed worker implementation.

## Execution dependency map

| Stage | Actual implementation and ownership |
| --- | --- |
| Mode/target/browser setup | `public/app.js`, `server/app.js`, `qaConfigurations.js`, `sqaRuntime.js`; per-mode API contracts and authorization |
| Account context and scheduling | `localServices.js`, `postgresServices.js`, `distributedExecution.js`, `worker.js`; owner configuration and fenced queue leases |
| Agent construction | `agent.js:ensureRuntime`; installed CleanSlate SDK 0.1.0, per-session tool registry and browser bridge |
| QA hybrid model calls | `hybridConfig.js`, `hybridModelRouter.js`, `hybridUsageTransport.js`; pinned Opus/JEV roles, qualified transport and exact usage receipts |
| Legacy/configured paths | Native SDK reasoning when a generative provider is selected; `jevRuntime.js` bounded controller when configured provider is JEV |
| Browser and tool policy | `browserBridge.js`, `browserPolicy.js`, `browserTools.js`, mode tool allowlists; one owner and serialized hybrid browser actions |
| QA progress/evidence | `qaScenarioLedger.js`, `hybridRouteExecution.js`, `qaExecutionState.js`, `qaCompletionGate.js` |
| SQA disposition/report | `sqaTools.js`, `sqaService.js`, `sqaAssessment.js`; control evidence contracts and reviewer requirements |
| Founder observations/report | `founderTools.js`, `founderService.js`, `founderSchema.js`; canonical plan, evidence lenses and report schema |
| Continuation/cancellation | `agent.js:runTurn`, SDK `runtime.run`, existing pending-question resume; host controller, bounded retries and mode-specific finalizers |
| Durable recovery | `agent.js` snapshot writer, `runResume.js`, local store, PostgreSQL repositories; evidence and owner attribution |
| UI synchronization | `store.js`/realtime adapters → SSE API → `public/app.js`; snapshots/reconnect/report links |

## Reproduced defects and changes

1. **Lost device ownership across SDK segments.** Automatic continuation/retry
   recursively called `runTurn` without the device-runtime manager. The final
   segment could not release its device lease. The manager now travels through
   both paths, an existing device is retained, and terminal release occurs once.
2. **Retry allowance replenished by continuation.** A timeout/disconnect followed
   by an incomplete model turn reset the retry count. A controlled alternating
   failure reproduced six segments despite the intended two-retry limit. The
   retry count now survives continuation; the same regression stops within five
   segments and ends with an accurate failure.
3. **Running lock stranded by storage/setup failure.** Initial `setStatus`
   occurred before the loop's protected cleanup. The regression reproduced a
   rejected start leaving `record.running=true`. Setup and escaped checkpoint
   failures now release the controller, running lock, frames and device lease.
4. **Duplicate runtime construction and startup ownership.** Concurrent runtime
   requests could overlap asynchronous construction. Construction now shares
   one in-flight promise, including failure; the turn claims ownership before
   asynchronous device selection. Cancellation during device selection prevents
   SDK dispatch. The real installed-SDK lifecycle fixture also requests runtime
   construction concurrently and verifies shared identity.
5. **Publication before durable commit.** SQA/Founder mutate an in-memory report
   before awaiting persistence. A concurrent finalizer could return
   `already_finalized` while that commit was pending or destined to fail.
   `finalizationGuard.js` now shares the pending result across factories for
   the same session. A failed commit cannot become duplicate success. QA uses
   the same guard. Mode-specific evidence and completion gates are preserved.
6. **Late publication after cancellation.** All finalizer tools now check both
   host cancellation and tool-context abort signals before dispatch, including
   idempotent existing-artifact paths. A durable write already dispatched is
   allowed to settle; the guard does not claim to undo committed publication.
7. **Restart re-executed published QA work.** Boot recovery recognized a legacy
   `publishedAt` field, but actual QA reports use `ts`. A status-write crash after
   report persistence could make completed QA resumable. `runResume.js` now
   recognizes both fields and excludes these artifacts from automatic testing.
8. **Unnecessary rejected model calls.** Live QA requested unsupported/unselected
   route categories twice. The batch tool schema now advertises only selected
   supported names and recommends omitting the optional checks list. Host scope
   validation still rejects invalid calls. Future token savings are unmeasured.
9. **Invalid missing-browser fault injection.** The opt-in engine test changed
   `PLAYWRIGHT_BROWSERS_PATH` after Playwright had cached its registry. Its probe
   now uses a fresh child process with the missing path set before import.
   Real engine launch tests remain intact; browser availability is not faked.
10. **Refresh selected the previous run during SSE startup.** The new current-UI
    qualification reproduced SQA's tab disappearing after refresh: the new run
    rendered before `selectSession` updated the URL, which waited for the SSE
    subscription. `public/app.js` now commits the selected run URL before
    rendering and checks selection identity before the later route application.
    The same real-browser test now passes for SQA and Founder, including a
    deliberately delayed fixture subscription.

Five regressions initially failed for items 1–3. The first post-fix shared-engine
suite passed all 52 tests. Additional cancellation, durable publication, startup
ownership, checkpoint failure and published-report recovery tests were added.

## Actual live execution results

Reproduce with the installed Node 24 toolchain and existing secure configuration:

```sh
NODE_ENV=development QASE_HYBRID_QA_ENABLED=true \
QASE_ALLOW_PRIVATE_NETWORK=true QASE_LIVE_SYSTEM_QUALIFICATION=true \
node scripts/qualify-system-mode.mjs qa
```

Replace `qa` with `sqa` or `founder` to use each existing mode path. The script
starts a disposable loopback fixture, uses real configured gateway calls and
real browsers, writes atomic isolated checkpoints, verifies a disk round-trip,
and generates Markdown from the actual artifact. Its deadline is four minutes;
no user-run history, production data or account configuration is written.
It also copies fixture artifacts to `test-results/system-qualification/<mode>/`;
after all three runs, `node scripts/qualify-system-ui.mjs` checks their actual
saved reports through the isolated HTTP/UI. Set
`QASE_SYSTEM_QUALIFICATION_OUTPUT` consistently on both scripts to choose a
different ignored artifact directory.

| Mode | Run ID | Actual outcome |
| --- | --- | --- |
| QA | `fd9e21cc-d40b-4285-ba2e-1f390b271a11` | Four selected suites passed: navigation 6 assertions, responsive 42, search 9, accessibility 15. Overall report remains partial: source-page navigation and broader assertion limits are disclosed. 29 completed browser activities. |
| SQA | `73171cec-19e4-4361-bb29-143518b620ba` | 30 controls dispositioned: 2 pass, 28 blocked. Conclusive coverage 6.67%; evidence satisfaction 5.56%. Report correctly says blocked. 10 completed browser activities. |
| Founder | `a6d453f7-0661-43d4-8bbb-b3e87112eb1c` | 17 lenses have bounded evidence-linked observations and a persisted advisory template report. Six completed browser activities; commercial hypotheses remain unverified. This is not a generative strategy qualification. |

Artifacts for each mode: `test-results/system-stabilization-2026-11-03/<mode>/`
contains `checkpoint.json`, `result.json`, and `report.md`. These contain only
synthetic fixture content, are ignored by Git, and were not injected into user
history. Live logs: `/private/tmp/qase-system-{qa,sqa,founder}-live.log`.
The QA live run predates the final route-schema narrowing; its two rejected
out-of-scope requests are retained as evidence, not erased.

## Performance measurements

One isolated live run per mode, not a statistically controlled benchmark:

| Mode | Runtime initialization | Run duration | Provider-reported tokens | Process RSS change |
| --- | --- | --- | --- | --- |
| QA hybrid | 9 ms | 72,512 ms | 155,945 | −7.0 MiB |
| SQA configured JEV | 11 ms | 3,599 ms | 12,880 | +96.7 MiB |
| Founder configured JEV | 7 ms | 2,491 ms | 6,947 | +87.0 MiB |

These are different workloads/providers and must not be compared as model
speed or quality benchmarks. RSS is Node process memory only; Chromium child
memory and peak memory were not measured. Runtime initialization excludes
initial browser navigation. There is no equivalent pre-fix performance run and
no reliable cost pricing in this qualification; before/after token/cost savings
and production capacity are **unverified**. Retry/device regressions demonstrate
bounded correctness improvements, not throughput claims.

## Verification and limits

- Shared execution/finalizer/recovery regression checks passed, with failure
  injection performed against deterministic fixtures. These are not live
  provider outages or real distributed worker restarts.
- Installed-SDK browser fixtures verify eleven scenarios across final-looking
  intermediate responses, rejected early publication, authenticated same-URL
  discovery, evidence integrity, and unchanged SDK loop identity. Model
  responses in those fault fixtures are deterministic substitutes; live model
  evidence is separately identified above.
- Real Chromium, Firefox and WebKit qualification passed (9 tests, no skips),
  including actual WebKit positive/negative form execution and attributable SQA
  evidence. The earlier opt-in run exposed the stale missing-engine test;
  the corrected test and real engines passed on re-execution.
- Current hybrid launcher qualification passed with zero model calls.
- Actual UI/SSE preview qualification passed with no page errors: reconnect,
  nested activity updates, desktop/mobile completion, refresh persistence,
  explicit results navigation, secure credential consent and budget decisions.
- The older broad `qualify-dashboard.mjs` script failed waiting for a legacy
  launcher retry button. Its configuration omits hybrid readiness and expects
  the previous three-browser default, while this checkout requires hybrid
  readiness and one browser. It is not accepted as current three-mode UI proof;
  It is a stale harness rather than the current UI release gate. The new
  `qualify-system-ui.mjs` independently passed SQA/Founder launcher authorization,
  real session creation, immediate refresh and retained run selection; all three
  live fixture reports rendered on desktop/mobile and downloaded through the
  actual Markdown and PDF endpoints. There were no browser page errors.
- No isolated PostgreSQL/control-plane database or Redis test endpoint is
  configured; no Docker/pg_ctl executable was found. PostgreSQL RLS and
  distributed restart/lease tests needing real services are BLOCKED. Production
  databases were not used as test fixtures. Existing deterministic worker,
  ownership, cancellation and recovery regressions passed.
- No sustained multi-user load, multi-hour workflow, real outage, production
  credentialed application run or SQA/Founder generative-provider E2E was
  qualified. Those are explicit release blockers, not covered by unit counts.

Full verification before the refresh-race patch: **2,132 passed, 26 skipped,
zero failed/cancelled (2,158 tests)**. The UI-specific focused regressions passed
after that patch; final full-suite and local restart results are appended below.

One subsequent full run overlapped standalone browser qualifiers and recorded
**2,131 passed, 26 skipped, one cancelled test**: the negative sign-in fixture
exceeded its unchanged 25-second test deadline. The same test had passed in the
baseline and first post-fix full runs. Its isolated real-browser suite then
passed **4/4** (the negative case took 12.26 seconds). Resource contention is a
possibility, not an established root cause. No deadline was increased and no
assertion was relaxed. Retain this intermittent failure as a reliability risk
until repeat/load qualification explains it. Logs:
`/private/tmp/qase-stabilization-release-verify.log` and
`/private/tmp/qase-stabilization-auth-isolated.log`.

The new mode UI checks passed all five grouped checks with zero page errors.
The backend was restarted locally only after confirming no active user runs;
`/healthz` returned `status: ok`, the homepage returned HTTP 200, and isolated
hybrid startup accepted the current 13-capability qualification with native SDK
loop identity and durable checkpoint checks passing. This startup check did not
invoke inference or browse a target.

**Final clean `npm run verify`: 2,132 passed, 26 skipped, zero failed or
cancelled (2,158 tests; 261.8 seconds).** This run did not overlap standalone
UI qualifiers. All four authentication browser cases passed, including the
negative case at 12.26 seconds. The earlier timeout remains documented above;
a clean repeat does not establish its root cause or production load reliability.
Log: `/private/tmp/qase-stabilization-final-clean-verify.log`.
Current UI log: `/private/tmp/qase-stabilization-system-ui-final.log`.

### Requested E2E matrix: scope of proof

| Case | QA | SQA | Founder |
| --- | --- | --- | --- |
| Normal workflow | Live scoped PASS; report partial | Live configured path PASS; assessment blocked | Live bounded path PASS; deep strategy BLOCKED |
| Long-running workflow | Eleven-scenario SDK/browser fixture PASS; sustained live load unverified | BLOCKED/unverified | BLOCKED/unverified |
| Model interruption | Controlled fixtures PASS; real outage unverified | Shared controlled retry fixtures PASS; real outage unverified | Shared controlled retry fixtures PASS; real outage unverified |
| Browser failure | Missing engine/no-fallback fixture PASS; mid-run disconnect unverified | Real selected-engine fixture PASS; mid-run disconnect unverified | Mid-run disconnect unverified |
| Worker restart | BLOCKED: no isolated DB/queue | BLOCKED: no isolated DB/queue | BLOCKED: no isolated DB/queue |
| Page refresh | Real UI PASS | Real UI PASS, including reproduced selection race | Real UI PASS, including selection race regression |
| Cancellation | Shared controlled lifecycle/tool tests PASS; live mid-run outage not claimed | Shared controlled lifecycle/tool tests PASS | Shared controlled lifecycle/tool tests PASS |
| Budget exhaustion | Deterministic host/SDK tests PASS; live depletion not deliberately induced | Shared retry cap tested; complete provider exhaustion unverified | Shared retry cap tested; complete provider exhaustion unverified |
| Incomplete plan | Real browser/SDK fixture rejects early publication | Mode finalizer regression PASS | Mode finalizer regression PASS |
| Evidence integrity | Host digest/ledger and persisted live fixture assertions PASS | Mode evidence gates and persisted fixture assessment PASS | Mode references/schema and persisted fixture report PASS |
| Report persistence | Disk round-trip and HTTP Markdown/PDF PASS | Disk round-trip and HTTP Markdown/PDF PASS | Disk round-trip and HTTP Markdown/PDF PASS |
| Concurrent execution | Runtime single-owner regression PASS; distributed multi-tenant load BLOCKED | Shared ownership/finalization regression PASS; distributed load BLOCKED | Shared ownership/finalization regression PASS; distributed load BLOCKED |

Controlled fault tests and UI fixtures explicitly use injected services/model
responses where stated. They supplement, and do not replace, the separately
recorded real-model browser runs. Unverified matrix cells remain release risks.

## Mode-by-mode production review matrix

| Mode | Execution | Recovery | Report | Performance | Verdict |
| --- | --- | --- | --- | --- | --- |
| QA | PASS for the four scoped live fixture suites; partial overall coverage | BLOCKED for distributed restart; local deterministic continuation passes | PASS for evidence-derived scoped report | Measured once; load/peaks unverified | Production sign-off BLOCKED |
| SQA | BLOCKED for a complete assessment (28 controls lack required evidence); bounded path executes | BLOCKED for distributed restart; shared local regressions pass | PASS for honest blocked disposition | Measured bounded JEV path | Production sign-off BLOCKED |
| Founder | BLOCKED for deep generative review; configured bounded JEV path executes | BLOCKED for distributed restart; shared local regressions pass | PASS for bounded advisory schema/evidence; strategic usefulness unverified | Measured bounded JEV path | Production sign-off BLOCKED |

## Local changes and rollback

New source: `server/finalizationGuard.js`, its tests,
`scripts/qualify-system-mode.mjs`, and `scripts/qualify-system-ui.mjs`.
Updated source: `public/app.js`, `server/agent.js`,
`qaTools.js`, `sqaTools.js`, `founderTools.js`, `runResume.js`,
`hybridRouteExecution.js`; regression changes in `agent.test.js`,
`runResume.test.js`, `hybridDepth.test.js`, `hybridLifecycle.integration.test.js`
and `multiEngine.integration.test.js`. This report and source manifest record
verification; the previously dirty working tree remains intact.

No commit, push, merge, deployment, migration or production flag activation was
performed. No schema change is required. The changes are suitable for code
review, with the release blockers above still open. Roll back only these focused
patches against the preserved initial tree; never reset the whole checkout or
replace prior uncommitted work with HEAD. Existing persisted reports keep their
original meaning and evidence.
