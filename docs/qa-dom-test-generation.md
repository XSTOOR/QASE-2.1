# QA test case generation from DOM evidence

## What was verified

On November 28, 2026, the configured Drytis gateway returned HTTP 200 for one model request using `z-ai/glm-5.2`. The input came from Chromium inspecting one required email field on a disposable local page. QASE validated and stored these two model selections in the temporary Test Cases store.

| Case in the diagnostic | Input | Expected browser result | Source | Initial state |
|---|---|---|---|---|
| TC-0001 · Well-formed email | `qa@example.test` | `validity.typeMismatch` is false | Application Constraint | Pending Review |
| TC-0002 · Empty required field | Empty string | `validity.valueMissing` is true | Application Constraint | Pending Review |

The repeatable regression suite uses a controlled model response so tests exercise the same choices every time. Chromium, the local HTTP form, its POST handler, validation messages, receipt, Test Cases UI and REST review endpoint are real. The fixture generated 27 cases across two batches with a test-only limit of 50. Repeating generation found 27 exact duplicates and inserted zero records. A controlled response with an unsupported scenario ID or output field produced a validation issue. A simulated timeout produced a failed generation status.

**161 targeted tests passed, with zero failures or skips.** The suite covered QA case management, browser replay, the matrix launcher, runtime diagnostics, review APIs, local storage and PostgreSQL repository contracts. PostgreSQL tests used scripted database clients. A live PostgreSQL migration and a full staging rollout remain to be verified.

## How the feature works

1. The existing QA page observer collects visible controls and native constraints. It verifies that both the CSS selector and XPath resolve to the same element. Each captured case refers to a run, page, snapshot, element fingerprint and revision.
2. After report publication, QASE builds candidate checks from that evidence. It offers the configured reasoner a bounded list from which it can select scenarios and priorities. The model cannot supply its own selectors or executable steps. Without an available reasoner, the stored method reads **DOM rules**. A failed model response is recorded.
3. QASE compares candidates against the project’s Test Cases. Exact repeats are skipped. A normalized title, common QA synonyms, element identity and objective distinguish possible duplicates from related checks. Reviewers can see the matching case numbers.
4. In **Test Cases**, expand the case and choose **View source inspection** to see the captured element and related controls. The details show the expectation, evidence source, confidence, review state, generation method and model. Editing retains the original draft and requires a new review.
5. Owners and admins can approve or reject a draft. The execution service checks role, approval, version and stale status. A changed procedure or business expectation requires a matching executable assertion before the case can be marked **Ready for Execution**.
6. The QA engine opens the approved source URL and rechecks the control. A supported case publishes its observed pass, failure or coverage gap. A pending write saved in a run checkpoint is reported as inconclusive after interruption. A verified form workflow requires one authorized staging submission and a newly visible receipt matched to the response.

## Operational settings

| Setting | Meaning |
|---|---|
| `QASE_AUTOGEN_TESTCASES` | Existing generation switch. Enabled by default. |
| `QASE_AUTOGEN_MAX_CASES` | Default 5 new cases per run. Configurable up to 20. |
| `QASE_AUTOGEN_DOM_BATCH_SIZE` | Default 16 candidate checks per model batch, maximum 32. Generation inspects at most 8 batches. |
| `QASE_AUTOGEN_PUBLIC_PATHS` | Comma-separated additional public paths approved for capture. Use literal paths with no private identifiers. |
| `QASE_DOM_CASE_WRITE_ORIGINS` | Comma-separated exact staging origins for replaying a verified form submission. The operator must also select an assigned environment and enable test writes for that individual run. |
| `QASE_AUTOGEN_TIMEOUT_MS` | Timeout for a model batch. The reasoner's call and token limits also apply. |

Deploy migration `046_dom_case_generation.sql` before enabling the updated server against PostgreSQL. Local JSON storage supports a single QASE application process. Distributed operation uses PostgreSQL. Older report-only runs continue to use their existing generation path. The Phase 10 evidence and approval guarantees apply to DOM-generated records.

## Completion criteria

| Criterion | Result |
|---|---|
| Structured inspection reaches the configured AI agent | Verified with the live Drytis gateway and a Chromium-inspected page. |
| Identify relevant elements and relationships | Verified on two forms with distinct controls, a link, selectable inputs and a disclosure. |
| Positive, negative, boundary, validation, edge and functional generation | All six categories appeared in the fixture. Numeric and length boundaries, a digit pattern and Unicode text were exercised. |
| Individual and workflow cases | Verified native predicates, a two-page navigation and a same-origin form with validation, correction and a response-backed receipt. |
| Evidence source for expected results | The case records the observed behavior, application constraint, inference or missing expectation. Reviewed expectations can be carried forward from a matching test specification. |
| Visibly distinguish inference from confirmed requirements | The expandable case shows the classification and confidence. The original suggestion survives review. |
| Unique test case identifiers | Existing TC numbering, same-process concurrency regression, PostgreSQL project lock and unique index. Live multi-worker database verification remains open. |
| Detect duplicates | Exact repeats, possible paraphrases and related checks covered. A possible duplicate stays visible for human comparison. |
| Source URL and evidence on each case | Source inspection drill-down exercised through the browser and HTTP API. |
| Valid selectors | Both locators checked during capture. Execution checks the live control revision again. |
| Review, edit, approve and reject | Covered through the service and browser review workflow. |
| Prevent unapproved execution | Covered in the shared launcher and focused replay logic. A changed or removed control produces a gap. |
| Protect sensitive information | The fixture’s password value and private label were absent from stored case evidence and the model input. Only selected structural attributes, approved names, synthetic data and public paths are used. |
| Use the existing QA workflows | Existing Test Cases editor, case IDs, report event, launch services, QA engine and findings are reused. Project-wide suite or external requirements-system integrations were outside the verified paths. |
| Preserve existing cases and project data | The fixture's pre-existing manual case was identical after generation and review. |
| Applicable tests pass and limitations recorded | 161 targeted tests passed. Live database and staging checks remain open. |
| Existing QASE functionality remains unaffected | The selected regression suites passed. This is a QA-scoped result. |

## Coverage limits

- Collection is bounded to eight retained pages, the first 160 candidate controls per page and 512 KB of retained inspection data. Partial coverage is recorded. Private paths, cross-frame controls and shadow-root internals are excluded. A closed shadow root may be undetectable.
- The replay supports a same-origin POST form with one empty required text, email or textarea field, one submit control and an observable receipt. Complex registration, payment, arbitrary file uploads and multi-form transactions need additional approved assertions.
- Arbitrary validation patterns, external PRDs, full business-process specifications and prose API contracts require human interpretation. A match on a title alone cannot establish a business requirement.
- Positional selectors can become stale after DOM reordering. Some controls with identical structure and redacted labels cannot be distinguished. A possible semantic duplicate is a heuristic match.
- The live gateway check demonstrated generation on a synthetic email field. The larger workflow, approval and replay checks used a local fixture. External application coverage and production performance require separate measurements.

## Files for this phase

| Area | Files |
|---|---|
| Inspection and evidence | `server/qa/domCaseEvidence.js`, `server/qa/appGraph.js`, `server/qa/report.js` |
| Scenario generation and model integration | `server/domCaseGenerator.js`, `server/testCaseAutogen.js`, `server/serviceFactory.js` |
| Review, storage and permissions | `server/testCaseService.js`, `server/testCaseApi.js`, `server/postgres/testCaseRepository.js`, `server/postgres/migrations/046_dom_case_generation.sql` |
| Run launch, execution and persistence | `server/app.js`, `server/matrixApi.js`, `server/matrixService.js`, `server/qa/engine.js`, `server/qa/domCaseReplay.js`, `server/hybridPersistence.js` |
| Review UI and launch form | `public/testCaseView.js`, `public/app.js` |
| Verification and handoff | `server/domCaseGeneration.integration.test.js`, `docs/qa-dom-test-generation.md` |

Run `node --test server/domCaseGeneration.integration.test.js` from the checkout for the focused Chromium regression. It starts a disposable HTTP server and uses temporary case storage.
