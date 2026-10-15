# Qase Studio UI master plan

> Implementation status: demo-critical UI phases are complete through commit `a82f452`. See [QASE_STUDIO_UI_IMPLEMENTATION_REPORT.md](QASE_STUDIO_UI_IMPLEMENTATION_REPORT.md) for phase results, test evidence, and remaining deployment boundaries.

## Baseline

| Item | Value |
| --- | --- |
| Branch | `PUSHKAR` |
| Baseline HEAD | `2e4fcb932a70747802f255f85e84d7bfe5192bff` |
| Baseline date | 6 October 2026 |
| Working tree at inspection | Clean except for the requested, uncommitted `docs/QASE_UI_TRANSCRIPT_VALIDATION.md` audit report |
| Application stack | Server-rendered static HTML with modular plain JavaScript and CSS; no React runtime |
| Primary UI files | `public/index.html`, `public/app.js`, `public/styles.css`, `public/studio-workspace.css` |
| Mode modules | `public/qaKickoff.js`, `public/founderView.js`, `public/founderPresentation.js`, `public/sqaPresentation.js` |
| Qualification | `scripts/qualify-dashboard.mjs`, `scripts/test-auth-browser.mjs`, `scripts/test-founder-completion-browser.mjs` |

The baseline `npm test` run completed with 879 tests: 854 passed, 5 failed, and 20 were skipped. The existing failures are two Windows POSIX-permission assertions, one timing-sensitive keepalive test, and two public-network reachability checks. None is in the UI scope. These failures remain the comparison baseline; implementation phases must not add failures.

The live deployment audit is recorded in [QASE_UI_TRANSCRIPT_VALIDATION.md](QASE_UI_TRANSCRIPT_VALIDATION.md). Its final build matched the baseline HEAD, but the deployment changed builds during the audit. Demo qualification must therefore use a pinned local build or a controlled fixture.

## Product goal

Qase should read as the active QA workspace inside Drytis Studio. The host keeps project navigation and AI context visible, while Qase owns the center workspace. During a run, the browser, plan, current activity, and findings lead. After a run, findings and report lead while the browser becomes a saved preview.

The standalone application remains supported. Embedded presentation reuses the same Qase controls and state; it does not add a second application or duplicate Studio account, project, or global settings.

## Current state

### Already working

- Standard QA starts with the target URL, recommended coverage, all 12 available checks selected, a zero-selection disabled state, and technical choices under Customize.
- The running view exposes authoritative status, elapsed time, plan progress, current activity, findings count, live preview, and a single Stop control.
- Completed and ended QA sessions minimize the preview, prioritize findings/report, preserve the conversation as supporting context, and offer accessible Show/Minimize preview controls.
- Findings prioritize title, severity, reproduction, expected/actual behavior, and evidence. Fix instructions are optional.
- Finding selection supports individual changes, Select all, exact counts, and copying only selected fixes.
- Quality review already uses a one-target recommended baseline with optional Advanced controls.
- Light, Dark, and System themes persist and update native `color-scheme`.
- The integration contract already supports a Studio-owned container URL, project context, signed lifecycle operations, board delivery when configured, and a fixed external handoff target.
- Feedback has a user submission flow and an owner-facing review panel, though the live completed-run route was not reached in the audit.

### Implementation update and remaining gaps

- The mock Studio shell and controlled launcher/running/completed walkthrough now exist behind the opt-in `?studio=mock` presentation mode.
- User Stop now persists a resumable `interrupted` state with the authoritative detail `Stopped by user.`; the UI labels only that exact state as stopped.
- Founder defaults to URL and authorization, keeps technical settings under Advanced Options, and leads completed results with what to improve, what to build next, why it matters, and what to do first.
- Real Studio repair handoff is deployment-dependent. Unavailable delivery must remain hidden or clearly unavailable.
- Exact visual parity remains dependent on an accessible current Studio reference. Existing Studio-labelled tokens are provisional.

## Visual direction

### Tokens

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| Canvas | `#f5f6f8` | `#0d0f12` | Host workspace background |
| Workspace | `#ffffff` | `#15181d` | Active Qase center surface |
| Supporting | `#f8f9fb` | `#1b1f25` | Host navigation and AI context |
| Text | `#171717` | `#f5f5f5` | Primary copy |
| Muted | `#60646c` | `#a8adb7` | Supporting copy |
| Border | `#e3e5e8` | `#2b3038` | Structural separation |
| Action | `#315ee8` | `#7c9cff` | Active tool and primary action |

Use semantic success, warning, and failure colors already present in Qase. The Studio shell should stay quiet so the live browser or findings list becomes the memorable element.

### Type

Inherit the host font when embedded and fall back to bundled Geist. Use 14 px body text, 13 px supporting text, 16 px section headings, and 20–24 px page titles. Reserve Geist Mono for code, identifiers, or raw evidence. Keep long reading blocks below about 80 characters per line.

### Layout

```text
┌───────┬──────────────┬──────────────────────────────────────────┐
│ host  │ AI / project │ Qase center workspace                    │
│ nav   │ context      │                                          │
│       │              │ running: browser + plan + activity       │
│       │              │ ended: findings + report + small preview │
└───────┴──────────────┴──────────────────────────────────────────┘
```

The host rail stays narrow. AI context is supporting and can collapse at tablet widths. Qase receives the remaining center area. Content remains left aligned. Borders communicate ownership and hierarchy; avoid decorative card grids.

### Design principles

1. The state change is the visual idea: the browser leads during execution, then yields to results.
2. Show the current project as known context, not a questionnaire.
3. Keep one primary action per state and use plain verbs that match the resulting status.
4. Keep technical controls available through progressive disclosure.
5. Never imply a successful stop, repair handoff, or completed run without authoritative evidence.

This direction was checked against generic dashboard patterns. The revision removes decorative dashboard statistics and repeated cards, and instead spends visual emphasis on the live-to-results transition that is specific to Qase.

## Implementation phases

| Phase | Scope | Existing foundation | Completion gate |
| --- | --- | --- | --- |
| 0. Freeze baseline | Record source, tests, screenshots, breakpoints, and dependencies. | Audit evidence and browser qualification exist. | Master plan records HEAD, test baseline, implemented behavior, and blockers. |
| 1. Mock Studio shell | Add an isolated `studio=mock` presentation layout with host rail, compact project/AI context, and Qase in the center. Keep standalone unchanged. | Studio tokens and integration project context exist. | The page immediately reads as Qase inside Studio; no duplicate Qase application shell appears. |
| 2. Running workspace | Refine the center layout so browser, plan, activity, findings, Stop, and elapsed time answer the four running-state questions. | All underlying controls already exist. | Fixture browser test proves hierarchy and responsive access. |
| 3. Results-first state | Preserve automatic finding/report choice and saved preview behavior inside the embedded shell. | Implemented and audited in standalone. | Completed fixture proves results dominate and preview remains accessible. |
| 4. Customer launcher | Reuse host project target in embedded mode and keep recommended coverage primary. | Standalone simplification is complete. | A user can launch default coverage without opening Customize. |
| 5. Lifecycle and Stop | Improve truthful labels and recovery UI where the server contract permits; document missing authoritative state. | Duplicate requests and frontend retry on request failure already work. | Every represented state is truthful; unknown/idle is never renamed stopped. |
| 6. Feedback | Make submission confirmation name the owner feedback inbox; validate the owner panel. | API and owner review panel exist. | UI points to the exact human-consumable destination. |
| 7. Founder | Move release, environment, device, and provider controls under Advanced; lead results with decisions and priority. | Evidence-rich report renderer exists. | Default launcher uses URL/project context and authorization only. |
| 8. Quality | Preserve simplified launcher; refine hierarchy only if qualification finds a presentation gap. | Launcher is already complete. | No regression in current Quality checks. |
| 9. Fix/retest handoff | Reuse board delivery or selected-copy; expose Studio delivery only when capability is verified. | Signed delivery contract and board UI exist. | No false delivery state; selected findings remain unfixed until retest. |
| 10. Responsive qualification | Validate 360, 390, 768, 1280, 1440, and embedded widths. | Existing breakpoints: 1280, 1100, 720, and 520 px. | No horizontal overflow; primary actions and results remain reachable. |
| 11. Demo scenario | Add a controlled, clearly labelled browser fixture for launcher, running, and completed presentation. | Dashboard qualifier already stubs APIs safely. | Reviewers can demonstrate the intended state transition without a paid or unstable live run. |
| 12. Final validation | Run focused tests, dashboard/auth/browser qualification, static UI review, and visual checks. | Existing scripts and audit matrix. | Implementation report records exact results, screenshots, and blockers. |

## Dependencies and boundaries

- The mock shell can demonstrate layout but cannot claim exact Studio parity until a current host component/token reference is available.
- The implemented user-stop contract uses the existing resumable `interrupted` state plus an authoritative `Stopped by user.` detail. A separate new terminal enum is unnecessary for the current UI contract.
- Send to Studio requires a configured, verified delivery capability. This repository must not fake it.
- Real Android/iOS and BrowserStack execution is outside this UI implementation unless credentials and an environment are supplied.
- The controlled demo fixture must intercept only its test page requests, perform no production mutation, and be clearly labelled in source and output.

## Validation strategy

Each implementation commit runs its focused unit/static tests. Phase 12 then runs dashboard qualification, authentication qualification, the controlled Studio demo journey, and the relevant UI suites. Visual evidence covers light and dark themes plus 360, 390, 768, 1280, 1440, and an embedded desktop width.

The Web Interface Guidelines review covers semantic controls, labels, focus visibility, dialog containment, status announcements, long text, reduced motion, native dark mode, touch targets, and responsive overflow. The application remains plain JavaScript; a React migration would add risk without improving this demo objective.
