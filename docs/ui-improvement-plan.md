# Qase UI improvement plan

Prepared 5 October 2026 against local `PUSHKAR`, baseline commit `01962aa`.

## Product goal

Help a nontechnical product owner test a website, understand what failed, and choose the next action without writing testing instructions or reading a long technical report.

The main journey is: **Open Qase → review the target → start testing → understand findings → select fixes or further tests.**

This plan reviews the supplied group discussion and the current source. The discussion describes an earlier version; several requests are already implemented. The implementation record below tracks browser checks completed after planning. Initial observations in the tables describe the baseline.

## First implementation batch — 5 October 2026

Implemented the workspace foundation and launcher simplification, plus finding readability and cancellation fixes:

- Recent tests and Start testing lead the sidebar. Workspace navigation, quick actions, and feedback review sit under Workspace tools. Footer destinations have one navigation route each.
- A separate scoped workspace stylesheet defines light/dark surfaces, typography, labelled mode buttons, responsive layouts, readable conversation and evidence text, and focus styles. Legacy simulated window/path decorations are hidden in the workspace.
- The QA launcher shows the URL, a live coverage summary, and recommended selections. Devices, browsers, and check selection sit under one disclosure. Required security authorization remains visible and enforced.
- Findings lead with reproduction steps, expected/actual behavior, and evidence. Fix instructions are optional to expand. Open findings and instructions survive connection recovery within the current page.
- Duplicate Stop/status IDs are removed. Stop prevents duplicate requests, shows pending state, allows retry after failure, and reconciles the saved server state. View results opens the report instead of the account panel.
- Existing post-run preview collapse is retained and browser-tested, with a restore control and a simpler collapsed strip.

Validation: dashboard browser qualification passes 14 journey checks, including actual HTTP handlers, selections, cancellation failures/retry, reconnects, all three launchers, preview collapse/restore, and navigation. Light/dark screenshots and QA/SQA dialogs were checked at 360, 390, 768, 1280, and 1440 px. These tests use isolated fixture data and a stub agent; they do not measure real model or hosted Studio behavior. Account browser qualification passes registration, profile, isolation, settings, CSRF, password rotation, login, and logout.

UI/module tests pass (104 passed, five skipped). Three existing UI test readers were corrected to resolve file URLs on Windows. Full verification passed syntax, ignore, and credential scans, with 900 tests passed and 20 skipped; four failures remain in unchanged Windows POSIX-permission assertions and live public-target reachability checks. Generated evidence is under `test-results/dashboard/`, `test-results/verification.log`, and `artifacts/auth/` (ignored local outputs).

Remaining planned work: finding bulk selection/action bars, promoting follow-up tests, simplifying the Quality/Ideas journeys, user trials, and Studio-side repair handoff. Exact visual parity still requires an accessible current Studio reference.

### Follow-up: manual theme selection

Added a labelled Theme selector in the sidebar and sign-in header with Light, Dark, and System choices. Preferences are stored in the browser, applied before styles load, synchronized between tabs, and kept when returning to the app. System follows live device theme changes; manual choices override the device preference throughout the workspace and dialogs. The device preview badge now sizes to its text instead of covering the empty preview.

Dashboard qualification passes 15 checks, including manual themes against opposite device preferences, reload persistence, browser chrome color, dialog surfaces, and live System updates. Authentication qualification covers the pre-login selector and mobile visibility. UI/module tests remain passing; full verification has the same four Windows/network failures recorded above.

### Follow-up: results-first completed state — 6 October 2026

Completed QA runs now give the findings and report workspace substantially more width while retaining the conversation as supporting context. Runs with findings open the Findings tab automatically; clean runs open the Report tab. The live capture becomes a saved screenshot thumbnail with clear show/minimize controls instead of a text “Collapse” action. Both the thumbnail and icon control have keyboard and screen-reader behavior. Findings are selected by default, support individual or Select all changes, show an exact selected count, and can copy only the chosen fix instructions.

Dashboard qualification covers the results hierarchy, automatic tab choice, accessible preview restoration, thumbnail visibility, and the 1101 px desktop breakpoint without horizontal overflow. Light and dark rendered screenshots were reviewed. Authentication qualification and the focused 23-test UI/module suite remain passing.

### Follow-up: simplified Quality review — 6 October 2026

Quality now starts with one required URL, a recommended universal baseline, and a short authorization confirmation. Product name, release, and environment are inferred from the URL and current context when omitted. Additional standards profiles, product characteristics, optional scope details, and browser/device controls remain available under Advanced options. The review boundary is disclosed separately so the main action stays easy to scan at narrow widths.

The user-facing interface consistently calls this a Quality review instead of SQA. Finalized results prioritize report actions, unresolved issues, and evidence gaps before coverage and technical detail; the full scope remains available last for audit context. No assessment engine or compliance behavior changed.

Dashboard qualification passes all 15 journeys, including recommended defaults, authorization, optional advanced scope, and 360/390/768/1280 px layouts. The 360 px and desktop launchers were visually reviewed after the disclosure change. Authentication qualification passes, and the focused Quality/launcher presentation suite passes all 19 tests.

## What the discussion means for design

| Discussion reference | Design requirement | Current position |
| --- | --- | --- |
| 00:47; 01:56–01:57 | Fit Studio's typography, theme, and usage display | Studio-labelled tokens exist alongside terminal styling. Exact parity needs the current Studio reference. |
| 01:09–01:13; 01:40–01:42 | Sensible defaults, checkboxes, select all; avoid a testing questionnaire | Launcher and follow-up selection already exist. The launcher still exposes substantial technical detail. |
| 01:27–01:29; 01:58–01:59 | Make findings easy to understand and move into the fix workflow | Individual and bulk prompt copying exist; integration-linked runs also have a board-delivery selection panel. |
| 01:43–01:44 | Minimize the finished live preview and give results more space | Automatic preview collapse is implemented. Validate it and improve results layout rather than rebuild it. |
| 00:53–01:02; 01:15–01:17 | Make Founder an optional route to useful feature suggestions | Business context is already optional. Product name and technical environment controls still add friction. |
| 01:28–01:29 | Runs must start, stop, and recover predictably | Assess the actual lifecycle. Duplicate UI control IDs are a confirmed source defect. |
| 01:44–01:49 | Learn from actual user behavior | Feedback and analytics surfaces exist. Confirm whether they measure the proposed user-journey events before adding more. |

Keep QA as the default purpose. Founder and SQA are optional actions with plain-language explanations. Recommendations should help the user decide what to build next, while findings explain what is currently broken.

## Skills and their jobs

- **frontend-design:** define the visual system, page hierarchy, wireframes, and interface copy; critique the design against Qase's workflow before implementation.
- **web-design-guidelines:** review navigation, forms, keyboard use, focus, motion, theme behavior, and long-content handling against the [current Vercel guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).
- **vercel-react-best-practices:** available for any React-based Studio implementation. Qase currently uses plain HTML, CSS, and JavaScript, so React-specific changes and a framework migration are outside this plan. Apply appropriate general performance practices within the existing stack.

## Confirmed source findings

### public/index.html

- `public/index.html:206` — duplicate `status-chip` ID; the first instance is at line 170. The controller selects one element, leaving the other outside the normal status update path.
- `public/index.html:210` — duplicate `stop-run` ID; the first instance is at line 181. The second control is not the element bound by the controller's singular lookup.
- `public/index.html:156` — workspace destinations repeat in the sidebar footer after appearing in the main navigation; consolidate the entry points.
- `public/index.html:665` — advanced device options are expanded initially; move environment-provider detail behind customization.
- `public/index.html:675` — launcher copy exposes User-Agent terminology to the main user flow; nearby environment controls also expose BrowserStack detail.
- `public/index.html:703` — scope text includes XSS and SQL error terminology; present clear user outcomes with technical descriptions in details.

### public/app.js

- `public/app.js:2444` — the expanded finding renders the full fix prompt; use progressive disclosure so impact and evidence stay prominent.
- `public/app.js:2497` — follow-up selection exists; keep it and promote its placement within results.
- `public/app.js:2583` — board delivery exists for integration-linked runs; extend the existing capability rather than create a competing delivery flow.

### public/styles.css

- `public/styles.css:3408`, `public/styles.css:4002`, `public/styles.css:5165` — successive workspace styling layers require consolidation before further redesign. Treat this as a maintenance risk, not proof of a rendered visual defect.

These are focused planning findings, not a complete accessibility audit. The first implementation milestone includes a rendered baseline and a full review of the affected flows.

## Visual direction

Follow the meeting's stated direction: Qase should feel like a native part of Drytis Studio. Preserve a recognizable Qase identity through clear evidence and coverage, with quiet surrounding chrome.

Use Studio's actual tokens when available. Until then, the following six values are a provisional base drawn from the existing Studio-labelled CSS, not a claim of exact Studio parity:

| Token | Value | Role |
| --- | --- | --- |
| Background | `#FFFFFF` | Main workspace |
| Secondary surface | `#FAFAFA` | Sidebar and supporting regions |
| Primary text | `#171717` | Headings and body |
| Secondary text | `#3F3F46` | Supporting information |
| Border | `#E5E5E5` | Grouping and separation |
| Action | `#2F5BEA` | Primary action and active selection |

Keep existing semantic status colors, checking each against its background. Supply matching dark tokens; the embedded theme should follow a documented Studio theme signal rather than relying only on the operating-system preference.

Typography: inherit the Studio typeface when integration supports it; otherwise retain bundled Geist. Use 14 px body, 13 px supporting text, 16 px section headings, and 20–24 px page headings. Use monospaced text for code and raw evidence only. Align content left and keep long reading passages below roughly 80 characters per line.

Layout: one primary action per state, consistent spacing at 4/8/12/16/24/32 px, compact navigation, and a wider results region. Use borders to communicate grouping; avoid placing every item in an identical card. Reserve animation for meaningful state changes. Terminal paths, decorative commands, scanlines, and oversized brand treatments should not compete with the product task.

## Proposed layouts

Standalone workspace while testing:

```text
┌──────────────┬───────────────────────────────────────────┐
│ New test     │ Project / target                         │
│ Recent runs  │ Testing forms · elapsed · usage · Stop   │
│              ├──────────────────────┬────────────────────┤
│ Findings     │ Live preview         │ Current checks     │
│ Saved tests  │                      │ Findings so far    │
│ More tools   ├──────────────────────┴────────────────────┤
│              │ Conversation / requests for your input   │
│ Account      │ Message Qase                             │
└──────────────┴───────────────────────────────────────────┘
```

Completed run:

```text
┌──────────────┬───────────────────────────────────────────┐
│ Recent runs  │ Test finished · coverage · Show preview  │
│              ├───────────────────────────────────────────┤
│              │ Findings / Coverage / Activity / Report  │
│              │ Select all · 4 selected · [Action]       │
│              │ □ High   Signup accepts invalid email    │
│              │ □ Medium Missing submission feedback     │
│              │ Open finding → impact / proof / fix      │
│              ├───────────────────────────────────────────┤
│              │ Test these next · Review product ideas   │
└──────────────┴───────────────────────────────────────────┘
```

Embedded Studio panel: omit redundant account and workspace chrome, use one scrollable column with the same findings and selection components, and allow the live preview to expand on request. Do not compress the standalone multi-column layout into a narrow toolbar panel.

## Implementation sequence

| Phase | Work | Completion gate |
| --- | --- | --- |
| 1. Establish the baseline | Capture launch, running, waiting, completed, error, findings, Founder, and settings states. Audit DOM IDs. Fix duplicate controls and verify the stop/status paths. | Unique control IDs; visible status and Stop behavior agree with server state; baseline screenshots recorded. |
| 2. Unify the visual system | Consolidate conflicting style layers, define theme tokens, simplify navigation, and standardize buttons, fields, dialogs, spacing, and text. | The same components render consistently across light, dark, standalone, and narrow embedded layouts. |
| 3. Simplify starting a test | Put URL/project target and Start testing first. Summarize recommended checks; move detailed catalog, provider, device, and engine settings into Customize. Persist deliberate user choices. | A first-time user can start without composing instructions or choosing technical test categories. No existing test-selection capability is lost. |
| 4. Make progress understandable | Use one authoritative run summary: current check, lifecycle state, elapsed time, usage, and Stop. Expose input requests clearly; explain reconnecting and failed requests. Verify existing preview collapse and expansion preferences. | Waiting, stopping, stopped, failed, and completed are distinguishable. The UI never claims cancellation before acknowledgement or shows invented progress. |
| 5. Make results actionable | Lead with findings and coverage. Use selectable rows, severity and impact, an evidence detail view, collapsed raw prompts, and a persistent selected-count action bar. Promote existing follow-up selection. Simplify Founder entry and prioritize its recommendations. | Users can understand a finding, select a subset or all, and complete the available next action without searching through a report. |
| 6. Qualify and learn | Test responsive behavior, keyboard navigation, themes, long findings, large lists, reconnects, and action failures. Validate existing feedback and analytics against the journey metrics below. | Critical journeys pass automated browser checks and manual visual review; metric definitions and collection gaps are documented. |

Implement in this order. Keep each phase reviewable and validate its behavior before adding the next layer. Start with the control defects and workspace foundation, then the launcher, then results. Refresh tests whose selectors or navigation depend on the changed layout.

## Behavior details

**Starting:** In Studio, prefill the authorized project preview supplied by the host. Standalone users supply a URL. Show a brief summary of included checks and supported browser/device coverage. Distinguish requested, available, completed, failed, and skipped coverage. Do not label emulation as testing on physical devices, or WebKit as complete Safari/device certification.

**Progress:** Translate lifecycle states into plain language. Stop should show a pending state, avoid duplicate requests, and explain failure with a retry route. Token usage remains visible but secondary; estimated values must remain labelled. Refreshing or returning to a run should restore the authoritative state and a usable selection context.

**Findings:** Show title, severity, user impact, page, and status before technical details. Expand to reproduction steps, expected versus actual behavior, and evidence. Put raw fix prompts behind View fix instructions. A sticky selection bar shows the exact number selected. Keep selection understandable when filters change; Select all must identify whether it means visible findings or the entire result set.

**Next actions:** Standalone users can copy selected fix instructions or export tickets. Integration-linked runs use the existing board-delivery capability when configured. A Send to Studio action becomes available only after the host's repair handoff is implemented and verified; show actual delivery status and recoverable failures. Sending instructions must not mark findings fixed. Re-testing supplies verification.

**Follow-up tests:** Reuse the existing preselected checklist, promote it beneath findings, and show why each area was not covered. Keep authorization for actions with external effects distinct from bulk selection; selection alone must not grant broader permission.

**Founder:** Present an optional Review product ideas action after QA, reusing target context where supported. Keep business context optional and collapsed. Prefer product names such as Product improvements and Target customers over specialist abbreviations. Recommendations show benefit, effort, confidence, and supporting evidence. Selecting recommendations prepares a build brief; actual feature creation requires Studio implementation.

## Integration dependencies

Qase owns the interface, reports, selection, run state, and its existing integration contract. Drytis Studio owns the toolbar placement, current project target, host theme signal, repository/board receiver, and coding-agent repair workflow. See [the integration architecture](drytis-studio-integration-architecture.md) and [the integration contract](drytis-integration.md).

The discussion's request for a toolbar entry above Files is a Studio-side task. Exact visual parity also needs the current Studio theme and component reference. Work in this repository can proceed on baseline, simplification, and provisional tokens while those references are obtained.

APK emulators, new load/security test engines, expanded physical-device coverage, and new execution infrastructure are separate capability projects. Reflect supported capabilities accurately in the UI and track those projects separately from this redesign.

## Validation and success measures

Use the existing dashboard, browser, and auth qualification scripts as the starting point. Run `npm run verify` after behavior changes; run the applicable `test:dashboard`, `test:browser`, and `test:auth` checks after adapting them to the final layout. See the implementation record for checks already completed.

Capture representative screens at 360, 768, 1280, and 1440 px, plus the agreed Studio panel width. Review light and dark themes, keyboard focus and dialog return, reduced motion, error recovery, empty runs, long URLs, and 100+ findings. Confirm results remain readable without horizontal page overflow.

Test with nontechnical teammates: give them a URL and ask them to start a test, explain one finding, select two fixes, and run suggested follow-ups. Record completion, hesitation, and any need for help.

| Measure | What it tells us |
| --- | --- |
| Target entered → run started; launcher abandonment | Whether starting remains difficult |
| Run completed → first finding opened | Whether results are discoverable |
| Select all versus manual selection; selection → successful handoff/export | Whether bulk actions match real behavior |
| Live preview expanded/viewed versus results viewed | Whether the proposed space allocation helps |
| Follow-up checklist shown → follow-up started | Whether uncovered work is understandable |
| Stop requested → stop acknowledged; stop failures | Whether the control works predictably |
| Result helpfulness feedback | Whether output is useful beyond successful execution |

Establish a baseline before setting numeric improvement targets. Reuse existing event/analytics support when suitable; identify missing events explicitly. Collect action names, counts, timings, and outcomes without recording passwords, private page content, or full fix prompts as analytics payloads.

The redesign is ready for demonstration when the main journey works from start to results, cancellation and recovery are reliable, available next actions are truthful, the interface is usable at narrow widths, and the Studio-dependent pieces are clearly accounted for.
