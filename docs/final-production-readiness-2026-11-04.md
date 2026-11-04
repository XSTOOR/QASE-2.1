# QASE final local production qualification — 4 November 2026

## Release decision

**BLOCKED — INFRASTRUCTURE.** The repaired local execution paths are suitable
for engineering review. This is not authorization to activate or deploy them.
Production image execution, the deployment topology, and authenticated browser
recovery across actual production workers have not been qualified here.
High model consumption also requires an agreed workload/cost envelope.

This audit used the current `codex/hybrid-production-readiness` working tree at
base commit `9e9e68f`, including its 78 initially dirty files. None were removed
or replaced with remote code. No branch changes, commits, pushes, merges,
production migrations, SDK-package edits or deployments were performed.
Generative SQA/Founder flags remain unset locally and false in `.env.example`.
Only isolated qualification processes enabled them.

## Execution architecture checked

The dashboard in `public/app.js` creates scoped sessions through `server/app.js`.
`server/agent.js` initializes installed CleanSlate SDK **0.1.0**, registers the
mode's approved tools, runs its native agent loop, handles continuation and
cancellation, and publishes only after a host finalizer succeeds durably.

| Path | Reasoning and execution | Authoritative result |
|---|---|---|
| Hybrid QA | Opus through native CleanSlate; JEV classifies immutable observations; serialized browser tools | Scenario ledger, scheduler and `qaCompletionGate.js` |
| Opt-in SQA | Same qualified transport/native SDK; independent SQA context/tools; advisory JEV | `sqaService.js` and deterministic `sqaAssessment.js`; missing evidence stays blocked |
| Opt-in Founder | Same qualified transport/native SDK; canonical review plan, 17 lenses; advisory JEV | Durable typed report draft, original `founderSchema.js`, existing publication prerequisites |
| Existing modes | Their pinned legacy/JEV adapters remain available | Their existing mode-specific contracts |

`hybridModelRouter.js` owns independent model budgets and verified usage
receipts. `modeReasoningRuntime.js` owns mode checkpoints, serialized actions,
bounded continuations and stall detection. Browser policy and the existing
bridge retain navigation, credential, device and execution ownership. A model
turn ending or JEV classification cannot publish a report. An uncertain mutation
or unverified usage receipt prevents automatic replay.

Local session/artifact storage and PostgreSQL repositories persist state.
In distributed execution **PostgreSQL owns jobs and leases**; Redis carries
tenant-scoped events and browser frames. UI SSE/reload handlers project that
state; the browser does not determine completion.

## Confirmed defects and repairs

| Severity | Root cause | Repair and evidence |
|---|---|---|
| High | Founder monolithic final tool arguments became malformed (`<parameter` inside JSON); subsequent generation timed out without a verifiable usage receipt | Save 11 original typed sections through the same SDK; append one recommendation per call; publish only the exact intact revision through the original full validator. Baseline failed; two subsequent bounded runs published |
| Medium | SDK-generated request envelopes repeated the same trusted workspace context; synthesis retained irrelevant browser execution context | Remove only exact trusted duplicates, retain human instructions/native call-result links, and use a small synthesis checkpoint. Originals and usage remain durable |
| High | Snapshot text/clock changes counted as continuation progress | Stable action/surface/assertion keys; real draft revisions count, repeated clocks do not. Three stagnant segments still pause |
| Medium | Only three pages were required even when additional eligible pages were observed; unsafe/download/new-window links could inflate the depth obligation | New runs pin an eight-observed-page maximum contract, within their existing budgets; downloads and state-changing destinations cannot become mandatory discovery targets. Saved old contracts remain pinned |
| Medium | Published SQA/Founder reports left the publication plan item `in_progress` | Complete only the allowed publication task in the same durable report write; restore it on storage failure; SSE updates the visible plan without refresh |
| High | Redis readiness PING could wait indefinitely in the offline queue; graceful shutdown could also wait on a stalled drain | One outstanding health probe, readiness/disconnect checks, bounded probe and shutdown with forced client cleanup. Real Redis restart and tenant-isolation tests pass |
| Medium | Missing CSS brace nested subsequent report styles under a textarea focus selector; hard-coded Founder colors assumed a dark canvas | Restore the rule boundary and use existing workspace theme tokens. Real browser reproduces `block` instead of `grid` before the fix, then verifies the grid and both theme palettes |
| Medium | Client browser-version/channel mirror disagreed with the server's shipping singleton catalog; matrix validator still assumed a multi-version ladder | Align client metadata and singleton semantics; independently compare server/client arrays and labels in tests and release validation |

The earlier QA scheduling repair is preserved, not attributed to a new SDK
replacement. Its actual historical run `424036b1-34d0-400a-a4dd-9a32b965bf9a`
used 328,886 reported tokens and attempted 8/11 areas; 3/11 represented conclusive
category coverage. The old gate discharged actionable failures after an attempt
and an exhausted frontier. The repaired gate rejects those remaining execution
obligations. See [the detailed QA root-cause report](qa-scenario-completion-2026-11-04.md).

## Files changed in this audit

Prior local modifications in these files were extended, never discarded.

- Runtime/context: `server/agent.js`, `server/modeReasoningRuntime.js`,
  `server/modeReasoningContext.js`, `server/founderPrompt.js`, and their relevant tests.
- Founder protocol: new `server/founderReportDraft.js` and `.test.js`;
  `server/founderTools.js` retains the original legacy schema by default.
- Durable publication: `server/finalizationGuard.js` and `.test.js`,
  `server/founderService.js` and `.test.js`, `server/sqaService.js`.
- Redis: `server/redisEvents.js`, `.test.js`, new `server/redisRestart.integration.test.js`.
- UI: `public/app.js`, `public/styles.css`, `public/brand.css`,
  `public/browserChannels.js`, `public/browserChannels.test.js`.
- Qualification: `scripts/qualify-system-mode.mjs`, `qualify-system-ui.mjs`,
  new `verify-system-mode-evidence.mjs`, `validate-matrix.mjs`.
- This report and the regenerated `SOURCE_MANIFEST.json`.

## Actual live-model/browser execution

These use real Opus/JEV requests, installed native SDK execution and real local
Chromium against disposable four-page applications. The run store is an isolated
file-backed harness, not a production worker. No remote form writes occurred.

| Mode / run | Actual work and result | Duration | Exact reported tokens |
|---|---|---:|---:|
| QA `2dd28a21-bd29-4e3a-aa02-e574be38fae3` | 11/11 attempted, accountable and conclusive; all 11 pass; 108 browser actions; 37 live input cases including 9 negative cases; no duplicate action keys; report published | 146.445 s | 376,847 |
| SQA `c8fc3f79-9dd6-42cb-b2a0-978f5200b3f9` | All four pages, real empty/one-character/valid form interactions, diagnostics, responsive/accessibility checks; 30/30 controls dispositioned: **12 pass, 18 blocked**, none unassessed; all 8 plan items complete | 153.468 s | 677,283 |
| Founder `8eb9b57d-2ffd-4fa4-b816-a134f24c7c7c` | All four pages and real negative/positive task journey; 17 evidence-backed lenses; 11 complete report sections, 3 recommendations, metrics/experiments and 30/60/90-day roadmap; all 8 plan items complete | 481.477 s | 841,004 |

QA's `partial` report is deliberate: completing this selected scenario set does
not establish successful remote submission, all authentication/business flows,
or full accessibility. Its 100% scenario disposition does not mean the whole
application was tested. SQA's `blocked` verdict is an assurance result, not a
failed execution or a compliance pass. Founder recommendations remain hypotheses;
customer, revenue and analytics outcomes were not supplied.

Founder also published run `b1e93161-5e6a-4f99-ae12-f1d317ad204e` in 475.881 s,
788,764 exact tokens, with 17 lenses and 22 browser actions. Earlier failure
artifacts remain available for runs `25dfb6f5-756a-4e35-84a4-df4b5fe0425a`
and `4f93e1a0-947d-4505-a876-272f35ff92b9`. Their final timed-out requests have
unknown usage: displayed known-token totals are **lower bounds**, not final bills.

Evidence is under `test-results/final-readiness/`:

- QA: `qa-live/healthy/{checkpoint.json,result.json,report.md}`.
- SQA: `publication/sqa/`; Founder: `final/founder/`.
- SQA positive receipt: `dc32daa4-7636-43fd-a3f1-c3eee2e138b1`.
- Founder positive receipt: `cba71a50-9fa9-4985-b05c-21e94a6f1b95`.
- Each `evidence-audit.json` independently verifies receipt hashes, completed
  browser activity references, negative/positive ordering, complete plan, settled
  usage, all four routes and report validity. Founder replay reproduces the
  saved report through the original normalizer exactly.
- `ui/` contains desktop/mobile screenshots, HTTP export and SSE results.
- `baseline/`, `optimized/`, `bounded-synthesis/` preserve comparison runs.

The two final live commands initially exited nonzero because an added test hook
was overwritten by `runTurn`, leaving the *test recorder* empty after successful
publication. This is not counted as a passing command. The recorder now observes
committed receipts. Separate independent audits of those unchanged checkpoints
passed, proving the actual journeys without rerunning actions or altering results.

## Performance measurements and limits

| Comparable SQA fixture | Baseline | Post-fix final |
|---|---:|---:|
| Duration | 174.581 s | 153.468 s |
| Reported tokens | 897,555 | 677,283 |
| Reasoner / classifier calls | 26 / 1 | 23 / 1 |
| Browser actions | 20 | 20 |

That pair observed 24.5% fewer tokens and 12.1% less elapsed time. Two additional
post-fix SQA samples used 705,736 / 790,914 tokens and 149.320 / 199.603 s.
This is a small nondeterministic sample, not a throughput guarantee; control
pass/blocked dispositions varied conservatively with the evidence recorded.
Full regressions also ran concurrently with some samples.

Final SQA/Founder measurements respectively: first browser activity 6.685/6.581 s;
first interaction dispatch 16.685/37.779 s; model latency 140.695/470.399 s;
classifier latency 1.158/1.211 s; sampled Node peak RSS 221.58/248.98 MiB;
Node CPU 4.746/13.370 s. SQA made 240 checkpoint writes totaling 119.04 ms;
Founder made 371 totaling 228.85 ms. Final report persistence was 0.65/1.63 ms
on the local filesystem. Planning-tool persistence was 8/7 ms, **not total model
planning time**, which is not separately observable. Browser-child CPU,
production database latency, load throughput and worker utilization were not measured.
The original harness field `firstCompletedInteractionMs` held dispatch time;
its label is corrected here. Future runs record dispatch and receipt-completion
timestamps separately; the saved originals were not rewritten.

Founder completion improved from failed synthesis to two published reports;
it did not become faster than the shorter failed runs. No total-token savings
claim is valid against those unknown-usage baselines. Synthesis inputs fell from
roughly 38–41K tokens/request to roughly 12–18K in the completed bounded path.
Its approximately 0.8M tokens/8-minute fixture cost is still material. QA's new
sample is slower and uses more tokens than the previous healthy sample
(122.341 s / 266,479 tokens); no QA speedup is claimed here.

## Gateway, regressions and recovery evidence

- All **13** live gateway checks passed at `2026-11-04T16:02:19.329Z`: text,
  usage, streaming, native tools, multiple tools, continuation, structured output,
  image input, cancellation, timeout, native SDK loop, SDK usage, JEV.
  Cancellation/timeout qualify client transport behavior; provider-side billing
  after cancellation is not observable. Unknown usage remains fail-closed.
- Complete regression results are recorded in the final verification addendum
  below. The earlier full rerun passed 2,207 tests with zero failures/skips.
  The first run had 2,206 passes and one stale synthesis-fixture failure;
  correcting its missing execution-state stub added a phase assertion.
- Focused runtime/publication suite: **110 passed**. Redis suite: **8 passed**,
  including a real server restart, readiness loss, recovery and tenant isolation.
- Authentication stress: **38 browser cases passed**, comprising six repetitions
  each of verified, unverified and readable-access cases with immediate and
  300-ms-delayed rendering, plus two cross-origin fixtures. No timeout increase
  or weakened sign-in proof was used.
- PostgreSQL tests used an isolated PostgreSQL 17.6 database and a non-superuser,
  non-BYPASSRLS role. Real transactions, tenant isolation, optimistic locking,
  backend interruption rollback, crashed claiming-process fencing, competing
  lease recovery, checkpoint preservation and cancellation propagation passed.
- Redis 7.4.6 restart qualification used a private disposable instance and
  recovered event delivery in the bounded test. It does not prove Redis-cluster
  failover or durable message replay; persisted run state remains authoritative.
- Real UI browser checks passed launcher authorization/reload, retained run
  route, publication SSE plan synchronization, desktop/mobile render, both
  Founder palettes and all three Markdown/PDF exports, with no page errors.
  Mobile report views fit the viewport. Refresh preserves the run route;
  the user's explicit Results action opens `/results`, as intended.
  UI services were injected; reports were replayed from the separate real runs.

### Mode qualification matrix

| Mode | Depth / selected coverage | Recovery | Performance | Verdict |
|---|---|---|---|---|
| QA | PASS: 11 executable scenarios on defined fixture | Native SDK/browser/host regressions pass; full live distributed matrix BLOCKED | Measured; no speedup claimed | BLOCKED for deployment |
| SQA | PASS: multi-page autonomous assessment; all 30 controls dispositioned; assurance remains blocked | Native SDK/host regressions pass; full live distributed matrix BLOCKED | Measured; high cost | BLOCKED for deployment; opt-in stays disabled |
| Founder | PASS: two complete multi-page reviews; final receipt audit and full schema pass | Draft checkpoint/rollback/cancellation regressions pass; full live distributed matrix BLOCKED | Measured; synthesis is expensive | BLOCKED for deployment; opt-in stays disabled |

### Mandatory fault-matrix boundaries

All modes have regression coverage for model-stop continuation, cancellation,
budget limits, state persistence, tool failures and publication guards. Real
gateway transport tests and real browser fixtures complement deterministic model
fixtures; mocks are not represented as live model-failure tests. Queue/process
recovery is real PostgreSQL process/lease testing, not a whole browser session
migrating between workers. A full per-mode live-model matrix of model interruption,
browser process loss, authenticated worker restart and checkpoint recovery has
**not** been executed. These cells remain BLOCKED, not PASS.

## Remaining deployment blockers and exact next steps

1. **Container infrastructure unavailable:** neither Docker nor Podman is
   installed/on PATH here. Build the reviewed source into the intended production
   image and run `npm run test:production-image -- <image>` in an isolated
   Docker environment. Verify non-root/read-only startup, volumes, authentication
   and all three packaged browser engines.
2. **Actual distributed topology unqualified:** use staging PostgreSQL/Redis/TLS,
   shared snapshot/evidence storage and the intended worker image. Run each
   mode through browser disconnection, model stream loss and worker kill/restart.
   Verify lease fencing, exact usage, no uncertain action replay, no stale
   credentials and one durable report. Do not move these tests to customer data.
3. **No fresh authenticated Studio assessment:** these runs target authorized
   local fixtures. Qualify the current realistic application with a designated
   test tenant and secure credential handoff; no customer-state mutations.
4. **Production load/cost envelope undefined:** agree page/scenario counts,
   concurrency, resource/cost ceilings and acceptable completion latency. Run
   comparable repeated workloads and deployment load/capacity/resilience gates.
   Browser-child CPU and worker saturation remain unmeasured.
5. **Matrix API checks 8–13 remain unverified:** the static matrix checks pass,
   but no staging session cookie was provided for those live API checks.
6. Review the existing pending migration chain (including the prior local 043
   migration), production settings and rollout identity before packaging. No
   production configuration or data was changed by this audit.

## Reproduction and rollback

Use the repository Node 24 toolchain or supported Node 22–24. Logs/evidence are
local, ignored artifacts; do not commit credentials or `.qase` snapshots.

```sh
export PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH"
NODE_ENV=development npm run qualify:hybrid-gateway

NODE_ENV=development QASE_ALLOW_PRIVATE_NETWORK=true \
  QASE_LIVE_SYSTEM_QUALIFICATION=true QASE_SQA_REASONING_ENABLED=true \
  QASE_SYSTEM_QUALIFICATION_OUTPUT=test-results/final-readiness/reproduction \
  node scripts/qualify-system-mode.mjs sqa --deep
# For Founder, replace sqa with founder and enable only QASE_FOUNDER_REASONING_ENABLED.

node scripts/verify-system-mode-evidence.mjs test-results/final-readiness/publication/sqa
node scripts/verify-system-mode-evidence.mjs test-results/final-readiness/final/founder
npm run validate:matrix
```

Full verification additionally sets `QASE_RUN_BROWSER_TESTS=1`,
`QASE_TEST_DATABASE_URL` and `QASE_TEST_CONTROL_DATABASE_URL` to the disposable
`postgresql://qase_phase2_test@127.0.0.1:55432/qase_phase2`,
`QASE_TEST_REDIS_URL=redis://127.0.0.1:56379`, and
`QASE_TEST_REDIS_SERVER=/private/tmp/qase-phase2-infra/redis-7.4.6/src/redis-server`
before `npm run verify`. Never substitute a production URL.

For rollback, leave SQA/Founder reasoning flags false for new sessions. Existing
sessions retain their pinned strategy/protocol/profile and must be completed or
paused under that strategy; do not silently reinterpret them as legacy runs.
The Founder draft is additive state and requires no destructive data rollback.
For deployment, retain the prior approved image/configuration and use the
existing draining/rollback procedure after reviewing database compatibility.

## Final verification addendum

The final `npm run verify` executed **2,208 tests in 31 suites: 2,208 passed,
zero failed, zero cancelled, zero skipped** in **259,915.473 ms**, with browser
fixtures and disposable PostgreSQL/Redis enabled. This supersedes the earlier
2,207-test run after adding the client/server browser metadata regression.
Syntax, ignored-private-state and high-confidence source credential checks passed.

The post-change public suite separately passed **425 tests**. Static matrix
checks 1–7c pass, while live API checks 8–13 are explicitly unverified.
The real UI script passed after correcting its test expectation: an explicit
mobile Results click is supposed to navigate to `/results`; refresh alone is not.
These independent suite totals overlap and must not be added together.

Logs copied to `test-results/final-readiness/verification/` include
`full-suite.log`, `gateway.log`, `redis-recovery.log`, `auth-fast.log`,
`auth-delayed.log`, `focused.log`, `matrix.log` and `public-tests.log`.
Original failed reproduction logs remain under `/private/tmp/qase-final-*`.
No historical failed or uncertain run was relabeled as successful.

The regenerated source manifest verifies **736 files** against SHA-256 under
the existing `qase-2026-10-28-hybrid-production-r5` identity. This inventories
the reviewed working tree; no release was published or production tag advanced.
Disposable PostgreSQL/Redis services were stopped after testing; their local
build/data directories remain for reproduction.
