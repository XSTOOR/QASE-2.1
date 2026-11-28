# QA network and runtime diagnostics

Phase 9 adds a bounded, per-run browser event history to the QA report. A QA run can now explain how a verified action, an API response and a missing UI result relate. The run still uses its selected browser, the existing write permissions, the existing finding pipeline and the existing report screen.

## Where to look

Open the report’s **Evidence index** for monitoring status, recent exceptions to normal network behavior and evidence IDs. The structured history is in `report.qaEngine.runtimeDiagnostics.events`. Each request entry is created when the request starts and updated as headers arrive and transfer finishes or fails. The event ID identifies the request through those updates. Redirect hops link to the preceding request. The run and trusted project IDs are on the enclosing record. The page observation session, scenario, activity or explorer step, and interaction IDs appear on individual events when available.

The QA browser attaches the listeners once per page. Its existing settle logic and detector logs consume the same events. Chromium shares a page CDP session between observation, throttling and heap sampling. Playwright supplies the authoritative request, exception and navigation events across browser engines. Chromium CDP can add a source location or initiator when its event matches uniquely. An initiator matched by URL, method and time is labelled as a timing match. [Playwright request events](https://playwright.dev/docs/api/class-request) · [Playwright CDP sessions](https://playwright.dev/docs/api/class-cdpsession)

## What the browser fixtures demonstrated

| User action or observation | Evidence | Recorded outcome |
|---|---|---|
| Click Save | The expected POST returned 200. The required receipt stayed hidden through the configured wait. | UI and Network Mismatch |
| Click Load | The matched API returned 503. The required result stayed hidden. | Verified Network Defect |
| Submit a form | The browser raised a TypeError at the configured application script. The approved post-submit result stayed hidden. | Verified Runtime Defect |
| Load a list | The endpoint returned 200 with valid JSON lacking the required array. The QA engine published one finding with an ID linking to the response event. | API Response Defect |
| Run negative validation | The endpoint returned the approved 422. | Expected Behavior |
| Observe background polling and an optional external service | Polling overlapped a click. A different origin returned 503. | Uncertain attribution remained visible without a confirmed functional bug. |

These are seeded local test cases. The fixture’s 250 ms wait and 1 ms performance threshold deliberately exercise the relevant branches. They are not product defaults.

## Configure an approved expectation

Set `QASE_QA_RUNTIME_DIAGNOSTICS` to a JSON object in the QA server or worker environment. Use the target application's actual origin, action and acceptance criteria. No configuration is needed for passive event capture. Without a configured performance requirement, the monitor records duration without labelling a request slow.

```json
{
  "maxEvents": 1000,
  "publicPaths": ["/orders", "/api/orders"],
  "contracts": [{
    "id": "save-order",
    "origin": "https://staging.example.org",
    "page": "/orders",
    "control": "#save-order",
    "action": "click",
    "method": "POST",
    "endpoint": "/api/orders",
    "statuses": [201],
    "contentType": "application/json",
    "fields": { "id": "string" },
    "visible": "[data-test=order-receipt]",
    "timeoutMs": 3000,
    "severity": "high"
  }]
}
```

The values above illustrate an operator-defined contract. The rule observes an operation the QA runner is already authorized to perform. Use distinct IDs and one UI contract per action. An endpoint-only contract omits the control and UI fields. `expectedText` narrows a visible selector to an exact text result. `values` checks approved top-level JSON scalar values in memory. `destination` checks a same-origin route, including a hash route. `script` and `errorMessage` match a known handler exception. An approved negative status can be recorded without creating a defect. Endpoint-specific `slowMs` overrides `thresholdsMs` keyed by Playwright resource type. Set `enabled` to false to explicitly skip Phase 9 history.

## Completion criteria and verification

| Criterion | Implementation and verification |
|---|---|
| Console errors and warnings | Chromium, Firefox and WebKit fixtures captured them. Consecutive identical console events on the same page and step group with a count. |
| JavaScript exceptions | Chromium captured uncaught handler exceptions and an unhandled rejection. The portable exception path ran in Firefox and WebKit. |
| Requests, responses, failures and HTTP errors | The browser fixture exercised 200, 302, 404, 422, 503, a dropped connection, abort and pending requests. The history preserves response and transfer state separately. |
| Configurable slow-request measurement | The fixture measured an actual delayed POST against its endpoint threshold. Pending requests retain elapsed observation time on page close. |
| Action correlation | The browser fixture joined control, step, method, endpoint, frame and response. Concurrent or previously observed background traffic at the same endpoint can leave the cause inconclusive. |
| Success without the expected DOM update | A 200 with a missing required receipt produced a mismatch. Existing receipt regressions also cover stale confirmations, the wrong reference, and a different submitted value. |
| JavaScript errors affecting functionality | Both click and form-submit fixtures required a matched application exception and a missing approved visible result. |
| Navigation, redirects and resources | The fixture exercised a wrong hash destination, redirect chain, exhausted redirect loop and failed script, style, image and font loads. |
| Data masking | New network history omits headers, query data, payloads and arbitrary console arguments. Unknown paths and messages use run-local keyed fingerprints. Operators may explicitly mark public paths and exact diagnostic messages as safe. Tests check that synthetic private data never enters the diagnostic report. |
| Expected and cancelled requests | Expected 422, abort, background polling and external failure cases were checked. A QASE policy refusal is tracked as a harness event. |
| Diagnostics with evidence | The report publication fixture checked an actual finding, its network event ID, status, category and evidence-index entry after the normal QA engine ran. |
| Project, run and session association | Run history uses QASE's trusted tenant context. Tests cover project and run IDs, two pages, and isolated per-page event attribution. Test case IDs are included when present. |
| Cleanup | Per-page network, console and exception listeners are removed at close. Pending entries are finalized, and bounded response-validation tasks are drained. |
| Applicable tests and limitations | The targeted regression set covers QA browser, report, forms, navigation, responsive menus and privacy. The test scope and remaining qualification are listed below. |
| Existing QA functionality | Existing targeted QA regressions were exercised. Whole-product compatibility and production-load behavior remain unqualified. |

## Scope and operational limits

**Local verification, 27 November 2026.** The final targeted run passed 89 tests across 11 files in 58.9 seconds, with zero failures or skips. This included seven Phase 9 tests, two of which exercised the Firefox and WebKit fallback. The publication fixture intentionally stopped after entry-page review and exercised the normal triage and report path. The broader adaptive end-to-end scenarios whose expectations changed were not executed in this qualification.

Run the same selection from the repository on a machine with the project's Playwright browsers installed.

```shell
node --test --test-concurrency=2 server/qa/runtimeReport.integration.test.js server/qa/runtimeDiagnostics.test.js server/qa/explorerClicks.integration.test.js server/qa/formOutcome.integration.test.js server/qa/formValidation.integration.test.js server/qa/mobileMenu.integration.test.js server/qa/pageReview.integration.test.js server/qa/layoutPrivacy.integration.test.js server/qa/browser.test.js server/qa/qa.test.js server/qa/adaptive.test.js
```

- API validation supports explicit status, MIME type, top-level fields, types and scalar values. JSON body inspection requires an approved same-origin endpoint, a verified size of 1–32,768 bytes and an uncompressed JSON response. Raw payloads are never persisted. Streaming, full OpenAPI/JSON Schema, GraphQL schema validation and body reconstruction are outside this implementation.
- The page observer records ambient requests from login, navigation and other QA activities. The explorer, shared activation helper and instrumented form and interaction detectors supply action scope. Executors that bypass them can supply only page or scenario attribution. The browser alone cannot determine server-side cause, an initiating user for every background request, or the business impact of an optional resource.
- DOM validation uses actual visibility, configured destination and existing mutation timestamps where available. A screenshot ID can be linked when the existing form receipt observer captured one. Browser frames, DOM observations and finding screenshots are subject to the permissions and retention of their existing QASE components.
- A full navigation can invalidate earlier DOM state. An exception from a worker, cross-origin frame or browser extension may lack a usable first-party stack. Logs retain safe location and error-class information. Only approved public diagnostic strings retain their exact wording.
- The default history limit is 1,000 events per run with an operator maximum of 5,000. Overflow or a failed monitor is reported. Checkpoint and final report storage follow the existing run store. The report fixture exercised publication through the QA engine and a test store. Staging storage, retention expiry and sustained load still need qualification.
- The shared branch supplied the browser, DOM inspection, mutation watcher, layout/accessibility checks, interaction executors, form receipts and reporting used here. Independently developed phase packages outside that checkout have not been integration-tested.

## Files

| Group | Paths relative to the repository |
|---|---|
| New engine and policy | `server/qa/runtimeDiagnostics.js`, `server/qa/runtimePolicy.js` |
| New tests | `server/qa/runtimeDiagnostics.test.js`, `server/qa/runtimeReport.integration.test.js` |
| Browser and action integration | `server/qa/browser.js`, `server/qa/executors.js`, `server/qa/explorer.js`, `server/qa/detectors/forms.js`, `server/qa/detectors/interactions.js` |
| Detection, reporting and coverage | `server/qa/detectors/page.js`, `server/qa/engine.js`, `server/qa/report.js`, `server/qa/capabilities.js` |
| Updated existing regression expectations | `server/qa/adaptive.integration.test.js` |
| Implementation and qualification record | `docs/qa-runtime-diagnostics.md` |

The working copy also contained earlier layout-privacy changes in `detectors/page.js`, `detectors/pageAudit.js` and `layoutPrivacy.integration.test.js` under `server/qa`.
