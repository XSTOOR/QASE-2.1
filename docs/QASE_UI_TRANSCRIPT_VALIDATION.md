# Qase UI live deployment validation

## Audit record

| Item | Value |
| --- | --- |
| Deployment | `https://qase-2-1-vbvclu.drytis.dev/` |
| Repository branch | `PUSHKAR` |
| Final deployed build identified | `2e4fcb932a70747802f255f85e84d7bfe5192bff` |
| Package version | `0.1.0` in the repository; no version or commit is visible in the UI |
| Test window | 6 October 2026, 19:57–20:45 IST |
| Browser | Playwright Chromium, clean contexts |
| Viewports | 360, 390, 768, 1280, and 1440 px |
| Themes | Light, Dark, and System |
| Test account | Disposable audit account with isolated test data |
| Safe target | The deployment's own `/demo` practice application |

This was a browser-first audit. Source code was inspected only to map entry points and identify the deployed build. A feature received `PASS` only when its rendered behavior was exercised. No product fix was implemented during this audit.

The deployment changed during the audit. At 19:57–20:07 IST the served UI assets matched commit `327fbf2`; by 20:44 IST they matched `2e4fcb9`. Twelve cache-busted reads then consistently returned `2e4fcb9`. The final static and responsive results below use `2e4fcb9`. The real run began during the rollout and is retained as lifecycle evidence.

Exact asset fingerprints:

| Build | `index.html` | `app.js` | `studio-workspace.css` |
| --- | --- | --- | --- |
| Initially served, `327fbf2` | `476363166dbd` | `23b92263d87d` | `ae0261bfcf6a` |
| Finally served, `2e4fcb9` | `a08666a5b06f` | `e1a90eed86ef` | `1143d8659d92` |

Hashes are the first 12 characters of SHA-256 over the served files.

## Executive result

The current build has a strong standard QA launcher, a simplified Quality review, reliable themes, usable narrow layouts, accessible preview controls, readable findings, and correct bulk selection. A safe demo run did not reach completion within ten minutes, and Stop did not settle into an explicit `stopped` state. That blocked validation of completed-report behavior, feedback delivery, and the full end-to-end journey. Founder Mode still presents technical setup before a nontechnical founder can reach recommendations.

**Demo readiness: NOT READY.** The interface is visually close, but the core run must complete predictably and Stop must provide a truthful terminal state before a live demonstration.

## Evidence index

Evidence is preserved locally under `test-results/live-ui-audit-2026-10-06/`.

| Evidence | What it shows |
| --- | --- |
| `01-initial-1440-light.png` | Public sign-in and technical terminal-style entry |
| `05-qa-launcher-default-1440.png` | Current default QA launcher |
| `06-qa-launcher-advanced-1440.png` | Technical QA choices inside Customize |
| `07-quality-launcher-1440.png` | Current simplified Quality review |
| `08-founder-launcher-1440.png` | Current Founder launcher |
| `10-qa-launcher-360.png` | QA launcher at 360 px |
| `11-quality-launcher-360.png` | Quality launcher at 360 px |
| `11-founder-launcher-360.png` | Founder launcher at 360 px |
| `14-stop-run-starting.png` | Real run starting/running state |
| `15-stop-pending.png` | Stop pending and disabled after one request |
| `16-stop-final.png` | Stop did not produce a clear terminal result during the recovery window |
| `complete-run-running.png` | Demo run after ten minutes: 3/14 steps and live findings |
| `18-complete-run-timeout.png` | Completion window expired while the run remained active |
| `24-live-findings.png` | Results-first list with eight selected findings |
| `25-live-finding-open.png` | Finding detail, evidence, and collapsed fix instructions |
| `26-report-while-running.png` | Final report unavailable because the run did not finish |
| `27-two-findings-selected.png` | Exact two-of-eight selection before copy |
| `static-audit.json` | Navigation, themes, launchers, responsive measurements, and accessibility checks |
| `run-audit.json` | Lifecycle timeline and request record |
| `selection-audit.json` | Individual, all, none, and two-item copy behavior |
| `keyboard-audit.json` | Keyboard preview controls and dialog focus return |
| `launcher-selection-audit.json` | QA Select all and Deselect all behavior |

## Transcript compliance matrix

| ID | Requirement | Status | Evidence | Issue | Recommendation |
|----|-------------|--------|----------|-------|----------------|
| UI-001 | Studio-native workspace | PARTIAL | Authenticated workspace uses compact navigation, consistent controls, quiet surfaces, and a results-focused right pane. `12-workspace-authenticated-1440.png`. | The public sign-in still leads with terminal/command decoration, and Founder exposes technical setup. | Align the entry screen and Founder flow with the authenticated Studio visual language. |
| UI-002 | Simple customer launcher | PASS | Target URL is first, recommended checks are summarized, and Start testing is primary. `05-qa-launcher-default-1440.png`. | None confirmed in the current build. | Keep this hierarchy. |
| UI-003 | Technical controls moved to Advanced | PARTIAL | QA and Quality hide devices, browser versions, standards, and scope details under Customize/Advanced. `06-qa-launcher-advanced-1440.png`, `07-quality-launcher-1440.png`. | Founder shows release, environment, device, and the BrowserStack matrix in the default flow. | Apply the same recommended/advanced pattern to Founder. |
| UI-004 | Select All / Run experience | PASS | QA began with `12 of 12 selected`; Deselect all produced `0 of 12` and disabled Start; Select all restored `12 of 12`. `launcher-selection-audit.json`. | None confirmed. | Preserve exact counts and disabled zero-selection state. |
| UI-005 | Understandable running state | PARTIAL | Running chip, elapsed timer, plan progress, current activity, live preview, findings count, and Stop were visible. `complete-run-running.png`. | Only running and stopping were reached; starting, waiting, reconnecting, failed, and completed could not all be exercised. Estimated usage reached about 2.98 million tokens and competed with task progress. | Re-test every lifecycle state and constrain or explain anomalous estimated usage. |
| UI-006 | Reliable Stop/recovery | FAIL | One Stop POST was sent; the button changed to disabled `Stopping…`. The API then remained `idle` during the 90-second terminal-state check rather than reporting `stopped`, and no retry/recovery action appeared. `15-stop-pending.png`, `run-audit.json`. | Stop does not settle into a truthful explicit terminal state. | Persist `stop_requested`, acknowledge `stopped`, and show retry when acknowledgement fails. |
| UI-007 | Results-first completed state | PARTIAL | After cleanup, the ended run showed Findings as the dominant pane, secondary conversation context, and a minimized saved preview. `24-live-findings.png`. | No run reached `completed`; automatic completed-run tab selection was therefore not validated. | Repeat against one completed run with findings and one clean run. |
| UI-008 | Preview becomes thumbnail | PASS | Ended run displayed a compact saved-preview strip; keyboard Enter restored it and the labelled control minimized it again. `24-live-findings.png`, `keyboard-audit.json`. | None confirmed. | Keep the thumbnail and keyboard behavior. |
| UI-009 | No old-style Collapse UX | PASS | Controls exposed `Show live preview` and `Minimize live preview`; no large `Collapse` action was present. `keyboard-audit.json`. | None confirmed. | Keep icon labels and tooltips synchronized. |
| UI-010 | Findings readable | PASS | Cards lead with title and severity; opening one reveals page/category, steps, expected, actual, and evidence. `25-live-finding-open.png`. | None confirmed for the eight-item result. | Test very long and 100+ finding sets later. |
| UI-011 | Evidence accessible | PASS | The opened finding displayed browser/network evidence separately from fix instructions. `25-live-finding-open.png`. | None confirmed. | Preserve plain-language evidence before implementation guidance. |
| UI-012 | Bulk finding selection | PASS | All eight were initially selected; none/all/individual/two-item states were exercised. `selection-audit.json`. | None confirmed. | Keep selection scoped to the visible result set label. |
| UI-013 | Exact selected count | PASS | Counts changed `8 of 8` → `0 of 8` → `8 of 8` → `7 of 8` → `2 of 8`. `selection-audit.json`. | None confirmed. | Keep the live count announcement. |
| UI-014 | Clear next action | PASS | `Copy selected fixes` disabled at zero; copying two produced a payload containing the first two titles and excluding the third. `selection-audit.json`, `27-two-findings-selected.png`. | Board delivery and Send to Studio were not available for this run. | Keep unavailable integration actions hidden or explicitly disabled. |
| UI-015 | Feedback reaches human workflow | INCONCLUSIVE | The report stated that it is published only after the run finishes. `26-report-while-running.png`. | No run reached a terminal report, so feedback submission and the owner/admin review destination could not be exercised. | Validate submit confirmation and the human review inbox with a completed run and an authorized reviewer account. |
| UI-016 | Founder Mode — what to improve | INCONCLUSIVE | Optional Ideas entry and Founder launcher were rendered. `08-founder-launcher-1440.png`. | No Founder review was run to completion; recommendations cannot be judged from launcher presence. | Complete a real Founder review after simplifying its launcher. |
| UI-017 | Founder Mode — what to build next | INCONCLUSIVE | Same Founder launcher evidence. | No recommendation output was produced. | Verify build recommendations with evidence and truthful integration states. |
| UI-018 | Founder Mode — why it matters | INCONCLUSIVE | Same Founder launcher evidence. | No benefit/opportunity explanation was produced. | Require each recommendation to show benefit and evidence/confidence. |
| UI-019 | Founder Mode — prioritization/order | INCONCLUSIVE | Same Founder launcher evidence. | No ordered recommendation result was produced. | Verify priority, effort, and order after a completed Founder review. |
| UI-020 | Quality review simplified | PASS | Current build requires only URL and authorization; recommended baseline is first; About and Advanced are closed by default. `07-quality-launcher-1440.png`, `11-quality-launcher-360.png`. | Finalized Quality results were not exercised. | Keep the launcher and validate one completed Quality result separately. |
| UI-021 | Responsive 360 px | PASS | QA, Quality, and Founder dialogs fit 334 px without horizontal overflow; primary controls remained reachable. `10-qa-launcher-360.png`, `11-quality-launcher-360.png`, `11-founder-launcher-360.png`. | Founder remains long and technically dense despite fitting. | Simplify Founder content; retain current sizing. |
| UI-022 | Responsive tablet | PASS | At 768 px the dialog measured 598 px with no horizontal overflow and visible primary actions. `10-qa-launcher-768.png`, `static-audit.json`. | Result screens at tablet width were not available after a true completion. | Add one completed-result tablet capture. |
| UI-023 | Responsive desktop | PASS | 1280 and 1440 layouts had no horizontal page overflow; workspace content retained priority. `03-workspace-1440-light.png`, `10-qa-launcher-1280.png`. | Exact hosted Studio panel width was unavailable. | Re-run at the agreed embedded width when Studio exposes it. |
| UI-024 | Theme behavior | PASS | Dark applied native color scheme; manual Dark survived reload; System followed live dark/light emulation. `04-workspace-1440-dark.png`, `static-audit.json`. | No full contrast certification was attempted. | Keep automated theme regression coverage. |
| UI-025 | Keyboard usability | PASS | Enter opened QA, URL received focus, Escape returned focus to `new-run`; saved preview show/minimize worked from the keyboard with correct ARIA state. `keyboard-audit.json`. | Full screen-reader testing was outside scope. | Add manual screen-reader review later. |
| UI-026 | Main E2E journey | INCONCLUSIVE | Target review, run start, live progress, findings, bulk selection, and selected-copy action were exercised. | The safe demo run did not finish within ten minutes, so completed Report, follow-ups, and feedback could not be reached. | Fix run completion/timeout behavior and repeat the complete nontechnical journey. |

## Defect report

### QASE-UI-001

**Title:** Stop does not settle into an explicit stopped state or recovery path  
**Severity:** P1  
**Requirement:** UI-006 Reliable Stop/recovery  
**Environment:** Deployed Qase, Chromium, audit session `52cb7ec6-4477-45db-a12e-eed4720abc19`  
**Viewport:** 1440 × 1000  
**Precondition:** A safe single-browser demo run has started.  
**Steps to reproduce:**

1. Start the `/demo` run.
2. Click Stop once.
3. Observe the disabled `Stopping…` state.
4. Poll the authoritative session for 90 seconds and reload.

**Expected:** Exactly one request is sent; UI remains pending until acknowledgement; session becomes explicitly `stopped`, or a failure with retry is shown.  
**Actual:** Exactly one POST was sent and duplicate input was blocked, but the session exposed `idle` rather than `stopped`; no stop failure or retry path appeared.  
**Evidence:** `15-stop-pending.png`, `16-stop-final.png`, `run-audit.json`  
**Screenshot:** `test-results/live-ui-audit-2026-10-06/15-stop-pending.png`  
**Console/network evidence:** One `POST /api/sessions/52cb7ec6-4477-45db-a12e-eed4720abc19/stop`; subsequent GETs never returned `stopped` during the audit window.  
**Reproducible:** YES — both cleanup requests ended with the sessions later represented as `idle`.

### QASE-UI-002

**Title:** Safe demo run does not complete within ten minutes, blocking the primary journey  
**Severity:** P1  
**Requirement:** UI-005, UI-007, UI-015, UI-026  
**Environment:** Deployed Qase, Chromium, audit session `c4785dc0-a00c-4cb6-af9f-60ff0d45ac44`  
**Viewport:** 1440 × 1000  
**Precondition:** One-browser `/demo` run with recommended checks and authorization.  
**Steps to reproduce:**

1. Use Try the demo site.
2. Keep Chromium as the only browser.
3. Start testing.
4. Wait ten minutes while observing the authoritative session.

**Expected:** The practice run completes or presents a clear timeout/failure and recovery action.  
**Actual:** The run remained `running`, reached only 3 of 14 plan items, accumulated eight findings and about 2.98 million estimated tokens, and never published a report. It required manual cleanup.  
**Evidence:** `complete-run-running.png`, `18-complete-run-timeout.png`, `run-audit.json`  
**Screenshot:** `test-results/live-ui-audit-2026-10-06/complete-run-running.png`  
**Console/network evidence:** Repeated authenticated GETs returned `running` for the full ten-minute window; no page exception occurred.  
**Reproducible:** NO — confirmed once; a second full ten-minute run was avoided to limit cost and production test data.

### QASE-UI-003

**Title:** Founder Mode exposes technical target and provider setup in the default founder journey  
**Severity:** P1  
**Requirement:** UI-003, UI-016–UI-019  
**Environment:** Commit `2e4fcb9`, Chromium  
**Viewport:** 1440 × 1000 and 360 × 800  
**Precondition:** Signed-in user opens Ideas.  
**Steps to reproduce:**

1. Select Ideas.
2. Review the default Founder form.
3. Scroll through the form at desktop or mobile width.

**Expected:** Reuse current target, ask only essential founder context, and keep device/provider details secondary.  
**Actual:** Product/project and URL are required; release/environment are prominent; the full target-device and BrowserStack environment matrix is in the default form.  
**Evidence:** `08-founder-launcher-1440.png`, `11-founder-launcher-360.png`, `static-audit.json`  
**Screenshot:** `test-results/live-ui-audit-2026-10-06/11-founder-launcher-360.png`  
**Console/network evidence:** None; this is rendered behavior.  
**Reproducible:** YES.

### QASE-UI-004

**Title:** Public entry screen uses terminal and command-line decoration instead of the Studio visual language  
**Severity:** P2  
**Requirement:** UI-001 Studio-native workspace  
**Environment:** Deployed Qase, Chromium  
**Viewport:** 1440 × 1000  
**Precondition:** Signed out.  
**Steps to reproduce:** Open the deployment in a clean browser context.  
**Expected:** A simple Studio-aligned account entry.  
**Actual:** The page leads with a faux terminal window, `./qase --initialize`, `qase auth`, command prompts, and large technical branding.  
**Evidence:** `01-initial-1440-light.png`, `probe.json`  
**Screenshot:** `test-results/live-ui-audit-2026-10-06/01-initial-1440-light.png`  
**Console/network evidence:** None required.  
**Reproducible:** YES.

### QASE-DEP-001

**Title:** Deployment changed from `327fbf2` to `2e4fcb9` during the audit  
**Severity:** P2  
**Requirement:** Stable, reviewable demo build  
**Environment:** Target deployment  
**Viewport:** All  
**Precondition:** Audit begins while a rollout is occurring.  
**Steps to reproduce:** Fetch and fingerprint `index.html`, `app.js`, and `studio-workspace.css` before and after the observed rollout.  
**Expected:** One identified build remains stable for the validation window.  
**Actual:** Initial files matched `327fbf2`; final files matched `2e4fcb9`. Twelve final cache-busted requests were consistent.  
**Evidence:** Asset hashes in Audit record; initial and final `static-audit.json` timestamps.  
**Screenshot:** The final screenshots use `2e4fcb9`; earlier live screenshots were superseded by the required current-build rerun.  
**Console/network evidence:** HTTP 200 throughout; content fingerprints changed.  
**Reproducible:** NO — rollout condition ended during the audit.

### QASE-UI-005

**Title:** Expected unauthenticated API checks create console error noise on first load  
**Severity:** P3  
**Requirement:** Phase 1 basic page and console check  
**Environment:** Signed-out deployment, Chromium  
**Viewport:** 1440 × 1000  
**Precondition:** Clean browser context.  
**Steps to reproduce:** Open the deployment and inspect the console before sign-in.  
**Expected:** Expected authentication probing is handled without avoidable error-level console noise.  
**Actual:** Multiple `Failed to load resource: 401 (Unauthorized)` entries appear for expected pre-auth requests. No JavaScript exception or blank screen occurs.  
**Evidence:** `probe.json`, `authenticated-probe.json`  
**Screenshot:** `01-initial-1440-light.png`  
**Console/network evidence:** 401 responses from pre-auth API requests including `/api/auth/me` and environment/session checks.  
**Reproducible:** YES.

## Focused Web Interface Guidelines review

The current rendered UI satisfies the audited high-impact rules: semantic buttons and form labels, visible focus, keyboard alternatives, ARIA labels on preview controls, reduced-motion detection, theme `color-scheme`, responsive dialogs, and no horizontal overflow at tested widths. Confirmed product issues are captured above. This is a focused review, not WCAG certification.

## Areas not validated

- A true `completed` run, clean-run Report default, and automatic completed-run Findings default.
- Final report actions, follow-up tests, and feedback submission/human review destination.
- Founder recommendation content, evidence, benefit, effort, confidence, ordering, selection, and Build in Studio truthfulness.
- Finalized Quality result ordering and evidence gaps.
- Hosted Drytis Studio embedding, host-supplied target/theme signals, board delivery, and Send to Studio.
- Physical Android/iOS devices or real BrowserStack execution.
- Waiting, reconnecting, failed, and failed-cancellation recovery states.
- Full screen-reader and WCAG conformance testing.

## QASE UI VALIDATION — FINAL

**Deployment:** `https://qase-2-1-vbvclu.drytis.dev/`  
**Build/commit:** final static build `2e4fcb932a70747802f255f85e84d7bfe5192bff`  
**Date:** 6 October 2026

| Result | Count |
| --- | ---: |
| Total requirements | 26 |
| PASS | 15 |
| PARTIAL | 4 |
| FAIL | 1 |
| INCONCLUSIVE | 6 |

| Defect priority | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 3 |
| P2 | 2 |
| P3 | 1 |

| Area | Result |
| --- | --- |
| Main journey | INCONCLUSIVE |
| Studio fit | PARTIAL |
| Results-first UI | PARTIAL |
| Customer simplicity | PASS |
| Founder Mode UX | PARTIAL |
| Feedback workflow | INCONCLUSIVE |
| Responsive readiness | PASS |
| Demo readiness | NOT READY |

### Top five issues to fix before demo

1. Make the safe demo run complete within a bounded time or show a clear failure/timeout and recovery path.
2. Make Stop end in an explicit `stopped` state, with acknowledgement and retry on failure.
3. Simplify Founder Mode to reuse the target and move release, environment, devices, and provider matrices under Advanced options.
4. Complete and verify one end-to-end run through Report, follow-ups, feedback confirmation, and the human review destination.
5. Freeze the deployment on one identified build before the demo and rerun the smoke audit from a clean account.

### Top five improvements that can wait

1. Replace the terminal-style public entry with the Studio visual language.
2. Remove expected 401 console noise during unauthenticated boot.
3. Validate the exact hosted Studio panel width when it becomes available.
4. Add full screen-reader and WCAG testing beyond the focused keyboard review.
5. Stress-test long content, 100+ findings, and large history lists.

### Blocker evidence

1. Run completion: `complete-run-running.png`, `18-complete-run-timeout.png`, `run-audit.json`.
2. Stop acknowledgement: `15-stop-pending.png`, `16-stop-final.png`, `run-audit.json`.
3. Founder complexity: `08-founder-launcher-1440.png`, `11-founder-launcher-360.png`, `static-audit.json`.
4. Incomplete Report/feedback path: `26-report-while-running.png`.
5. Build stability: initial/final asset fingerprints in the Audit record.
