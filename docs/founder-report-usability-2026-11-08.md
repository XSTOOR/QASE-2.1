# Founder report reader — Phase 6

Candidate branch: `integration/founder-sqa-20261107`, based on Phase 5 commit
`aa79a56`. Release: `qase-founder-sqa-2026-11-08-report-r1`; UI: `20261108-1`.

## Reader behavior

Both the Founder and completed Report views offer twelve named sections through
a labeled native selector and explicit Go action. Navigation moves keyboard
focus to the selected heading without changing the run route. Supporting
observation buttons open an accessible dialog; closing it returns focus to the
opening control when that control is still visible in the same run.

Assumption disclosures start expanded and show the full text beside the relevant
claim. Observation confidence is labeled separately from recommendation scores.
An absent observation or receipt is shown as unavailable, never as verified.
Recommendation rows keep their text column on mobile, use readable report text
and retain the application theme. Reader controls have 44px touch targets.

Completed reports remain mounted during ordinary activity, progress, selection
and duplicate publication updates. This preserves native text selection and
keyboard focus. The actual report pane retains its scroll position. Founder and
Report disclosures, section choice and position survive reload and run switches
independently. Browser session storage holds at most twelve preference records,
scoped by owner, run, pane and publication; it contains no report content,
credentials or recommendation selections. Blocked storage falls back to memory.

Selection saves use the existing project-state API. Pending saves retain their
checkbox and focus, expose a saving status and prevent overlapping actions in
the current run. Sending remains an explicit separate action. Cross-version
project selection consistency and Studio delivery reliability remain Phase 7.

## Evidence contract

`GET /api/sessions/:id/founder/evidence/:observationId/:index` is authenticated,
owner-scoped, read-only and `Cache-Control: no-store`. The observation and
one-based index must already be attached to that run. No request body, arbitrary
file lookup, external URL fetch, browser operation or model call is involved.

| State | Meaning |
| --- | --- |
| `verified` | The retained completed browser activity, timestamp, attached summary and internal reference match the original SHA-256 receipt. |
| `mismatch` | Retained activity or evidence metadata changed; no activity is returned as verified. |
| `unavailable` | An activity was pruned or its supported digest is missing. Any legacy activity shown is context only. |
| `external_unverified` | The reference is text only and was not fetched or validated. |
| `redacted` | The original digest matched, but additional current vault redaction changes the delivered copy. |

Existing digest encoding is preserved exactly, including omitted activity fields;
published records are never migrated on read. A fixed historical Phase 5 receipt
guards this compatibility. Current vault values are redacted before delivery.
The dialog uses text nodes for all stored content and ignores late replies after
run switches. Failed lookups retain an inline retry and pending lookups coalesce.

A matching activity receipt does not establish raw page bytes, a screenshot,
customer demand, commercial outcomes or strategic correctness. The UI states
that boundary beside the inspected record. No new screenshot is inferred.

## Local qualification

- Focused evidence, preference, presentation, service and quality checks:
  **40 passed, zero failed**.
- Existing report-draft checks after shared fixture extraction: **20 passed**.
- HTTP API checks: **61 passed**, including no model invocation or run mutation
  during evidence inspection.
- Full `node scripts/verify.mjs`: **2,379 passed, zero failed, 33 optional skips**
  from 2,412 tests. Syntax passed for 656 source files; private-path and source
  credential checks passed. Final touch-target CSS refinements were checked in
  the browser; inference and API code did not change after the full run.
- Reader browser: **nine acceptance groups passed** with both a deterministic
  validated report and the saved Phase 5 live report, with zero page errors,
  unexpected API mutations, external requests or model calls. Each replay made
  one controlled selection save and eight real evidence requests. This includes
  real authentication/owner isolation, focus/text selection, pending saves,
  reload/tab/run state, evidence retry/coalescing, stale replies, unavailable and
  mismatched receipts, inert hostile text and mobile/dark-theme target sizes.
- Existing browser regressions: eleven Founder completion, seven progress and
  five Founder/SQA launcher groups passed, with zero page errors.
- SQA evidence browser: all four integrity states, injection prevention,
  preserved historical versions, restart, Markdown/PDF and mobile overflow
  passed in Chromium, with zero model calls or page errors.

Desktop/mobile screenshots were visually reviewed. Generated diagnostics remain local under
`test-results/founder-reader/` and `test-results/integration/phase6-*`.

The 33 optional skips retain the previous PostgreSQL/Redis, opt-in integration
and POSIX-permission limitations. Release identity, source inventory and private
credential scanning are checked again after documentation is finalized. Linux
and Docker execution remain Phase 8 checks; Docker is unavailable locally.

The browser acceptance script runs an authenticated isolated server with real
evidence HTTP reads and temporary test accounts. Configuration, project selection
writes and SSE are controlled fixtures. It can also replay a completed Founder
session read-only with `--session-file`. It does not repeat live inference.

## Remaining phases

Phase 7 covers project/version-scoped recommendation saves, request ordering and
Studio handoff feedback, retry, duplicate prevention and export fallback.
Phase 8 covers the remaining live/authenticated/provider matrix, Linux and
Docker checks, then promotion to `Push-SQA`. No push or production activation is
part of this local reader milestone. Existing Phase 5 live qualification remains
the inference evidence; this phase changes report reading and evidence access.
