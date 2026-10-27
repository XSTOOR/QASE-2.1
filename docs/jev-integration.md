# JEV-only local QASE

The native JEV adapter uses `jev-1.13` at
`https://llm.drytis.ai/typesafe/api/alpha/decisions`. The gateway resolves the
alias to the dated TypeSafe JEV model and the returned model ID is recorded
with each decision. It never calls a chat endpoint, JEV Router, or another
model. Model weights cannot be fine-tuned through this Decisions interface.
The integration changes QASE's controller and its SDK execution boundary.

## Start

Configure the ignored local `.env` file with `JEV_API_KEY`, `QASE_PROVIDER=jev`,
`QASE_MODEL=jev-1.13`, `QASE_LOCK_MODEL=true`, and the exact endpoint above as
`QASE_BASE_URL`. Set `NODE_ENV=development`, `PORT=5174`,
`QASE_HOST=127.0.0.1`, `QASE_PUBLIC_URL=http://127.0.0.1:5174`,
`QASE_RUN_STORE=local`, `QASE_EXECUTION_MODE=local`, and `QASE_HEADLESS=true`.
Keep credentials out of source control.

From this application directory:

```sh
PATH="$PWD/.tooling/node-v24.22.1-darwin-arm64/bin:$PATH" npm run start:jev
```

QASE is served at <http://127.0.0.1:5174> and its development-only model lab at
<http://127.0.0.1:5175>. QASE keeps its normal authentication. Register or sign
in with your local QASE account. The lab is loopback-only and rejects
cross-origin requests; its key is never sent to the browser.

## Architecture and scope

`server/jevClient.js` implements the native typed Decisions protocol, validates
requested answer types, candidate membership, model identity, probabilities,
and token usage, bounds body sizes and timeouts, disables redirects, and
supports cancellation. It does not automatically retry billable requests.

`server/jevRuntime.js` replaces the SDK's generative run loop for the JEV
provider while retaining the existing approved tool executor, browser bridge,
session activity stream, credential redaction, and mode-specific finalizers.
No package files in `node_modules` are patched. A JEV-only instance lock keeps
saved user preferences from silently selecting another model. SDK auxiliary
generation fails explicitly; test-case auto-generation uses the existing
deterministic fallback from recorded run evidence.

The host constructs candidate actions from fresh DOM snapshots. JEV chooses
among observed same-origin links and a limited set of reversible disclosure
controls. Query URLs, known destructive/account/commerce actions, and external
destinations are excluded. Existing network policies still apply. The host
persists attempted actions before execution to avoid repeating them after a
restart. Each invocation reacquires browser evidence. SQA/Founder retain their
bounded six-action sampler (`QASE_JEV_MAX_ACTIONS`). QA uses the coverage-driven
v2 planner below, not that sampler. The default decision limit is forty per
invocation (`QASE_JEV_MAX_DECISIONS`); prior invocations do not consume a new
turn's entire budget. All limits have hard upper bounds.

### Coverage-driven QA (v2)

`server/jevQaRunner.js` plans one disposition per selected check, discovers a
frontier from real observed anchors, and lets JEV rank routes. It does **not**
offer an early-finish action while executable selected work remains. Default
limits are 20 distinct rendered routes, 60 navigation attempts, and 600 seconds;
`QASE_JEV_MAX_PAGES` (1–30) and `QASE_JEV_MAX_SECONDS` (30–900) configure this
representative sample. There is no artificial minimum run duration. Unused
budget is not a reason to loop over the same pages, and exhausted budget is
never evidence of a passing test.

`server/jevBrowserChecks.js` supplies fixed scenarios through the existing SDK
tool gate and policy-guarded context:

- Settled DOM inventory and fresh observed selectors, including safe menus.
- Bounded overlapping document scrolling (up to 24 viewport samples) reveals
  intersection-observer content before inventory. Scroll position is restored;
  remaining document distance is an explicit coverage gap.
- Up to 24 observed disclosures per route, rather than two. Declared expanded
  panels must actually exist and be visible. Mobile menu interactions are
  checked at 390px, in addition to geometry. Tabs are not treated as disclosures.
- `server/jevInteractions.js` exercises up to 12 observed tabs and 16 distinct
  native fragment links per page. It checks tab selection/panel visibility and
  reproduces missing fragment targets. Per-control failures preserve other
  results. Custom hash views restore the original page before continuing.
  Local trials block navigation/fetch/write requests; static rendering assets
  still pass through existing network policy. Dependencies remain scope gaps.
- Safe close/dismiss controls inside observed dialogs release onboarding
  overlays. Dialog identity is tracked across sequential introductions. Menus
  are restored between checks and reopened before following their links.
- Actual anchor click, destination rendering, browser back, and browser forward
  assertions. HTTP errors receive a second load before broken-link confirmation.
- Document overflow and interactive-control geometry at 390px, 768px and the
  selected original viewport, restored in `finally`. Live preview captures are
  drained and suspended during scenarios to avoid racing viewport restoration.
- Native empty/invalid/corrected email/URL and numeric-boundary cases on detached
  field copies. App handlers, autosave and form submission never execute.
- Real local search trials (observed matching term, unmatched term, and input
  restoration) when a standalone result list can be identified. A temporary
  request guard makes network-dependent searches explicit gaps.
- Bounded visible image decoding/intrinsic-dimension checks, lazy-image scrolling
  and media loading-error inspection, with scroll restoration and an independent
  decode attempt before confirming a broken image.
- Repeated accessible-name/text-alternative checks when the operator requests
  accessibility. Content correctness and cross-page design requests also get
  explicit plan dispositions; they are no longer silently omitted by the older
  eight-checkbox catalog. Full contrast/keyboard/design review remains a gap.

An unavailable/blank page is retried once, then recorded as a local coverage gap;
the planner continues other discovered routes. Redirects to already tested pages
also continue the frontier instead of prematurely ending the run. Each page gets diagnostics and a
normal SDK screenshot. Assertion results, durations, expected/actual evidence,
coverage dispositions and the stop reason are persisted under `session.jev.qa`.
The report projects safe structured `executionEvidence`, renders it in the
Report tab, and includes it in JSON exports. Failed assertions are distinguished
from confirmed findings; unconfirmed failures cannot silently become passes.
Completed plan work is labelled **Completed**, never automatically **Passed**.
Recorded dispositions render as Tested, Partial, Not tested, or Not observed,
including historical runs without changing their underlying evidence. Bounded
report projections preserve full assertion totals and disclose omitted records;
individual interaction limitations are retained in the report.

Route selection keeps JEV ranking but uses a functional-diversity fallback when
model budget is reserved for review. Redundant source-page inspections were
removed. Controls are positioned with instant scroll before normal, non-forced
actionability checks; this avoids competing smooth-scroll animations. No
artificial minimum run time or fabricated finding count is used.

The browser bridge captures uncaught JavaScript exceptions, failed requests,
request provenance and prefetch metadata in addition to SDK diagnostics.
Diagnostics are consumed per observation window. Eligible failures are rechecked
on an independent page load, so rereading a cumulative log cannot confirm a bug.
Expected anonymous authentication denials, speculative prefetches, third-party
noise and policy blocks are distinguished from application failures.

QA findings require reproducible objective browser evidence. JEV support is
recorded separately, so a probability below 0.9 cannot erase a reproduced error
and a high probability cannot manufacture confirmation. Every candidate has a
visible confirmed, unresolved or excluded disposition with a reason. Large
candidate sets are batched; unreviewed evidence is retained. Shared defects and
asset failures are deduplicated. Behavior scenarios, discovery/DOM observations
and detached native constraints have separate counts. Requested checks not
fully executed remain `notCovered`. Successful sampling with missing selected
workflows has verdict `partial` ("Completed with gaps"), never `pass` or a global
prerequisite blocker. `blocked` is reserved for inability to exercise any
selected check, unavailable rendered browser evidence, or failed runtime
integrity. Coverage uses every page's diagnostics, not just the final page.
A console-only smoke scope can finish without claiming a whole-application
pass. Navigation and layout checks cover the recorded sample, not every link or
possible screen. Forms remain partial until real authorized submission/error/
recovery scenarios exist. Authentication requires an authorized test account;
query-result relevance, media playback, meeting participation, security probes
and subjective visual interpretation are not established by native constraint,
control or loading checks. No feature observed in the sampled pages is recorded
as `not_observed`, which is a scope limitation, not proof of site-wide absence.

SQA evaluates typed control decisions through the original evidence contract.
Only initial rendering and console/request smoke controls are eligible for
positive results from this controller. Other controls remain blocked with
their missing evidence requirements. JEV cannot replace documentary artifacts
or required reviewer approval.

Founder mode classifies all review lenses against sampled DOM and diagnostics.
Unobserved business facts remain unknown, and recommendations use explicit,
low-confidence evidence-collection templates. These are not free-form model
strategy generation, validated market claims, or a complete user-journey review.
Missing product context triggers the existing structured question flow.

This is a deliberate change in review capability: the Decisions API cannot
generate arbitrary text, tool arguments, new test scenarios, or a bespoke
strategy document. The UI and reports describe the bounded scope explicitly.

## Verification

```sh
node --test server/jev.test.js
node --test server/jevQaRunner.test.js server/jevBrowserChecks.test.js
node --test server/jevAccuracy.test.js server/jevAccessibility.test.js
node scripts/smoke-jev.mjs qa
node scripts/smoke-jev.mjs qa https://your-authorized-target.example/
node scripts/smoke-jev.mjs sqa
node scripts/smoke-jev.mjs founder
node scripts/smoke-jev.mjs lab
```

Set `QASE_SMOKE_RUN_ID` to an existing verification run ID to resume read-only
monitoring without starting another test. The monitor can reauthenticate once
if another verification login rotates its cookie; write requests are not retried.

For the controlled end-to-end accuracy target, start
`node scripts/serve-jev-accuracy-fixture.mjs`, then run
`node scripts/smoke-jev.mjs qa http://127.0.0.1:5186/ "Test accessibility basics"`.
It deliberately contains seven defect classes (uncaught exception, required
script failure, broken image, overflow, missing control name, inert disclosure,
and incorrect local filtering), plus benign authentication/prefetch noise.
The fixture is loopback-only and accepts no writes.

Smoke verification uses QASE's local defect fixtures, creates an isolated local
verification account, and stores its generated password only in
`.qase/jev-smoke-account.json` with mode 0600. Runs and reports remain visible
under that account. It verifies actual browser activity, JEV usage accounting,
and publication through each mode's existing finalizer.

The downloaded `SOURCE_MANIFEST.json` identifies the original October 15 source
snapshot. These intentional integration edits mean that original release
manifest no longer validates this development tree; do not label or deploy
these changes as the unchanged production release.
