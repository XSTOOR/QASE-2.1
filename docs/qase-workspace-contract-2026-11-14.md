# QASE workspace contract

14 November 2026 · Phase 1 · Implementation reference for the launcher, live workspace and results.

Build on the existing run routes, session snapshot and evidence endpoint. The first redesigned workspace uses hybrid QA. SQA and Founder keep their mode-specific readers and share the workspace shell where appropriate.

## Screen and field mapping

| Screen or region | Source | Display behavior |
| --- | --- | --- |
| Launcher | `#/runs/new`, existing QA catalog, `GET /api/qa-configurations`, `POST /api/sessions` and the existing kickoff flow in `public/app.js` | Show target URL, expected behavior or goal, mode and selected supported browser/device. Keep advanced configuration accessible. Show validation and qualification beside the affected inputs. Show a launch error with the submitted inputs intact when creation or kickoff fails. |
| Run header | `GET /api/sessions/:id`, `status`, `statusDetail`, existing timing fields and `serverNow`, `environmentSnapshot`, `runtimeFacts` | Show target, mode, lifecycle, elapsed active time and available actions. Identify the selected profile and actual execution engine separately. Use `runtimeFacts.brandedBinary` for a branded claim only when it confirms the binary was used. A profile selection alone describes intended coverage. |
| Journey | `GET /api/sessions/:id/qa-evidence`, `currentScenarioId`, `scenarios[].{id,category,objective,status,route,targets}` | Show scenario order in the live view. Identify the current scenario by ID. Preserve the user's selection by scenario ID across updates. When selection disappears, choose the current visible scenario or the first applicable row. |
| Step details | `scenarios[].{expectation,passed,failed,assertions,gaps,incompleteRoutes,absent}` | Show the objective, applicable expectation and verified counts. The step can show a failed assertion and coverage gaps together. Explain the gap when checks could not reach a result. |
| Assertion | `assertions[].{id,name,outcome,expected,actual,authority,reference,capturedAt,source,destination,control,httpStatus,findingId}` | Show Expected and Observed with the assertion result. The receipt uses `reference` and `capturedAt`. Open the matching finding only when `findingId` is present. |
| Browser preview | `frame` from the run snapshot or `frame` stream events with `ts`, `viewport` and image data | Show the latest frame for the current run. Identify last received frames when reconnecting or paused. Use the existing selected-device preview behavior during responsive samples. |
| Saved screenshot | `GET /api/sessions/:id/artifacts` then `GET /api/sessions/:id/artifacts/:artifactId`, artifact `type`, `capturedAt`, `label` and execution metadata | Label the final capture **Saved browser screenshot**. It belongs to the run. A specific assertion can claim a screenshot only when a durable assertion-to-artifact link exists. If the image is unavailable, show the verified assertion and receipt if present. |
| Results | `#/runs/:id/results`, `report.verdict`, `report.notCovered`, `findings[]`, same bounded evidence projection | Lead with the outcome and a confirmed finding where one exists. Reuse the scenario and assertion rows. Explain missing or blocked coverage, and preserve the existing report export. |
| SQA | `session.sqa.assessment`, `public/sqaReportModel.js`, `public/sqaPresentation.js` and existing versioned evidence routes | Use `technicalSummary` for browser checks. Show evidence requests with control ID and owner. Keep review status and publication tied to the assessment's version. |
| Founder | `session.founder`, `founderProgress`, `public/founderPresentation.js`, existing evidence routes and `public/founderActions.js` | Show observations, their evidence, recommendations and assumptions. Display Studio delivery from saved handoff state. Offer export when delivery is unconfigured. |

The QA evidence endpoint is a bounded projection of the existing ledger. Counts include all verified assertions in the scenario. Displayed rows are capped at 12, with failures prioritized, and discovery previews at 24. Use the counts to report totals and disclose when the visible rows are a subset. Prefer this projection for results. It checks receipt integrity, run and action associations, and tool authority, and applies redaction and excerpts. The response is scoped to the requested run through the existing access boundary. The browser can display what the server verified without independently inspecting raw receipts.

The projection currently supplies approved expectation text but omits the underlying `scenario.expected.source` code. It also omits an assertion-specific screenshot ID. In Phase 2, use the generic **Expected** label and the available authority/receipt details. Showing a specific requirement provenance or an assertion-linked image would require an explicit projected field backed by a saved record.

## Lifecycle and evidence states

| Condition | Workspace state | Action or detail |
| --- | --- | --- |
| Empty workspace or new launch | Start a test | Provide URL, goal and browser profile |
| `idle` or `queued` | Ready or queued | Show the corresponding launch state and available actions |
| `running`, evidence pending | Running, loading saved evidence | Show the run header while waiting for evidence |
| `running`, evidence available | Running, with current scenario | Retain earlier checks and allow Stop |
| `awaiting_input` | Waiting for you | Open the existing question flow |
| `paused` or `interrupted` | Paused, saved progress available | Show pause reason and existing Resume eligibility. An unfinished active scenario displays Interrupted. |
| `done`, verified fail with gaps | Failed with coverage gaps | Open finding and show remaining coverage |
| `done`, `partial` verdict | Completed with gaps | Review executed and untested coverage |
| `done`, `blocked` verdict | Blocked | Show the prerequisite or missing evidence |
| `done`, `pass` verdict | Complete with passing results | Show the covered scope and evidence |
| `error` or `cancelled` | Needs attention or cancelled | Show saved progress and the appropriate recovery action |
| Evidence request failed | Retry evidence | Keep the last verified view if available, with a refresh notice |
| Evidence loads with zero scenarios | No scenarios recorded | Show the run context and applicable activity or report |
| Historical run has no hybrid ledger | Existing legacy results | Use the legacy reader and existing export route |

`public/runPresentation.js` supplies run labels and the shared `qaScenarioDisposition` used by the live and results evidence views. A scenario with verified failures shows Failed. A saved pass/fail status without supporting verified assertions shows Inconclusive. An otherwise passing scenario with incomplete routes or recorded gaps shows Partial. `absent` describes the sampled pages. `not_executed` describes untested work. A finding count and a run's lifecycle status alone cannot establish an assertion outcome. Use `workflowStatus` and existing handlers for recovery eligibility.

## Updates and screen arrangement

- Initial load and reconnect use the existing `GET /api/sessions/:id` snapshot and `EventSource` connection. The client checks that a response still belongs to the active run. When stream events arrive during resync, it retries the snapshot instead of overwriting those events. Reuse this path in Phase 2.
- The evidence reader refreshes from its endpoint after snapshot, checkpoint, report, finding and status changes. Coalesce fetches through `createQaEvidenceWorkspace` and preserve expanded controls, scroll and focus. A run switch clears the previous run's evidence and invalidates late responses. The client revision counter guards the snapshot race. It is not a durable event sequence or a replay guarantee.
- Apply `frame` events to the preview. Apply `execution_facts` and `qa.viewport` to environment labels. Keep assertion state tied to saved evidence. Use captured times from the records. If a time is missing, display that it is unavailable.

```text
Desktop launcher                       Mobile launcher
Target URL                             Target URL
Goal or expected result                Goal or expected result
Mode                  Browser/device   Mode
Advanced                               Browser/device
Validation            Start test       Advanced / validation / Start test

Desktop run                            Mobile run
Target / browser / state / actions     Target / browser / state / actions
Journey | Browser preview | Step       Journey / Preview / Step
        | Live or saved   | Expected   Selected view and its details
        | Captured time   | Observed   Finding link and evidence disclosure
        |                 | Evidence   Activity and coverage when opened
Results / Findings / Coverage / Activity
```

Use the existing preview controls, visible keyboard focus and reduced-motion behavior. A report is useful without an image. In the small-screen view the selected step's status and evidence action should stay close to its expected and observed results.

## Representative payloads and implementation handoff

Phase 0 generated controlled Chromium and Firefox runs for **Home → Solutions → Pricing**, with expected text “Plans and pricing”. The Phase 1 payload samples are in `test-results/redesign/phase-1/contract-samples.json`. They exercise the bounded projection and the same presentation functions used by the UI.

| Record | Run label | Content scenario | Evidence behavior |
| --- | --- | --- | --- |
| Healthy fixture with optional coverage gaps | Completed with gaps | Passed | Verified pricing assertion is available |
| HTTP 200 with wrong pricing copy | Failed with coverage gaps | Failed | Expected and observed text plus receipt and linked finding |
| Interrupted fixture | Paused | Interrupted | Content remains unfinished, with its recorded gaps |
| Same checkpoint displayed as paused | Paused lifecycle in workspace | Interrupted | Completed checks keep their verified outcomes |
| All content receipts unavailable in the defective fixture | Previously saved report outcome remains visible | Inconclusive | Current projection excludes unverifiable assertions and reports the missing receipts |
| Historical QA run without hybrid mode | Existing lifecycle presentation | Legacy reader | No new evidence projection required |

For Phase 2, start by moving the existing journey and receipt rendering into the desktop/mobile arrangement above. Keep the current endpoints and route identities. Verify launch validation, switching runs, reconnect, and an evidence fetch failure before considering the workspace integrated. A model-backed run through the new flow is the subsequent integration milestone.
