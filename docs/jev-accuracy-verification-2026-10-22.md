# JEV execution accuracy verification — 22 October 2026

## What changed

- Added uncaught JavaScript exception and failed-request capture to the browser
  bridge. Events retain their source page, request identity and prefetch metadata.
- Consume diagnostic windows once and reproduce eligible failures on a fresh
  page load. Reading the same cumulative log twice is not confirmation.
- Keep JEV's assessment separate from objective reproduction. Confirmed failures
  are not discarded at an arbitrary model-support threshold; high model support
  alone cannot create a finding. Every candidate retains a review disposition.
- Exercise local search with matching/unmatched inputs and restore its state.
  Network-dependent searches remain explicit limitations.
- Add repeated accessible-name and image-alternative checks when requested.
  Preserve content/design requests as explicit plan dispositions.
- Handle hover-open menus correctly, restore disclosure state between checks,
  and reopen the observed menu before following links discovered inside it.
- Close observed welcome dialogs safely, tracking element identity when closing
  one dialog causes another introduction to appear at the same selector.
- Continue the remaining frontier after a redirect to an already tested route.
- Deduplicate corroborating/shared failures and separate behavior scenarios,
  DOM observations and detached native constraints in the report.

## Controlled end-to-end accuracy target

Run: `f6a1f220-350c-447f-8d7f-f4035159e3c0`.
Target: local loopback fixture served by `scripts/serve-jev-accuracy-fixture.mjs`.
Actual model: `typesafe/jev-1.13-20260917`; no other model used.

Detected all **seven deliberately seeded defect classes**:

1. Uncaught JavaScript exception.
2. Required script returning HTTP 500.
3. Broken image returning HTTP 404 and failing to decode.
4. Horizontal overflow at narrow viewport widths.
5. Interactive control without an accessible name.
6. Declared disclosure that does not respond to clicks.
7. Local search retaining unmatched results.

The run produced eight distinct findings (overflow reproduced at two widths),
with no findings for the deliberately benign anonymous-authentication or
speculative-prefetch requests. It exercised two routes and 38 assertions.
This is a controlled detection test, not a claim of universal accuracy.

## Live recovery cases verified during development

The initial live run identified hover-menu timing and source-menu reacquisition
problems. The next run exposed sequential onboarding-dialog replacement and a
delayed redirect that prematurely ended the frontier. Regression fixtures now
cover these cases. Earlier reports remain historical records; they were not
rewritten to claim newly executed checks.

## Final monitored live run

Run: `9aaedac1-c015-4234-a8b4-deb8f8df2398`.
Target: `https://thewariend.com/`.
Actual model: `typesafe/jev-1.13-20260917`.

The corrected build completed **20 routes in 177 seconds**, with **zero unavailable
browser scenarios, zero failed assertions and zero confirmed findings**. Both
onboarding dialogs closed successfully. It exercised 32 disclosure scenarios,
including reopening menus for navigation, and recorded 1,143 assertions across
layout, navigation, assets, native constraints and accessible-name observations.
Ten diagnostic candidates were retained with explicit exclusion reasons; none
was silently discarded. No unresolved candidates remained in this sample.

The verdict remains **partial**, not a release pass: 15 observed routes remained
outside the route budget, and authentication, application form submissions,
remote search relevance, full accessibility, content correctness and visual
consistency were not fully established. Zero confirmed findings does not mean
the whole application is defect-free. Both local service health checks returned
HTTP 200 after completion.

## Regression result

Final full suite: **1,853 passed, zero failed, 26 skipped** (1,879 total).
Real-browser fixtures cover working and broken local filtering, no-submit
behavior, input restoration, guarded network dependencies, working hover menus,
inert controls, sequential dialogs, disclosure restoration, missing accessible
names, broken assets and responsive geometry. Runner tests cover reproduced
errors despite uncertain model support, benign-noise exclusion, candidate
retention beyond 24 entries, blank-page recovery and delayed redirects.

## Practical scope

The default route budget is 20, with a 600-second execution budget. Exhausted
budgets are coverage gaps. Login and application submissions require authorized
fixtures. These checks do not establish full keyboard/contrast conformance,
business-copy correctness, remote search relevance or design consistency.

Verification runs use the isolated local verification account. Refresh QASE and
start a new run from your own account to use the corrected executor with your
normal history. The local QASE service remains on port 5174 and the JEV lab on 5175.
