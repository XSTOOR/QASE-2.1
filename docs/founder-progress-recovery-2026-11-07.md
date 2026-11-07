# Founder progress and recovery — Phase 5

Branch: `integration/founder-sqa-20261107`, based on `b1ee59d`.
Release: `qase-founder-sqa-2026-11-07-progress-r1`, UI `20261107-4`.

## Progress and recovery

The Founder view separates scope, product exploration, evidence recording,
report writing and publication. Counters show evidence-backed review areas,
saved report sections and completed browser actions. A complete plan or model
prose never marks a report published. The sidebar labels its separate counter
as plan steps. The progress controls stay mounted through SSE/evidence updates,
retain keyboard focus, announce phase/count changes and work on mobile. Wrapped
Founder tabs reserve their full row height rather than overlapping content.

GET `/api/sessions/:id/founder/progress` derives progress and a checkpoint token
from owner-scoped saved state. POST `/api/sessions/:id/founder/continue` requires
that exact token. It reuses the run, SDK/browser owner, access/context decisions,
evidence, draft and cumulative usage. It rejects stale tabs, pending questions,
active/uncertain actions, changed evidence/drafts, unverified qualified receipts,
unsupported saved protocols and exhausted approved budgets. Secure input remains
in the existing question/vault flow. Connection problems point to Settings;
blocked recovery offers saved activity. No limit or completion gate is relaxed.

A per-run admission ticket prevents duplicate continuation or competing chat
while initialization is pending. Stop cancels before model dispatch; deletion
cannot resurrect the run. Initialization failures preserve saved work and allow
a fresh explicit retry. These are local admission guarantees; distributed
failover and production ownership qualification remain release work.

Founder commits in the local adapter now write the atomic JSON mirror before
acknowledgement. This includes report sections, investigation facts and usage;
ephemeral browser frames retain their existing behavior. A real immediate
process-exit/reload test preserves the saved section and the latest cumulative
usage without waiting for a debounce or shutdown hook. An obstructed filesystem
must reject the commit before publishing its event.

## Investigation context

New configured-provider Founder runs deduplicate exact SDK context envelopes,
retain recent native tool rounds and two recent screenshots, and send a fresh
host progress checkpoint. A concise execution brief preserves all seventeen
lenses, access decisions, safety rules and the canonical plan, while preferring
bounded native check suites over repeating the same checks manually.
Human requests, native call/result links, pending
calls and recent errors remain available. All original receipts and usage stay
saved. Legacy, bounded JEV and qualified Opus/JEV paths keep their own execution
and accounting contracts.

Actual snapshot text and check/diagnostic outcomes are saved in a bounded,
redacted, versioned investigation checkpoint tied to completed activity IDs.
Per-page facts retain the content needed to record lenses after old transcript
outputs are omitted. Query strings, form value fields and screenshot base64 are not
copied into that checkpoint. Its hash and activity references are checked on
restoration. Saving failures restore the previous checkpoint and surface an
error rather than silently discarding browser facts.

## Verification

| Check | Observed result |
| --- | --- |
| Full `node scripts/verify.mjs` | 2,387 tests: 2,354 passed, zero failed, 33 optional skips. Syntax, private-path and credential checks passed. |
| Runtime/API focused checks | 140 passed before the final durability correction. Includes stale checkpoints, concurrent controls, Stop, failed initialization and deletion races. |
| Final local-store/report/checkpoint checks | 39 passed after the durability correction, including immediate process exit/reload and rejected disk writes. The full suite was not repeated for this adapter-only correction. |
| Final API and native-loop/prompt checks | 60 API tests and 74 native-loop/prompt tests passed after the durability correction. The five prompt cases also passed after restoring the original advice caveat in the shorter brief. |
| Chromium recovery acceptance | Seven groups passed: stable keyboard controls, duplicate prevention, failure/retry, reload, mobile targets/overflow, secure questions and unverified-usage blocking. Zero page errors and zero model calls. Final desktop/mobile screenshots inspected; included in CI. |
| Existing Founder completion browser | All eleven cases passed, zero page errors. |
| Existing mode launcher browser | All five launch groups passed, zero page errors. Real isolated HTTP/SSE, injected transport, zero live model calls. |

Full-suite log: `test-results/integration/phase5-full-verification-r2.log`.
Final affected checks: `phase5-durability.log`,
`phase5-final-api-unrestricted.log` and `phase5-final-contracts.log`. The first
attempt at the final API repeat failed because the Windows sandbox denied
loopback connections; the unrestricted repeat above passed. Browser artifacts:
`test-results/integration/phase5-recovery-browser/`, with final log
`phase5-recovery-browser-final.log`. Generated artifacts remain local.

The first full regression attempt passed 2,352 tests, failed one hybrid SPA
navigation integration case and skipped 33 optional checks. The failed case
passed in isolation. Its owned fixture applied navigation only after an
unrelated asynchronous read; the DOM transition now happens before that read.
Product QA guards and evidence/completion assertions are unchanged. The full
repeat above passed after this fixture correction and the concise Founder brief.

Live tests use the existing custom gateway and `z-ai/glm-5.2`, isolated accounts
and disposable local targets. Every attempt retains the 15-minute deadline and
750,000 cumulative input-estimate ceiling. No provider/model, permission or
completion gate is changed. SDK estimates are not provider billing receipts.

- `phase5-live`: deadline reached, 608,535 input estimates, zero observations.
  Pruning page content without retaining actual facts caused revisits. Bounded
  durable per-page facts were added before the next attempt.
- `phase5-live-r2`: deadline reached, 543,500 input estimates, eight observations.
  Added the shorter execution brief and guidance to batch native checks.
- `phase5-live-r3`: all seventeen lenses recorded and the first report section
  saved at 521,118 input estimates. Immediate restart exposed a real local-store
  debounce gap: that last section and recent usage had not reached disk.
  Qualification failed, the failure artifacts were retained, and the adapter
  correction plus process-exit tests were added. This is not a passing benchmark.

- `phase5-live-r4-compact`: deadline failed before report generation; fifteen
  activities, zero observations, latest saved usage 163,902 input / 5,227 output
  estimates. Logs have no new completed model call between 02:58:15 and
  04:37:14 UTC. The gateway connection then entered its existing retry path.
  These records do not distinguish a stalled request from a suspended local
  environment, so this attempt cannot establish active-run performance or
  validate the live restart flow after the correction. Credential scan passed.

The bounded live restart qualification remains open for both fixture sizes.
The final harness now waits briefly for explicit Stop to settle before saving
failure artifacts and records its fixed limits plus the stopped checkpoint.
It never turns a failed attempt into a pass. Phase 5 implementation and local
acceptance are complete; its live completion/performance gate remains pending.

UI checks follow the accessibility, focus, content-overflow and feedback rules
in the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).
The existing application design tokens are retained.

The next phase covers report navigation/evidence usability. CI/Linux/Node 22,
Docker, broader live access scenarios and production topology remain in the
Phase 8 release matrix. Nothing is promoted or pushed by this local milestone.
