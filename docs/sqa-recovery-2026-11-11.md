# SQA connection recovery — 11 November 2026

## Problem and change

The previous controlled live run saved ten control observations, including six
technical passes, then ended with a provider connection error. Its final usage
was 314,358 input tokens, above the existing 300,000 closeout threshold. The host
checked that threshold after tool results, but a disconnect could prevent the
next tool result from arriving. Restarting also depended on another model call.

`server/agent.js` now shares one validated closeout path across completed tool
results, the start of a resumed turn, and retryable provider interruptions after
usage is flushed. A saved run already at the threshold can publish without a
new model request. The existing finalizer preserves recorded results and marks
pending controls blocked with the actual budget limitation. Neither the 350,000
input-token hard limit nor the evidence-collection limits were increased.

Publication still requires the existing evidence, exploration, authentication,
finding-consistency, persistence and cancellation checks. Rejected closeout
leaves the run interrupted with its validation reason instead of making another
model request at the same threshold. Connection failures below that threshold
retain the existing bounded retry behavior; this change is not a guarantee that
an unavailable gateway can complete every unfinished investigation.

## Saved-run qualification

The repeatable `scripts/qualify-sqa-report-resume.mjs` accepts only a controlled
localhost SQA release-fixture checkpoint and requires a fresh output directory.
It imports the application after changing to isolated storage, registers the
real configured runtime and finalizer, and replaces model dispatch with a
failure sentinel. Original checkpoint bytes are checked unchanged.

The original failed checkpoint recovered successfully:

- All ten original observations, existing findings and browser activities retained.
- No new model calls, browser replay or token usage.
- Final report: seven passes, zero failures and 23 blockers across 30 controls.
- All six technical controls remain passes; 20 previously pending controls are
  conservatively blocked. This does not establish new test coverage.
- All 328,851 estimated tokens retained, including 314,358 input tokens.
- Saved assessment and usage survive checkpoint reload; Markdown and HTML exports
  generated. The report overview rendered without horizontal overflow.
- Configured-credential scan passed. Original user runs and environment file
  were not modified.

Evidence: `test-results/sqa-recovery-20261111/checkpoint-recovery/result.json`,
`checkpoint.json`, `report.md`, `report.html` and `report-preview.png`.

## Validation and remaining work

Focused recovery tests cover usage crossing the threshold during a disconnect,
restart without model dispatch, cancellation, active tools, authentication,
contradictory findings, incomplete qualified exploration and failed persistence.
Related tests cover SQA services and evidence, mode runtime behavior, browser
workflows, finalization and exports. The final focused suite passed 100 tests;
the related suite passed 162, with no failures or skips. Evidence:
`test-results/sqa-recovery-20261111/focused-final.log` and
`related-regression-authorized.log`. This is relevant regression coverage, not a
new full-repository or Linux/Docker qualification.

Initial browser attempts were blocked by sandbox browser-cache discovery and
localhost restrictions. Their failed logs are retained separately; successful
reruns use the installed browser bundles and authorized localhost access.

The fresh live configured-gateway qualification **passed** using the existing
`custom` provider and `z-ai/glm-5.2` model. It took approximately eight minutes
including export and restart checks, within the unchanged nine-minute limit.
Both composed browser workflows ran exactly once, covering all four bounded
smoke actions without standalone input actions. All six technical controls
passed. The full assessment recorded eight passes, zero failures and 22 blockers
across 30 controls, with no unassessed controls. Twelve evidence records,
historical Markdown/PDF exports, restart persistence, cross-account isolation
and hybrid isolation passed. The credential scan passed. Total retained usage:
336,997 input / 26,959 output / 363,956 estimated tokens.

Evidence: `test-results/sqa-recovery-20261111/live-authorized/result.json` and
`live-authorized-driver.log`. This fresh run completed through its ordinary
finalizer; transport-failure recovery is established separately by the retained
failed checkpoint and injected-disconnect tests, not by claiming the fresh run
experienced an outage.

Recovery proves publication of existing evidence; it does not prove all
application journeys were tested or remove missing reviewer evidence. The live
trace also shows an avoidable rejected finalization followed by a plan repair,
so completion efficiency still needs work. Founder completion time, more useful
blocker classification on budget closeout, authenticated application coverage and
new remote release checks remain separate work. This change has not been pushed
or deployed.
