# Founder live qualification — Phase 5 follow-up

Branch: `integration/founder-sqa-20261107`, based on `b3dbd7f`.
Candidate: `qase-founder-sqa-2026-11-07-progress-r2`, UI `20261107-4`.

## Failure reproduced

The uninterrupted `phase5-live-r5-compact` attempt missed its unchanged
15-minute deadline. Stop settled to `interrupted`, with zero recorded lenses,
zero report sections and cumulative estimates of 276,987 input / 20,691 output
tokens. The credential scan passed. The target was the isolated two-route
practice fixture; no customer application or saved customer run was changed.

The agent repeated the exact Home-to-Help navigation check. The previous
inference checkpoint retained only the four latest checks per page, so later
responsive, accessibility and diagnostic checks displaced the earlier
navigation and form results. The original receipts remained on disk, but their
facts were missing from the next model request. This is an actual context
retention failure, separate from the unexplained long gap in attempt r4.

## Changes

- Retain up to twelve distinct checks per page, including failure and recovery,
  with bounded assertion text. Observed selectors and query-stripped expected
  URLs distinguish navigation checks. The saved fact list remains bounded to
  36 entries and still references actual completed native browser activities.
  Limitations retain their actual bounded text; a string is no longer mistaken
  for an array and truncated to four characters.
- Configured-provider observation schemas enforce titles up to 120 characters
  and summaries up to 600. All seventeen lenses and the original evidence
  validator remain mandatory. Full browser evidence remains saved separately.
- Only fresh configured-provider runs select `sectionBatchSize: 3` under the
  existing `section-draft-v1` protocol. Old configured runs without that option,
  legacy runs and qualified Opus/JEV strategies retain their previous path.
  Unsupported saved batch options are rejected.
- Six successful bounded native report requests assemble the same eleven sections through
  thirteen individual durable writes. Each request contains at most three
  consecutive section fields and at most one recommendation append. Each
  section still uses the original serial writer, evidence validation, durable
  revision and final complete-report validator. No batch publishes a report.
- Each new recommendation receives one unused ID choice in the native schema.
  Existing IDs remain unchanged; a stale or reused choice is rejected before
  any write. The model still authors the recommendation and its evidence.
- Exact input revisions reject stale requests. A failed or cancelled later
  write leaves earlier sections saved; a restored run advertises only its
  remaining fields. The SDK still owns the single model/tool loop. Provider,
  model, approved limits, browser permissions and finalization gates are intact.
- Nested typed objects explicitly forbid extra fields, matching the writer's
  existing validation. Each report group also receives the last three saved
  sections and the actual saved recommendations as bounded strategy context.
  The native SDK boundaries remain unchanged; earlier decisions are no longer
  reduced to section counts and recommendation titles. New batch reports prefer
  concise scalar text and optional lists while retaining all required minima.
- Founder status transitions also use immediate atomic persistence, preserving
  a settled user Stop across a process exit instead of restoring it as crashed
  running work. QA and SQA keep their existing status persistence behavior.

## Acceptance criteria

The live qualification must finish within 900,000 milliseconds and 750,000
cumulative input-token estimates using the existing custom gateway and
`z-ai/glm-5.2`. It must record all seventeen lenses, finish the canonical plan,
publish all eleven sections with three recommendations, survive an immediate
mid-report restart, preserve already saved content and cumulative usage, avoid
replaying browser work after that restart, serve Markdown/PDF before and after
final restart, and refuse another account access. Estimates are not billing
receipts. Credentials must not appear in retained artifacts.

## Verification

The final focused set passes 115 tests, including late receipt retention,
limitation text, exact recommendation IDs, per-section failure/cancellation,
concurrent delivery, unchanged complete-report validation, original strategy
compatibility and the native SDK synthesis boundary. The local store/API set
passes 88 tests with one Windows/POSIX skip; immediate process exit preserves
the section, usage and explicit user Stop state.

`phase5-live-r6-compact` failed its deadline after saving seventeen lenses and
ten of eleven report sections, at 339,196 input / 44,368 output estimates. Its
immediate restart restored the first three sections, retained cumulative usage
and added no browser actions. Two generated recommendation IDs collided with
saved IDs and were correctly rejected, causing expensive retries. That failure
led to the exact unused ID schema above. R6 is not a passing full qualification.

`phase5-live-r7-four-route` also missed the unchanged deadline, at 474,978 input /
46,953 output estimates, with seventeen lenses and four complete sections plus
saved recommendation work. Its immediate restart restored the first three
sections. No repeated recommendation-ID error occurred. A generated nested
`actions_max_3_note` field was correctly rejected by the writer but was not
explicitly forbidden in that nested schema. That finding led to the schema
alignment and retained strategy context above. R7 remains a failed qualification.

## Final local results

| Check | Observed result |
| --- | --- |
| Four-route live qualification, `phase5-live-r8-four-route` | Passed in 14 minutes 18 seconds from harness start through cleanup, within the unchanged 15-minute ceiling. All seventeen lenses, eleven report sections and three recommendations published. |
| Cumulative live usage | 420,423 input / 33,992 output estimates, below the 750,000 input-estimate ceiling. Logs identify only `z-ai/glm-5.2`. No provider/model switch or usage reset. |
| Mid-report restart and recovery API | First three sections restored unchanged; observations and cumulative usage retained. No browser work replayed. Final run had 24 completed browser activities. |
| Exports and final restart | Markdown (48,434 bytes) and PDF (243,378 bytes) served successfully. Published report, draft and usage survived another restart; both exports remained available. |
| Account isolation and target scope | Another account received 404 for the run and exports. Zero HTTP mutations reached the disposable target. Artifact credential scan passed. |
| Full `node scripts/verify.mjs` | 2,400 tests: 2,367 passed, zero failed, 33 optional skips. Syntax, private-path and source credential checks passed. |
| Chromium progress recovery | All seven groups passed, zero page errors and zero model calls: keyboard focus, duplicate controls, failure/retry, reload, mobile layout, secure questions and unverified-usage blocking. |
| Chromium completion and launchers | All eleven completion cases and five Founder/SQA launch groups passed; zero page errors. Controlled API/SSE and injected execution, no live-model calls in these browser cases. |

R8 used seven report requests: six succeeded, and one request with an invalid
risk-list item count was rejected and corrected. That failed request did not
overwrite saved content or publish a partial report. The final assembled report
passed the original complete validator; a text scan found no draft-tool,
checkpoint-parameter or `actions_max_3_note` instructions in its prose. The previous failed live
attempts remain failures; their records have not been rewritten.

Logs: `test-results/integration/phase5-r2-full-verification.log`,
`phase5-batch-final-focused.log`, `phase5-status-api.log`, and
`phase5-r2-{recovery,completion,launch}-browser.log`. The live run's `result.json`,
`interrupted-checkpoint.json`, `session.json`, `report.md` and `report.pdf` remain
under `test-results/integration/phase5-live-r8-four-route/`. Generated artifacts
stay local and are excluded from the source commit.

This completes Phase 5's local controlled qualification. It establishes one full
configured-gateway pass, not an authenticated-product or latency SLA. The next
phase is report navigation and evidence usability.

No release promotion, repository push or production activation is part of this
local qualification milestone. Linux CI, Docker, authenticated products,
distributed ownership and the broader Founder/SQA matrix remain Phase 8 work.
