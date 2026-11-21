# QA engine

QA mode runs on a host-orchestrated engine in `server/qa/`. Deterministic
detectors do the measuring, the reasoning model explores user journeys and
reviews screenshots, and JEV verifies and grades every candidate before it
becomes a finding. Every run ends with a published report and a fix prompt
for each finding — model outages, phase errors and user stops become report
limitations, never stuck runs.

## Why it replaced the hybrid runtime

The previous hybrid QA runtime drove one CleanSlate SDK loop and gated every
model tool call through a scenario ledger. Runs ended in `interrupted` or
`awaiting_input` whenever a gate fired: no progress in three SDK segments,
a missing JEV usage receipt, a discovery timeout, an expired 24-hour model
qualification, an uncertain action or a budget question. Detection depended
on the model choosing the right fixed checks, so layout, animation and
security defects were rarely reported. The engine inverts this: the host runs
a fixed, complete test plan and uses models only where judgement helps.

## Pipeline (adaptive architecture)

The engine observes the application before it plans anything. Nothing in it is
application specific: what gets tested follows from what it finds.

| Stage | What happens | Module |
| --- | --- | --- |
| `observe` | Open the target; record DOM features, accessibility snapshot, console/network counts, sign-in entry points (password form, two-step identifier form, sign-in links, SSO, CAPTCHA/MFA) and a screenshot. **No plan exists yet.** | `engine.js`, `appGraph.js`, `signin.js` |
| `signin` | When sign-in exists (or an account was supplied): use the vault account, asking once through the secure card if none was given; handle identifier-first sign-in; verify the session by opening the next page; MFA/CAPTCHA pause for a person and are never bypassed | `signin.js`, `engine.js` |
| `discover` | Crawl public pages in a **signed-out** context, then the signed-in area, into the application graph (pages, features, transitions, auth state, roles). A signed-in page that bounces to sign-in triggers re-authentication (bounded by `QASE_QA_MAX_REAUTH`) and a retry | `crawl.js`, `appGraph.js`, `engine.js` |
| `plan` | Scenarios = graph × capability registry (`planner.js`), plus user journeys the reasoner proposes from the graph summary; a deterministic journey when the reasoner fails | `planner.js`, `capabilities.js` |
| `execute` | Scenarios run by priority (access control and core flows first, visual review last). Each scenario is checkpointed. After every scenario the plan is re-derived from the graph; new pages, features, roles or sessions add scenarios and record a **revision** | `engine.js`, `executors.js`, detectors |
| `triage` | Merge duplicates, verify with JEV, **escalate** JEV verdicts between 0.35 and 0.65 to the reasoner, grade severity | `triage.js`, `router.js` |
| `publish` | Capability coverage for all 140 categories, the **completion gate**, findings with fix guidance, the 25-section report | `capabilities.js`, `completionGate.js`, `report.js` |

Stages share the remaining budget (`STAGE_SHARE`); scenarios share the
execute budget (journeys and visual review get larger slices). Time spent
waiting for the owner is not counted. A user stop, budget end or error marks
every scenario that did not run as `not_executed` with the reason, and
`triage` and `publish` still run.

### Application graph and plan

`session.hybrid.graph` holds pages (`discoveredBy`: observe / crawl /
signed-in / explore; `auth`: public / signed-in / protected), per-page
features (search, filter, sort, pagination, table, forms, upload, media,
menus, dialogs, manifest, websocket, restricted…), transitions, auth state
and roles. `session.hybrid.plan` holds scenarios
(`{ id, unit, title, targets, capabilities, priority, state, reason, origin, revision }`)
and every revision with its trigger. Pages reached only by a journey join the
graph unaudited and get a `page_audit` scenario in the next revision.

### Capability registry (140 categories)

`capabilities.js` lists every category with applicability (a graph feature),
access (public / signed-in), executor units, safety class, evidence,
pass/fail criteria, recovery and support (`executed`, `partial` with a note,
or `unsupported` with the prerequisite that would make it runnable). Coverage
states are `passed`, `failed`, `blocked`, `inconclusive`, `not_applicable`,
`unsupported` and `not_executed`. A category is `passed` only when one of
its executors actually ran; writes, destructive tests, load tests, payments,
MFA/CAPTCHA and SSO are `unsupported` until the owner authorizes them.

### Completion gate

`completionGate.js` decides `complete` / `partial` / `blocked` from recorded
state only: target loaded, observation before planning, graph and plan
exist, every scenario terminal and executed, non-pass states explained,
authentication resolved (signed in or a recorded reason), no unexecuted
category marked passed, every finding has an observed result and evidence,
triage ran. A model saying "testing is complete" (the explorer's `finish`)
ends only that journey; it never satisfies a gate check. A clean verdict
becomes `partial` when the gate is not `complete`.

### Hybrid routing

`router.js` wraps the model client. Planning, exploration, visual review and
report writing go to the reasoner; verification goes to JEV; uncertain JEV
verdicts escalate to the reasoner; when a model is unavailable the router
falls back (JEV → reasoner → deterministic) and logs why. Every decision and
its token cost per task is kept in `hybrid.routing` and shown in report
sections 23–24.

## What it detects

Every detector returns *candidates* in one shape (`findings.js`): detector,
category, severity, confidence, title, URL, viewport, selector, expected,
actual, evidence, steps, fix guidance and an optional screenshot artifact.

**Layout and visual** — text overlapping text (measured on text line boxes,
not element boxes), controls covered by other elements (via
`elementFromPoint`), text hidden behind opaque elements, clipped text,
text spilling out of buttons/badges, horizontal overflow per viewport (using
the real device width), large fixed overlays, broken and distorted images,
content that stays invisible after scrolling into view, missing viewport meta.
Screenshots are annotated with a highlight box.

**Interaction and animation** — dead controls, toggles that open nothing,
stale `aria-expanded`, panels that open off-screen, behind other content, or
clipped by an `overflow: hidden` ancestor, animations that never finish
(panel left semi-transparent), slow animations (≥1 s), animated layout
properties, dropped frames during an animation, scrollbar jumps when an
overlay opens, dialogs that keep focus behind them, Escape that does not
close overlays, hover submenus that close before the pointer reaches them,
motion that ignores `prefers-reduced-motion`, layout shift during load (CLS).
Three frames of every interaction are captured for the visual reviewer.

**Forms** — empty required data sent without validation, silent rejection,
malformed emails accepted, password fields typed in plain text.

**Accessibility** — controls without accessible names, unlabeled fields,
missing alt text, contrast below WCAG thresholds, missing `lang`, disabled
zoom, small touch targets (WCAG 2.5.8 spacing exception applied), duplicate
ids, focus and Escape handling above.

**Content, console, network, performance** — `undefined`/`NaN`/`[object
Object]`/template placeholders in the UI, lorem ipsum, blank pages, missing
titles and headings, broken in-page anchors, uncaught exceptions, console
errors, failed API and asset requests, broken internal/external links, slow
LCP/load, long main-thread tasks, page weight.

**Security (non-destructive)** — CSP missing/weak, HSTS, clickjacking
(frame-ancestors / X-Frame-Options), `nosniff`, Referrer-Policy, version
disclosure, session cookie flags, CORS origin reflection (with credentials),
HTTP served without redirect, exposed files (`.git`, `.env`, backups,
`server-status`, `phpinfo`, … verified by content signature, soft-404 aware),
public source maps, secrets in client JavaScript (AWS, Stripe, GitHub,
OpenAI/Anthropic keys …, redacted in the report), vulnerable client libraries
(jQuery, AngularJS, Lodash, Bootstrap, Moment, Handlebars, DOMPurify),
reflected XSS and script-context reflection using an inert `<qase-probe>`
marker, DOM XSS through the URL fragment, error-based SQL injection
indicators (single quote only), open redirects on sign-in/redirect routes,
missing CSRF tokens (indicator), credentials over HTTP, debug output and
stack traces. No probe executes script, changes data or attempts to
authenticate.

**AI exploration** — the reasoner gets a compact page observation (refs for
interactive elements, visible text, recent errors) and tools: `click`,
`type`, `select`, `press`, `navigate`, `scroll`, `back`, `look` (screenshot),
`report_issue`, `finish`. It focuses on behaviour: wrong results, broken
flows, counters that do not update, edge-case input. Destructive labels are
refused and writes are blocked by the browser layer.

## Models

`models.js` wraps both models with timeouts, retries for 408/409/425/429/5xx,
a circuit breaker (three consecutive failures disable a model for the run)
and per-run call/token caps.

- **Reasoner**: OpenAI-compatible `chat/completions` (default
  `drytis/claude-opus-4.7` at `https://llm.drytis.ai/v1`), with native tool
  calls and `image_url` parts for vision.
- **JEV**: TypeSafe Decisions (`jev-1.13`). Each candidate gets a `noul`
  question ("is this a genuine user-impacting defect?") and a `score`
  question (impact 0–4). Answers are validated individually; a missing usage
  receipt never discards valid answers.

Keys: `QASE_REASONER_API_KEY` / `JEV_API_KEY`, falling back to the account's
configured key / `QASE_API_KEY`. Neither model is required.

## The conversation

The engine talks in the run conversation (`role: 'agent'`):

| Message kind | When | Rendered by |
| --- | --- | --- |
| `qa-step` | Start of the run and the end of every phase: what was tested, how many possible issues (by category) | `public/qaConversation.js` (markdown) |
| `qa-finding` | After triage, one per confirmed finding (most severe first, up to 15); id `qaf-<findingId>` | finding card: severity, page, viewports, screenshot, Copy fix prompt, Details |
| `qa-report` | Last message; id `qa-report-<ts>` | report card: verdict, counts, summary, what was not tested, PDF, all fix prompts |

Messages carry only id, role, kind and text, so they survive the PostgreSQL
store unchanged; the cards read the finding and report from the session.

### Asking for a test account

When no test account was given at launch and the site has a sign-in form
(`hasLoginForm` in `signin.js`: a visible password field in a form with a
submit control, or next to a "Sign in"/"Log in" button), the engine sets
`session.pendingQuestion = { kind: 'qa_credentials', … }`, moves the run to
`awaiting_input` and waits on `record.qaAnswer`:

- `POST /api/sessions/:id/credentials` stores the account in the run vault and
  resumes the engine, which signs in (one write window) and continues signed in;
- `POST /api/sessions/:id/answer`, or a chat reply such as "skip", continues
  with public pages only. A password typed into the chat is never accepted;
- no answer within `QASE_QA_CREDENTIAL_WAIT_MINUTES` (10) continues public-only;
- a failed sign-in is reported and asked once more;
- after a server restart the question is still pending; answering it resumes
  the run from its last completed phase.

Scheduled/matrix runs (`session.matrixRunId`) never ask.

## Avoiding false positives

QASE blocks writes and off-site navigations while testing. Their side effects
are not defects, so:

- interaction tests skip controls whose click tried to leave the site or send
  data, and never grade spinners or other infinite animations;
- explorer findings observed right after a blocked request carry
  `data.harness` and a low confidence; JEV and the reasoner get `HARNESS_NOTE`
  (`triage.js`) with every verification;
- an icon button inside a field (show password, clear) is an adornment, not an
  element covering the field;
- low contrast is re-measured on rendered pixels; claims the pixels disprove
  (pseudo-element, gradient or image backgrounds) are dropped;
- the same automated finding on several pages is merged into one finding that
  lists every page.

## Triage rule

```
detector candidate:  score = 0.35 × detector confidence + 0.65 × verifier probability
model candidate:     score = verifier probability   (unverified: 0.85 × own confidence)
promote when score ≥ 0.5
```

A verifier that is confident a candidate is a false positive can therefore
dismiss even a high-confidence detector result. Model-sourced candidates take
the verifier's severity; a detector's measured severity may drop one step, and
rises one step only when the verifier rates it at least two steps higher. Dismissed candidates are listed in the report
(`report.qaEngine.dismissed`) so nothing is silently dropped.

The verdict is deterministic: `blocked` if the target never loaded, `fail`
with any critical/high finding, `pass_with_issues` with other findings,
`partial` when a coverage-affecting phase did not finish, otherwise `pass`.

## Safety

- **Scope**: top-level navigation stays on the target origin plus
  `QASE_BROWSER_ALLOWED_ORIGINS`; blocked navigations answer HTTP 204 so the
  tab keeps its state.
- **Private networks**: every browser request and every server-side probe goes
  through the shared `browserPolicy` (SSRF protection). Allow approved
  internal targets with `QASE_BROWSER_ALLOWED_PRIVATE_HOSTS`.
- **Read-only**: during interaction every non-GET request is blocked (GraphQL
  queries excepted) and form POST navigations are always blocked, unless the
  owner enabled "Allow test data writes". The test-account sign-in submit is
  the only other write, inside a 10-second window.
- **Credentials**: the test account is stored in the run's encrypted vault
  (`server/secrets.js`) and resolved only at the keyboard in `signin.js`.
  All candidates and findings pass through `redact()`.
- Service workers are blocked so routing sees all traffic.

`server/qa/browser.test.js` locks these properties in.

## Persistence and resume

State lives in `session.hybrid` (version 2, `architecture: "adaptive"`; the PostgreSQL column
`qa_runs.hybrid_qa` from migration 043 stores it, see `hybridPersistence.js`).
Per-finding details that the findings table has no columns for (fix guidance,
selector, viewports, screenshot) are kept in `hybrid.findingDetails` and
re-attached on load. After a process restart `runResume.js` hands
interrupted QA runs straight back to the engine, which skips completed
stages and resumes the plan: a scenario that was running is re-queued when it
is read-only and marked `inconclusive` (never replayed) when it could have
side effects. Runs created by the previous hybrid runtime (version 1) remain
readable; continuing one starts the engine.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `QASE_QA_MAX_MINUTES` | 25 | Run budget (phases share the remaining time; waiting for the owner is not counted) |
| `QASE_QA_ASK_CREDENTIALS` | true | `false`: never ask for a test account |
| `QASE_QA_CREDENTIAL_WAIT_MINUTES` | 10 | How long the agent waits for the sign-in answer |
| `QASE_QA_MAX_PAGES` | 12 | Pages crawled and audited |
| `QASE_QA_VIEWPORT_PAGES` | 5 | Pages re-audited on extra viewports |
| `QASE_QA_INTERACTION_PAGES` | 4 | Pages whose toggles and animations are tested |
| `QASE_QA_TRIGGERS_PER_PAGE` | 8 | Controls tested per page and viewport |
| `QASE_QA_EXPLORE_STEPS` | 30 | Reasoner exploration steps |
| `QASE_QA_VISUAL_SHOTS` | 8 | Screenshots sent for visual review |
| `QASE_QA_REASONER_TOKENS` / `_CALLS` | 600000 / 80 | Reasoner caps |
| `QASE_QA_JEV_CALLS` | 40 | JEV caps |
| `QASE_QA_REASONER`, `QASE_QA_JEV` | true | Set `false` to disable a model |
| `QASE_REASONER_MODEL`, `QASE_REASONER_BASE_URL`, `QASE_REASONER_VISION` | Opus / Drytis gateway / true | Reasoner endpoint |
| `QASE_QA_MAX_ARTIFACTS` | 120 | Screenshots saved per run |
| `QASE_QA_JOURNEYS` | 3 | User journeys the reasoner may plan |
| `QASE_QA_MAX_SCENARIOS` | 80 | Upper bound on planned scenarios (all revisions) |
| `QASE_QA_MAX_REAUTH` | 3 | Re-authentications after session expiry per run |

## Testing it

- `npm test` includes `server/qa/*.test.js`: model layer, triage, report,
  fix prompts, crawl rules, browser safety, and end-to-end engine runs against
  the **QA Lab** with models simulated at the HTTP boundary (full run, both
  models failing, user stop, unreachable target, test-account sign-in).
- `server/qa/adaptive.test.js` covers the registry (exactly 140 categories,
  every field present), coverage states, planning and replanning, resume
  safety, the completion gate (including a false completion claim), routing
  and escalation. `server/qa/adaptive.integration.test.js` runs the engine in
  a real browser against the **Projectly** workspace app with a scripted
  reasoner and JEV stub: two-step sign-in, session expiry and
  re-authentication, protected routes, seeded defects, a stop after planning,
  and a wrong password.
- `server/qa/fixtureWorkspace.js` ("Projectly", under `/workspace/` in the
  QA Lab) is a multi-page app with two-step sign-in, member/admin roles, a
  signed-out-readable reports page, search with an unescaped echo, filters,
  sorting, pagination that fails on page 3, an unvalidated create form with
  a file input, a failing stats API and sessions that expire after
  `QASE_LAB_SESSION_HITS` page loads. `WORKSPACE_DEFECTS` lists what the
  engine must find.
- The QA Lab (`server/qa/fixtureSite.js`) is a seeded-defect site;
  `SEEDED_DEFECTS` lists every planted defect and the detector expected to
  find it. Outside production it is served at `/demo/qa-lab/`. `/clean` is a
  defect-free control page for false-positive checks.
- `npm run qualify:qa-live [-- https://your-staging-site]` runs the engine
  with the real model keys (capped), prints the seeded-defect scorecard and
  model usage, and writes JSON results and fix prompts to
  `test-results/qa-live/`.

## Adding a detector

1. Write a function that returns `candidate({...})` objects (see
   `findings.js`). Give it a stable `detector` id (`area.kind`), a
   `data.key` that identifies the same defect across viewports, a realistic
   `confidence`, and `fix` guidance written for a developer.
2. Add it as an executor unit (`executors.js` for new browser checks, or a
   unit in `engine.js`), plan it in `planner.js` from the graph feature it
   needs, and map its detector ids to categories in `capabilities.js`.
3. Plant the defect in `fixtureSite.js`, add it to `SEEDED_DEFECTS`, and make
   sure `/clean` still produces no page-level findings.
