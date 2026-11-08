# Founder actions — Phase 7

Branch: `integration/founder-sqa-20261107`, based on `c81e296`.
Release: `qase-founder-sqa-2026-11-08-actions-r1`; UI: `20261108-2`.

## Selection behavior

Selections belong to an owned published run and its exact report content, not
just recommendation IDs or the report schema version. Reopening an older report
restores that report's selection. A new report with reused IDs starts with an
independent selection. Duplicate finalization does not reset saved actions.

Each write checks the report key and expected action revision. Concurrent edits
have one winner; stale writes return 409 and the UI reloads the saved selection
without automatically overwriting it. A failed save restores the acknowledged
checkbox state, retains the attempted selection in memory and offers an explicit
retry. Pending operations disable conflicting controls while keeping the report
mounted. Late responses cannot replace another report's state or trigger an
unexpected export after navigation.

The original project state remains the last good report summary. Small action
records reference durable run reports instead of duplicating every report.
Legacy selections migrate only when owner, target and complete recommendation
publication match; a legacy action receipt is retained even if a newer report
is published first. Unbound legacy clients can read a summary but must reload
the completed report before writing or sending.

## Persistence and API contract

- `GET /api/founder/state?runId=<owned-run>` returns its immutable source identity,
  action revision, saved selection, matching handoff and delivery capability.
- `PATCH /api/founder/state/selections` requires `runId`, `reviewKey`,
  `expectedRevision` and `selectedRecommendationIds`.
- `POST /api/founder/handoff` uses the same binding. It sends only an acknowledged
  saved selection. `export: true` builds a payload without saving or delivering.
- Missing report bindings and stale revisions return 409. Cross-account run
  lookups return 404. Pilot write restrictions remain in force. Tenant/project
  identity comes from server configuration, never request fields.

Local updates serialize within the single API process, write a private temporary
file and atomically replace the committed state. Failed writes leave the old
file intact. Invalid stored JSON or malformed action history fails closed and
is preserved for recovery. Local mode is not a shared-filesystem distributed
database.

PostgreSQL updates take a transaction-scoped advisory lock for the trusted
organization/project, then read the row with `FOR UPDATE` and commit its new
JSONB state. The advisory lock also protects the first insert. Network delivery
runs outside the transaction. PostgreSQL deployments require migration **044**
before these version 2 actions can be saved. Phase 8's database review found
that migration 040 still allowed only version 1. Migration 044 preserves legacy
rows, accepts version 2 and adds forced tenant row-level security. The initial
Phase 7 statement that no migration was needed was incorrect; local/mock
repository checks had not established compatibility with the real constraint.

The existing 1 MB project-state bound remains. There are at most 500 report
action records and 100 distinct delivery intents per report. Capacity failures
preserve existing work; they never silently evict selections or accepted
receipts. Storage capacity expansion remains an operational consideration.

## Studio handoff behavior

Sending immediately shows a pending state and locks that saved selection. The
server reserves the intent atomically before invoking the existing signed Drytis
client. Concurrent requests cannot start another project handoff. Completion
re-reads the current project state and updates only the reserved attempt, so a
slow response cannot erase another report or newer selection.

The delivery key hashes trusted project, owner, run, report key and ordered
selection; it is not a truncated concatenation of recommendation IDs. Retries
reuse the original timestamp, payload and key, including after changing to
another selection and returning. Accepted intent receipts remain in history.
A completed duplicate returns the original receipt without another delivery.

The UI reports Studio acceptance and its returned job reference; it does not
claim that a build completed. Receipt fields are read from the signed client's
response body. An explicit refusal remains a failure even with HTTP 200.
Transport failure retains the selection and offers explicit retry. A lost client
response first reloads saved status; acceptance clears the transient error.
Pending state survives reload and is polled without automatically re-sending.
Failed status polling offers explicit reload instead of an endless error loop.

A pending lease lasts ten minutes. If a process dies after possible upstream
acceptance, retrying that same intent after expiry reuses the exact original
delivery key/payload. A different unresolved intent blocks another delivery
until reconciliation. Receiver-side idempotency remains part of the external
integration contract; local qualification cannot prove a real Studio receiver
honors it.

Copy and Download requirements are available for the current saved selection.
Clipboard failure leaves Download available. Exports carry the source run,
report key, ordered requirements, evidence references and acceptance criteria.
Nested secret-looking context fields, including objects inside arrays, are
removed. With no Studio integration configured, Send is disabled and export
remains available. No build is implied.

A Founder-specific destination now enables its signing client independently of
the QA results destination. QA ticket delivery still requires its own explicit
target. Existing provider, SDK, browser execution and model limits are unchanged.

## Local qualification

| Check | Result |
| --- | --- |
| Full `node scripts/verify.mjs` | 2,431 tests: **2,398 passed, zero failed, 33 optional skips**. Syntax passed for 662 files; private-path and source credential checks passed. |
| Focused action/controller, reader-state, presentation and factory contracts | 34 passed. |
| API/local-store/PostgreSQL repository contracts | 139 passed, one Windows permission skip. |
| Founder action browser | Eight flow groups plus desktop/mobile target and overflow checks passed. Four controlled signed receiver requests, zero AI calls, page errors or unexpected mutations. |
| Founder reader browser | Nine groups passed with real selection persistence, including reading-anchor restoration across asynchronous feedback. |
| Existing mode browsers | Eleven Founder completion, seven progress and five Founder/SQA launcher groups passed. |
| SQA evidence browser | All four integrity states, two retained versions, restart, historical Markdown/PDF and mobile overflow passed. |

The action flow covers owner/publication binding, reload/run isolation, failed
saves, stale-tab conflicts, clipboard denial/download, immediate sending,
concurrent and completed duplicates, signed retry payload identity, returned job
references, pending reload/polling, restart and unconfigured export fallback.
Desktop and mobile screenshots were visually reviewed. Final UI refinements
and the explicit test-authentication path were checked again in the browser.
The integration account file's fingerprint remained unchanged in that run.
Earlier synthetic test accounts were removed; there were no other accounts in
that integration file. The original Push-SQA application was not involved.

Diagnostics remain local in `test-results/founder-actions/` and
`test-results/integration/phase7-*`.

The action browser uses real account authentication, owned reports, HTTP APIs,
atomic local files and the real HMAC signing client. Its outbound fetch receiver
is controlled in the test process; no external Studio request or AI run occurs.
PostgreSQL locking is checked through repository contracts; a live PostgreSQL
deployment and real Studio receiver still require Phase 8 qualification.
The 33 optional skips retain the existing PostgreSQL/Redis, opt-in integration
and POSIX-permission limitations. Docker is unavailable on this host. Release
inventory and identity are verified again after these notes are finalized.

Asynchronous action feedback can change layout above a reader's position.
Reading preferences now retain a section anchor and offset, keeping the same
content in place as loading/save/delivery feedback changes height. This also
preserves reload position without relying on an unchanged absolute pixel count.

## Next phase

Phase 8 is final qualification and promotion: representative Founder/SQA runs,
authenticated/recovery/provider cases, Linux CI, Docker image checks and the
remaining deployment topology gates. The original `Push-SQA` worktree and data
remain untouched. This milestone is committed locally, without push or
production activation.
