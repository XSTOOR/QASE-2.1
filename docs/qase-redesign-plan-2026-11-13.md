# QASE landing page and application redesign

Date: 13 November 2026. Status: proposed design and implementation plan.

This plan extends the existing architecture and proof plans. It does not mean the proposed agent architecture, animation testing, or all pictured capabilities are implemented. Keep the current evidence workspace and execution protections while evolving the presentation.

## Product direction

QASE should help a tester or product owner answer three questions quickly: what was tested, what actually happened, and what should be fixed? The public page should demonstrate that value. The application should make it inspectable.

Design signature: a browser action connects to an expected/observed comparison and its saved evidence. Use this relationship as the main landing-page animation and as the organizing principle inside the workspace.

## Reference research

Reviewed these official pages on 13 November 2026. These are references for principles and techniques, not a requirement to reproduce their branding. Page content and documented examples were reviewed; their live animation performance was not benchmarked.

| Reference | Relevant idea | QASE interpretation |
| --- | --- | --- |
| [Linear product page](https://linear.app/) | Product UI appears within the product story | Show a sample browser journey and its finding in the hero, using QASE's own components |
| [Linear UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui) | Reduce navigation noise and establish clearer hierarchy across panels | One global sidebar, one run header, contextual evidence panel |
| [Motion JavaScript path drawing](https://motion.dev/examples/js-loading-infinite-path-drawing) | SVG paths can communicate progression | Adapt the path technique into a finite action-to-evidence sequence, with replay |
| [Motion JavaScript path morphing](https://motion.dev/examples/js-svg-path-morphing) | Shapes can transition continuously | Optional small state transition in the sample demo; only use if it improves comprehension |
| [Vercel interface guidelines](https://vercel.com/design/guidelines) | Keyboard use, focus management, stable layouts and purposeful animation | Reliable forms, accessible panels, interruptible feedback and clear loading states |
| [Motion accessibility guide](https://motion.dev/docs/react-accessibility) | Respect reduced motion and replace spatial motion where appropriate | Static hero state and immediate panel changes when reduced motion is requested; React-specific APIs are not required |

The direction is a bright, precise testing workspace with QASE blue and strong evidence hierarchy. Avoid borrowing another product's full visual identity. Do not use third-party logos, customer claims, screenshots or performance statistics as QASE proof.

## Visual system

| Token | Choice |
| --- | --- |
| Workspace | Paper `#F6F8FC` |
| Content surface | White `#FFFFFF` |
| Main text | Ink `#14213D` |
| Primary action | QASE blue `#315DE7` |
| Verified pass | Green `#167253` plus icon and text |
| Verified failure | Red `#A43634` plus icon and text |

Retain self-hosted Geist for headings and interface text. Reserve Geist Mono for URLs, identifiers and raw technical evidence. Landing headings: approximately 48–64px desktop and 34–40px mobile. App body: 14–16px. Use an 8px spacing rhythm, restrained surface rounding and left-aligned content. Verify contrast for every actual foreground/background pair.

Use a wide hero with a readable text column and a larger product demonstration. Inside the app, use compact rows for steps and findings, with roomy evidence detail. Keep theme settings in account/preferences. Support the existing light/dark preference without adding a theme selector to sign-in.

Design critique: a floating dashboard, decorative gradients, identical feature cards and repeated scroll reveals would make this interchangeable with another SaaS page. Replace those with a single concrete broken-journey demonstration and a useful sample report.

## Public landing page

Proposed destinations are public home, sample report, sign-in and authenticated workspace. Resolve their exact paths against existing routing and embedded Studio behavior during implementation. Existing run deep links must continue working.

```text
QASE                 How it works   Coverage   Sample report   Sign in

Know what works.                 [Sample browser journey             ]
See what needs fixing.           [Home -> Solutions -> Pricing       ]
                                 [Expected: Pricing heading         ]
Run browser journeys and         [Observed: Heading missing          ]
inspect the evidence behind      [Screenshot + failed assertion      ]
each result.

[Start testing] [View sample report]

How it works: Set scope -> Run checks -> Review evidence
Coverage: Verified capabilities, limitations and planned extensions
One finding: Expected / Observed / Evidence / Reproduction steps
Choose an output: Test | SQA | Founder
How QASE works: Plan -> Execute -> Verify -> Save evidence
Questions: Credentials, device coverage, reviewer evidence, data handling
Final start action and footer
```

### Landing content requirements

- Start testing opens the launcher for a signed-in user or sign-in with a return destination. Do not start a remote test on page load.
- View sample report opens a useful, accessible example clearly labeled as sample data.
- The hero explains one defect, including a successful navigation followed by a failing content assertion. A loaded page alone is not a pass.
- Coverage lists only qualified current capabilities as available. Broader motion, visual, device or compliance coverage must be marked planned until verified.
- The three modes explain their outputs. SQA includes technical assessment and reviewer evidence. Founder includes observations and hypotheses, each identified appropriately.
- The architecture section is a simple explanatory diagram. Detailed technical plans can be a separate document. Label proposed changes explicitly.
- Avoid unsupported claims such as all bugs detected, complete compliance, every device tested, or guaranteed runtime.

## Landing animation storyboard

The hero is a short, approximately four-second sample sequence. The exact timing is a design target to validate, not a test-runtime claim.

| Moment | Visible behavior | Meaning |
| --- | --- | --- |
| Initial | Readable sample screenshot and journey are present immediately | Content remains usable before animation loads |
| 0–1s | A finite SVG connector advances from Home to Solutions | A sample journey step executed |
| 1–2s | Pricing opens and the expected heading is highlighted | Show the assertion being evaluated |
| 2–3s | An observed-result row shows the missing heading | Separate navigation success from content failure |
| 3–4s | Evidence thumbnail connects to the failed assertion | The finding has inspectable support |
| End | Hold the result with Replay and Open sample evidence controls | Let the user inspect at their pace |

Play at most once when visible, with pause/replay controls. Stop work when the page is hidden or the demo leaves the viewport. Reduced-motion users see the final state and can inspect every step without animation. Demo timings never drive live run status.

## Application information architecture

Global navigation: Projects, Runs, Findings, Evidence, Settings. Start testing is the main action. Test, SQA and Founder are run/output choices rather than three competing global navigation systems. Preserve direct access to existing mode reports during migration.

### Start test

Show target URL, mode, goal/expected behavior and selected browser/device. Preselect an available, qualified desktop profile and state clearly whether it is an emulated profile or a real device. Make changes easy. Display the effective test scope before launch.

Capture run time automatically. Make build/version and environment optional metadata under details; never silently label a public production URL as local. If environment is suggested, let users confirm or edit it. Keep credentials and advanced options out of the primary form unless needed.

Start must explain any unmet requirement beside the relevant field. A disabled button with no explanation is unacceptable. Preserve authorization checks and avoid a redundant confirmation step when the form already supplies all necessary information.

### Live run and results

```text
Project / Run                   Running: step 2 of 5    Stop
Browser profile                Latest update: timestamp

Journey              Browser / saved screenshot      Selected step
Passed step          Evidence for current selection  Expected
Current step                                         Observed
Pending step                                         Assertion result
                                                     Open evidence

Summary | Findings | Coverage | Activity
```

At narrower desktop sizes, open evidence in a drawer. On mobile, use a single column with Journey, Evidence and Findings views; avoid squeezing three panels. The main content has one clear scroll area. Chat and raw logs are secondary tools.

Execution state and assessment outcome are separate. A completed run can contain failed assertions or incomplete assessment coverage. Use Passed, Failed, Blocked, Not tested and Needs review consistently and explain them. Counts come from saved results. A missing screenshot must show a missing-evidence state, never an unrelated substitute.

### Findings and evidence

Each finding shows the affected journey, severity with rationale, expected behavior and its source, observed behavior, reproduction steps, browser/profile, timestamp and supporting artifacts. Deep-link to the exact evidence. Let users compare a rerun with the original result. Keep unverified hypotheses distinct from confirmed failures.

### SQA and Founder

SQA separates technical results from reviewer evidence. Show the missing artifact, why it is needed, where to upload/link it and review status. Agent-generated text is not automatically an approval record. Technical completion remains visible even when reviewer evidence is outstanding.

Founder separates observed product behavior, interpretation and recommended action. Show supporting evidence and uncertainty. Configured, authorized automatic Studio handoff should expose queued, sent, failed and retry status. Otherwise show the actual export/configuration state. Do not display a successful handoff before a receipt exists.

## Workspace motion rules

| Interaction | Proposed treatment |
| --- | --- |
| Button response | Immediate visual feedback, approximately 100–150ms transition |
| Evidence drawer | Approximately 180–240ms, interruptible, focus moved and restored correctly |
| Tab change | Immediate content with at most a brief opacity transition |
| New run event | Highlight the changed row once, without shifting surrounding content |
| Loading | Reserved space and readable status; avoid flashing placeholders |
| Completion | Persist the result and summary; no blocking celebration |

These are proposed UI timings, not measured performance. Use CSS/WAAPI first with the existing vanilla JavaScript frontend. Add a small animation dependency only if the storyboard needs it. Motion's examples are technique references, not a reason to migrate to React. Never run decorative background animation in an active evidence workspace.

## Implementation boundaries

Current frontend is vanilla JavaScript and CSS, with self-hosted fonts. Relevant existing files include `public/index.html`, `public/app.js`, `public/entry-motion.js`, `public/entry.js`, `public/runStartupView.js`, `public/qaEvidenceView.js`, `public/qaEvidence.css`, `public/sqaReviewView.js` and `public/founderView.js` if present. Verify exact module exports before editing.

Proposed additions: a public landing view, scoped landing styles, an isolated demo-motion module and shared design tokens. Reuse the existing evidence presenter and state models. Keep landing animation code out of authenticated run loading. Preserve authentication, owner-only evidence access, embedded Studio behavior, session persistence and run deep links. Do not place sample results in production session storage.

Connect the workspace to actual run events and saved assertions. Revalidate completion labels after refresh and reconnect. A live image must carry its timestamp; a saved screenshot must be identified as saved evidence. UI animation must not wait for or interfere with agent execution.

## Phases and acceptance gates

Effort ranges assume one contributor and reusable existing APIs. They are planning estimates, exclude the underlying agent rebuild, and must be revised after the first prototype. Do not sum them into a committed release date without checking integration scope.

| Phase | Deliverable | Effort estimate | Completion gate |
| --- | --- | --- | --- |
| 1. Screen inventory and wireframes | Landing, start, live run, results and evidence layouts | 0.5–1 day | Every main task has one obvious next action; desktop/mobile layouts reviewed |
| 2. Landing and sample story | Responsive page, sample report and finite hero animation | 1–2 days | Sign-in/start routes work; sample label, keyboard access and static fallback verified |
| 3. Workspace integration | Clean launcher, run progress, evidence inspection and recovery states | 2–3 days | Real healthy and seeded-defect runs display accurate assertions; refresh/reconnect work |
| 4. SQA and Founder presentation | Clear technical/reviewer distinction and evidence-linked recommendations | 1–2 days | Missing evidence and handoff failures are actionable; existing reports remain accessible |
| 5. Qualification | Responsive, accessibility, browser, motion and performance verification | 1–2 days | Critical flows pass with reduced motion, mobile layout and supported browsers; release regressions cleared |

Earliest useful review artifact: landing and run-screen wireframes with a short sample animation. A polished sample is not evidence that the new agent execution architecture works. The functional journey remains a separate acceptance gate from the architecture plan.

## Performance and validation

Proposed frontend budgets: aim for visible local interaction feedback within 100ms, initial landing JavaScript at or below 100KB compressed excluding deferred demo/media, and no new motion-related long tasks over 50ms on the agreed reference device. Measure before accepting these budgets. Report exact browser, device, network throttling and build for comparisons.

Reserve media dimensions, self-host required fonts, load below-fold media on demand and pause off-screen animation. Measure landing loading, layout shifts, interaction responsiveness and active-run CPU with motion enabled and disabled. Agent speed is measured separately by time to first evidence, total run duration, model calls and verified assertions.

Acceptance coverage:

- Desktop, tablet and 390px mobile layouts, with no unintended horizontal overflow.
- Keyboard navigation, visible focus, screen-reader status updates, zoom and reduced motion.
- Existing supported browser profiles, with results recorded separately.
- Valid/invalid URL, missing permission, missing required input, offline, expired session and retry states.
- Run start, stop, reconnect, resume, complete, fail and blocked states.
- Evidence absent, evidence access denied, partial coverage and reviewer evidence outstanding.
- Correct sample/live separation, report download and configured Studio delivery outcomes.
- A healthy fixture passes and a seeded visible-content failure fails even if navigation returns HTTP 200.

## Immediate next implementation

Start with Phase 1 and a lightweight Phase 2 prototype on `codex/qase-evidence-workspace`. Produce the landing page, sample evidence story and corresponding run-screen design together so the public promise matches the application. Review screenshots at desktop and mobile sizes, then integrate real run data. Keep the architectural JEV execution work tracked in its existing plan.

## First implementation checkpoint

The first landing-page implementation is available at `/welcome.html`. It includes a finite sample journey animation with pause/replay, an interactive healthy/defective sample report, an evidence dialog, coverage boundaries, mode explanations and responsive layouts. The embedded report establishes the proposed results layout using explicitly labeled sample data. Start testing opens the existing `index.html#/runs/new` route. The sign-in brand links back to the landing page. Existing root and run deep links retain their behavior.

Files: `public/welcome.html`, `public/welcome.css`, `public/welcome.js`. No frontend framework or animation dependency was added. The public sample does not call APIs or create sessions.

Verification command: `npm run test:welcome`. Use `PLAYWRIGHT_BROWSERS_PATH` when the browser installation is outside the current account's default cache. Set `QASE_WELCOME_LIVE_URL` to an already-running local instance to additionally verify the real landing page and launcher. The default fixture serves the actual frontend with a simulated signed-out API response; it does not exercise credential validation or AI execution. Screenshots and browser results are saved under `test-results/welcome-redesign`.

Next: integrate the revised layout with actual workspace run events and saved assertions, then adapt the SQA and Founder views. The new agent execution architecture and release qualification remain separate work.
